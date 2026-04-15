/**
 * Evolution Queue Deduplication Utilities
 *
 * Dedup logic for preventing duplicate pain tasks and redundant reflections.
 * Extracted from evolution-worker.ts.
 */

import type { EvolutionQueueItem } from './evolution-queue-migration.js';

/**
 * Dedup window for pain queue tasks (30 minutes).
 */
export const PAIN_QUEUE_DEDUP_WINDOW_MS = 30 * 60 * 1000;

function normalizePainDedupKey(source: string, preview: string, reason?: string): string {
    const normalizedReason = (reason || '').trim().toLowerCase();
    return `${source.trim().toLowerCase()}::${preview.trim().toLowerCase()}::${normalizedReason}`;
}

export function findRecentDuplicateTask(
    queue: EvolutionQueueItem[],
    source: string,
    preview: string,
    now: number,
    reason?: string
): EvolutionQueueItem | undefined {
    const key = normalizePainDedupKey(source, preview, reason);
    return queue.find((task) => {
        if (task.status === 'completed') return false;
        const taskTime = new Date(task.enqueued_at || task.timestamp).getTime();
        if (!Number.isFinite(taskTime) || (now - taskTime) > PAIN_QUEUE_DEDUP_WINDOW_MS) return false;
        return normalizePainDedupKey(task.source, task.trigger_text_preview || '', task.reason) === key;
    });
}

/**
 * Check if a similar pain task was enqueued recently.
 */
export function hasRecentDuplicateTask(
    queue: EvolutionQueueItem[],
    source: string,
    preview: string,
    now: number,
    reason?: string
): boolean {
    return !!findRecentDuplicateTask(queue, source, preview, now, reason);
}

/**
 * Check if a phrase matches an active promoted rule.
 */
export function hasEquivalentPromotedRule(
    dictionary: { getAllRules(): Record<string, { type: string; phrases?: string[]; pattern?: string; status: string; }> },
    phrase: string
): boolean {
    const normalizedPhrase = phrase.trim().toLowerCase();
    return Object.values(dictionary.getAllRules()).some((rule) => {
        if (rule.status !== 'active') return false;
        if (rule.type === 'exact_match' && Array.isArray(rule.phrases)) {
            return rule.phrases.some((candidate) => candidate.trim().toLowerCase() === normalizedPhrase);
        }
        if (rule.type === 'regex' && typeof rule.pattern === 'string') {
            return rule.pattern.trim().toLowerCase() === normalizedPhrase;
        }
        return false;
    });
}
