/**
 * Codex conversation ingestion orchestrator (Codex Governance Closure
 * Slice A; SPEC rev 2 §7/§9/§17; PRI-1171 P1 seam migration).
 *
 * Called by pd-hook ONLY after both `host.codex` and
 * `codex_conversation_ingestion` are enabled — the flag check happens
 * before any transcript filesystem I/O, so flag-off means this module is
 * never entered and the transcript boundary receives zero calls (SPEC §10
 * hard privacy invariant, proven by a port spy test).
 *
 * Responsibilities: extract validated ingestion fields from the raw hook
 * payload (Codex protocol facts live in the adapter, not host-runtime), and
 * run the transcript delta through the host-neutral
 * `runConversationIngestion` pipeline with the Codex source adapter
 * (locate/decode/version guard live in transcript-source.ts; the pipeline
 * owns checkpoint, TOCTOU mapping, stop classification, and the store
 * commit). Verified tool outcomes ride the pipeline's pre-ingest hook so a
 * write failure still holds the checkpoint (CR-01 ordering).
 *
 * Stop (`turn_complete`) is the turn-complete ingestion trigger (G1 §2);
 * live `UserPromptSubmit`/`PostToolUse` contribute live observations that
 * the transcript replay later converges with (SPEC §10 source precedence).
 */
import type { HostEventKind } from '@principles/core/host';
import {
  CODEX_INGESTION_DISCLOSURE_VERSION,
  ingestGovernanceObservations,
  readConversationIngestionConsent,
  recordVerifiedToolOutcomes,
  resolveTextPolicy,
  runConversationIngestion,
  type ConversationIngestionOutcome,
  type GovernanceObservationInput,
  type GovernanceSignalCandidate,
  type TextPolicy,
  type VerifiedToolOutcomeInput,
  type TranscriptDelta,
  type TranscriptPort,
} from '@principles/host-runtime';
import { createNodeTranscriptPort } from './transcript-decoder.js';
import { createCodexTranscriptSource } from './transcript-source.js';
import { resolveCodexHome } from './codex-home.js';
import { validateCodexTranscriptPath } from './transcript-path.js';
import { extractFields, type PayloadFields } from './ingestion-fields.js';
import { buildLiveCorrectionCandidate, buildTranscriptCandidates } from './admission.js';

export interface CodexIngestionOptions {
  readonly workspaceDir: string;
  readonly env?: { CODEX_HOME?: string | undefined };
  readonly now?: Date;
  readonly port?: TranscriptPort;
}

export type CodexIngestionOutcome =
  | {
    status: 'ok'; inserted: number; enriched: number; duplicates: number; warnings: readonly string[]; lagBytes: number;
    /** Slice B: normalized admission candidates for the committed observations (host-neutral; consumed by pd-hook's admission pass). */
    readonly admissionCandidates: readonly GovernanceSignalCandidate[];
    readonly rolloutIdentity: string;
  }
  | { status: 'degraded'; reason: string; nextAction: string; warnings: readonly string[] };

let activePort: TranscriptPort | null = null;

/** Test seam: inject/inspect the transcript filesystem boundary (zero-read proofs). */
export function setCodexTranscriptPortForTest(port: TranscriptPort | null): void {
  activePort = port;
}

function activeTranscriptPort(options: CodexIngestionOptions): TranscriptPort {
  return options.port ?? activePort ?? createNodeTranscriptPort();
}

/**
 * PRI-1179: the consent-tiered `visible_text` bound for Codex. The full tier is
 * reachable ONLY from a record that is `granted` against the CURRENT frozen
 * disclosure (`CODEX_INGESTION_DISCLOSURE_VERSION`); an absent, unreadable,
 * revoked or older-disclosure record resolves to the bounded tier. An
 * unreadable ledger resolves narrow on purpose — the health surface reports the
 * malformed record loudly, and no content is lost by staying bounded.
 */
function resolveCodexTextPolicy(workspaceDir: string): TextPolicy {
  const read = readConversationIngestionConsent(workspaceDir, 'codex');
  const record = read.ok ? read.record : null;
  return resolveTextPolicy(
    { decision: record?.decision ?? 'not_present', disclosureVersion: record?.disclosureVersion ?? null },
    CODEX_INGESTION_DISCLOSURE_VERSION,
  );
}

