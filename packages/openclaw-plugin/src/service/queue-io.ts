/**
 * Queue I/O — extracted from evolution-worker.ts
 *
 * Full persistence layer encapsulating queue file locking, atomic writes,
 * and queue format. Depends on file-lock.ts, io.ts, and queue-migration.ts.
 * Zero imports from evolution-worker.ts.
 */

import * as fs from 'fs';
import { acquireLockAsync, releaseLock as releaseImportedLock, type LockContext } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/io.js';
import { LockUnavailableError } from '../config/errors.js';
import { migrateQueueToV2 } from './queue-migration.js';
import type { EvolutionQueueItem } from '../core/evolution-types.js';
import type { RawQueueItem } from './queue-migration.js';
import type { PluginLogger } from '../openclaw-sdk.js';

export const EVOLUTION_QUEUE_LOCK_SUFFIX = '.lock';
export const LOCK_MAX_RETRIES = 50;
export const LOCK_RETRY_DELAY_MS = 50;
export const LOCK_STALE_MS = 30_000;

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

/**
 * RAII-style lock guard — always releases the lock on exceptions.
 */
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

/**
 * Load and migrate the evolution queue. Returns empty array if file doesn't exist.
 */
export function loadEvolutionQueue(queuePath: string): EvolutionQueueItem[] {
    let rawQueue: RawQueueItem[] = [];
    try {
        rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    } catch {
        // Queue doesn't exist yet - create empty array
        rawQueue = [];
    }
    return migrateQueueToV2(rawQueue) as unknown as EvolutionQueueItem[];
}

/**
 * Atomically write the queue to disk.
 */
export function saveEvolutionQueue(queuePath: string, queue: EvolutionQueueItem[]): void {
    atomicWriteFileSync(queuePath, JSON.stringify(queue, null, 2));
}
