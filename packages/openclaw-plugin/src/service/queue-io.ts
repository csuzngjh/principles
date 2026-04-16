/**
 * Queue I/O + Enqueue — extracted from evolution-worker.ts
 *
 * Full persistence layer encapsulating queue file locking, atomic writes,
 * queue format, and enqueue orchestration. Depends on file-lock.ts, io.ts,
 * queue-migration.ts, correction-cue-learner.ts, and pain.ts.
 * Zero imports from evolution-worker.ts.
 */

import * as fs from 'fs';
import { createHash } from 'crypto';
import { acquireLockAsync, releaseLock as releaseImportedLock, type LockContext } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/io.js';
import { LockUnavailableError } from '../config/errors.js';
import { migrateQueueToV2 } from './queue-migration.js';
import type { EvolutionQueueItem } from '../core/evolution-types.js';
import type { RawQueueItem } from './queue-migration.js';
import type { PluginLogger } from '../openclaw-sdk.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import { readPainFlagContract } from '../core/pain.js';

/**
 * Extended EvolutionQueueItem that includes the recentPainContext field.
 * This field is added inline in evolution-worker.ts but needs to be available
 * in queue-io.ts for the enqueue functions.
 */
interface EvolutionQueueItemWithPain extends EvolutionQueueItem {
    recentPainContext?: RecentPainContext;
}

export const EVOLUTION_QUEUE_LOCK_SUFFIX = '.lock';
export const LOCK_MAX_RETRIES = 50;
export const LOCK_RETRY_DELAY_MS = 50;
export const LOCK_STALE_MS = 30_000;

export const PAIN_QUEUE_DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

// ---------------------------------------------------------------------------
// requireQueueLock — thin wrapper that adds LockUnavailableError
// ---------------------------------------------------------------------------

/**
 * Acquire a queue lock, throwing LockUnavailableError on failure.
 * This is the standard lock used across all queue operations.
 */
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

// ---------------------------------------------------------------------------
// RecentPainContext
// ---------------------------------------------------------------------------

export interface RecentPainContext {
    mostRecent: {
        score: number;
        source: string;
        reason: string;
        timestamp: string;
        sessionId: string;
        /** Trajectory pain_events row ID — set when pain flag includes pain_event_id */
        painEventId?: number;
    } | null;
    recentPainCount: number;
    recentMaxPainScore: number;
}

// ---------------------------------------------------------------------------
// Task ID creation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a specific task kind has a pending or in-progress entry.
 */
export function hasPendingTask(queue: EvolutionQueueItem[], taskKind: string): boolean {
    return queue.some(
        (t) => t.taskKind === taskKind && (t.status === 'pending' || t.status === 'in_progress'),
    );
}

/**
 * Build a dedup key from pain context.
 * Returns null when no pain context is available (bypasses dedup).
 */
function buildPainSourceKey(
    painCtx: ReturnType<typeof readRecentPainContext>,
): string | null {
    if (!painCtx.mostRecent) return null;
    return `${painCtx.mostRecent.source}::${painCtx.mostRecent.reason?.slice(0, 50) ?? ''}`;
}

/**
 * Check whether a similar sleep_reflection task completed recently.
 */
function hasRecentSimilarReflection(
    queue: EvolutionQueueItemWithPain[],
    painSourceKey: string,
    now: number,
): EvolutionQueueItem | null {
    return queue.find((t) => {
        if (t.taskKind !== 'sleep_reflection') return false;
        if (t.status !== 'completed') return false;
        if (!t.completed_at) return false;
        const age = now - new Date(t.completed_at).getTime();
        if (age > PAIN_QUEUE_DEDUP_WINDOW_MS) return false;
        const taskPainKey = buildPainSourceKey(t.recentPainContext ?? { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 });
        if (!taskPainKey) return false;
        return taskPainKey === painSourceKey;
    }) ?? null;
}

// ---------------------------------------------------------------------------
// Pain context
// ---------------------------------------------------------------------------

export function readRecentPainContext(wctx: WorkspaceContext): RecentPainContext {
    const contract = readPainFlagContract(wctx.workspaceDir);
    if (contract.status !== 'valid') {
        return { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 };
    }

    try {
        const score = parseInt(contract.data.score ?? '0', 10) || 0;
        const source = contract.data.source ?? '';
        const reason = contract.data.reason ?? '';
        const timestamp = contract.data.time ?? '';
        const sessionId = contract.data.session_id ?? '';
        const painEventIdRaw = contract.data.pain_event_id;
        const painEventId = painEventIdRaw ? parseInt(painEventIdRaw, 10) : undefined;

        if (score > 0) {
            return {
                mostRecent: { score, source, reason, timestamp, sessionId, painEventId },
                recentPainCount: 1,
                recentMaxPainScore: score,
            };
        }
    } catch (err) {
      // Best effort — non-fatal, but surface unexpected errors
       
      console.warn(`[queue-io] Failed to read pain context (non-fatal): ${String(err)}`);
       
    }

    return { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 };
}

/**
 * Decide whether to skip enqueuing due to a recent similar reflection.
 */
