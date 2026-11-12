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

/**
 * Host adapters load LAZILY inside the assess functions (PRI-1061 host-agnostic
 * startup): `pd health --help` must work with NO host adapter resolvable. A
 * missing adapter degrades that host's checkpoint/lag rows with a structured
 * reason — flags/consent (host-runtime only) stay live.
 */
type CodexLocator = (codexHome: string, rolloutIdentity: string) => { ok: boolean; sizeBytes?: number | null } & Record<string, unknown>;
type WorkbuddyLocator = (projectsRoot: string, rolloutIdentity: string) => string | null;
type WorkbuddyValidator = (transcriptPath: string, projectsRoot: string) => { ok: boolean } & Record<string, unknown>;

interface AdapterLocators {
  codex: CodexLocator | null;
  workbuddy: WorkbuddyLocator | null;
  workbuddyRoot: ((home: string) => string) | null;
  /** Same containment/shape validation the catch-up writer applies before touching a located path. */
  workbuddyValidate: WorkbuddyValidator | null;
}

async function loadAdapterLocators(): Promise<AdapterLocators> {
  // Dynamic imports of workspace packages are fully typed — no casts needed.
  const codex = await import('@principles/codex-adapter').then((m) => m.locateCodexTranscriptByRolloutIdentity).catch(() => null);
  const workbuddy = await import('@principles/workbuddy-adapter').then((m) => ({
    locate: m.locateWorkbuddyTranscriptBySessionIdentity,
    root: m.workbuddyProjectsRoot,
    validate: m.validateWorkbuddyTranscriptPath,
  })).catch(() => null);
  return {
    codex,
    workbuddy: workbuddy?.locate ?? null,
    workbuddyRoot: workbuddy?.root ?? null,
    workbuddyValidate: workbuddy?.validate ?? null,
  };
}

const ADAPTER_NEXT_ACTION = 'The host adapter package failed to resolve in this pd-cli install; repair the install with `npx create-principles-disciple` (do not edit the runtime by hand).';

/** Bounded per-session detail rows in the health output. */
const MAX_DETAIL_SESSIONS = 8;
const MAX_LIVE_SESSIONS = 8;

