/**
 * Queue I/O + Enqueue — extracted from evolution-worker.ts
 *
 * Full persistence layer encapsulating queue file locking, atomic writes,
 * queue format, and enqueue orchestration. Depends on file-lock.ts, io.ts,
 * queue-migration.ts, and pain.ts.
 * Zero imports from evolution-worker.ts.
 */

import * as fs from 'fs';
import { createHash } from 'crypto';
import { acquireLockAsync, releaseLock as releaseImportedLock, type LockContext } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/io.js';
import { LockUnavailableError } from '../config/errors.js';
import { migrateQueueToV2, validateQueueItem } from './queue-migration.js';
import type { EvolutionQueueItem } from '../core/evolution-types.js';
import type { RawQueueItem } from './queue-migration.js';
import type { PluginLogger } from '../openclaw-sdk.js';

export const EVOLUTION_QUEUE_LOCK_SUFFIX = '.lock';
export const LOCK_MAX_RETRIES = 50;
export const LOCK_RETRY_DELAY_MS = 50;
export const LOCK_STALE_MS = 30_000;

export async function requireQueueLock(
  resourcePath: string,
  logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined,
  scope: string,
  lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX,
): Promise<() => void> {
  try {
    return await acquireQueueLock(resourcePath, logger, lockSuffix);
  } catch (err) {
    throw new LockUnavailableError(resourcePath, scope, { cause: err });
  }
}

export function createEvolutionTaskId(
  source: string,
  score: number,
  preview: string,
  reason: string,
  now: number,
): string {
  return createHash('md5')
    .update(`${source}:${score}:${preview}:${reason}:${now}`)
    .digest('hex')
    .substring(0, 8);
}

export function hasPendingTask(queue: EvolutionQueueItem[], taskKind: string): boolean {
  return queue.some(
    (t) => t.taskKind === taskKind && (t.status === 'pending' || t.status === 'in_progress'),
  );
}

export async function acquireQueueLock(
  resourcePath: string,
  logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined,
  lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX,
): Promise<() => void> {
  try {
    const ctx: LockContext = await acquireLockAsync(resourcePath, {
      lockSuffix,
      maxRetries: LOCK_MAX_RETRIES,
      baseRetryDelayMs: LOCK_RETRY_DELAY_MS,
      lockStaleMs: LOCK_STALE_MS,
    });
    return () => releaseImportedLock(ctx);
  } catch (error: unknown) {
    const warn = logger?.warn;
    warn?.(`[PD:EvolutionWorker] Failed to acquire lock for ${resourcePath}: ${String(error)}`);
    throw error;
  }
}

export async function withQueueLock<T>(
  resourcePath: string,
  logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined,
  scope: string,
  fn: () => Promise<T>,
): Promise<T> {
  const releaseLock = await acquireQueueLock(resourcePath, logger, EVOLUTION_QUEUE_LOCK_SUFFIX);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

export function loadEvolutionQueue(queuePath: string): EvolutionQueueItem[] {
  let rawQueue: RawQueueItem[] = [];
  try {
    rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      rawQueue = [];
    } else {
      console.warn(`[queue-io] Failed to load evolution queue (recovering with empty): ${String(err)}`);
      rawQueue = [];
    }
  }
  // rc-1/rc-4 (ERR-007): every element of the parsed array is untrusted disk
  // JSON — validate before returning. Malformed items are filtered out and
  // reported via console.warn (rc-9: no silent drop). This is the single
  // chokepoint that loadEvolutionQueue callers inherit.
  const migrated = migrateQueueToV2(rawQueue);
  return migrated.filter((item) => {
    const errors = validateQueueItem(item);
    if (errors.length > 0) {
      console.warn(`[queue-io] Dropping malformed queue item: ${errors.join(', ')} | id=${(item as { id?: string })?.id ?? 'N/A'}`);
      return false;
    }
    return true;
  });
}

export function saveEvolutionQueue(queuePath: string, queue: EvolutionQueueItem[]): void {
  atomicWriteFileSync(queuePath, JSON.stringify(queue, null, 2));
}
