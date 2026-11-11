/**
 * Conversation-ingestion seam — host-neutral transcript source contract
 * (PRI-1171 unified host trajectory ingestion; SPEC v0.2 §4.1).
 *
 * This is the ONE interface a new host implements to join unified trajectory
 * ingestion: a transcript source adapter (deterministic locate + pure
 * incremental decode) plus the shared pipeline in pipeline.ts. Host-specific
 * decoding stays in the host's own adapter package (AGENTS §8.2) — this seam
 * deliberately knows nothing about rollout/session/jsonl formats beyond the
 * byte-window contract below.
 *
 * Moved here from codex-adapter/src/ingestion/transcript-decoder.ts (P1
 * migration, behavior-locked by the existing Codex fixtures):
 *   - the injectable filesystem boundary (TranscriptPort) with post-open
 *     identity revalidation (TOCTOU refusal);
 *   - the bounded batch constants;
 *   - the newline-window plan (complete lines + unterminated tail) that
 *     carries the incomplete-tail semantics: a final line without a trailing
 *     newline at EOF is a transient append/flush boundary — it is NOT consumed
 *     and the checkpoint does not advance past it.
 */
import fs from 'node:fs';
import type { GovernanceCheckpointRecord, GovernanceObservationHostKind, GovernanceObservationInput } from '../governance-observation-store.js';

/** Bounded single-window read: 1 MiB per invocation (hosts loop from checkpoints). */
export const CONVERSATION_INGESTION_MAX_BATCH_BYTES = 1024 * 1024;
/** Bounded records per window before the decode reports a byte-bound stop. */
export const CONVERSATION_INGESTION_MAX_BATCH_RECORDS = 256;

export interface TranscriptReadResult {
  /** Raw bytes read from [offset, offset+maxBytes) — never a decoded string, so multi-byte UTF-8 never corrupts offset math. */
  readonly bytes: Buffer;
  readonly fileSize: number;
}

/** Identity the validator captured pre-open; the port must re-prove it post-open (TOCTOU). */
export interface TranscriptExpectedIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Arguments for one bounded transcript window read. */
export interface TranscriptReadRequest {
  readonly canonicalPath: string;
  readonly offset: number;
  readonly maxBytes: number;
  /** Pre-open identity from the validator; the port re-proves it post-open. */
  readonly expectedIdentity?: TranscriptExpectedIdentity;
}

/** Filesystem boundary for the transcript read — injectable so tests can spy. */
export interface TranscriptPort {
  read(request: TranscriptReadRequest): TranscriptReadResult;
}

/** Thrown by the port when the opened object is not the validated one (replacement/TOCTOU). */
export class TranscriptReplacedError extends Error {
  constructor() {
    super('transcript_replaced_after_validation');
    this.name = 'TranscriptReplacedError';
  }
}

function identityMatches(opened: fs.Stats, expected: TranscriptExpectedIdentity): boolean {
  // Size+mtime fingerprint must ALWAYS hold. When the platform reports a
  // Number-safe inode on both sides, the inode must match too (it is what
  // catches delete+recreate replacements whose inode got reused on Linux CI
  // with a same-ms write; a same-size same-ms recreate remains outside the
  // threat model for an append-only host-owned file). On platforms whose
  // ino exceeds Number.MAX_SAFE_INTEGER (Windows file IDs), the inode is not
  // reliably comparable and the fingerprint alone decides. A false refusal
  // is the safe direction: the hook degrades observably and the next Stop
  // revalidates and retries.
  if (opened.size !== expected.size || opened.mtimeMs !== expected.mtimeMs) return false;
  const comparableIno = expected.ino !== 0 && expected.dev !== 0
    && opened.ino !== 0 && Number.isSafeInteger(expected.ino) && Number.isSafeInteger(opened.ino);
  if (comparableIno) return opened.ino === expected.ino && opened.dev === expected.dev;
  return true;
}

