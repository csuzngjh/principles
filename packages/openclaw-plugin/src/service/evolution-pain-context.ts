/**
 * Evolution Pain Context Reader
 *
 * Reads and processes pain signal context for task enrichment.
 * Extracted from evolution-worker.ts.
 */

import type { WorkspaceContext } from '../core/workspace-context.js';
import { readPainFlagContract } from '../core/pain.js';
import type { EvolutionQueueItem } from './evolution-queue-migration.js';
import type { RecentPainContext } from './evolution-queue-migration.js';

/**
 * Read recent pain context from PAIN_FLAG file.
 * Extracts session_id to link to trajectory DB.
 * Returns structured pain metadata for attaching to sleep_reflection tasks.
 * Returns null if no pain flag exists.
 */
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

        if (score > 0) {
            return {
                mostRecent: { score, source, reason, timestamp, sessionId },
                recentPainCount: 1,
                recentMaxPainScore: score,
            };
        }
    } catch {
        // Best effort — non-fatal
    }

    return { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 };
}

/**
 * Build a dedup key from pain context.
 * Returns null when no pain context is available (bypasses dedup).
 */
export function buildPainSourceKey(
    painCtx: ReturnType<typeof readRecentPainContext>,
): string | null {
    if (!painCtx.mostRecent) return null;
    return `${painCtx.mostRecent.source}::${painCtx.mostRecent.reason?.slice(0, 50) ?? ''}`;
}

/**
 * Check whether a similar sleep_reflection task completed recently.
 * Phase 3c: Prevents redundant reflections of the same underlying issue.
 */
export function hasRecentSimilarReflection(
    queue: EvolutionQueueItem[],
    painSourceKey: string,
    now: number,
): EvolutionQueueItem | null {
    const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
    return queue.find((t) => {
        if (t.taskKind !== 'sleep_reflection') return false;
        // Only match completed tasks (exclude failed to allow retries)
        if (t.status !== 'completed') return false;
        if (!t.completed_at) return false;
        const age = now - new Date(t.completed_at).getTime();
        if (age > DEDUP_WINDOW_MS) return false;
        const taskPainKey = buildPainSourceKey(t.recentPainContext ?? { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 });
        // If either side has no pain context, they don't match
        if (!taskPainKey) return false;
        return taskPainKey === painSourceKey;
    }) ?? null;
}
