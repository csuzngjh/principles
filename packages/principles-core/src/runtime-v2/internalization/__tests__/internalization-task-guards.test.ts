import { describe, it, expect } from 'vitest';
import type { PITaskRecord, LineageRef } from '../peer-runner-contracts.js';
import type { TaskRecord } from '../../task-status.js';
import {
  canRetryNow,
  canAcquireLease,
  areDependenciesMet,
  canTransitionTo,
  isResultRefImmutable,
  canUpdateLastError,
  isArtifactRejected,
  isUnresolvable,
  recordRejection,
  isRetryWaitStale,
  DEFAULT_UNRESOLVABLE_THRESHOLD,
  DEFAULT_RETRY_WAIT_STALE_TTL_MS,
} from '../internalization-task-guards.js';

function makePITask(overrides: Partial<PITaskRecord> = {}): PITaskRecord {
  const {
    taskId = 'test-task',
    taskKind = 'dreamer',
    status = 'pending',
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
    leaseExpiresAt,
    attemptCount = 0,
    maxAttempts = 3,
    dependencyTaskIds = [],
    channel = 'prompt',
    timeoutMs = 60000,
    inputArtifactRefs = [],
    outputArtifactRefs = [],
  } = overrides;
  return {
    taskId,
    taskKind,
    status,
    createdAt,
    updatedAt,
    ...(leaseExpiresAt !== undefined && { leaseExpiresAt }),
    attemptCount,
    maxAttempts,
    dependencyTaskIds,
    channel,
    timeoutMs,
    inputArtifactRefs,
    outputArtifactRefs,
    ...('rejectionCount' in overrides
      ? { rejectionCount: overrides.rejectionCount }
      : { rejectionCount: 0 }),
  } as PITaskRecord;
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const {
    taskId = 'dep-task',
    status = 'succeeded',
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
    attemptCount = 0,
    maxAttempts = 3,
  } = overrides;
  return {
    taskId,
    status,
    createdAt,
    updatedAt,
    attemptCount,
    maxAttempts,
  } as TaskRecord;
}

