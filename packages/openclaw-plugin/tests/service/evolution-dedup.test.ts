/**
 * Unit tests for evolution-dedup.ts — pure deduplication logic.
 * No I/O, no timers needed for the core logic.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
    findRecentDuplicateTask,
    hasRecentDuplicateTask,
    hasEquivalentPromotedRule,
    PAIN_QUEUE_DEDUP_WINDOW_MS,
} from '../../src/service/evolution-dedup.js';
import type { EvolutionQueueItem } from '../../src/core/evolution-types.js';

function makeTask(overrides: Partial<EvolutionQueueItem> & { id: string; timestamp: string; status: EvolutionQueueItem['status'] }): EvolutionQueueItem {
    return {
        id: 'default-id',
        taskKind: 'pain_diagnosis',
        priority: 'medium',
        score: 50,
        source: 'tool_failure',
        reason: 'Default reason',
        timestamp: '2026-04-10T00:00:00.000Z',
        enqueued_at: '2026-04-10T00:00:00.000Z',
        trigger_text_preview: 'Default',
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
        ...overrides,
    } as EvolutionQueueItem;
}

describe('PAIN_QUEUE_DEDUP_WINDOW_MS', () => {
    it('is 30 minutes (1800000 ms)', () => {
        expect(PAIN_QUEUE_DEDUP_WINDOW_MS).toBe(30 * 60 * 1000);
    });
});

describe('findRecentDuplicateTask', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns the matching task when source/preview/reason match within window', () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const existing = makeTask({
            id: 'match-001',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: 'permission denied',
            timestamp: tenMinutesAgo,
            enqueued_at: tenMinutesAgo,
            status: 'pending',
        });

        const queue = [existing];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

        expect(result).toBeDefined();
        expect(result?.id).toBe('match-001');
    });

    it('returns undefined when no match found', () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const existing = makeTask({
            id: 'no-match-001',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: 'permission denied',
            timestamp: tenMinutesAgo,
            enqueued_at: tenMinutesAgo,
            status: 'pending',
        });

        const queue = [existing];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'user_frustration', 'Something else', now, 'different');

        expect(result).toBeUndefined();
    });

    it('returns undefined for completed tasks (skips completed status)', () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const completedTask = makeTask({
            id: 'completed-001',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: 'permission denied',
            timestamp: tenMinutesAgo,
            enqueued_at: tenMinutesAgo,
            status: 'completed',
            resolution: 'success',
        });

        const queue = [completedTask];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

        expect(result).toBeUndefined();
    });

    it('skips tasks older than the dedup window', () => {
        const fortyMinutesAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString();
        const oldTask = makeTask({
            id: 'old-001',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: 'permission denied',
            timestamp: fortyMinutesAgo,
            enqueued_at: fortyMinutesAgo,
            status: 'pending',
        });

        const queue = [oldTask];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

        expect(result).toBeUndefined();
    });

    it('handles tasks with only timestamp (no enqueued_at)', () => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const task = makeTask({
            id: 'ts-only-001',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: 'permission denied',
            timestamp: fiveMinutesAgo,
            enqueued_at: undefined,
            status: 'pending',
        });

        const queue = [task];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

        expect(result).toBeDefined();
        expect(result?.id).toBe('ts-only-001');
    });

    it('handles tasks with invalid timestamp gracefully', () => {
        const task = makeTask({
            id: 'invalid-ts-001',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: 'permission denied',
            timestamp: 'not-a-valid-date',
            enqueued_at: undefined,
            status: 'pending',
        });

        const queue = [task];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

        expect(result).toBeUndefined();
    });

    it('returns the first match when multiple duplicates exist', () => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const first = makeTask({
            id: 'first-match',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: 'permission denied',
            timestamp: fifteenMinutesAgo,
            enqueued_at: fifteenMinutesAgo,
            status: 'pending',
        });
        const second = makeTask({
            id: 'second-match',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: 'permission denied',
            timestamp: fiveMinutesAgo,
            enqueued_at: fiveMinutesAgo,
            status: 'in_progress',
        });

        const queue = [first, second];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

        expect(result).toBeDefined();
        expect(result?.id).toBe('first-match');
    });

    it('normalizes case and whitespace in dedup key', () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const existing = makeTask({
            id: 'case-norm-001',
            source: 'TOOL_FAILURE',
            trigger_text_preview: '  File Write Failed  ',
            reason: '  PERMISSION DENIED  ',
            timestamp: tenMinutesAgo,
            enqueued_at: tenMinutesAgo,
            status: 'pending',
        });

        const queue = [existing];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

        expect(result).toBeDefined();
        expect(result?.id).toBe('case-norm-001');
    });

    it('works without reason parameter (empty reason matches empty task reason)', () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const existing = makeTask({
            id: 'no-reason-001',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: '',
            timestamp: tenMinutesAgo,
            enqueued_at: tenMinutesAgo,
            status: 'pending',
        });

        const queue = [existing];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now);

        expect(result).toBeDefined();
        expect(result?.id).toBe('no-reason-001');
    });

    it('truncates very long source strings to prevent memory/performance issues', () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const longSource = 'a'.repeat(500) + 'tool_failure' + 'b'.repeat(500);
        const longPreview = 'x'.repeat(500) + 'File write failed' + 'y'.repeat(500);
        const existing = makeTask({
            id: 'long-src-001',
            source: longSource,
            trigger_text_preview: longPreview,
            reason: 'permission denied',
            timestamp: tenMinutesAgo,
            enqueued_at: tenMinutesAgo,
            status: 'pending',
        });

        const queue = [existing];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, longSource, longPreview, now, 'permission denied');

        expect(result).toBeDefined();
        expect(result?.id).toBe('long-src-001');
    });

    it('returns undefined for empty queue', () => {
        const queue: EvolutionQueueItem[] = [];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

        expect(result).toBeUndefined();
    });

    it('matches in_progress and pending status tasks (not just pending)', () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const inProgress = makeTask({
            id: 'in-progress-001',
            source: 'gate_block',
            trigger_text_preview: 'Score below threshold',
            reason: 'threshold_violation',
            timestamp: tenMinutesAgo,
            enqueued_at: tenMinutesAgo,
            status: 'in_progress',
        });

        const queue = [inProgress];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'gate_block', 'Score below threshold', now, 'threshold_violation');

        expect(result).toBeDefined();
        expect(result?.id).toBe('in-progress-001');
    });

    it('truncates reason to 50 characters for dedup key', () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const longReason1 = 'x'.repeat(60) + 'suffix-a';
        const longReason2 = 'x'.repeat(60) + 'suffix-b';
        const existing = makeTask({
            id: 'reason-trunc-001',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: longReason1,
            timestamp: tenMinutesAgo,
            enqueued_at: tenMinutesAgo,
            status: 'pending',
        });

        const queue = [existing];
        const now = Date.now();

        const result = findRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, longReason2);

        expect(result).toBeDefined();
        expect(result?.id).toBe('reason-trunc-001');
    });
});

describe('hasRecentDuplicateTask', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns true when findRecentDuplicateTask would return a task', () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const existing = makeTask({
            id: 'bool-true-001',
            source: 'tool_failure',
            trigger_text_preview: 'File write failed',
            reason: 'permission denied',
            timestamp: tenMinutesAgo,
            enqueued_at: tenMinutesAgo,
            status: 'pending',
        });

        const queue = [existing];
        const now = Date.now();

        expect(hasRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied')).toBe(true);
    });

    it('returns false when findRecentDuplicateTask would return undefined', () => {
        const queue: EvolutionQueueItem[] = [];
        const now = Date.now();

        expect(hasRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied')).toBe(false);
    });
});

describe('hasEquivalentPromotedRule', () => {
    function createMockDictionary(rules: Record<string, { type: string; phrases?: string[]; pattern?: string; status: string }>) {
        return {
            getAllRules: () => rules,
        };
    }

    it('returns true when exact_match rule has matching phrase', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'exact_match',
                phrases: ['always verify backup before delete', 'never skip validation'],
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'always verify backup before delete')).toBe(true);
    });

    it('returns false when no rule matches the phrase', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'exact_match',
                phrases: ['always verify backup before delete'],
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'never skip validation')).toBe(false);
    });

    it('returns false for inactive rules', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'exact_match',
                phrases: ['always verify backup before delete'],
                status: 'inactive',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'always verify backup before delete')).toBe(false);
    });

    it('returns false for archived rules', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'exact_match',
                phrases: ['always verify backup before delete'],
                status: 'archived',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'always verify backup before delete')).toBe(false);
    });

    it('matches case-insensitively', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'exact_match',
                phrases: ['Always Verify Backup Before Delete'],
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'always verify backup before delete')).toBe(true);
    });

    it('matches with trimmed whitespace', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'exact_match',
                phrases: ['  always verify backup before delete  '],
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'always verify backup before delete')).toBe(true);
    });

    it('returns true when regex rule has matching pattern string', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'regex',
                pattern: 'file.*delete',
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'file.*delete')).toBe(true);
    });

    it('returns false when regex rule pattern does not match (exact string comparison)', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'regex',
                pattern: 'file.*delete',
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'file delete')).toBe(false);
    });

    it('returns false for rules with unknown type', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'unknown_type',
                phrases: ['always verify backup before delete'],
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'always verify backup before delete')).toBe(false);
    });

    it('returns false for empty dictionary', () => {
        const dict = createMockDictionary({});

        expect(hasEquivalentPromotedRule(dict, 'always verify backup before delete')).toBe(false);
    });

    it('checks multiple rules and returns true if any matches', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'exact_match',
                phrases: ['first rule phrase'],
                status: 'active',
            },
            'rule-2': {
                type: 'exact_match',
                phrases: ['second rule phrase'],
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'second rule phrase')).toBe(true);
    });

    it('exact_match rule without phrases array returns false', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'exact_match',
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'some phrase')).toBe(false);
    });

    it('regex rule without pattern string returns false', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'regex',
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, 'some pattern')).toBe(false);
    });

    it('handles empty phrase input', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'exact_match',
                phrases: [''],
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, '')).toBe(true);
    });

    it('handles phrase with only whitespace', () => {
        const dict = createMockDictionary({
            'rule-1': {
                type: 'exact_match',
                phrases: ['   '],
                status: 'active',
            },
        });

        expect(hasEquivalentPromotedRule(dict, '   ')).toBe(true);
    });
});