interface LiveObservationArgs {
  readonly fields: PayloadFields;
  readonly rolloutIdentity: string;
  readonly workspaceDir: string;
  readonly now: Date;
}

function ingestLiveObservation({ fields, rolloutIdentity, workspaceDir, now }: LiveObservationArgs): CodexIngestionOutcome {
  const nowIso = now.toISOString();
  let observation: GovernanceObservationInput | null = null;
  if (fields.turnId !== null && fields.prompt !== null) {
    observation = {
      hostKind: 'codex',
      rolloutIdentity,
      rootSessionId: fields.sessionId,
      hostTurnId: fields.turnId,
      kind: 'user_turn',
      logicalObservationKey: `codex|${rolloutIdentity}|${fields.turnId}|user`,
      visibleText: fields.prompt,
      source: 'live_hook',
      completeness: 'complete',
      observedAt: nowIso,
    };
  } else if (fields.turnId !== null && fields.toolUseId !== null) {
    observation = {
      hostKind: 'codex',
      rolloutIdentity,
      rootSessionId: fields.sessionId,
      hostTurnId: fields.turnId,
      kind: 'tool_call',
      logicalObservationKey: `codex|${rolloutIdentity}|${fields.toolUseId}`,
      toolUseId: fields.toolUseId,
      toolFacts: {
        toolName: fields.toolName,
        params: fields.toolInput ?? null,
        result: fields.toolResponse ?? null,
      },
      source: 'live_hook',
      completeness: 'complete',
      observedAt: nowIso,
    };
  }
  if (observation === null) {
    return { status: 'degraded', reason: 'transcript_path_invalid', nextAction: 'the live event lacks turn/prompt/tool identity; no observation was written.', warnings: [] };
  }
  const result = ingestGovernanceObservations({
    workspaceDir,
    // PRI-1179 P1: the LIVE path must apply the same consent-tiered bound as
    // the transcript replay. A narrower live bound stores a truncated
    // user_turn, and the replay then sees a content mismatch on the same
    // logical key — a lineage conflict that stalls the checkpoint forever.
    maxVisibleTextChars: resolveCodexTextPolicy(workspaceDir).maxChars,
    observations: [observation],
    now,
  });
  if (!result.ok) return { status: 'degraded', reason: result.reason ?? 'governance_write_failed', nextAction: result.nextAction ?? 'inspect the workspace trajectory database.', warnings: result.warnings };
  // Slice B: hand the live observation to the admission pass as a normalized
  // candidate (SPEC §12) — the caller (pd-hook) runs detection/admission.
  // Phase A: tool-call observations stay technical trajectory only; they never
  // become a behavioral-deviation Pain candidate by themselves.
  const candidate = observation.kind === 'user_turn'
    ? buildLiveCorrectionCandidate({ fields, rolloutIdentity })
    : null;
  return {
    status: 'ok', inserted: result.inserted, enriched: result.enriched, duplicates: result.duplicates, warnings: result.warnings, lagBytes: 0,
    admissionCandidates: candidate !== null ? [candidate] : [],
    rolloutIdentity,
  };
}

interface TranscriptDeltaArgs {
  readonly fallbackRootSessionId: string;
  /** Raw transcript path from the hook payload / checkpoint resolution — the source adapter revalidates it. */
  readonly transcriptPath: string;
  readonly workspaceDir: string;
  readonly env: { CODEX_HOME?: string | undefined };
  readonly now: Date;
  readonly port: TranscriptPort;
}

/** Exact Operator-facing degradation texts the Codex CLI vocabulary owns (quarantine commands etc.). */
const CODEX_PIPELINE_DEGRADE_TEXTS = {
  readFailedNextAction: 'verify the transcript file still exists and is a regular file inside the Codex sessions root.',
  checkpointInconsistentNextAction: 'the transcript is shorter than the committed checkpoint; quarantine the stale rollout records via `pd codex ingest quarantine` or re-ingest from a fresh rollout.',
  malformedNextAction: 'the record is stable-invalid; quarantine this record via `pd codex ingest quarantine` (dry-run default). Later records remain as lag.',
  oversizedNextAction: 'a single transcript record exceeds the bounded-read window; inspect the rollout file.',
} as const;

