/**
 * Conversation-ingestion pipeline — the single orchestration entry for
 * unified host trajectory ingestion (PRI-1171; SPEC v0.2 §4.1).
 *
 * Five segments, host-neutral:
 *
 *   gate (flag short-circuit, ZERO port calls) → consent gate → locate →
 *   bounded window read (TOCTOU-mapped) → host decode → host contract guard →
 *   pre-ingest host side-writes → sanitize-at-store ingest with checkpoint →
 *   stop-classified outcome.
 *
 * Ordering invariants carried over verbatim from the Codex path (behavior
 * lock, fixtures in codex-adapter/tests/ingestion/ingestion.test.ts):
 *   - flag-off / consent-not-granted short-circuit BEFORE locate — the
 *     transcript filesystem boundary receives zero calls (SPEC §10 hard
 *     privacy invariant, proven by a port spy);
 *   - a host contract guard refusal (e.g. unsupported host version) ingests
 *     NOTHING and holds the checkpoint — the next trigger retries;
 *   - pre-ingest side-write failure (e.g. verified tool outcomes) holds the
 *     checkpoint so the delta retries instead of silently losing facts;
 *   - a stable malformed record commits the records BEFORE it, holds the
 *     checkpoint at it, and degrades loudly;
 *   - an incomplete tail commits what precedes it, parks the checkpoint at
 *     the tail start, and reports a warning (transient by design).
 *
 * The pipeline never learns host formats: the source adapter supplies locate
 * + decode + rollout lineage; `degradeTexts` carries host-CLI vocabulary
 * (quarantine commands etc.) so Operator-facing nextActions stay exact.
 */
import {
  ingestGovernanceObservations,
  readGovernanceCheckpoint,
  type GovernanceIngestDegradation,
  type GovernanceObservationInput,
} from '../governance-observation-store.js';
import {
  CONVERSATION_INGESTION_MAX_BATCH_BYTES,
  TranscriptReplacedError,
  createNodeTranscriptPort,
  type HookHints,
  type SessionRef,
  type TranscriptDelta,
  type TranscriptPort,
  type TranscriptSourceAdapter,
} from './source.js';
import type { ConversationIngestionConsentDecision } from './consent.js';

/** Verdict of a pre-ingest host side-write: failure holds the checkpoint (retry-safe). */
export type PreIngestVerdict = { ok: true } | { ok: false; reason: string; nextAction: string };

/** Neutral defaults; hosts pass their exact CLI vocabulary to keep Operator-facing text stable. */
export interface PipelineDegradeTexts {
  /** nextAction for `transcript_read_failed:*`. */
  readonly readFailedNextAction: string;
  /** nextAction for `checkpoint_inconsistent`. */
  readonly checkpointInconsistentNextAction: string;
  /** nextAction for the post-commit `transcript_record_malformed` degradation. */
  readonly malformedNextAction: string;
  /** nextAction for `transcript_record_too_large`. */
  readonly oversizedNextAction: string;
}

export interface RunIngestionArgs {
  readonly workspaceDir: string;
  readonly source: TranscriptSourceAdapter;
  readonly session: SessionRef;
  readonly hints: HookHints;
  readonly env?: { home?: string | undefined };
  /** The ingestion flag verdict, resolved by the caller BEFORE any I/O (double flag gate stays host-side). */
  readonly flags: { ingestionEnabled: boolean };
  /** The host's consent decision from the v3 ledger (see conversation-ingestion/consent.ts). */
  readonly consent: { decision: ConversationIngestionConsentDecision | 'not_present' };
  readonly now?: Date;
  /** Injected filesystem boundary (tests spy here; production uses the node port). */
  readonly port?: TranscriptPort;
  readonly maxBatchBytes?: number;
  readonly degradeTexts?: Partial<PipelineDegradeTexts>;
  /**
   * Host side-writes that must land BEFORE the checkpoint advances (e.g. Codex
   * verified tool outcomes). A failure holds the checkpoint; the delta retries.
   */
  readonly preIngest?: (args: { workspaceDir: string; delta: TranscriptDelta; now: Date }) => PreIngestVerdict;
}

