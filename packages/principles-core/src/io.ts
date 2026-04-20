/**
 * I/O utilities for @principles/core SDK.
 *
 * Provides atomic file write operations that are crash-safe.
 * No dependencies on openclaw-plugin — self-contained.
 */

import * as fs from 'fs';

/**
 * AsyncQueueLock — lightweight in-process async queue lock.
 * Serializes async operations on the same key within a single Node.js process.
 * NOT a distributed lock — use for CLI-in-process concurrency only.
 */
export class AsyncQueueLock {
  private queues = new Map<string, Promise<void>>();

  /**
   * Execute a function while holding an exclusive lock on the given key.
   * Uses a promise chain to serialize operations — only one operation runs at a time
   * for any given key within this process.
   *
   * @param key - Lock key (e.g. file path to serialize)
   * @param fn - Async function to execute
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = key;
    let resolveRelease: () => void;
    const releasePromise = new Promise<void>(r => { resolveRelease = r; });
    const previousQueue = this.queues.get(lockPath) || Promise.resolve();
    const currentQueue = previousQueue.then(() => releasePromise);
    this.queues.set(lockPath, currentQueue);
    try {
      await previousQueue;
      return await fn();
    } finally {
      resolveRelease!();
      if (this.queues.get(lockPath) === currentQueue) {
        this.queues.delete(lockPath);
      }
    }
  }
}

// Module-level singleton for recordPainSignal to use
export const painFlagLock = new AsyncQueueLock();

const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

/**
 * Atomic file write — write to temp file then rename.
 *
 * Prevents corruption if process crashes mid-write.
 * On Windows, retries with exponential backoff on EPERM/EBUSY/EACCES
 * to handle transient file locks.
 *
 * @param filePath - Target file path
 * @param data - Content to write (UTF-8 string)
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, data, 'utf8');

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < RENAME_MAX_RETRIES; attempt++) {
        try {
            fs.renameSync(tmpPath, filePath);
            return;
        } catch (err) {
            lastError = err as Error;
            const code = (err as NodeJS.ErrnoException).code;
            // Only retry on Windows transient lock errors
            if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
                if (attempt < RENAME_MAX_RETRIES - 1) {
                    const delay = RENAME_BASE_DELAY_MS * Math.pow(2, attempt);
                    // Synchronous sleep using a tight spin with accessSync yield
                    const waitUntil = Date.now() + delay;
                    while (Date.now() < waitUntil) {
                        try { require('fs').accessSync?.(tmpPath); } catch { /* ignore */ }
                    }
                }
                continue;
            }
            // Non-retryable error — throw immediately
            break;
        }
    }

    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw lastError;
}
