/**
 * Transaction progress sidecar — what the journal deliberately is not.
 *
 * The transaction journal (`<id>.jsonl`) is the authoritative state machine:
 * append-only, fsynced, one validated transition per line. It records WHEN a
 * stage begins, never how far along that stage is — and it must stay that way.
 * A download that takes minutes and a deploy that takes half a minute are, to
 * the Owner watching the Console, the difference between "it is working" and
 * "it hung". This module is the observational channel for that difference.
 *
 * Contract:
 *  - `<transactionsDir>/<id>.progress.json`, replaced atomically, throttled.
 *  - DERIVED and best-effort, never authoritative: nothing may branch on it.
 *    Absence is normal (an executor built before this file never writes one;
 *    the reporter removes it when the transaction ends) and a failed write is
 *    swallowed — reporting progress can never fail an update.
 *  - The reader validates every field: on the Console side this file is
 *    untrusted runtime input, and anything it cannot vouch for is dropped.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export const TRANSACTION_PROGRESS_SCHEMA_VERSION = 1 as const;

export interface TransactionProgress {
  readonly schemaVersion: typeof TRANSACTION_PROGRESS_SCHEMA_VERSION;
  readonly transactionId: string;
  /** When this observation was written (ISO-8601). */
  readonly at: string;
  /** What the installer is doing right now, in its own words (its CLI label). */
  readonly step?: string;
  /** The installer's weighted completion, 0–100. Absent while unknown. */
  readonly percent?: number;
  /** Release-asset bytes received so far, and how many are expected. */
  readonly bytesReceived?: number;
  readonly bytesTotal?: number;
}

export interface TransactionProgressReporter {
  /**
   * The installer moved to another step. `percent` is its weighted completion
   * (0–100) when it knows one; null means "not measurable". A new step ends
   * the download view: byte counts belong to the step that produced them.
   */
  step(message: string, percent?: number | null): void;
  /** Download byte count. Throttled: at most one write per interval, plus a trailing write. */
  bytes(received: number, total?: number): void;
  /** The transaction is over and progress has no further meaning: remove the sidecar. */
  close(): void;
}

export interface TransactionProgressReporterOptions {
  /** Minimum spacing between two sidecar writes (default 400ms). */
  readonly minWriteIntervalMs?: number;
  readonly now?: () => number;
}

/** Same shape the journal enforces for a transaction id; doubles as the path guard. */
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DEFAULT_MIN_WRITE_INTERVAL_MS = 400;
const MAX_STEP_LENGTH = 200;

/**
 * Replaces the sidecar in one step: write beside it, rename over it. A reader
 * sees the whole previous observation or the whole new one.
 *
 * Deliberately NOT the journal's `writeRecordAtomically`: that adapter is
 * built for records a recovery depends on — fsync, verified reread, and a
 * blocking multi-second rename retry. None of that is worth stalling the
 * update for a file that is rewritten twice a second and may simply be
 * missing. If the rename is refused (antivirus holding the file, a directory
 * in the way), this observation is dropped; the next one is 400ms away.
 */