export function createNodeTranscriptPort(): TranscriptPort {
  return {
    read({ canonicalPath, offset, maxBytes, expectedIdentity }: TranscriptReadRequest): TranscriptReadResult {
      const fd = fs.openSync(canonicalPath, 'r');
      try {
        // Post-open revalidation: fstat the OPEN OBJECT — not the path — and
        // re-prove it is the regular file the validator approved, still at the
        // expected identity. A path swapped between validation and open
        // (replacement/symlink TOCTOU) is refused before a single byte is read.
        const stats = fs.fstatSync(fd);
        if (!stats.isFile()) throw new Error('transcript_is_not_regular_file');
        if (expectedIdentity !== undefined && !identityMatches(stats, expectedIdentity)) {
          throw new TranscriptReplacedError();
        }
        const length = Math.max(0, Math.min(maxBytes, stats.size - offset));
        if (length === 0) return { bytes: Buffer.alloc(0), fileSize: stats.size };
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
        // Post-read byte bound re-verification (EP-08): never trust the
        // pre-read stat for the enforced cap.
        const actual = bytesRead < 0 ? 0 : bytesRead;
        if (actual > maxBytes) throw new Error('transcript_read_exceeded_bound');
        return { bytes: buffer.subarray(0, actual), fileSize: stats.size };
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

/**
 * Why a decode stopped. Semantics moved verbatim from the Codex decoder (SPEC
 * rev 2 §14): `incomplete_tail` is transient (retry), `malformed` is stable
 * (stop at the record, never advance past it), `byte_bound`/`oversized_record`
 * report bounded lag, `eof` is a clean end.
 */
export type TranscriptDecodeStop =
  | { kind: 'eof' }
  | { kind: 'incomplete_tail' }
  | { kind: 'malformed'; ordinal: number | null }
  | { kind: 'byte_bound' }
  | { kind: 'oversized_record' };

// ─── Host-neutral source contract ───────────────────────────────────────────

export type SeamHostKind = GovernanceObservationHostKind;

/** The host session being ingested (identity the host's own hooks carry). */
export interface SessionRef {
  readonly sessionId: string;
  readonly cwd?: string;
}

/**
 * Hook-payload hints pointing at the durable transcript. Field names differ
 * by channel: UserPromptSubmit/SessionStart/SessionEnd carry
 * `transcript_path`; Stop carries `agent_transcript_path` (capability-matrix
 * Table A). Hosts read whichever their protocol provides.
 */
export interface HookHints {
  readonly transcriptPath?: string;
  readonly agentTranscriptPath?: string;
  readonly generationId?: string;
}

export type TranscriptLocator =
  | {
    status: 'ok';
    /** Canonical, containment-authorized transcript file path. */
    filePath: string;
    /** Pre-open identity the port will re-prove (TOCTOU). */
    expectedIdentity: TranscriptExpectedIdentity;
    /** The host's durable session identity (Codex rollout uuid / WorkBuddy sessionId) — checkpoint + ingest key. */
    sessionIdentity: string;
  }
  | { status: 'degraded'; reason: string; nextAction: string };

/** Rollout/session lineage carried alongside a decoded delta (host-filled). */
export interface TranscriptRolloutContext {
  readonly rootSessionId?: string;
  readonly cliVersion?: string;
  readonly parentRolloutIdentity?: string;
  readonly agentIdentity?: string;
  readonly agentDepth?: number;
}

/**
 * Host contract guard verdict: when non-null, the delta is REFUSED — nothing
 * is ingested, the checkpoint does not advance (e.g. Codex supported-version
 * guard: never guess the record contract of an unverified host version).
 */
export interface TranscriptDecodeGuard {
  readonly reason: string;
  readonly nextAction: string;
}

/** Neutral result of decoding one bounded transcript window. */
export interface TranscriptDelta {
  readonly observations: readonly GovernanceObservationInput[];
  readonly rollout: TranscriptRolloutContext;
  readonly guard: TranscriptDecodeGuard | null;
  /** Compaction marker timestamp (Codex); hosts without the concept pass null. NEVER passed as a store tombstone speculatively. */
  readonly compactionTimestamp: string | null;
  readonly rollbackTurns: readonly number[];
  readonly stop: TranscriptDecodeStop;
  /** Checkpoint byte offset to commit: start of the first unconsumed byte. */
  readonly nextByteOffset: number;
  /** Highest ordinal consumed (for the checkpoint's last_ordinal); -1 when none. */
  readonly lastOrdinal: number;
  readonly warnings: readonly string[];
  /** Transcript file size at read time (lag computation + shrink detection). */
  readonly fileSize: number;
}

/** One bounded window handed to a host decoder. */
export interface TranscriptWindow {
  readonly bytes: Buffer;
  readonly fileOffset: number;
  /** True when bytes did not reach EOF — the window was cut by the bounded read. */
  readonly byteBoundReached: boolean;
  readonly fileSize: number;
}

/**
 * The per-host adapter: deterministic locate + pure incremental decode.
 * Implementations live in the HOST's adapter package; this seam defines the
 * contract and the shared pipeline that drives it.
 */
export interface TranscriptSourceAdapter {
  readonly hostKind: SeamHostKind;
  /**
   * Deterministic transcript location: hook hints first, then the host's own
   * exact-path derivation. NEVER directory-scan for a "latest" file.
   */
  locate(session: SessionRef, hints: HookHints, env: { home?: string }): TranscriptLocator;
  /**
   * Decode one bounded window into observations — PURE: no filesystem access,
   * no store writes; all FS goes through the port in the pipeline. Must
   * inherit the incomplete-tail semantics via planJsonlWindow.
   */
  decodeWindow(locator: TranscriptLocator & { status: 'ok' }, window: TranscriptWindow, checkpoint: GovernanceCheckpointRecord | null): TranscriptDelta;
}

// ─── Newline-window plan (incomplete-tail semantics, host-neutral) ──────────

/** One newline-terminated raw line with its absolute byte start. */
export interface JsonlLineSlice {
  readonly bytes: Buffer;
  readonly recordByteStart: number;
}

export interface JsonlWindowPlan {
  /** Newline-terminated lines in source order (empty lines included; hosts skip them). */
  readonly lines: readonly JsonlLineSlice[];
  /** Absolute offset just past the final newline (= next offset when no tail is consumable). */
  readonly completeEndOffset: number;
  /** Unterminated bytes after the final newline (EOF flush boundary or byte-bound cut), with their absolute start. */
  readonly tail: { readonly bytes: Buffer; readonly startOffset: number } | null;
}

/**
 * Split a bounded read window at newline bytes. UTF-8 multi-byte sequences
 * never contain 0x0A, so byte-level splitting is safe and keeps checkpoint
 * math byte-exact. Hosts classify the tail: a parseable final line at EOF is
 * a complete record (consume + advance to EOF); an unparseable one is an
 * incomplete tail (hold the checkpoint); under a byte bound the tail is
 * simply lag (or `oversized_record` when the whole window had no newline).
 */
export function planJsonlWindow(bytes: Buffer, fileOffset: number): JsonlWindowPlan {
  const lastNewline = bytes.lastIndexOf(0x0a);
  const completeEnd = lastNewline + 1; // exclusive byte end of the newline-terminated region
  const lines: JsonlLineSlice[] = [];
  let lineStart = 0;
  while (lineStart < completeEnd) {
    const lineEnd = bytes.indexOf(0x0a, lineStart);
    if (lineEnd === -1 || lineEnd >= completeEnd) break;
    lines.push({ bytes: bytes.subarray(lineStart, lineEnd), recordByteStart: fileOffset + lineStart });
    lineStart = lineEnd + 1;
  }
  const tailBytes = completeEnd < bytes.length ? bytes.subarray(completeEnd) : null;
  return {
    lines,
    completeEndOffset: fileOffset + completeEnd,
    tail: tailBytes !== null && tailBytes.length > 0 ? { bytes: tailBytes, startOffset: fileOffset + completeEnd } : null,
  };
}
