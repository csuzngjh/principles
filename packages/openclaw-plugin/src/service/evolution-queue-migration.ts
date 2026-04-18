/**
 * Evolution Queue Migration — V1 to V2 Schema
 *
 * Pure transformation functions and shared queue types.
 */

import type { TaskKind, TaskPriority } from '../core/trajectory-types.js';

// Re-export TaskKind and TaskPriority for convenience
export type { TaskKind, TaskPriority } from '../core/trajectory-types.js';

/**
 * Queue item status values.
 */
export type QueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';

/**
 * Task resolution strings.
 */
export type TaskResolution =
    | 'marker_detected'
    | 'auto_completed_timeout'
    | 'failed_max_retries'
    | 'runtime_unavailable'
    | 'canceled'
    | 'late_marker_principle_created'
    | 'late_marker_no_principle'
    | 'stub_fallback'
    | 'skipped_thin_violation'
    | 'noise_classified';

/**
 * Recent pain context for sleep_reflection tasks.
 * Attached to queue items to provide pain signal context.
 */
export interface RecentPainContext {
    mostRecent: { score: number; source: string; reason: string; timestamp: string; sessionId: string } | null;
    recentPainCount: number;
    recentMaxPainScore: number;
}

/**
 * Default values for new V2 fields when migrating legacy items.
 */
export const DEFAULT_TASK_KIND: TaskKind = 'pain_diagnosis';
export const DEFAULT_PRIORITY: TaskPriority = 'medium';
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Legacy (pre-V2) queue item schema.
 */
export interface LegacyEvolutionQueueItem {
    id: string;
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
    status?: string;
    resolution?: string;
    session_id?: string;
    agent_id?: string;
    taskKind?: string;
    priority?: string;
    retryCount?: number;
    maxRetries?: number;
    lastError?: string;
    resultRef?: string;
}

/**
 * V2 queue item schema.
 */
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
    recentPainContext?: RecentPainContext;
}

export type RawQueueItem = Record<string, unknown>;

/**
 * Migrate a legacy queue item to V2 schema.
 * Old items without taskKind are assumed to be pain_diagnosis for backward compatibility.
 */
export function migrateToV2(item: LegacyEvolutionQueueItem): {
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
} {
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
 */
export function migrateQueueToV2(queue: RawQueueItem[]): ReturnType<typeof migrateToV2>[] {
    return queue.map(item => isLegacyQueueItem(item) ? migrateToV2(item as unknown as LegacyEvolutionQueueItem) : item as unknown as ReturnType<typeof migrateToV2>);
}