export function shouldSkipForDedup(
    queue: EvolutionQueueItemWithPain[],
    wctx: WorkspaceContext,
    logger: PluginLogger | undefined,
): boolean {
    const recentPainContext = readRecentPainContext(wctx);
    const painSourceKey = buildPainSourceKey(recentPainContext);

    if (!painSourceKey) return false;

    const now = Date.now();
    const recentSimilarReflection = hasRecentSimilarReflection(queue, painSourceKey, now);

    if (recentSimilarReflection) {
        const completedTime = new Date(recentSimilarReflection.completed_at!).getTime();  
        logger?.debug?.(`[PD:EvolutionWorker] Skipping sleep_reflection — similar reflection completed ${Math.round((now - completedTime) / 60000)}min ago (same pain pattern: ${painSourceKey})`);
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Enqueue functions
// ---------------------------------------------------------------------------

function enqueueNewSleepReflectionTask(
    queue: EvolutionQueueItemWithPain[],
    recentPainContext: ReturnType<typeof readRecentPainContext>,
    queuePath: string,
    logger: PluginLogger | undefined,
): void {
    const taskId = createEvolutionTaskId('nocturnal', 50, 'idle workspace', 'Sleep-mode reflection', Date.now());
    const nowIso = new Date().toISOString();

    queue.push({
        id: taskId,
        taskKind: 'sleep_reflection',
        priority: 'medium',
        score: 50,
        source: 'nocturnal',
        reason: 'Sleep-mode reflection triggered by idle workspace',
        trigger_text_preview: 'Idle workspace detected',
        timestamp: nowIso,
        enqueued_at: nowIso,
        status: 'pending',
        traceId: taskId,
        retryCount: 0,
        maxRetries: 1,
        recentPainContext,
    });

    // Cast to EvolutionQueueItem[] because saveEvolutionQueue expects the base type
    // but the queue may contain extended fields (recentPainContext) that are
    // serialized as part of the JSON - this is safe at runtime.
    saveEvolutionQueue(queuePath, queue as unknown as EvolutionQueueItem[]);
    logger?.info?.(`[PD:EvolutionWorker] Enqueued sleep_reflection task ${taskId}`);
}

/**
 * Enqueue a sleep_reflection task if one is not already pending.
 */
export async function enqueueSleepReflectionTask(
    wctx: WorkspaceContext,
    logger: PluginLogger | undefined,
): Promise<void> {
    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    const releaseLock = await requireQueueLock(queuePath, logger, 'enqueueSleepReflection', EVOLUTION_QUEUE_LOCK_SUFFIX);

    try {
        const queue = loadEvolutionQueue(queuePath);

        if (hasPendingTask(queue, 'sleep_reflection')) {
            logger?.debug?.('[PD:EvolutionWorker] sleep_reflection task already pending/in-progress, skipping');
            return;
        }

        if (shouldSkipForDedup(queue, wctx, logger)) {
            return;
        }

        const recentPainContext = readRecentPainContext(wctx);
        enqueueNewSleepReflectionTask(queue, recentPainContext, queuePath, logger);
    } finally {
        releaseLock();
    }
}

/**
 * Enqueue a keyword_optimization task if one is not already pending/in-progress.
 */
export async function enqueueKeywordOptimizationTask(
    wctx: WorkspaceContext,
    logger: PluginLogger | undefined,
): Promise<void> {
    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    const releaseLock = await requireQueueLock(queuePath, logger, 'enqueueKeywordOpt', EVOLUTION_QUEUE_LOCK_SUFFIX);

    try {
        const queue = loadEvolutionQueue(queuePath);

        if (hasPendingTask(queue, 'keyword_optimization')) {
            logger?.debug?.('[PD:EvolutionWorker] keyword_optimization task already pending/in-progress, skipping');
            return;
        }

        const learner = CorrectionCueLearner.get(wctx.stateDir);
        if (!learner.canRunKeywordOptimization()) {
            logger?.debug?.('[PD:EvolutionWorker] keyword_optimization throttle exhausted, skipping');
            return;
        }

        const taskId = createEvolutionTaskId('keyword_optimization', 50, 'keyword optimization', 'Keyword optimization via LLM', Date.now());
        const nowIso = new Date().toISOString();

        queue.push({
            id: taskId,
            taskKind: 'keyword_optimization',
            priority: 'medium',
            score: 50,
            source: 'correction',
            reason: 'Keyword optimization triggered by heartbeat',
            trigger_text_preview: 'Keyword optimization via LLM',
            timestamp: nowIso,
            enqueued_at: nowIso,
            status: 'pending',
            traceId: taskId,
            retryCount: 0,
            maxRetries: 1,
        });

        saveEvolutionQueue(queuePath, queue);
        logger?.info?.(`[PD:EvolutionWorker] Enqueued keyword_optimization task ${taskId}`);
    } finally {
        releaseLock();
    }
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
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // Queue doesn't exist yet - create empty array
            rawQueue = [];
        } else {
            // Corrupted JSON or other read error — warn and recover with empty queue
             
            console.warn(`[queue-io] Failed to load evolution queue (recovering with empty): ${String(err)}`);
             
            rawQueue = [];
        }
    }
    return migrateQueueToV2(rawQueue) as unknown as EvolutionQueueItem[];
}

/**
 * Atomically write the queue to disk.
 */
export function saveEvolutionQueue(queuePath: string, queue: EvolutionQueueItem[]): void {
    atomicWriteFileSync(queuePath, JSON.stringify(queue, null, 2));
}
