/**
 * Unit tests for purgeStaleFailedTasks and hasRecentDuplicateTask.
 * Tests deduplication logic and 24-hour stale task cleanup.
 * Uses vi.useFakeTimers() per D-10.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  purgeStaleFailedTasks,
  hasRecentDuplicateTask,
} from '../../src/service/evolution-worker.js';
import type { EvolutionQueueItem } from '../../src/service/evolution-worker.js';

describe('purgeStaleFailedTasks', () => {
  let mockLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
      started_at: null,
      completed_at: null,
      assigned_session_key: null,
      trigger_text_preview: 'Default',
      status: 'pending',
      resolution: undefined,
      session_id: null,
      agent_id: null,
      traceId: 'trace-default',
      retryCount: 0,
      maxRetries: 3,
      lastError: undefined,
      resultRef: undefined,
      ...overrides,
    } as EvolutionQueueItem;
  }

  it('purges failed tasks older than 24 hours', () => {
    // 25 hours ago - should be purged
    const staleFailed = makeTask({
      id: 'stale-failed',
      timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      status: 'failed',
      lastError: 'timeout',
    });
    // 1 hour ago - should be kept
    const recentFailed = makeTask({
      id: 'recent-failed',
      timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      status: 'failed',
      lastError: 'timeout',
    });

    const queue = [staleFailed, recentFailed];
    const result = purgeStaleFailedTasks(queue, mockLogger);

    expect(result.purged).toBe(1);
    expect(result.remaining).toBe(1);
    expect(result.byReason['timeout']).toBe(1);
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe('recent-failed');
  });

  it('preserves non-failed tasks regardless of age', () => {
    const oldPending = makeTask({
      id: 'old-pending',
      timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      status: 'pending',
    });
    const oldInProgress = makeTask({
      id: 'old-in-progress',
      timestamp: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      status: 'in_progress',
    });
    const oldCompleted = makeTask({
      id: 'old-completed',
      timestamp: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
      status: 'completed',
      resolution: 'success',
    });

    const queue = [oldPending, oldInProgress, oldCompleted];
    const result = purgeStaleFailedTasks(queue, mockLogger);

    expect(result.purged).toBe(0);
    expect(result.remaining).toBe(3);
    expect(result.byReason).toEqual({});
  });

  it('returns accurate byReason breakdown', () => {
    const failedTimeout = makeTask({
      id: 'fail-timeout',
      timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      status: 'failed',
      lastError: 'timeout',
    });
    const failedAuth = makeTask({
      id: 'fail-auth',
      timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      status: 'failed',
      lastError: 'auth_error',
    });
    const failedBoth = makeTask({
      id: 'fail-both',
      timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      status: 'failed',
      lastError: 'timeout',
    });

    const queue = [failedTimeout, failedAuth, failedBoth];
    const result = purgeStaleFailedTasks(queue, mockLogger);

    expect(result.purged).toBe(3);
    expect(result.byReason['timeout']).toBe(2);
    expect(result.byReason['auth_error']).toBe(1);
  });

  it('handles queue with no failed tasks', () => {
    const pending = makeTask({
      id: 'pending-only',
      timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      status: 'pending',
    });

    const queue = [pending];
    const result = purgeStaleFailedTasks(queue, mockLogger);

    expect(result.purged).toBe(0);
    expect(result.remaining).toBe(1);
    expect(result.byReason).toEqual({});
  });

  it('handles empty queue', () => {
    const queue: EvolutionQueueItem[] = [];
    const result = purgeStaleFailedTasks(queue, mockLogger);

    expect(result.purged).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.byReason).toEqual({});
  });

  it('mutates queue in place (splice)', () => {
    const failed = makeTask({
      id: 'failed-to-purge',
      timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      status: 'failed',
      lastError: 'persist_error',
    });
    const keep = makeTask({
      id: 'keep-me',
      timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      status: 'in_progress',
    });

    const queue = [failed, keep];
    const originalLength = queue.length;

    purgeStaleFailedTasks(queue, mockLogger);

    // Queue was mutated in place
    expect(queue.length).toBeLessThan(originalLength);
    expect(queue.find(t => t.id === 'keep-me')).toBeDefined();
    expect(queue.find(t => t.id === 'failed-to-purge')).toBeUndefined();
  });
});

describe('hasRecentDuplicateTask', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
      started_at: null,
      completed_at: null,
      assigned_session_key: null,
      trigger_text_preview: 'Default',
      status: 'pending',
      resolution: undefined,
      session_id: null,
      agent_id: null,
      traceId: 'trace-default',
      retryCount: 0,
      maxRetries: 3,
      lastError: undefined,
      resultRef: undefined,
      ...overrides,
    } as EvolutionQueueItem;
  }

  it('returns true for matching source/preview/reason within 30-min window', () => {
    // PAIN_QUEUE_DEDUP_WINDOW_MS = 30 minutes, status must NOT be 'completed'
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const existing = makeTask({
      id: 'existing-001',
      source: 'tool_failure',
      trigger_text_preview: 'File write failed',
      reason: 'permission denied',
      timestamp: tenMinutesAgo,
      enqueued_at: tenMinutesAgo,
      status: 'pending', // hasRecentDuplicateTask skips 'completed'
    });

    const queue = [existing];
    const now = Date.now();

    const result = hasRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

    expect(result).toBe(true);
  });

  it('returns false for same source/preview but different reason', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const existing = makeTask({
      id: 'existing-002',
      source: 'tool_failure',
      trigger_text_preview: 'File write failed',
      reason: 'permission denied',
      timestamp: tenMinutesAgo,
      enqueued_at: tenMinutesAgo,
      status: 'pending', // hasRecentDuplicateTask skips 'completed'
    });

    const queue = [existing];
    const now = Date.now();

    // Same source and preview, but different reason
    const result = hasRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'disk full');

    expect(result).toBe(false);
  });

  it('returns false for item older than 30 min window', () => {
    // PAIN_QUEUE_DEDUP_WINDOW_MS = 30 minutes
    const fortyMinutesAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const oldTask = makeTask({
      id: 'old-duplicate',
      source: 'tool_failure',
      trigger_text_preview: 'File write failed',
      reason: 'permission denied',
      timestamp: fortyMinutesAgo,
      enqueued_at: fortyMinutesAgo,
      status: 'pending',
    });

    const queue = [oldTask];
    const now = Date.now();

    const result = hasRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

    expect(result).toBe(false);
  });

  it('returns false when queue is empty', () => {
    const queue: EvolutionQueueItem[] = [];
    const now = Date.now();

    const result = hasRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

    expect(result).toBe(false);
  });

  it('normalizes case and whitespace in dedup key', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const existing = makeTask({
      id: 'case-test',
      source: 'TOOL_FAILURE',
      trigger_text_preview: '  File write failed  ',
      reason: '  PERMISSION DENIED  ',
      timestamp: tenMinutesAgo,
      enqueued_at: tenMinutesAgo,
      status: 'pending', // hasRecentDuplicateTask skips 'completed'
    });

    const queue = [existing];
    const now = Date.now();

    // Different case/whitespace should still match
    const result = hasRecentDuplicateTask(queue, 'tool_failure', 'File write failed', now, 'permission denied');

    expect(result).toBe(true);
  });

  it('returns true when reason parameter matches task reason', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const existing = makeTask({
      id: 'reason-test',
      source: 'gate_block',
      trigger_text_preview: 'Score below threshold',
      reason: 'threshold_violation',
      timestamp: tenMinutesAgo,
      enqueued_at: tenMinutesAgo,
      status: 'in_progress', // hasRecentDuplicateTask skips 'completed'
      lastError: 'threshold_violation',
    });

    const queue = [existing];
    const now = Date.now();

    // Pass matching reason - should return true
    const result = hasRecentDuplicateTask(queue, 'gate_block', 'Score below threshold', now, 'threshold_violation');

    expect(result).toBe(true);
  });
});