function replaceSidecar(progressPath: string, text: string): void {
  const temporaryPath = join(dirname(progressPath), `.${basename(progressPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, text);
    renameSync(temporaryPath, progressPath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // The write itself failed; there is nothing of ours to clean up.
    }
    throw error;
  }
}

export function transactionProgressPath(transactionsDir: string, transactionId: string): string {
  return join(transactionsDir, `${transactionId}.progress.json`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads and validates one transaction's progress. Null for anything that is
 * not a fully trustworthy observation: absent, unreadable, a different
 * transaction, an unknown schema, or a field of the wrong shape.
 */
export function readTransactionProgress(transactionsDir: string, transactionId: string): TransactionProgress | null {
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) return null;
  const progressPath = transactionProgressPath(transactionsDir, transactionId);
  if (!existsSync(progressPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(progressPath, 'utf8'));
  } catch {
    // A torn or half-replaced read is "no observation", not an error: the
    // atomic writer guarantees the next read sees a whole record.
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.schemaVersion !== TRANSACTION_PROGRESS_SCHEMA_VERSION || parsed.transactionId !== transactionId) return null;
  if (typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at))) return null;
  const step = typeof parsed.step === 'string' && parsed.step.length > 0 ? parsed.step.slice(0, MAX_STEP_LENGTH) : undefined;
  const rawPercent = parsed.percent;
  const percent = typeof rawPercent === 'number' && Number.isFinite(rawPercent) && rawPercent >= 0 && rawPercent <= 100
    ? rawPercent
    : undefined;
  // Byte counts are only meaningful as a pair that adds up; one without the
  // other, or a count past its total, is dropped rather than shown wrong.
  const { bytesReceived, bytesTotal } = parsed;
  const hasBytes = isNonNegativeSafeInteger(bytesReceived) && isNonNegativeSafeInteger(bytesTotal)
    && bytesTotal > 0 && bytesReceived <= bytesTotal;
  return {
    schemaVersion: TRANSACTION_PROGRESS_SCHEMA_VERSION,
    transactionId,
    at: parsed.at,
    ...(step !== undefined ? { step } : {}),
    ...(percent !== undefined ? { percent } : {}),
    ...(hasBytes ? { bytesReceived, bytesTotal } : {}),
  };
}

interface Observation {
  step?: string;
  percent?: number;
  bytesReceived?: number;
  bytesTotal?: number;
}

/**
 * Reporter handed to the code that performs the transaction. Every method is
 * total: no input and no filesystem state can make it throw.
 */
export function createTransactionProgressReporter(
  transactionsDir: string,
  transactionId: string,
  options: TransactionProgressReporterOptions = {},
): TransactionProgressReporter {
  const noOp: TransactionProgressReporter = { step: () => undefined, bytes: () => undefined, close: () => undefined };
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) return noOp;

  const minWriteIntervalMs = options.minWriteIntervalMs ?? DEFAULT_MIN_WRITE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const progressPath = transactionProgressPath(transactionsDir, transactionId);
  let observation: Observation = {};
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let trailingTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const write = (): void => {
    if (trailingTimer !== undefined) {
      clearTimeout(trailingTimer);
      trailingTimer = undefined;
    }
    lastWriteAt = now();
    try {
      mkdirSync(transactionsDir, { recursive: true });
      replaceSidecar(progressPath, `${JSON.stringify({
        schemaVersion: TRANSACTION_PROGRESS_SCHEMA_VERSION,
        transactionId,
        at: new Date(now()).toISOString(),
        ...observation,
      })}\n`);
    } catch {
      // Progress is an observability nicety. A disk that refuses it has to be
      // reported by the transaction itself, on its own authority.
    }
  };

  /** Write now, or soon: never more often than the interval, never lose the last value. */
  const schedule = (): void => {
    if (closed) return;
    const elapsed = now() - lastWriteAt;
    if (elapsed >= minWriteIntervalMs) {
      write();
      return;
    }
    if (trailingTimer === undefined) {
      trailingTimer = setTimeout(() => {
        trailingTimer = undefined;
        if (!closed) write();
      }, minWriteIntervalMs - elapsed);
      // A pending progress write must not keep a dying executor alive.
      trailingTimer.unref?.();
    }
  };

  return {
    step(message, percent) {
      if (closed) return;
      observation = {
        ...(message.length > 0 ? { step: message.slice(0, MAX_STEP_LENGTH) } : {}),
        ...(typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100
          ? { percent: Math.round(percent) }
          : {}),
      };
      write();
    },
    bytes(received, total) {
      if (closed) return;
      if (!isNonNegativeSafeInteger(received)) return;
      observation = {
        ...observation,
        bytesReceived: received,
        ...(isNonNegativeSafeInteger(total) && total > 0 ? { bytesTotal: total } : {}),
      };
      if (observation.bytesTotal !== undefined && observation.bytesTotal < received) delete observation.bytesTotal;
      schedule();
    },
    close() {
      if (closed) return;
      closed = true;
      if (trailingTimer !== undefined) {
        clearTimeout(trailingTimer);
        trailingTimer = undefined;
      }
      try {
        rmSync(progressPath, { force: true });
      } catch {
        // A sidecar that cannot be removed is ignored by readers the moment it
        // goes stale; it must not turn a finished transaction into a failure.
      }
    },
  };
}
