/**
 * PRI-104 task state semantic contract.
 *
 * This test file is a regression contract for Internalization Engine queue
 * readiness. It intentionally focuses on the meaning of task statuses rather
 * than on runner implementation details.
 */
import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import {
  canAcquireLease,
  canRetryNow,
} from '../internalization/internalization-task-guards.js';
import { validateInternalizationTaskReady } from '../internalization/internalization-state-machine.js';
import {
  createMinimalPITaskRecord,
  type PeerRunnerKind,
  type PITaskRecord,
} from '../internalization/peer-runner-contracts.js';
import { InternalizationQueueReadModel } from '../internalization-queue-read-model.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';

const NOW_MS = Date.parse('2026-05-11T12:00:00.000Z');
const futureIso = () => new Date(Date.now() + 300_000).toISOString();
const pastIso = () => new Date(Date.now() - 300_000).toISOString();

function makePITask(overrides: Partial<PITaskRecord> = {}): PITaskRecord {
  return {
    ...createMinimalPITaskRecord('task-1', 'dreamer', 'prompt'),
    createdAt: '2026-05-11T11:00:00.000Z',
    updatedAt: '2026-05-11T11:00:00.000Z',
    ...overrides,
  };
}

function makeRawTask(overrides: Partial<PITaskRecord> = {}): TaskRecord {
  const task = makePITask(overrides);
  return {
    taskId: task.taskId,
    taskKind: task.taskKind,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts,
    leaseOwner: task.leaseOwner,
    leaseExpiresAt: task.leaseExpiresAt,
    diagnosticJson: createPITaskDiagnosticJson(task),
  };
}

function makeStateManager(tasks: TaskRecord[]): RuntimeStateManager {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  return {
    listTasks: async (filter?: { status?: string }) =>
      filter?.status ? tasks.filter((task) => task.status === filter.status) : tasks,
    getTask: async (taskId: string) => byId.get(taskId) ?? null,
  } as unknown as RuntimeStateManager;
}

describe('PRI-104 task lease and readiness semantics', () => {
  it('pending without an active lease can be ready when dependencies pass', () => {
    const task = makePITask({ status: 'pending' });
    const result = validateInternalizationTaskReady(task, [], NOW_MS);

    expect(canAcquireLease(task)).toBe(true);
    expect(result).toEqual({
      decision: 'proceed',
      ready: true,
      blockedBy: [],
      failedDependencies: [],
    });
  });

  it('pending with unexpired lease is not a valid store state for readiness evaluation and is reported by queue as lease conflict', async () => {
    const task = makeRawTask({
      taskId: 'leased-pending',
      status: 'pending',
      leaseOwner: 'runner-a',
      leaseExpiresAt: futureIso(),
    });
    const snapshot = await new InternalizationQueueReadModel(makeStateManager([task])).getSnapshot();

    expect(snapshot.readyTasks).toHaveLength(0);
    expect(snapshot.leaseConflictSummary.count).toBe(1);
    expect(snapshot.leaseConflictSummary.sampleTaskIds).toEqual(['leased-pending']);
    expect(snapshot.noReadyTasks).toEqual({ reason: 'all_lease_conflict', inspectedCount: 1 });
  });

  it('pending with expired lease is visible as ready; recovery sweep owns actual lease cleanup', async () => {
    const task = makeRawTask({
      taskId: 'expired-lease-pending',
      status: 'pending',
      leaseOwner: 'runner-a',
      leaseExpiresAt: pastIso(),
    });
    const snapshot = await new InternalizationQueueReadModel(makeStateManager([task])).getSnapshot();

    expect(snapshot.leaseConflictSummary.count).toBe(0);
    expect(snapshot.readyTasks.map((ready) => ready.taskId)).toEqual(['expired-lease-pending']);
  });

  it('retry_wait before backoff deadline is not ready', () => {
    const task = makePITask({
      status: 'retry_wait',
      leaseExpiresAt: '2026-05-11T12:05:00.000Z',
    });
    const result = validateInternalizationTaskReady(task, [], NOW_MS);

    expect(canAcquireLease(task)).toBe(true);
    expect(canRetryNow(task, NOW_MS)).toBe(false);
    expect(result.decision).toBe('retry_wait_pending');
    expect(result.ready).toBe(false);
    expect(result.retryAfter).toBe('2026-05-11T12:05:00.000Z');
  });

  it('retry_wait after backoff deadline can become ready', () => {
    const task = makePITask({
      status: 'retry_wait',
      leaseExpiresAt: '2026-05-11T11:59:00.000Z',
    });
    const result = validateInternalizationTaskReady(task, [], NOW_MS);

    expect(canRetryNow(task, NOW_MS)).toBe(true);
    expect(result.decision).toBe('proceed');
    expect(result.ready).toBe(true);
  });

  it.each(['succeeded', 'failed'] as const)('%s terminal task is never ready', (status) => {
    const task = makePITask({ status });
    const result = validateInternalizationTaskReady(task, [], NOW_MS);

    expect(canAcquireLease(task)).toBe(false);
    expect(result.decision).toBe('blocked');
    expect(result.ready).toBe(false);
  });

  it('queue read model does not include retry_wait tasks before backoff deadline in readyTasks', async () => {
    const task = makeRawTask({
      taskId: 'retry-waiting',
      status: 'retry_wait',
      leaseExpiresAt: futureIso(),
    });
    const snapshot = await new InternalizationQueueReadModel(makeStateManager([task])).getSnapshot();

    expect(snapshot.readyTasks).toHaveLength(0);
    expect(snapshot.retryWaitPendingSummary.count).toBe(1);
    expect(snapshot.noReadyTasks).toEqual({ reason: 'all_retry_wait_pending', inspectedCount: 1 });
  });

  it('dependency failed dominates blocked dependencies when reporting readiness', () => {
    const task = makePITask({
      status: 'pending',
      dependencyTaskIds: ['failed-dep', 'blocked-dep'],
    });
    const deps: TaskRecord[] = [
      { ...makeRawTask({ taskId: 'failed-dep', status: 'failed' }) },
      { ...makeRawTask({ taskId: 'blocked-dep', status: 'pending' }) },
    ];
    const result = validateInternalizationTaskReady(task, deps, NOW_MS);

    expect(result.decision).toBe('dependency_failed');
    expect(result.failedDependencies).toEqual(['failed-dep']);
    expect(result.blockedBy).toEqual(['blocked-dep']);
  });

  it('taskKind filtering cannot make other runner kinds ready through queue semantics', async () => {
    const dreamer = makeRawTask({ taskId: 'dreamer-ready', taskKind: 'dreamer' as PeerRunnerKind });
    const philosopher = makeRawTask({ taskId: 'philosopher-ready', taskKind: 'philosopher' as PeerRunnerKind });
    const snapshot = await new InternalizationQueueReadModel(makeStateManager([dreamer, philosopher])).getSnapshot();

    expect(snapshot.readyTasks.map((ready) => ready.taskId).sort()).toEqual(['dreamer-ready', 'philosopher-ready']);
    expect(snapshot.pendingCount).toBe(2);
  });
});
