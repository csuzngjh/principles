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
import * as nodePath from 'node:path';
import { appendEventLogLine } from '@principles/core/runtime';
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
  type TranscriptExpectedIdentity,
  type TranscriptPort,
  type TranscriptSourceAdapter,
} from './source.js';
import type { ConversationIngestionConsentDecision } from './consent.js';
import { TEXT_POLICY_BOUNDED_MAX_CHARS, type TextPolicy } from './text-policy.js';

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
  /**
   * PRI-1179: how much `visible_text` may be stored. The host resolves this
   * from its OWN consent record via `resolveTextPolicy(record, disclosureVersion)`
   * — a stale or non-granted record resolves to the bounded tier, never wider.
   * Absent = bounded (the pre-existing 200-char content bound).
   */
  readonly textPolicy?: TextPolicy;
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

/**
 * PRI-1261: how far the oversized-record scan-ahead may read past the bounded
 * window while looking for the record's terminating newline. Bounded memory is
 * preserved — chunks are discarded as soon as they are scanned. Beyond the cap
 * the record's completeness cannot be confirmed and the checkpoint HOLDS (the
 * same safe posture as an incomplete tail) instead of guessing.
 */
export const OVERSIZED_RECORD_SCAN_AHEAD_CAP_BYTES = 64 * 1024 * 1024;

interface OversizedScanResult {
  readonly found: boolean;
  /** Absolute offset of the newline, valid when `found`. */
  readonly newlineOffset: number;
  readonly scannedBytes: number;
  readonly stopReason: 'newline' | 'eof' | 'cap' | 'read_failed';
}

/**
 * PRI-1261: scan PAST the bounded window for the oversized record's
 * terminating newline, discarding bytes as they are scanned (bounded memory).
 * The scan starts after the window — the decoder only reports
 * `oversized_record` when the window contains NO newline at all.
 */
function scanAheadForRecordNewline(args: {
  readonly port: TranscriptPort;
  readonly locator: { readonly filePath: string; readonly expectedIdentity: TranscriptExpectedIdentity };
  readonly fromOffset: number;
  readonly maxChunkBytes: number;
}): OversizedScanResult {
  const {port, locator, maxChunkBytes} = args;
  let cursor = args.fromOffset;
  let scanned = 0;
  for (;;) {
    if (scanned >= OVERSIZED_RECORD_SCAN_AHEAD_CAP_BYTES) {
      return {found: false, newlineOffset: -1, scannedBytes: scanned, stopReason: 'cap'};
    }
    let bytes: Buffer;
    try {
      const window = port.read({
        canonicalPath: locator.filePath,
        offset: cursor,
        maxBytes: Math.min(maxChunkBytes, OVERSIZED_RECORD_SCAN_AHEAD_CAP_BYTES - scanned),
        expectedIdentity: locator.expectedIdentity,
      });
      ({ bytes } = window);
    } catch {
      return {found: false, newlineOffset: -1, scannedBytes: scanned, stopReason: 'read_failed'};
    }
    if (bytes.length === 0) {
      return {found: false, newlineOffset: -1, scannedBytes: scanned, stopReason: 'eof'};
    }
    const index = bytes.indexOf(0x0a);
    if (index !== -1) {
      return {found: true, newlineOffset: cursor + index, scannedBytes: scanned + bytes.length, stopReason: 'newline'};
    }
    cursor += bytes.length;
    scanned += bytes.length;
  }
}

