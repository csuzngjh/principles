/**
 * Unified three-host conversation-ingestion health section for `pd health`
 * (PRI-1171 ticket ⑦; SPEC v0.2 §6, tech design §9).
 *
 * Read-only throughout: checkpoint/observation reads through the store,
 * transcript access is a SIZE STAT ONLY — never content. Every degraded or
 * unknown field carries reason + nextAction (rc-9); "unknown" is never
 * rendered as healthy.
 *
 * Per-host contract (tech design §9): hostFlag + ingestionFlag + consent +
 * checkpoint water-mark summary (lastSuccessAt / checkpointOffset / lagBytes
 * / lastDegradation) + the explicit `live_only` list — sessions with
 * observations but NO checkpoint row. The live hook path never writes a
 * checkpoint, so a missing checkpoint is a STATUS, not a lag anomaly.
 *
 * Host wiring truth table (honest, not aspirational):
 *   - codex: host.codex + codex_conversation_ingestion + v3 ledger slot +
 *     per-rollout byte lag via locateCodexTranscriptByRolloutIdentity;
 *   - workbuddy: host.workbuddy + workbuddy_conversation_ingestion + v3
 *     ledger slot + per-session byte lag via the ONE session locator the
 *     catch-up writer uses (locateWorkbuddyTranscriptBySessionIdentity);
 *   - openclaw: `not_wired` — its live hook path writes to the governance
 *     base tables (user_turns/assistant_turns) and the unified live
 *     observation bypass (`openclaw_unified_observation`) lands in P3
 *     (ticket ⑨). Reported as an explicit state with nextAction, never as
 *     an empty-but-monitored row.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deriveConversationIngestionConsentState,
  listGovernanceCheckpoints,
  listGovernanceUncheckpointedSessions,
  loadPdConfigForPlugin,
  readConversationIngestionConsent,
  type ConversationIngestionConsentState,
  type GovernanceCheckpointRecord,
} from '@principles/host-runtime';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '@principles/core/runtime';
import { locateCodexTranscriptByRolloutIdentity } from '@principles/codex-adapter';
import { locateWorkbuddyTranscriptBySessionIdentity, workbuddyProjectsRoot } from '@principles/workbuddy-adapter';

/** Bounded per-session detail rows in the health output. */
const MAX_DETAIL_SESSIONS = 8;
const MAX_LIVE_SESSIONS = 8;

export interface IngestionFlagView {
  state: 'ENABLED' | 'DISABLED' | 'UNKNOWN';
  /** Where the verdict was read from (user config vs built-in defaults vs malformed). */
  source: 'user_config' | 'defaults' | 'malformed';
}

export interface IngestionConsentView {
  state: ConversationIngestionConsentState | 'unreadable';
  decidedAt?: string;
  decidedVia?: string;
  disclosureVersion?: string;
  /** Present for state='unreadable' (rc-9). */
  reason?: string;
  nextAction?: string;
}

export interface IngestionCheckpointSession {
  readonly rolloutIdentity: string;
  readonly byteOffset: number;
  readonly lagBytes: number | null;
  readonly incompleteTail: boolean;
  readonly lastDegradationReason: string | null;
  readonly updatedAt: string;
}

export interface IngestionCheckpointSummary {
  total: number;
  /** MAX(updated_at) across the host's checkpoints (TD §9 lastSuccessAt). */
  lastSuccessAt: string | null;
  /** MAX(byte_offset) across the host's checkpoints (TD §9 checkpointOffset). */
  checkpointOffset: number | null;
  /** MAX lag over sessions where the transcript was stat-able; null when none determinable. */
  lagBytes: number | null;
  lagUndetectable: boolean;
  incompleteTailCount: number;
  lastDegradation: { reason: string; ordinal: number | null; updatedAt: string } | null;
  /** Newest-updated sessions first, bounded (full set stays in the store). */
  sessions: readonly IngestionCheckpointSession[];
  truncated: boolean;
}

export interface IngestionLiveOnlyView {
  /** Sessions with observations and NO checkpoint — the explicit live_only state (TD §9). */
  sessions: readonly { rolloutIdentity: string; lastObservedAt: string; observationCount: number }[];
  truncated: boolean;
}