export interface IngestionFlagView {
  state: 'ENABLED' | 'DISABLED' | 'UNKNOWN';
  /** Where the verdict was read from (user config vs built-in defaults vs malformed). */
  source: 'user_config' | 'defaults' | 'malformed';
  /** Loader diagnostics when source='malformed' (rc-9: UNKNOWN is never bare). */
  reason?: string;
  nextAction?: string;
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
  /**
   * MAX(updated_at) across checkpoints that carry NO degradation reason
   * (TD §9 lastSuccessAt). Checkpoint rows whose updated_at was refreshed by
   * a catch-up DEFERRAL carry last_degradation_reason — counting them would
   * report "a failure was postponed just now" as "ingestion succeeded".
   */
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

interface FlagVerdict extends IngestionFlagView {
  hostEnabled: boolean;
  ingestionEnabled: boolean;
}

function resolveFlags(workspaceDir: string, hostFlagKey: string, ingestionFlagKey: string): FlagVerdict {
  const configLoad = loadPdConfigForPlugin(workspaceDir);
  if (!configLoad.ok) {
    const [first] = configLoad.errors;
    return {
      source: 'malformed',
      state: 'UNKNOWN',
      hostEnabled: false,
      ingestionEnabled: false,
      ...(first !== undefined ? { reason: first.reason, nextAction: first.nextAction } : {}),
    };
  }
  const flags = computeFeatureFlagsFromConfig(configLoad.effective);
  return {
    source: configLoad.source,
    state: configLoad.source === 'malformed' ? 'UNKNOWN' : 'DISABLED',
    hostEnabled: isFeatureEnabled(flags, hostFlagKey),
    ingestionEnabled: isFeatureEnabled(flags, ingestionFlagKey),
  };
}

function flagView(enabled: boolean, verdict: FlagVerdict): IngestionFlagView {
  return {
    state: verdict.source === 'malformed' ? 'UNKNOWN' : enabled ? 'ENABLED' : 'DISABLED',
    source: verdict.source,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    ...(verdict.nextAction !== undefined ? { nextAction: verdict.nextAction } : {}),
  };
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
    // A deferral/failure refreshes updated_at WITH a degradation reason; only
    // clean rows may claim lastSuccessAt (a postponed failure is not a success).
    if (checkpoint.lastDegradationReason === null
      && (lastSuccessAt === null || checkpoint.updatedAt > lastSuccessAt)) lastSuccessAt = checkpoint.updatedAt;
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

function assessCodex(workspaceDir: string, locator: CodexLocator | null, codexHomeOverride: string | undefined): HostIngestionHealth {
  const verdict = resolveFlags(workspaceDir, 'host.codex', 'codex_conversation_ingestion');
  const codexHome = codexHomeOverride ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  // Lag = transcript size − committed byte offset; sizeBytes rides on the
  // lookup (stat only, never content). A null locator = adapter package
  // unresolvable (PRI-1061): lag degrades with a structured reason, flags and
  // consent (host-runtime) stay live. A transcript SMALLER than the committed
  // offset means the file was replaced/truncated — that is not "no lag", it
  // is an incomparable state, so the lag is reported undetectable instead.
  const sizeOf = (identity: string): number | null => {
    if (locator === null) return null;
    const lookup = locator(codexHome, identity);
    if (!lookup.ok || typeof lookup.sizeBytes !== 'number') return null;
    return lookup.sizeBytes;
  };
  const lagBySession = (identity: string, byteOffset: number): number | null => {
    const size = sizeOf(identity);
    if (size === null || size < byteOffset) return null;
    return size - byteOffset;
  };
  let checkpoints: HostIngestionHealth['checkpoints'];
  let liveOnly: HostIngestionHealth['liveOnly'];
  const listed = listGovernanceCheckpoints({ workspaceDir, hostKind: 'codex' });
  if (listed.ok) {
    checkpoints = summarizeCheckpoints(
      listed.checkpoints,
      (identity) => lagBySession(identity, listed.checkpoints.find((row) => row.rolloutIdentity === identity)?.byteOffset ?? 0),
      locator === null || listed.checkpoints.some((checkpoint) => {
        const size = sizeOf(checkpoint.rolloutIdentity);
        return size === null || size < checkpoint.byteOffset;
      }),
    );
  } else {
    checkpoints = { reason: listed.reason, nextAction: listed.nextAction };
  }
  if (locator === null) {
    checkpoints = {
      reason: 'host_adapter_unavailable:@principles/codex-adapter',
      nextAction: ADAPTER_NEXT_ACTION,
    };
  }
  const live = listGovernanceUncheckpointedSessions({ workspaceDir, hostKind: 'codex', limit: MAX_LIVE_SESSIONS });
  liveOnly = live.ok ? { sessions: live.sessions, truncated: live.truncated } : { reason: live.reason, nextAction: live.nextAction };
  return {
    status: 'monitored',
    hostFlag: flagView(verdict.hostEnabled, verdict),
    ingestionFlag: flagView(verdict.ingestionEnabled, verdict),
    consent: consentView(workspaceDir, 'codex', verdict.ingestionEnabled),
    checkpoints,
    liveOnly,
  };
}

function assessWorkbuddy(workspaceDir: string, home: string, locators: AdapterLocators): HostIngestionHealth {
  const verdict = resolveFlags(workspaceDir, 'host.workbuddy', 'workbuddy_conversation_ingestion');
  // Consent BEFORE any transcript locate/stat (privacy ordering): a revoked
  // or absent grant means the health surface describes checkpoint rows from
  // the store only — it never touches the host's transcript files.
  const consent = consentView(workspaceDir, 'workbuddy', verdict.ingestionEnabled);
  const consentAllowsStat = consent.state === 'granted';
  const projectsRoot = locators.workbuddyRoot !== null ? locators.workbuddyRoot(home) : null;
  // Size via stat ONLY and only AFTER the same containment/shape validation
  // the catch-up writer applies — a symlink escape located by the raw name
  // scan must never feed the lag number. A file SMALLER than the committed
  // offset is an incomparable (replaced/truncated) state → undetectable,
  // never a fake zero lag.
  const sizeOf = (identity: string, byteOffset: number): number | null => {
    if (!consentAllowsStat || projectsRoot === null || locators.workbuddy === null || locators.workbuddyValidate === null) return null;
    const located = locators.workbuddy(projectsRoot, identity);
    if (located === null) return null;
    if (locators.workbuddyValidate(located, projectsRoot).ok !== true) return null;
    try {
      const { size } = fs.statSync(located);
      return size < byteOffset ? null : size;
    } catch {
      return null;
    }
  };
  const lagBySession = (identity: string, byteOffset: number): number | null => {
    const size = sizeOf(identity, byteOffset);
    if (size === null) return null;
    return size - byteOffset;
  };
  const lagUndetectable = !consentAllowsStat
    || locators.workbuddy === null
    || projectsRoot === null
    || locators.workbuddyValidate === null;
  let checkpoints: HostIngestionHealth['checkpoints'];
  let liveOnly: HostIngestionHealth['liveOnly'];
  const listed = listGovernanceCheckpoints({ workspaceDir, hostKind: 'workbuddy' });
  if (listed.ok) {
    checkpoints = summarizeCheckpoints(
      listed.checkpoints,
      (identity) => lagBySession(identity, listed.checkpoints.find((row) => row.rolloutIdentity === identity)?.byteOffset ?? 0),
      lagUndetectable || listed.checkpoints.some((checkpoint) => sizeOf(checkpoint.rolloutIdentity, checkpoint.byteOffset) === null),
    );
  } else {
    checkpoints = { reason: listed.reason, nextAction: listed.nextAction };
  }
  if (locators.workbuddy === null || projectsRoot === null) {
    checkpoints = {
      reason: 'host_adapter_unavailable:@principles/workbuddy-adapter',
      nextAction: ADAPTER_NEXT_ACTION,
    };
  }
  const live = listGovernanceUncheckpointedSessions({ workspaceDir, hostKind: 'workbuddy', limit: MAX_LIVE_SESSIONS });
  liveOnly = live.ok ? { sessions: live.sessions, truncated: live.truncated } : { reason: live.reason, nextAction: live.nextAction };
  return {
    status: 'monitored',
    hostFlag: flagView(verdict.hostEnabled, verdict),
    ingestionFlag: flagView(verdict.ingestionEnabled, verdict),
    consent,
    checkpoints,
    liveOnly,
  };
}

export async function assessIngestionHealth(options: AssessIngestionHealthOptions): Promise<IngestionHealthSection> {
  // The caller (handleHealth / tests) owns workspace resolution — this section
  // reads the SAME workspace the rest of the report describes, never a
  // separately re-resolved "nearest" one that could disagree with the report.
  const { workspaceDir } = options;
  const home = options.home ?? os.homedir();
  const locators = await loadAdapterLocators();
  return {
    codex: assessCodex(workspaceDir, locators.codex, options.codexHome),
    workbuddy: assessWorkbuddy(workspaceDir, home, locators),
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
    // Bounded session detail in TEXT mode too (the JSON fields are not a
    // substitute for operator diagnosis): newest sessions with their lag,
    // the latest degradation, and which sessions are live_only.
    if ('sessions' in row.checkpoints) {
      if (row.checkpoints.lastDegradation !== null) {
        lines.push(`    lastDegradation: ${row.checkpoints.lastDegradation.reason} @ ${row.checkpoints.lastDegradation.updatedAt}`);
      }
      for (const session of row.checkpoints.sessions.slice(0, 3)) {
        const lag = session.lagBytes === null ? 'n/a' : `${session.lagBytes}B`;
        const tail = session.incompleteTail ? ', incomplete_tail' : '';
        const degradation = session.lastDegradationReason !== null ? `, degraded=${session.lastDegradationReason}` : '';
        lines.push(`    session ${session.rolloutIdentity}: offset=${session.byteOffset}, lag=${lag}${tail}${degradation}`);
      }
      if (row.checkpoints.truncated) lines.push(`    …and ${row.checkpoints.total - row.checkpoints.sessions.length} more sessions`);
    }
    if ('sessions' in row.liveOnly) {
      for (const session of row.liveOnly.sessions.slice(0, 3)) {
        lines.push(`    liveOnly session ${session.rolloutIdentity}: lastObserved=${session.lastObservedAt}, ${session.observationCount} observation(s), no checkpoint (live hook path)`);
      }
      if (row.liveOnly.truncated) lines.push('    …and more live-only sessions');
    }
    if ('reason' in row.checkpoints) lines.push(`    nextAction: ${row.checkpoints.nextAction}`);
    if ('reason' in row.liveOnly) lines.push(`    nextAction: ${row.liveOnly.nextAction}`);
    if (row.consent.state === 'unreadable' && row.consent.nextAction !== undefined) {
      lines.push(`    nextAction: ${row.consent.nextAction}`);
    }
    if (row.consent.state === 'flag_on_without_grant' && row.consent.nextAction !== undefined) {
      lines.push(`    nextAction: ${row.consent.nextAction}`);
    }
    if (row.hostFlag.reason !== undefined) {
      lines.push(`    config: ${row.hostFlag.reason}`);
      if (row.hostFlag.nextAction !== undefined) lines.push(`    nextAction: ${row.hostFlag.nextAction}`);
    }
  }
  return lines;
}