export function runConversationIngestion(args: RunIngestionArgs): ConversationIngestionOutcome {
  const texts: PipelineDegradeTexts = {
    readFailedNextAction: 'verify the transcript file still exists and is a regular file inside the host sessions root.',
    checkpointInconsistentNextAction: 'the transcript is shorter than the committed checkpoint; quarantine the stale records or re-ingest from a fresh session.',
    malformedNextAction: 'the record is stable-invalid; quarantine this record. Later records remain as lag.',
    oversizedNextAction: 'a single transcript record exceeds the bounded-read window; inspect the transcript file.',
    ...args.degradeTexts,
  };
  const now = args.now ?? new Date();
  const eventLogStateDir = nodePath.join(args.workspaceDir, '.state');
  const boundedText = (value: string): string => {
    // Code-point bounded: a log line may be rendered by an Owner-facing
    // surface, so never split a surrogate pair (EP-11).
    const points = Array.from(value);
    return points.length > 300 ? `${points.slice(0, 300).join('')}…` : value;
  };
  /**
   * rc-9: every refused ingest leaves a durable fact in the existing
   * `events_<date>.jsonl` channel. The hook's stderr is the only other
   * surface, and it is per-process — "0 rows" was previously unattributable
   * after the fact. Best-effort: a failed write must not break the hook, but
   * it must stay observable on the returned warnings.
   */
  const degraded = (reason: string, nextAction: string, warnings: readonly string[]): ConversationIngestionOutcome => {
    const observableWarnings = [...warnings];
    try {
      appendEventLogLine(eventLogStateDir, {
        ts: now.toISOString(),
        type: 'conversation_ingestion',
        category: 'degraded',
        sessionId: args.session.sessionId,
        data: {
          hostKind: args.source.hostKind,
          reason: boundedText(reason),
          nextAction: boundedText(nextAction),
          warningCount: warnings.length,
        },
      });
    } catch (error) {
      const detail = boundedText(error instanceof Error ? error.message : String(error));
      observableWarnings.push(`degradation_event_log_failed:${detail}`);
    }
    return { status: 'degraded', reason, nextAction, warnings: observableWarnings };
  };

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
  // PRI-1261: an oversized_record whose terminating newline exists in the file
  // is a COMPLETE record that policy cannot retain — the checkpoint SKIPS past
  // it (tracked disposition below) so subsequent turns stay reachable instead
  // of the checkpoint stalling on the same offset forever. No newline until
  // EOF (or the scan cap) is indistinguishable from a record still being
  // written: the checkpoint HOLDS exactly like an incomplete tail.
  let checkpointByteOffset = delta.nextByteOffset;
  let oversizedSkip: { start: number; bytes: number } | null = null;
  let oversizedHeldIncomplete = false;
  if (delta.stop.kind === 'malformed') {
    degradations.push({ reason: 'transcript_record_malformed', ...(delta.stop.ordinal !== null ? { ordinal: delta.stop.ordinal } : {}), nextAction: texts.malformedNextAction });
  } else if (delta.stop.kind === 'oversized_record') {
    const scan = scanAheadForRecordNewline({
      port,
      locator,
      fromOffset: offset + windowBytes.length,
      maxChunkBytes: args.maxBatchBytes ?? CONVERSATION_INGESTION_MAX_BATCH_BYTES,
    });
    if (scan.found) {
      checkpointByteOffset = scan.newlineOffset + 1;
      oversizedSkip = { start: offset, bytes: checkpointByteOffset - offset };
      degradations.push({
        reason: 'transcript_record_too_large',
        nextAction: `a complete record of ${oversizedSkip.bytes} bytes at offset ${oversizedSkip.start} exceeded the retention window and was SKIPPED (not retained); later records continue from offset ${checkpointByteOffset}.`,
      });
    } else {
      oversizedHeldIncomplete = scan.stopReason !== 'read_failed';
      degradations.push({
        reason: 'transcript_record_too_large',
        nextAction: scan.stopReason === 'eof'
          ? 'the oversized record has no terminating newline yet (likely still being written); the checkpoint holds and retries after the record completes.'
          : scan.stopReason === 'cap'
            ? `the record exceeded the ${OVERSIZED_RECORD_SCAN_AHEAD_CAP_BYTES}-byte scan-ahead cap, so its completeness cannot be confirmed; the checkpoint holds. Inspect the transcript file.`
            : texts.oversizedNextAction,
      });
    }
  }

  const rootSessionId = delta.rollout.rootSessionId ?? existing?.rootSessionId ?? args.session.sessionId;

  // 9. Pre-ingest host side-writes — failure holds the checkpoint (retry-safe).
  if (args.preIngest !== undefined) {
    const verdict = args.preIngest({ workspaceDir: args.workspaceDir, delta, now });
    if (verdict !== null && !verdict.ok) {
      return degraded(verdict.reason, verdict.nextAction, delta.warnings);
    }
  }

  // 10. Sanitize-at-store ingest with the durable checkpoint. The text bound
  // comes from the caller's consent-tiered policy (PRI-1179); the store's
  // generic evidence bound stays the default when no policy is supplied.
  const textPolicy: TextPolicy = args.textPolicy ?? { tier: 'bounded', maxChars: TEXT_POLICY_BOUNDED_MAX_CHARS };
  const result = ingestGovernanceObservations({
    workspaceDir: args.workspaceDir,
    maxVisibleTextChars: textPolicy.maxChars,
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
      byteOffset: checkpointByteOffset,
      lastOrdinal: delta.lastOrdinal >= 0 ? delta.lastOrdinal : existing?.lastOrdinal ?? 0,
      ...(delta.rollout.cliVersion !== undefined ? { cliVersion: delta.rollout.cliVersion } : {}),
      rootSessionId,
      incompleteTail: delta.stop.kind === 'incomplete_tail' || oversizedHeldIncomplete,
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
    // PRI-1261: the tracked disposition rides the warnings so the skip (or the
    // hold) is queryable without re-deriving it from the checkpoint row.
    if (oversizedSkip !== null) {
      warnings.push(`transcript_record_skipped_oversized:${oversizedSkip.bytes}b@${oversizedSkip.start}->${checkpointByteOffset}`);
    } else if (oversizedHeldIncomplete) {
      warnings.push('transcript_record_oversized_incomplete_tail');
    }
    return degraded('transcript_record_too_large', degradations.find((entry) => entry.reason === 'transcript_record_too_large')?.nextAction ?? texts.oversizedNextAction, warnings);
  }
  return {
    status: 'ok',
    inserted: result.inserted,
    enriched: result.enriched,
    duplicates: result.duplicates,
    warnings,
    lagBytes: Math.max(0, fileSize - checkpointByteOffset),
    observations: delta.observations,
    sessionIdentity: locator.sessionIdentity,
    checkpointByteOffset,
  };
}