export interface HostIngestionHealth {
  status: 'monitored';
  hostFlag: IngestionFlagView;
  ingestionFlag: IngestionFlagView;
  consent: IngestionConsentView;
  checkpoints: IngestionCheckpointSummary | { reason: string; nextAction: string };
  liveOnly: IngestionLiveOnlyView | { reason: string; nextAction: string };
}

export interface NotWiredIngestionHealth {
  status: 'not_wired';
  reason: string;
  nextAction: string;
}

export interface IngestionHealthSection {
  codex: HostIngestionHealth;
  workbuddy: HostIngestionHealth;
  openclaw: NotWiredIngestionHealth;
}

export interface AssessIngestionHealthOptions {
  readonly workspaceDir: string;
  /** Codex home override (defaults to CODEX_HOME / ~/.codex). */
  readonly codexHome?: string;
  /** WorkBuddy home override for tests; production uses the OS home. */
  readonly home?: string;
}

interface FlagVerdict {
  source: IngestionFlagView['source'];
  hostEnabled: boolean;
  ingestionEnabled: boolean;
}

function resolveFlags(workspaceDir: string, hostFlagKey: string, ingestionFlagKey: string): FlagVerdict {
  const configLoad = loadPdConfigForPlugin(workspaceDir);
  if (!configLoad.ok) {
    return { source: 'malformed', hostEnabled: false, ingestionEnabled: false };
  }
  const flags = computeFeatureFlagsFromConfig(configLoad.effective);
  return {
    source: configLoad.source,
    hostEnabled: isFeatureEnabled(flags, hostFlagKey),
    ingestionEnabled: isFeatureEnabled(flags, ingestionFlagKey),
  };
}

function flagView(verdict: boolean, source: IngestionFlagView['source']): IngestionFlagView {
  return { state: source === 'malformed' ? 'UNKNOWN' : verdict ? 'ENABLED' : 'DISABLED', source };
}

function consentView(workspaceDir: string, hostKind: 'codex' | 'workbuddy', ingestionEnabled: boolean): IngestionConsentView {
  const read = readConversationIngestionConsent(workspaceDir, hostKind);
  if (!read.ok) {
    return { state: 'unreadable', reason: read.reason, nextAction: read.nextAction };
  }
  const state = deriveConversationIngestionConsentState(read.record, ingestionEnabled);
  const { record } = read;
  if (record === null) {
    return {
      state,
      nextAction: state === 'flag_on_without_grant'
        ? `Record a consent decision for ${hostKind} (setup flow or Owner directive) before transcript ingestion runs.`
        : undefined,
    };
  }
  return {
    state,
    decidedAt: record.decidedAt,
    decidedVia: record.decidedVia,
    disclosureVersion: record.disclosureVersion,
  };
}

/** Latest-degradation-wins over the checkpoint rows (rows are oldest-updated-first). */
function summarizeCheckpoints(checkpoints: readonly GovernanceCheckpointRecord[], lagBySession: (identity: string) => number | null, lagUndetectable: boolean): IngestionCheckpointSummary {
  let lastSuccessAt: string | null = null;
  let checkpointOffset: number | null = null;
  let lagBytes: number | null = null;
  let incompleteTailCount = 0;
  let lastDegradation: IngestionCheckpointSummary['lastDegradation'] = null;
  for (const checkpoint of checkpoints) {
    if (lastSuccessAt === null || checkpoint.updatedAt > lastSuccessAt) lastSuccessAt = checkpoint.updatedAt;
    if (checkpointOffset === null || checkpoint.byteOffset > checkpointOffset) checkpointOffset = checkpoint.byteOffset;
    const lag = lagBySession(checkpoint.rolloutIdentity);
    if (lag !== null && (lagBytes === null || lag > lagBytes)) lagBytes = lag;
    if (checkpoint.incompleteTail) incompleteTailCount += 1;
    if (checkpoint.lastDegradationReason !== null
      && (lastDegradation === null || checkpoint.updatedAt > lastDegradation.updatedAt)) {
      lastDegradation = { reason: checkpoint.lastDegradationReason, ordinal: checkpoint.lastDegradationOrdinal, updatedAt: checkpoint.updatedAt };
    }
  }
  const detail = [...checkpoints]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, MAX_DETAIL_SESSIONS)
    .map((checkpoint) => ({
      rolloutIdentity: checkpoint.rolloutIdentity,
      byteOffset: checkpoint.byteOffset,
      lagBytes: lagBySession(checkpoint.rolloutIdentity),
      incompleteTail: checkpoint.incompleteTail,
      lastDegradationReason: checkpoint.lastDegradationReason,
      updatedAt: checkpoint.updatedAt,
    }));
  return {
    total: checkpoints.length,
    lastSuccessAt,
    checkpointOffset,
    lagBytes,
    lagUndetectable,
    incompleteTailCount,
    lastDegradation,
    sessions: detail,
    truncated: checkpoints.length > detail.length,
  };
}

