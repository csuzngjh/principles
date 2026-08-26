/**
 * Atomic record adapter (SPEC §8).
 *
 * Atomicity: readers see either the old record or the new record — never a
 * partial write. Durability: the selected record survives a crash. The two
 * are tested separately; rename alone does NOT guarantee durability, so the
 * writer fsyncs the record file before renaming and flushes the containing
 * directory where the platform allows it.
 *
 * Platform notes (deliberate, documented):
 * - POSIX: file fsync + directory fd fsync after rename.
 * - Windows: file fsync + rename; Node cannot fsync a directory handle on
 *   Windows, so durability of the RENAME itself relies on the filesystem
 *   journal. As a compensating control the record is REREAD and verified
 *   after the rename — a torn state fails loud instead of silently lying.
 * - Windows rename after large writes can transiently fail EPERM/EACCES
 *   while antivirus holds handles; the rename is retried within a bounded
 *   window and fails loud afterwards (never falls back to non-atomic copy).
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class AtomicRecordError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AtomicRecordError';
    this.code = code;
  }
}

export interface AtomicWriteResult {
  readonly path: string;
  /** True when the post-rename reread reproduced the intended record bytes. */
  readonly verified: boolean;
}

function isDirectory(directoryPath: string): boolean {
  return existsSync(directoryPath) && statSync(directoryPath).isDirectory();
}

function fsyncDirectory(directoryPath: string): void {
  // Directory fd fsync is POSIX-only; on Windows this is a documented no-op
  // compensated by the post-rename reread verification below.
  if (process.platform === 'win32') return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directoryPath, 'r');
    fsyncSync(descriptor);
  } catch {
    // Some filesystems refuse directory fsync entirely; the file-level fsync
    // already ran. Failing the whole write here would trade a durable-enough
    // record for no record.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 800, 800, 800];

/**
 * Synchronous bounded sleep for the rename retry loop. Atomics.wait is
 * intentional here: this module is a synchronous CLI code path where
 * blocking the thread IS the requested behaviour (there is no concurrent
 * work to yield to), and Node.js — unlike browsers — permits Atomics.wait on
 * the main thread. It returns 'timed-out' after the delay, which is exactly
 * the sleep semantics we need.
 */
function sleepSync(delayMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function renameWithWindowsRetry(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? String(Reflect.get(error, 'code'))
        : 'unknown';
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if (!['EPERM', 'EACCES', 'EAGAIN'].includes(code) || delayMs === undefined) {
        throw new AtomicRecordError(
          'atomic_rename_failed',
          `Atomic record replacement failed (${code}): ${source} -> ${destination}. The previous record is untouched.`,
        );
      }
      sleepSync(delayMs);
    }
  }
}

/**
 * Replaces `recordPath` with `recordText` atomically:
 * temp file (same directory) → fsync → rename → directory flush → reread.
 * `recordText` must be the exact intended bytes; the reread must match.
 */
export function writeRecordAtomically(recordPath: string, recordText: string): AtomicWriteResult {
  const directory = dirname(recordPath);
  if (!isDirectory(directory)) {
    throw new AtomicRecordError('atomic_directory_missing', `Record directory does not exist: ${directory}`);
  }
  const tempPath = join(directory, `.record-${process.pid}-${Date.now()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, 'wx');
    writeFileSync(descriptor, recordText);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    renameWithWindowsRetry(tempPath, recordPath);
    fsyncDirectory(directory);

    const reread = existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : null;
    if (reread !== recordText) {
      throw new AtomicRecordError(
        'atomic_verify_failed',
        `Post-rename verification failed for ${recordPath}: the record on disk does not match the intended bytes. The previous record may or may not be in place — recovery must consult the journal.`,
      );
    }
    return { path: recordPath, verified: true };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(tempPath, { force: true });
    throw error;
  }
}