/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-01: project decoded CommandExecution facts
 * onto the shared verified-outcome upgrade. The transcript's model-level call
 * name for the shell tool is `exec` while the PostToolUse hook names it
 * `Bash` (g1 fixture 04-post-tool-use.json ↔ normal-tool-final-turn.jsonl,
 * same tool_use_id) — the host-specific mapping stays here in the adapter.
 */
function collectVerifiedToolOutcomes(observations: readonly GovernanceObservationInput[]): VerifiedToolOutcomeInput[] {
  const outcomes: VerifiedToolOutcomeInput[] = [];
  for (const observation of observations) {
    if (observation.kind !== 'tool_call' || observation.toolUseId === undefined) continue;
    const facts = observation.toolFacts;
    if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) continue;
    const {exitCode} = (facts as Record<string, unknown>);
    if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) continue;
    const rawName = (facts as Record<string, unknown>).toolName;
    const toolName = rawName === 'exec' || typeof rawName !== 'string' || rawName.length === 0 ? 'Bash' : rawName;
    const {stdout} = (facts as Record<string, unknown>);
    const {stderr} = (facts as Record<string, unknown>);
    const previewParts: string[] = [];
    if (typeof stderr === 'string' && stderr.length > 0) previewParts.push(stderr);
    if (typeof stdout === 'string' && stdout.length > 0) previewParts.push(stdout);
    outcomes.push({
      toolUseId: observation.toolUseId,
      toolName,
      params: (facts as Record<string, unknown>).command ?? undefined,
      exitCode,
      ...(previewParts.length > 0 ? { outputPreview: previewParts.join('\n') } : {}),
    });
  }
  return outcomes;
}

/**
 * CR-01 rides the pipeline's pre-ingest hook: upgrade text-only live
 * observations with the host-verified exit codes BEFORE the checkpoint
 * advances, so a write failure holds the delta and the next Stop retries
 * instead of silently losing the verified facts.
 */
function codexVerifiedOutcomesPreIngest({ workspaceDir, delta, now: _now }: { workspaceDir: string; delta: TranscriptDelta; now: Date }): { ok: true } | { ok: false; reason: string; nextAction: string } {
  const verifiedOutcomes = collectVerifiedToolOutcomes(delta.observations);
  if (verifiedOutcomes.length === 0) return { ok: true };
  // SPEC-RULECODE-HOST-PROMOTION-001 R2: stamp the producing host on the
  // inserted rows so attribution-aware readers can prove provenance.
  const rootSessionId = delta.rollout.rootSessionId ?? '';
  const verified = recordVerifiedToolOutcomes({ workspaceDir, sessionId: rootSessionId, outcomes: verifiedOutcomes, hostKind: 'codex' });
  const failed = verified.find((result) => result.status === 'unavailable');
  if (failed !== undefined) {
    const reason = failed.reason === 'trajectory_db_not_found' ? 'verified_outcome_db_unavailable' : `verified_outcome_write_failed:${failed.reason.split(':', 2)[1] ?? ''}`;
    return { ok: false, reason, nextAction: 'inspect the workspace trajectory database; the transcript checkpoint was NOT advanced, the next Stop retries this delta.' };
  }
  return { ok: true };
}

