/**
 * Failure Classifier -- Pure stateless classification of task failure patterns
 * ===========================================================
 *
 * Classifies consecutive task failures from the evolution queue as transient
 * or persistent. This module is pure (no file I/O) and testable in isolation.
 *
 * The classifier reads the evolution queue to count consecutive failures per
 * task kind. When the count reaches the configured threshold (default 3),
 * the pattern is classified as "persistent" and the cooldown strategy should
 * be invoked.
 *
 * IMPORTANT: Only `status === 'failed'` counts as a failure.
 * `status === 'completed'` (including stub_fallback and skipped_thin_violation
 * resolutions) counts as a success and breaks the consecutive failure chain.
 */

import type { EvolutionQueueItem } from './evolution-worker.js';

/** Task kinds subject to failure classification.
 *  Only sleep_reflection and keyword_optimization have outcome handling in
 *  evolution-worker.ts. pain_diagnosis and model_eval are excluded. */
export type ClassifiableTaskKind = 'sleep_reflection' | 'keyword_optimization';

export interface FailureClassificationResult {
    /** Whether the failure pattern is transient or persistent */
    classification: 'transient' | 'persistent';
    /** Number of consecutive failures for this task kind */
    consecutiveFailures: number;
    /** The task kind that was analyzed */
    taskKind: ClassifiableTaskKind;
}

/**
 * Classify the failure pattern for a given task kind based on recent task
 * outcomes in the evolution queue.
 *
 * Algorithm:
 * 1. Filter queue to tasks of the specified taskKind with status 'completed' or 'failed'
 * 2. Sort by completed_at (or timestamp fallback) descending (newest first)
 * 3. Count consecutive 'failed' tasks from the top
 * 4. First non-'failed' task (i.e., 'completed') breaks the chain
 * 5. If consecutive count >= threshold, classify as 'persistent'
 *
 * @param queue - Current evolution queue (array of EvolutionQueueItem)
 * @param taskKind - Task kind to classify
 * @param threshold - Consecutive failure threshold for "persistent" (default: 3)
 * @returns FailureClassificationResult
 */
export function classifyFailure(
    queue: EvolutionQueueItem[],
    taskKind: ClassifiableTaskKind,
    threshold: number = 3,
): FailureClassificationResult {
    // Filter to this task kind, only terminal states (completed or failed)
    const relevantTasks = queue
        .filter(t => t.taskKind === taskKind)
        .filter(t => t.status === 'completed' || t.status === 'failed')
        .sort((a, b) => {
            const aTime = new Date(a.completed_at || a.timestamp).getTime();
            const bTime = new Date(b.completed_at || b.timestamp).getTime();
            return bTime - aTime; // newest first
        });

    let consecutive = 0;
    for (const task of relevantTasks) {
        if (task.status === 'failed') {
            consecutive++;
        } else {
            break; // completed (any resolution including stub_fallback) breaks the chain
        }
    }

    return {
        classification: consecutive >= threshold ? 'persistent' : 'transient',
        consecutiveFailures: consecutive,
        taskKind,
    };
}