function assessCodex(workspaceDir: string): HostIngestionHealth {
  const verdict = resolveFlags(workspaceDir, 'host.codex', 'codex_conversation_ingestion');
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  // Lag = transcript size − committed byte offset; sizeBytes rides on the
  // lookup (stat only, never content).
  const lagBySession = (identity: string, byteOffset: number): number | null => {
    const lookup = locateCodexTranscriptByRolloutIdentity(codexHome, identity);
    if (!lookup.ok || lookup.sizeBytes === null) return null;
    return Math.max(0, lookup.sizeBytes - byteOffset);
  };
  const lagUndetectableFor = (checkpoints: readonly GovernanceCheckpointRecord[]): boolean => {
    return checkpoints.some((checkpoint) => {
      const lookup = locateCodexTranscriptByRolloutIdentity(codexHome, checkpoint.rolloutIdentity);
      return !lookup.ok || lookup.sizeBytes === null;
    });
  };
  let checkpoints: HostIngestionHealth['checkpoints'];
  let liveOnly: HostIngestionHealth['liveOnly'];
  const listed = listGovernanceCheckpoints({ workspaceDir, hostKind: 'codex' });
  if (listed.ok) {
    checkpoints = summarizeCheckpoints(
      listed.checkpoints,
      (identity) => lagBySession(identity, listed.checkpoints.find((row) => row.rolloutIdentity === identity)?.byteOffset ?? 0),
      lagUndetectableFor(listed.checkpoints),
    );
  } else {
    checkpoints = { reason: listed.reason, nextAction: listed.nextAction };
  }
  const live = listGovernanceUncheckpointedSessions({ workspaceDir, hostKind: 'codex', limit: MAX_LIVE_SESSIONS });
  liveOnly = live.ok ? { sessions: live.sessions, truncated: live.truncated } : { reason: live.reason, nextAction: live.nextAction };
  return {
    status: 'monitored',
    hostFlag: flagView(verdict.hostEnabled, verdict.source),
    ingestionFlag: flagView(verdict.ingestionEnabled, verdict.source),
    consent: consentView(workspaceDir, 'codex', verdict.ingestionEnabled),
    checkpoints,
    liveOnly,
  };
}

