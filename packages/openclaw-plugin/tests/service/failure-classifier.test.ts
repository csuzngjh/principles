import { describe, it, expect } from 'vitest';
import { classifyFailure, type ClassifiableTaskKind, type FailureClassificationResult } from '../../src/service/failure-classifier.js';
import type { EvolutionQueueItem } from '../../src/service/evolution-worker.js';

function makeItem(overrides: Partial<EvolutionQueueItem> & { taskKind: ClassifiableTaskKind }): EvolutionQueueItem {
    const base: EvolutionQueueItem = {
        id: `task-${Math.random().toString(36).slice(2, 8)}`,
        taskKind: overrides.taskKind,
        priority: 'medium',
        source: 'test',
        score: 0,
        reason: 'test',
        timestamp: new Date().toISOString(),
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
    };
    return { ...base, ...overrides } as EvolutionQueueItem;
}

describe('failure-classifier', () => {
    describe('classifyFailure', () => {
        it('returns transient with 0 failures', () => {
            const result = classifyFailure([], 'sleep_reflection');
            expect(result.classification).toBe('transient');
            expect(result.consecutiveFailures).toBe(0);
        });

        it('returns transient with 1 consecutive failure', () => {
            const queue = [makeItem({ taskKind: 'sleep_reflection', status: 'failed' })];
            const result = classifyFailure(queue, 'sleep_reflection');
            expect(result.classification).toBe('transient');
            expect(result.consecutiveFailures).toBe(1);
        });

        it('returns transient with 2 consecutive failures', () => {
            const queue = [
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:02:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:01:00Z' }),
            ];
            const result = classifyFailure(queue, 'sleep_reflection');
            expect(result.classification).toBe('transient');
            expect(result.consecutiveFailures).toBe(2);
        });

        it('returns persistent with 3 consecutive failures', () => {
            const queue = [
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:03:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:02:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:01:00Z' }),
            ];
            const result = classifyFailure(queue, 'sleep_reflection');
            expect(result.classification).toBe('persistent');
            expect(result.consecutiveFailures).toBe(3);
        });

        it('returns persistent with 5 consecutive failures with correct count', () => {
            const queue = Array.from({ length: 5 }, (_, i) =>
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: `2026-04-14T10:0${5 - i}:00Z` }),
            );
            const result = classifyFailure(queue, 'sleep_reflection');
            expect(result.classification).toBe('persistent');
            expect(result.consecutiveFailures).toBe(5);
        });

        it('returns transient when failure chain broken by success', () => {
            const queue = [
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:03:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'completed', completed_at: '2026-04-14T10:02:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:01:00Z' }),
            ];
            const result = classifyFailure(queue, 'sleep_reflection');
            expect(result.classification).toBe('transient');
            expect(result.consecutiveFailures).toBe(1);
        });

        it('sleep_reflection ignores keyword_optimization failures', () => {
            const queue = [
                makeItem({ taskKind: 'keyword_optimization', status: 'failed', completed_at: '2026-04-14T10:03:00Z' }),
                makeItem({ taskKind: 'keyword_optimization', status: 'failed', completed_at: '2026-04-14T10:02:00Z' }),
                makeItem({ taskKind: 'keyword_optimization', status: 'failed', completed_at: '2026-04-14T10:01:00Z' }),
            ];
            const result = classifyFailure(queue, 'sleep_reflection');
            expect(result.classification).toBe('transient');
            expect(result.consecutiveFailures).toBe(0);
        });

        it('keyword_optimization ignores sleep_reflection failures', () => {
            const queue = [
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:03:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:02:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:01:00Z' }),
            ];
            const result = classifyFailure(queue, 'keyword_optimization');
            expect(result.classification).toBe('transient');
            expect(result.consecutiveFailures).toBe(0);
        });

        it('supports custom threshold=5: transient at 4, persistent at 5', () => {
            const queue4 = Array.from({ length: 4 }, (_, i) =>
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: `2026-04-14T10:${String(4 - i).padStart(2, '0')}:00Z` }),
            );
            const result4 = classifyFailure(queue4, 'sleep_reflection', 5);
            expect(result4.classification).toBe('transient');
            expect(result4.consecutiveFailures).toBe(4);

            const queue5 = [...queue4, makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:00:00Z' })];
            const result5 = classifyFailure(queue5, 'sleep_reflection', 5);
            expect(result5.classification).toBe('persistent');
            expect(result5.consecutiveFailures).toBe(5);
        });

        it('ignores pending and in_progress tasks', () => {
            const queue = [
                makeItem({ taskKind: 'sleep_reflection', status: 'pending' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'in_progress' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:01:00Z' }),
            ];
            const result = classifyFailure(queue, 'sleep_reflection');
            expect(result.consecutiveFailures).toBe(1);
            expect(result.classification).toBe('transient');
        });

        it('treats completed with stub_fallback resolution as success (chain breaker)', () => {
            const queue = [
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:03:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'completed', resolution: 'stub_fallback', completed_at: '2026-04-14T10:02:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:01:00Z' }),
            ];
            const result = classifyFailure(queue, 'sleep_reflection');
            expect(result.classification).toBe('transient');
            expect(result.consecutiveFailures).toBe(1);
        });

        it('treats completed with skipped_thin_violation resolution as success (chain breaker)', () => {
            const queue = [
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:03:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'completed', resolution: 'skipped_thin_violation', completed_at: '2026-04-14T10:02:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:01:00Z' }),
            ];
            const result = classifyFailure(queue, 'sleep_reflection');
            expect(result.classification).toBe('transient');
            expect(result.consecutiveFailures).toBe(1);
        });

        it('returns transient with consecutiveFailures=0 for empty queue', () => {
            const result = classifyFailure([], 'keyword_optimization');
            expect(result.classification).toBe('transient');
            expect(result.consecutiveFailures).toBe(0);
            expect(result.taskKind).toBe('keyword_optimization');
        });

        it('counts independently per task kind in mixed queue', () => {
            const queue = [
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:05:00Z' }),
                makeItem({ taskKind: 'keyword_optimization', status: 'failed', completed_at: '2026-04-14T10:04:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:03:00Z' }),
                makeItem({ taskKind: 'keyword_optimization', status: 'failed', completed_at: '2026-04-14T10:02:00Z' }),
                makeItem({ taskKind: 'sleep_reflection', status: 'failed', completed_at: '2026-04-14T10:01:00Z' }),
            ];

            const srResult = classifyFailure(queue, 'sleep_reflection');
            expect(srResult.classification).toBe('persistent');
            expect(srResult.consecutiveFailures).toBe(3);

            const koResult = classifyFailure(queue, 'keyword_optimization');
            expect(koResult.classification).toBe('transient');
            expect(koResult.consecutiveFailures).toBe(2);
        });
    });
});