export type ConversationIngestionOutcome =
  | {
    status: 'ok';
    inserted: number;
    enriched: number;
    duplicates: number;
    warnings: readonly string[];
    lagBytes: number;
    /** Decoded observations (admission candidate derivation stays host-side). */
    observations: readonly GovernanceObservationInput[];
    /** The host session identity the checkpoint/rollout were committed under. */
    sessionIdentity: string;
    checkpointByteOffset: number;
  }
  | { status: 'degraded'; reason: string; nextAction: string; warnings: readonly string[] };

export function runConversationIngestion(args: RunIngestionArgs): ConversationIngestionOutcome {
  const texts: PipelineDegradeTexts = {
    readFailedNextAction: 'verify the transcript file still exists and is a regular file inside the host sessions root.',
    checkpointInconsistentNextAction: 'the transcript is shorter than the committed checkpoint; quarantine the stale records or re-ingest from a fresh session.',
    malformedNextAction: 'the record is stable-invalid; quarantine this record. Later records remain as lag.',
    oversizedNextAction: 'a single transcript record exceeds the bounded-read window; inspect the transcript file.',
    ...args.degradeTexts,
  };
  const degraded = (reason: string, nextAction: string, warnings: readonly string[]): ConversationIngestionOutcome =>
    ({ status: 'degraded', reason, nextAction, warnings });

  // 1. Flag short-circuit — before locate, before ANY port call (SPEC §10).
  if (!args.flags.ingestionEnabled) {
    return degraded('ingestion_disabled', 'enable the conversation-ingestion flag for this host in the workspace .pd/config.yaml to ingest transcripts.', []);
  }
  // 2. Consent gate (SPEC §8.2: host flag AND ingestion flag AND consent=granted).
  if (args.consent.decision !== 'granted') {
    return degraded(
      `consent_not_granted:${args.consent.decision}`,
      'record a granted consent decision for this host (setup flow or Owner directive) before transcript ingestion runs.',
      [],
    );
  }

  const now = args.now ?? new Date();
  const port = args.port ?? createNodeTranscriptPort();

  // 3. Locate (deterministic, host rules).
  const locator = args.source.locate(args.session, args.hints, args.env ?? {});
  if (locator.status === 'degraded') {
    return degraded(locator.reason, locator.nextAction, []);
  }

  // 4. Durable checkpoint (per host_kind + session identity).
  const checkpoint = readGovernanceCheckpoint({ workspaceDir: args.workspaceDir, hostKind: args.source.hostKind, rolloutIdentity: locator.sessionIdentity });
  if (checkpoint !== null && !('byteOffset' in checkpoint) && 'ok' in checkpoint && checkpoint.ok === false) {
    return degraded(checkpoint.reason, checkpoint.nextAction, []);
  }
  const existing = checkpoint !== null && 'byteOffset' in checkpoint ? checkpoint : null;
  const offset = existing !== null ? existing.byteOffset : 0;

  // 5. One bounded window read; TOCTOU/replacement maps to structured refusals.
  let windowBytes: Buffer;
  let fileSize: number;
  try {
    const window = port.read({
      canonicalPath: locator.filePath,
      offset,
      maxBytes: args.maxBatchBytes ?? CONVERSATION_INGESTION_MAX_BATCH_BYTES,
      expectedIdentity: locator.expectedIdentity,
    });
    ({ bytes: windowBytes, fileSize } = window);
  } catch (error) {
    if (error instanceof TranscriptReplacedError) {
      return degraded('transcript_replaced', 'the transcript changed identity after validation (replacement or symlink swap); refusing to read — the next Stop revalidates the current file.', []);
    }
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return degraded(`transcript_read_failed:${detail}`, texts.readFailedNextAction, []);
  }
  if (offset > fileSize) {
    // The file shrank below the committed cursor: replaced or truncated —
    // never guess; hold the checkpoint and degrade explicitly.
    return degraded('checkpoint_inconsistent', texts.checkpointInconsistentNextAction, []);
  }

  // 6. Host decode (pure).
  const byteBoundReached = offset + windowBytes.length < fileSize;
  const delta = args.source.decodeWindow(
    locator,
    { bytes: windowBytes, fileOffset: offset, byteBoundReached, fileSize },
    existing,
  );

  // 7. Host contract guard — refuse the WHOLE delta, hold the checkpoint.
  if (delta.guard !== null) {
    return degraded(delta.guard.reason, delta.guard.nextAction, delta.warnings);
  }

  // 8. Stop-classified store degradations (recorded on the checkpoint row).
  const degradations: GovernanceIngestDegradation[] = [];
  if (delta.stop.kind === 'malformed') {
    degradations.push({ reason: 'transcript_record_malformed', ...(delta.stop.ordinal !== null ? { ordinal: delta.stop.ordinal } : {}), nextAction: texts.malformedNextAction });
  } else if (delta.stop.kind === 'oversized_record') {
    degradations.push({ reason: 'transcript_record_too_large', nextAction: texts.oversizedNextAction });
  }

  const rootSessionId = delta.rollout.rootSessionId ?? existing?.rootSessionId ?? args.session.sessionId;

  // 9. Pre-ingest host side-writes — failure holds the checkpoint (retry-safe).
  if (args.preIngest !== undefined) {
    const verdict = args.preIngest({ workspaceDir: args.workspaceDir, delta, now });
    if (verdict !== null && !verdict.ok) {
      return degraded(verdict.reason, verdict.nextAction, delta.warnings);
    }
  }

  // 10. Sanitize-at-store ingest with the durable checkpoint.
  const result = ingestGovernanceObservations({
    workspaceDir: args.workspaceDir,
    rollout: {
      hostKind: args.source.hostKind,
      rolloutIdentity: locator.sessionIdentity,
      rootSessionId,
      ...(delta.rollout.parentRolloutIdentity !== undefined ? { parentRolloutIdentity: delta.rollout.parentRolloutIdentity } : {}),
      ...(delta.rollout.agentIdentity !== undefined ? { agentIdentity: delta.rollout.agentIdentity } : {}),
      ...(delta.rollout.agentDepth !== undefined ? { agentDepth: delta.rollout.agentDepth } : {}),
    },
    observations: delta.observations,
    checkpoint: {
      hostKind: args.source.hostKind,
      rolloutIdentity: locator.sessionIdentity,
      byteOffset: delta.nextByteOffset,
      lastOrdinal: delta.lastOrdinal >= 0 ? delta.lastOrdinal : existing?.lastOrdinal ?? 0,
      ...(delta.rollout.cliVersion !== undefined ? { cliVersion: delta.rollout.cliVersion } : {}),
      rootSessionId,
      incompleteTail: delta.stop.kind === 'incomplete_tail',
    },
    ...(degradations.length > 0 ? { degradations } : {}),
    ...(delta.compactionTimestamp !== null ? { compactionTimestamp: delta.compactionTimestamp } : {}),
    ...(delta.rollbackTurns.length > 0 ? { rollbackTurns: delta.rollbackTurns } : {}),
    now,
  });

  const warnings = [...delta.warnings, ...result.warnings];
  if (!result.ok) {
    return degraded(result.reason ?? 'governance_write_failed', result.nextAction ?? 'inspect the workspace trajectory database.', warnings);
  }
  if (delta.stop.kind === 'incomplete_tail') {
    warnings.push('transcript_incomplete_tail');
  }
  if (delta.stop.kind === 'malformed') {
    // The store already committed the records before the malformed line and
    // held the checkpoint at it; surface the stable failure loudly.
    return degraded('transcript_record_malformed', texts.malformedNextAction, warnings);
  }
  if (delta.stop.kind === 'oversized_record') {
    return degraded('transcript_record_too_large', texts.oversizedNextAction, warnings);
  }
  return {
    status: 'ok',
    inserted: result.inserted,
    enriched: result.enriched,
    duplicates: result.duplicates,
    warnings,
    lagBytes: Math.max(0, fileSize - delta.nextByteOffset),
    observations: delta.observations,
    sessionIdentity: locator.sessionIdentity,
    checkpointByteOffset: delta.nextByteOffset,
  };
}
