/**
 * Unit tests for queue-migration.ts — pure data transformation functions.
 * No I/O, no timers needed.
 */

import { describe, expect, it } from 'vitest';
import {
    migrateToV2,
    isLegacyQueueItem,
    migrateQueueToV2,
    LegacyEvolutionQueueItem,
    DEFAULT_TASK_KIND,
    DEFAULT_PRIORITY,
    DEFAULT_MAX_RETRIES,
} from '../../src/service/queue-migration.js';

describe('isLegacyQueueItem', () => {
    it('returns false for V2 item with taskKind', () => {
        expect(isLegacyQueueItem({ id: 'x', taskKind: 'pain_diagnosis' })).toBe(false);
    });

    it('returns true for legacy item without taskKind', () => {
        expect(isLegacyQueueItem({ id: 'x', score: 50, source: 'test' })).toBe(true);
    });

    it('returns false/falsy for null', () => {
        expect(isLegacyQueueItem(null as any)).toBeFalsy();
    });

    it('returns true for empty object (no taskKind)', () => {
        expect(isLegacyQueueItem({})).toBe(true);
    });
});

describe('migrateToV2 defaults', () => {
    it('applies DEFAULT_TASK_KIND, DEFAULT_PRIORITY, DEFAULT_MAX_RETRIES for minimal legacy item', () => {
        const legacy: LegacyEvolutionQueueItem = {
            id: 'item-1',
            score: 75,
            source: 'tool_failure',
            reason: 'Tool write failed',
            timestamp: '2026-04-10T08:30:00.000Z',
        };
        const result = migrateToV2(legacy);
        expect(result.taskKind).toBe(DEFAULT_TASK_KIND);
        expect(result.priority).toBe(DEFAULT_PRIORITY);
        expect(result.maxRetries).toBe(DEFAULT_MAX_RETRIES);
        expect(result.retryCount).toBe(0);
    });

    it('preserves existing taskKind, priority, maxRetries when provided', () => {
        const legacy: LegacyEvolutionQueueItem = {
            id: 'item-2',
            taskKind: 'sleep_reflection',
            priority: 'high',
            maxRetries: 5,
            score: 80,
            source: 'user_frustration',
            reason: 'User corrected the agent',
            timestamp: '2026-04-11T10:00:00.000Z',
        };
        const result = migrateToV2(legacy);
        expect(result.taskKind).toBe('sleep_reflection');
        expect(result.priority).toBe('high');
        expect(result.maxRetries).toBe(5);
    });

    it('preserves all optional fields through migration', () => {
        const legacy: LegacyEvolutionQueueItem = {
            id: 'item-3',
            task: 'Diagnose pain',
            score: 90,
            source: 'pain_signal',
            reason: 'Test pain',
            timestamp: '2026-04-12T00:00:00.000Z',
            enqueued_at: '2026-04-12T00:00:01.000Z',
            started_at: '2026-04-12T00:05:00.000Z',
            completed_at: '2026-04-12T00:10:00.000Z',
            assigned_session_key: 'session-key-123',
            trigger_text_preview: 'Some trigger text',
            status: 'completed',
            resolution: 'success',
            session_id: 'session-456',
            agent_id: 'agent-789',
            traceId: 'trace-abc',
            taskKind: 'keyword_optimization',
            priority: 'low',
            retryCount: 2,
            maxRetries: 4,
            lastError: undefined,
            resultRef: 'result-ref-001',
        };
        const result = migrateToV2(legacy);
        expect(result.id).toBe('item-3');
        expect(result.task).toBe('Diagnose pain');
        expect(result.score).toBe(90);
        expect(result.source).toBe('pain_signal');
        expect(result.enqueued_at).toBe('2026-04-12T00:00:01.000Z');
        expect(result.started_at).toBe('2026-04-12T00:05:00.000Z');
        expect(result.completed_at).toBe('2026-04-12T00:10:00.000Z');
        expect(result.assigned_session_key).toBe('session-key-123');
        expect(result.trigger_text_preview).toBe('Some trigger text');
        expect(result.status).toBe('completed');
        expect(result.resolution).toBe('success');
        expect(result.session_id).toBe('session-456');
        expect(result.agent_id).toBe('agent-789');
        expect(result.traceId).toBe('trace-abc');
        expect(result.taskKind).toBe('keyword_optimization');
        expect(result.priority).toBe('low');
        expect(result.retryCount).toBe(2);
        expect(result.maxRetries).toBe(4);
        expect(result.lastError).toBeUndefined();
        expect(result.resultRef).toBe('result-ref-001');
    });
});

describe('migrateQueueToV2', () => {
    it('migrates array with mixed legacy and V2 items correctly', () => {
        const queue = [
            { id: 'legacy-1', score: 50, source: 'a', reason: 'r', timestamp: '2026-04-01T00:00:00.000Z' },
            { id: 'v2-1', taskKind: 'sleep_reflection', priority: 'high', source: 'b', score: 60, reason: 'r', timestamp: '2026-04-01T00:00:00.000Z' },
            { id: 'legacy-2', score: 70, source: 'c', reason: 'r', timestamp: '2026-04-01T00:00:00.000Z' },
        ];
        const result = migrateQueueToV2(queue as any);
        expect(result[0].taskKind).toBe('pain_diagnosis'); // migrated
        expect(result[1].taskKind).toBe('sleep_reflection'); // V2 unchanged
        expect(result[2].taskKind).toBe('pain_diagnosis'); // migrated
        expect(result[0].priority).toBe('medium');
        expect(result[1].priority).toBe('high');
        expect(result[2].priority).toBe('medium');
    });

    it('returns V2 items unchanged (as EvolutionQueueItem[])', () => {
        const v2Items = [
            { id: 'v2-1', taskKind: 'pain_diagnosis', priority: 'medium', source: 'a', score: 55, reason: 'r', timestamp: '2026-04-01T00:00:00.000Z', status: 'pending', retryCount: 0, maxRetries: 3 },
            { id: 'v2-2', taskKind: 'sleep_reflection', priority: 'high', source: 'b', score: 65, reason: 'r', timestamp: '2026-04-01T00:00:00.000Z', status: 'in_progress', retryCount: 1, maxRetries: 3 },
        ];
        const result = migrateQueueToV2(v2Items as any);
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('v2-1');
        expect(result[1].id).toBe('v2-2');
    });

    it('returns empty array for empty input', () => {
        expect(migrateQueueToV2([])).toHaveLength(0);
    });
});