function assessWorkbuddy(workspaceDir: string, home: string): HostIngestionHealth {
  const verdict = resolveFlags(workspaceDir, 'host.workbuddy', 'workbuddy_conversation_ingestion');
  const projectsRoot = workbuddyProjectsRoot(home);
  // Lag = transcript size − committed byte offset (same shape as Codex).
  // Size via stat ONLY; the locator is the SAME one the catch-up writer uses.
  const lagBySession = (identity: string, byteOffset: number): number | null => {
    const located = locateWorkbuddyTranscriptBySessionIdentity(projectsRoot, identity);
    if (located === null) return null;
    try {
      return Math.max(0, fs.statSync(located).size - byteOffset);
    } catch {
      return null;
    }
  };
  const lagUndetectableFor = (checkpoints: readonly GovernanceCheckpointRecord[]): boolean => {
    return checkpoints.some((checkpoint) => locateWorkbuddyTranscriptBySessionIdentity(projectsRoot, checkpoint.rolloutIdentity) === null);
  };
  let checkpoints: HostIngestionHealth['checkpoints'];
  let liveOnly: HostIngestionHealth['liveOnly'];
  const listed = listGovernanceCheckpoints({ workspaceDir, hostKind: 'workbuddy' });
  if (listed.ok) {
    checkpoints = summarizeCheckpoints(
      listed.checkpoints,
      (identity) => lagBySession(identity, listed.checkpoints.find((row) => row.rolloutIdentity === identity)?.byteOffset ?? 0),
      lagUndetectableFor(listed.checkpoints),
    );
  } else {
    checkpoints = { reason: listed.reason, nextAction: listed.nextAction };
  }
  const live = listGovernanceUncheckpointedSessions({ workspaceDir, hostKind: 'workbuddy', limit: MAX_LIVE_SESSIONS });
  liveOnly = live.ok ? { sessions: live.sessions, truncated: live.truncated } : { reason: live.reason, nextAction: live.nextAction };
  return {
    status: 'monitored',
    hostFlag: flagView(verdict.hostEnabled, verdict.source),
    ingestionFlag: flagView(verdict.ingestionEnabled, verdict.source),
    consent: consentView(workspaceDir, 'workbuddy', verdict.ingestionEnabled),
    checkpoints,
    liveOnly,
  };
}

export function assessIngestionHealth(options: AssessIngestionHealthOptions): IngestionHealthSection {
  // The caller (handleHealth / tests) owns workspace resolution — this section
  // reads the SAME workspace the rest of the report describes, never a
  // separately re-resolved "nearest" one that could disagree with the report.
  const { workspaceDir } = options;
  const home = options.home ?? os.homedir();
  return {
    codex: assessCodex(workspaceDir),
    workbuddy: assessWorkbuddy(workspaceDir, home),
    openclaw: {
      status: 'not_wired',
      reason: 'openclaw live observation bypass (openclaw_unified_observation) lands in PRI-1171 P3 ticket ⑨; the OpenClaw live hook path writes the governance base tables and never a transcript checkpoint.',
      nextAction: 'No action — this row becomes monitored when P3 ticket ⑨ wires the unified live bypass.',
    },
  };
}

/** Compact text lines for the non-JSON `pd health` output (cli-6: nextAction visible). */
export function formatIngestionHealthLines(section: IngestionHealthSection): string[] {
  const lines: string[] = [];
  lines.push('Conversation ingestion (unified transcript seam):');
  for (const host of ['codex', 'workbuddy', 'openclaw'] as const) {
    const row = section[host];
    if (row.status === 'not_wired') {
      lines.push(`  ${host}: not_wired — ${row.reason}`);
      lines.push(`    nextAction: ${row.nextAction}`);
      continue;
    }
    const flags = `host=${row.hostFlag.state}/ingestion=${row.ingestionFlag.state}/consent=${row.consent.state}`;
    const checkpoints = 'reason' in row.checkpoints
      ? `checkpoints=degraded(${row.checkpoints.reason})`
      : `checkpoints=${row.checkpoints.total}(offset=${row.checkpoints.checkpointOffset ?? 'n/a'}, lag=${row.checkpoints.lagBytes ?? 'n/a'}B${row.checkpoints.lagUndetectable ? ', lagUndetectable' : ''})`;
    const liveOnly = 'reason' in row.liveOnly
      ? `liveOnly=degraded(${row.liveOnly.reason})`
      : `liveOnly=${row.liveOnly.sessions.length}${row.liveOnly.truncated ? '+' : ''}`;
    lines.push(`  ${host}: ${flags}; ${checkpoints}; ${liveOnly}`);
    if ('reason' in row.checkpoints) lines.push(`    nextAction: ${row.checkpoints.nextAction}`);
    if ('reason' in row.liveOnly) lines.push(`    nextAction: ${row.liveOnly.nextAction}`);
    if (row.consent.state === 'unreadable' && row.consent.nextAction !== undefined) {
      lines.push(`    nextAction: ${row.consent.nextAction}`);
    }
    if (row.consent.state === 'flag_on_without_grant' && row.consent.nextAction !== undefined) {
      lines.push(`    nextAction: ${row.consent.nextAction}`);
    }
  }
  return lines;
}