function ingestTranscriptDelta({ fallbackRootSessionId, transcriptPath, workspaceDir, env, now, port }: TranscriptDeltaArgs): CodexIngestionOutcome {
  const outcome: ConversationIngestionOutcome = runConversationIngestion({
    workspaceDir,
    source: createCodexTranscriptSource({ env, fallbackRootSessionId, now }),
    session: { sessionId: fallbackRootSessionId },
    hints: { transcriptPath },
    // PRI-1171 P1 phasing: the double FLAG gate (host.codex ∧
    // codex_conversation_ingestion) is checked by pd-hook / catch-up BEFORE
    // this module is entered, and the consent LEDGER remains the governance
    // record the setup flow enforces (v2 authority model — the runtime gate
    // reads only the flags). The pipeline's consent gate therefore keeps
    // receiving the setup-flow invariant 'granted'.
    flags: { ingestionEnabled: true },
    consent: { decision: 'granted' },
    // PRI-1179: the STORED TEXT bound is a separate fact from the gate above —
    // it comes from the recorded v3 consent record, so a stale disclosure or a
    // revoke can only ever narrow what is stored, never widen it.
    textPolicy: resolveCodexTextPolicy(workspaceDir),
    now,
    port,
    degradeTexts: CODEX_PIPELINE_DEGRADE_TEXTS,
    preIngest: codexVerifiedOutcomesPreIngest,
  });
  if (outcome.status === 'degraded') {
    return outcome;
  }
  return {
    status: 'ok',
    inserted: outcome.inserted,
    enriched: outcome.enriched,
    duplicates: outcome.duplicates,
    warnings: outcome.warnings,
    lagBytes: outcome.lagBytes,
    // Slice B: transcript-only user turns / tool calls that were never seen
    // live get their admission evaluation here (SPEC §10/§12) — already
    // admitted logical keys no-op on the marker.
    admissionCandidates: buildTranscriptCandidates(outcome.observations),
    rolloutIdentity: outcome.sessionIdentity,
  };
}

export function ingestCodexConversation(rawPayload: unknown, kind: HostEventKind, options: CodexIngestionOptions): CodexIngestionOutcome {
  const fields = extractFields(rawPayload);
  if (fields === null || fields.sessionId.length === 0) {
    return { status: 'degraded', reason: 'transcript_path_invalid', nextAction: 'the hook payload lacks the required Codex identity fields.', warnings: [] };
  }
  if (fields.transcriptPath === null) {
    // SPEC §9: never scan for another file; keep a neutral degraded result.
    return { status: 'degraded', reason: 'transcript_unavailable', nextAction: 'Codex supplied no transcript for this event; nothing is read or fabricated.', warnings: [] };
  }
  const now = options.now ?? new Date();

  if (kind === 'before_prompt_build' || kind === 'after_tool_call') {
    // Live observations key on the rollout identity derived from the SAME
    // validated transcript reference the Stop replay later converges with
    // (SPEC §10) — validate here exactly as before the seam migration.
    const home = resolveCodexHome(options.env);
    if (!home.ok) return { status: 'degraded', reason: home.reason, nextAction: home.nextAction, warnings: [] };
    const validated = validateCodexTranscriptPath(fields.transcriptPath, home.home);
    if (!validated.ok) return { status: 'degraded', reason: validated.reason, nextAction: validated.nextAction, warnings: [] };
    return ingestLiveObservation({ fields, rolloutIdentity: validated.rolloutIdentity, workspaceDir: options.workspaceDir, now });
  }
  return ingestTranscriptDelta({
    fallbackRootSessionId: fields.sessionId,
    transcriptPath: fields.transcriptPath,
    workspaceDir: options.workspaceDir,
    env: options.env ?? {},
    now,
    port: activeTranscriptPort(options),
  });
}

export interface CodexTranscriptFromPathArgs {
  readonly workspaceDir: string;
  /** Absolute transcript path (catch-up resolves it by exact rollout identity before calling). */
  readonly transcriptPath: string;
  /** Fallback root session when neither the transcript nor the checkpoint carries one. */
  readonly fallbackRootSessionId: string;
  readonly env?: { CODEX_HOME?: string | undefined };
  readonly now?: Date;
  readonly port?: TranscriptPort;
}

/**
 * PRI-624 (Slice C): bounded incremental ingest of one known rollout from its
 * durable checkpoint, driven by an explicit transcript path instead of a live
 * hook payload. The path is re-authorized through the same
 * `validateCodexTranscriptPath` containment + post-open identity contract the
 * hook path uses (SPEC §9) — callers MUST only pass paths resolved from
 * previously-authenticated rollouts (checkpoints), never discovered sessions.
 */
export function ingestCodexTranscriptFromPath(args: CodexTranscriptFromPathArgs): CodexIngestionOutcome {
  return ingestTranscriptDelta({
    fallbackRootSessionId: args.fallbackRootSessionId,
    transcriptPath: args.transcriptPath,
    workspaceDir: args.workspaceDir,
    env: args.env ?? {},
    now: args.now ?? new Date(),
    port: args.port ?? activeTranscriptPort({ workspaceDir: args.workspaceDir }),
  });
}
