/**
 * Evolution Queue Lock Utilities
 *
 * File locking for safe concurrent queue access.
 * Extracted from evolution-worker.ts.
 */

import { acquireLockAsync, releaseLock as releaseImportedLock, type LockContext } from '../utils/file-lock.js';
import { LockUnavailableError } from '../config/index.js';

export const EVOLUTION_QUEUE_LOCK_SUFFIX = '.lock';
export const LOCK_MAX_RETRIES = 50;
export const LOCK_RETRY_DELAY_MS = 50;
export const LOCK_STALE_MS = 30_000;

export async function acquireQueueLock(
    resourcePath: string,
    logger: { warn?: (message: string) => void; info?: (message: string) => void } | undefined,
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

export async function requireQueueLock(
    resourcePath: string,
    logger: { warn?: (message: string) => void; info?: (message: string) => void } | undefined,
    scope: string,
    lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX,
): Promise<() => void> {
    try {
        return await acquireQueueLock(resourcePath, logger, lockSuffix);
    } catch (err) {
        throw new LockUnavailableError(resourcePath, scope, { cause: err });
    }
}