describe('Internalization Task Guards (PRI-62)', () => {
  describe('canRetryNow', () => {
    it('returns true for non-retry_wait status', () => {
      expect(canRetryNow(makePITask({ status: 'pending' }))).toBe(true);
      expect(canRetryNow(makePITask({ status: 'leased' }))).toBe(true);
      expect(canRetryNow(makePITask({ status: 'succeeded' }))).toBe(true);
      expect(canRetryNow(makePITask({ status: 'failed' }))).toBe(true);
    });

    it('returns true for retry_wait with no leaseExpiresAt', () => {
      expect(canRetryNow(makePITask({ status: 'retry_wait', leaseExpiresAt: undefined }))).toBe(true);
    });

    it('returns true for retry_wait with expired leaseExpiresAt', () => {
      const nowMs = 1000000;
      const expiredTime = new Date(nowMs - 60000).toISOString();
      expect(canRetryNow(makePITask({ status: 'retry_wait', leaseExpiresAt: expiredTime }), nowMs)).toBe(true);
    });

    it('returns false for retry_wait with future leaseExpiresAt', () => {
      const nowMs = 1000000;
      const futureTime = new Date(nowMs + 60000).toISOString();
      expect(canRetryNow(makePITask({ status: 'retry_wait', leaseExpiresAt: futureTime }), nowMs)).toBe(false);
    });

    it('returns true for retry_wait with invalid leaseExpiresAt', () => {
      expect(canRetryNow(makePITask({ status: 'retry_wait', leaseExpiresAt: 'invalid-date' }))).toBe(true);
    });

    it('returns true for retry_wait at exact boundary (leaseExpiresAt === nowMs)', () => {
      const nowMs = 1000000;
      const exactTime = new Date(nowMs).toISOString();
      expect(canRetryNow(makePITask({ status: 'retry_wait', leaseExpiresAt: exactTime }), nowMs)).toBe(true);
    });
  });

  describe('canAcquireLease', () => {
    it('returns true for pending status', () => {
      expect(canAcquireLease(makePITask({ status: 'pending' }))).toBe(true);
    });

    it('returns true for retry_wait status', () => {
      expect(canAcquireLease(makePITask({ status: 'retry_wait' }))).toBe(true);
    });

    it('returns false for leased status', () => {
      expect(canAcquireLease(makePITask({ status: 'leased' }))).toBe(false);
    });

    it('returns false for succeeded status', () => {
      expect(canAcquireLease(makePITask({ status: 'succeeded' }))).toBe(false);
    });

    it('returns false for failed status', () => {
      expect(canAcquireLease(makePITask({ status: 'failed' }))).toBe(false);
    });
  });

  describe('areDependenciesMet', () => {
    it('returns true for empty dependencyTaskIds', () => {
      const task = makePITask({ dependencyTaskIds: [] });
      expect(areDependenciesMet(task, [])).toBe(true);
    });

    it('returns true when all dependencies are succeeded', () => {
      const task = makePITask({ dependencyTaskIds: ['dep1', 'dep2'] });
      const dependencies = [
        makeTask({ taskId: 'dep1', status: 'succeeded' }),
        makeTask({ taskId: 'dep2', status: 'succeeded' }),
      ];
      expect(areDependenciesMet(task, dependencies)).toBe(true);
    });

    it('returns false when dependency is missing (fail closed)', () => {
      const task = makePITask({ dependencyTaskIds: ['dep1', 'dep2'] });
      const dependencies = [makeTask({ taskId: 'dep1', status: 'succeeded' })];
      expect(areDependenciesMet(task, dependencies)).toBe(false);
    });

    it('returns false when dependency is not succeeded', () => {
      const task = makePITask({ dependencyTaskIds: ['dep1', 'dep2'] });
      const dependencies = [
        makeTask({ taskId: 'dep1', status: 'succeeded' }),
        makeTask({ taskId: 'dep2', status: 'pending' }),
      ];
      expect(areDependenciesMet(task, dependencies)).toBe(false);
    });

    it('returns false when dependency is failed', () => {
      const task = makePITask({ dependencyTaskIds: ['dep1'] });
      const dependencies = [makeTask({ taskId: 'dep1', status: 'failed' })];
      expect(areDependenciesMet(task, dependencies)).toBe(false);
    });

    it('returns false when dependency is leased', () => {
      const task = makePITask({ dependencyTaskIds: ['dep1'] });
      const dependencies = [makeTask({ taskId: 'dep1', status: 'leased' })];
      expect(areDependenciesMet(task, dependencies)).toBe(false);
    });

    it('returns false when dependency is in retry_wait', () => {
      const task = makePITask({ dependencyTaskIds: ['dep1'] });
      const dependencies = [makeTask({ taskId: 'dep1', status: 'retry_wait' })];
      expect(areDependenciesMet(task, dependencies)).toBe(false);
    });

    it('ignores extra dependencies not referenced by task', () => {
      const task = makePITask({ dependencyTaskIds: ['dep1'] });
      const dependencies = [
        makeTask({ taskId: 'dep1', status: 'succeeded' }),
        makeTask({ taskId: 'dep-extra', status: 'pending' }),
      ];
      expect(areDependenciesMet(task, dependencies)).toBe(true);
    });
  });

  describe('canTransitionTo', () => {
    it('allows pending -> leased', () => {
      expect(canTransitionTo('pending', 'leased')).toBe(true);
    });

    it('allows leased -> succeeded', () => {
      expect(canTransitionTo('leased', 'succeeded')).toBe(true);
    });

    it('allows leased -> retry_wait', () => {
      expect(canTransitionTo('leased', 'retry_wait')).toBe(true);
    });

    it('allows leased -> failed', () => {
      expect(canTransitionTo('leased', 'failed')).toBe(true);
    });

    it('allows leased -> pending', () => {
      expect(canTransitionTo('leased', 'pending')).toBe(true);
    });

    it('allows retry_wait -> pending', () => {
      expect(canTransitionTo('retry_wait', 'pending')).toBe(true);
    });

    it('disallows pending -> succeeded', () => {
      expect(canTransitionTo('pending', 'succeeded')).toBe(false);
    });

    it('disallows pending -> failed', () => {
      expect(canTransitionTo('pending', 'failed')).toBe(false);
    });

    it('disallows pending -> retry_wait', () => {
      expect(canTransitionTo('pending', 'retry_wait')).toBe(false);
    });

    it('disallows pending -> pending (self-transition)', () => {
      expect(canTransitionTo('pending', 'pending')).toBe(false);
    });

    it('disallows leased -> leased (self-transition)', () => {
      expect(canTransitionTo('leased', 'leased')).toBe(false);
    });

    it('disallows retry_wait -> leased', () => {
      expect(canTransitionTo('retry_wait', 'leased')).toBe(false);
    });

    it('disallows retry_wait -> succeeded', () => {
      expect(canTransitionTo('retry_wait', 'succeeded')).toBe(false);
    });

    it('disallows retry_wait -> failed', () => {
      expect(canTransitionTo('retry_wait', 'failed')).toBe(false);
    });

    it('disallows retry_wait -> retry_wait (self-transition)', () => {
      expect(canTransitionTo('retry_wait', 'retry_wait')).toBe(false);
    });

    it('disallows succeeded -> any state', () => {
      expect(canTransitionTo('succeeded', 'pending')).toBe(false);
      expect(canTransitionTo('succeeded', 'leased')).toBe(false);
      expect(canTransitionTo('succeeded', 'failed')).toBe(false);
      expect(canTransitionTo('succeeded', 'retry_wait')).toBe(false);
    });

    it('disallows failed -> any state', () => {
      expect(canTransitionTo('failed', 'pending')).toBe(false);
      expect(canTransitionTo('failed', 'leased')).toBe(false);
      expect(canTransitionTo('failed', 'succeeded')).toBe(false);
      expect(canTransitionTo('failed', 'retry_wait')).toBe(false);
    });
  });

  describe('isResultRefImmutable', () => {
    it('returns true when status is succeeded', () => {
      expect(isResultRefImmutable(makePITask({ status: 'succeeded' }))).toBe(true);
    });

    it('returns false for other statuses', () => {
      expect(isResultRefImmutable(makePITask({ status: 'pending' }))).toBe(false);
      expect(isResultRefImmutable(makePITask({ status: 'leased' }))).toBe(false);
      expect(isResultRefImmutable(makePITask({ status: 'retry_wait' }))).toBe(false);
      expect(isResultRefImmutable(makePITask({ status: 'failed' }))).toBe(false);
    });
  });

  describe('canUpdateLastError', () => {
    it('returns true for retry_wait', () => {
      expect(canUpdateLastError(makePITask({ status: 'retry_wait' }))).toBe(true);
    });

    it('returns true for failed', () => {
      expect(canUpdateLastError(makePITask({ status: 'failed' }))).toBe(true);
    });

    it('returns false for pending', () => {
      expect(canUpdateLastError(makePITask({ status: 'pending' }))).toBe(false);
    });

    it('returns false for leased', () => {
      expect(canUpdateLastError(makePITask({ status: 'leased' }))).toBe(false);
    });

    it('returns false for succeeded', () => {
      expect(canUpdateLastError(makePITask({ status: 'succeeded' }))).toBe(false);
    });
  });

  describe('isArtifactRejected', () => {
    it('returns true when validationStatus is rejected', () => {
      const artifact = {
        artifactId: 'art-1',
        artifactKind: 'principle' as const,
        sourceTaskId: 'task-1',
        lineageRefs: [] as LineageRef[],
        validationStatus: 'rejected' as const,
      };
      expect(isArtifactRejected(artifact)).toBe(true);
    });

    it('returns false when validationStatus is validated', () => {
      const artifact = {
        artifactId: 'art-1',
        artifactKind: 'principle' as const,
        sourceTaskId: 'task-1',
        lineageRefs: [] as LineageRef[],
        validationStatus: 'validated' as const,
      };
      expect(isArtifactRejected(artifact)).toBe(false);
    });

    it('returns false when validationStatus is pending', () => {
      const artifact = {
        artifactId: 'art-1',
        artifactKind: 'principle' as const,
        sourceTaskId: 'task-1',
        lineageRefs: [] as LineageRef[],
        validationStatus: 'pending' as const,
      };
      expect(isArtifactRejected(artifact)).toBe(false);
    });
  });

  describe('Three Strikes Out (PRI-141)', () => {
    it('DEFAULT_UNRESOLVABLE_THRESHOLD is 3', () => {
      expect(DEFAULT_UNRESOLVABLE_THRESHOLD).toBe(3);
    });

    it('isUnresolvable returns false when below threshold', () => {
      expect(isUnresolvable(makePITask({ rejectionCount: 0 }))).toBe(false);
      expect(isUnresolvable(makePITask({ rejectionCount: 1 }))).toBe(false);
      expect(isUnresolvable(makePITask({ rejectionCount: 2 }))).toBe(false);
    });

    it('isUnresolvable returns true when at threshold', () => {
      expect(isUnresolvable(makePITask({ rejectionCount: 3 }))).toBe(true);
    });

    it('isUnresolvable returns true when above threshold', () => {
      expect(isUnresolvable(makePITask({ rejectionCount: 5 }))).toBe(true);
    });

    it('isUnresolvable handles undefined rejectionCount', () => {
      expect(isUnresolvable(makePITask({ rejectionCount: undefined }))).toBe(false);
    });

    it('isUnresolvable works with custom threshold', () => {
      expect(isUnresolvable(makePITask({ rejectionCount: 2 }), 2)).toBe(true);
      expect(isUnresolvable(makePITask({ rejectionCount: 1 }), 2)).toBe(false);
    });

    it('recordRejection increments rejectionCount', () => {
      const task = makePITask({ rejectionCount: 2 });
      const result = recordRejection(task);
      expect(result.rejectionCount).toBe(3);
    });

    it('recordRejection handles undefined rejectionCount', () => {
      const task = makePITask({ rejectionCount: undefined });
      const result = recordRejection(task);
      expect(result.rejectionCount).toBe(1);
    });

    it('recordRejection updates updatedAt', () => {
      const task = makePITask({ rejectionCount: 0, updatedAt: '2024-01-01T00:00:00.000Z' });
      const result = recordRejection(task);
      expect(result.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
      expect(new Date(result.updatedAt).getTime()).toBeGreaterThan(0);
    });

    it('recordRejection does not mutate the original task', () => {
      const task = makePITask({ rejectionCount: 2 });
      const result = recordRejection(task);
      expect(task.rejectionCount).toBe(2);
      expect(result.rejectionCount).toBe(3);
    });
  });

  // ── F7-6 (PRI-442): Retry Wait Staleness ──

  describe('F7-6: isRetryWaitStale (retry_wait TTL)', () => {
    const ONE_HOUR = 60 * 60 * 1000;
    const NOW_MS = new Date('2026-06-30T12:00:00.000Z').getTime();

    it('returns false for non-retry_wait tasks', () => {
      const task = makePITask({ status: 'pending', updatedAt: new Date(NOW_MS - 48 * ONE_HOUR).toISOString() });
      expect(isRetryWaitStale(task, NOW_MS)).toBe(false);
    });

    it('returns false for retry_wait task newer than TTL', () => {
      const task = makePITask({
        status: 'retry_wait',
        updatedAt: new Date(NOW_MS - 1 * ONE_HOUR).toISOString(), // 1h ago
      });
      expect(isRetryWaitStale(task, NOW_MS)).toBe(false);
    });

    it('returns true for retry_wait task older than default TTL (24h)', () => {
      const task = makePITask({
        status: 'retry_wait',
        updatedAt: new Date(NOW_MS - 25 * ONE_HOUR).toISOString(), // 25h ago
      });
      expect(isRetryWaitStale(task, NOW_MS)).toBe(true);
    });

    it('returns true for retry_wait task exactly at TTL boundary', () => {
      const updatedAt = new Date(NOW_MS - DEFAULT_RETRY_WAIT_STALE_TTL_MS).toISOString();
      const task = makePITask({ status: 'retry_wait', updatedAt });
      expect(isRetryWaitStale(task, NOW_MS)).toBe(true);
    });

    it('returns false for retry_wait task just under TTL boundary', () => {
      const updatedAt = new Date(NOW_MS - DEFAULT_RETRY_WAIT_STALE_TTL_MS + 1).toISOString();
      const task = makePITask({ status: 'retry_wait', updatedAt });
      expect(isRetryWaitStale(task, NOW_MS)).toBe(false);
    });

    it('honors custom maxWaitMs', () => {
      const task = makePITask({
        status: 'retry_wait',
        updatedAt: new Date(NOW_MS - 2 * ONE_HOUR).toISOString(), // 2h ago
      });
      // 2h > 1h custom TTL → stale
      expect(isRetryWaitStale(task, NOW_MS, 1 * ONE_HOUR)).toBe(true);
      // 2h < 3h custom TTL → not stale
      expect(isRetryWaitStale(task, NOW_MS, 3 * ONE_HOUR)).toBe(false);
    });

    it('returns false (fail-safe) when updatedAt is missing', () => {
      const task = makePITask({ status: 'retry_wait' });
      delete (task as { updatedAt?: string }).updatedAt;
      expect(isRetryWaitStale(task, NOW_MS)).toBe(false);
    });

    it('returns false (fail-safe) when updatedAt is unparseable', () => {
      const task = makePITask({ status: 'retry_wait', updatedAt: 'not-a-date' });
      expect(isRetryWaitStale(task, NOW_MS)).toBe(false);
    });
  });
});
