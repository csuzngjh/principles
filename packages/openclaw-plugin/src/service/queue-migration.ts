/**
 * Queue Migration — extracted from evolution-worker.ts (lines 297-379)
 *
 * Pure data transformation functions for migrating legacy queue items
 * to the V2 schema. Zero I/O, zero imports from evolution-worker.ts.
 */

import type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
import type { QueueStatus, TaskResolution, EvolutionQueueItem } from '../core/evolution-types.js';

// V2 types — canonical definitions live in evolution-types.ts (single source of truth).
// Re-exported here for backward compatibility with existing importers.
export type { QueueStatus, TaskResolution, EvolutionQueueItem } from '../core/evolution-types.js';

/**
 * Legacy queue item shape (pre-V2) for migration compatibility.
 * These items lack taskKind, priority, retryCount, maxRetries, lastError fields.
 */
export interface LegacyEvolutionQueueItem {
    id: string;
    task?: string;
    score: number;
    source: string;
    reason: string;
    timestamp: string;
    enqueued_at?: string;
    started_at?: string;
    completed_at?: string;
    assigned_session_key?: string;
    trigger_text_preview?: string;
    status?: string;
    resolution?: string;
    session_id?: string;
    agent_id?: string;
    traceId?: string;
    taskKind?: string;
    priority?: string;
    retryCount?: number;
    maxRetries?: number;
    lastError?: string;
    resultRef?: string;
}

/**
 * Default values for new V2 fields when migrating legacy items.
 */
const DEFAULT_TASK_KIND: TaskKind = 'pain_diagnosis';
const DEFAULT_PRIORITY: TaskPriority = 'medium';
const DEFAULT_MAX_RETRIES = 3;

export { DEFAULT_TASK_KIND, DEFAULT_PRIORITY, DEFAULT_MAX_RETRIES };

export type RawQueueItem = Record<string, unknown>;

/**
 * Migrate a legacy queue item to V2 schema.
 * Old items without taskKind are assumed to be pain_diagnosis for backward compatibility.
 */
export function migrateToV2(item: LegacyEvolutionQueueItem): EvolutionQueueItem {
    return {
        id: item.id,
        taskKind: (item.taskKind as TaskKind) || DEFAULT_TASK_KIND,
        priority: (item.priority as TaskPriority) || DEFAULT_PRIORITY,
        source: item.source,
        traceId: item.traceId,
        task: item.task,
        score: item.score,
        reason: item.reason,
        timestamp: item.timestamp,
        enqueued_at: item.enqueued_at,
        started_at: item.started_at,
        completed_at: item.completed_at,
        assigned_session_key: item.assigned_session_key,
        trigger_text_preview: item.trigger_text_preview,
        status: (item.status as QueueStatus) || 'pending',
        resolution: item.resolution as TaskResolution | undefined,
        session_id: item.session_id,
        agent_id: item.agent_id,
        retryCount: item.retryCount || 0,
        maxRetries: item.maxRetries || DEFAULT_MAX_RETRIES,
        lastError: item.lastError,
        resultRef: item.resultRef,
    };
}

/**
 * Check if an item is a legacy (pre-V2) queue item.
 */
export function isLegacyQueueItem(item: RawQueueItem): boolean {
    return item && typeof item === 'object' && !('taskKind' in item);
}

/**
 * Migrate entire queue to V2 schema if needed.
 * Returns a new array with all items migrated to V2 format.
 */
export function migrateQueueToV2(queue: RawQueueItem[]): EvolutionQueueItem[] {
    return queue.map(item => isLegacyQueueItem(item) ? migrateToV2(item as unknown as LegacyEvolutionQueueItem) : item as unknown as EvolutionQueueItem);
}

// ── Validation (rc-1/rc-2, rc-4: validate array elements from untrusted JSON) ─

/**
 * Canonical set of valid taskKind values. Single source of truth — mirrors
 * TaskKind in trajectory-types.ts. Previously the inline validator in
 * evolution-worker.ts hard-coded `['model_eval']`, which silently rejected
 * three legitimate taskKind values (pain_diagnosis / sleep_reflection /
 * keyword_optimization). Keep this in sync with TaskKind.
 */
export const VALID_TASK_KINDS: readonly TaskKind[] = [
    'pain_diagnosis',
    'sleep_reflection',
    'model_eval',
    'keyword_optimization',
] as const;

/**
 * Validate a single queue item loaded from untrusted disk JSON.
 *
 * Returns an array of human-readable error reasons; an empty array means the
 * item is valid. Use {@link isValidQueueItem} for a type-guard form.
 *
 * This consolidates the inline validation that lived in processEvolutionQueue
 * (evolution-worker.ts) so every queue load path (loadEvolutionQueue,
 * registerEvolutionTaskSession) applies the same filter. rc-4 (ERR-007):
 * array elements from parsed JSON must be element-wise validated.
 */
export function validateQueueItem(item: unknown): string[] {
    const errors: string[] = [];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return ['item is not an object'];
    }
    const it = item as Record<string, unknown>;
    if (!it.id || typeof it.id !== 'string') errors.push('missing/invalid id');
    if (!it.source || typeof it.source !== 'string') errors.push('missing/invalid source');
    if (typeof it.score !== 'number') errors.push('missing/invalid score');
    if (!it.status || typeof it.status !== 'string') errors.push('missing/invalid status');
    if (!it.taskKind || typeof it.taskKind !== 'string') errors.push('missing/invalid taskKind');
    else if (!VALID_TASK_KINDS.includes(it.taskKind as TaskKind)) {
        errors.push(`invalid taskKind value '${it.taskKind}' (expected one of: ${VALID_TASK_KINDS.join(', ')})`);
    }
    if (typeof it.retryCount !== 'number') errors.push('missing/invalid retryCount');
    if (typeof it.maxRetries !== 'number') errors.push('missing/invalid maxRetries');
    return errors;
}

/**
 * Type-guard convenience over {@link validateQueueItem}.
 * Drops the reason strings (callers that need them should call validateQueueItem).
 */
export function isValidQueueItem(item: unknown): item is EvolutionQueueItem {
    return validateQueueItem(item).length === 0;
}
