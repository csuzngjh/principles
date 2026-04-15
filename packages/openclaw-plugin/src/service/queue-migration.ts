/**
 * Queue Migration — extracted from evolution-worker.ts (lines 297-379)
 *
 * Pure data transformation functions for migrating legacy queue items
 * to the V2 schema. Zero I/O, zero imports from evolution-worker.ts.
 */

import type { TaskKind, TaskPriority } from '../core/trajectory-types.js';

// V2 types (not exported from evolution-types.ts — defined here for self-containment)
export type QueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type TaskResolution = 'success' | 'failure' | 'skipped';
export interface EvolutionQueueItem {
    id: string;
    taskKind: TaskKind;
    priority: TaskPriority;
    source: string;
    traceId?: string;
    task?: string;
    score: number;
    reason: string;
    timestamp: string;
    enqueued_at?: string;
    started_at?: string;
    completed_at?: string;
    assigned_session_key?: string;
    trigger_text_preview?: string;
    status: QueueStatus;
    resolution?: TaskResolution;
    session_id?: string;
    agent_id?: string;
    retryCount: number;
    maxRetries: number;
    lastError?: string;
    resultRef?: string;
}

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

type RawQueueItem = Record<string, unknown>;

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
