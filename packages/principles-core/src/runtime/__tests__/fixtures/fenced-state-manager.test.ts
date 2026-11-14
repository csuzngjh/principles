/**
 * The shared fencing double is production-shaped test infrastructure: nine
 * suites depend on it to model acquire → probe → release. A double that drifts
 * from the real semantics silently weakens those suites (ERR-107 class), so its
 * own contract is asserted here.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TaskRecord } from '../../task-status.js';
import type { LeaseFence } from '../../store/lifecycle/lease-fence.js';
import { installDiagnosticianCommitMock, installFencedLeaseMock } from './fenced-state-manager.js';

const TASK_ID = 'task-fixture';
const OWNER = 'fixture-owner';

function makeTask(): TaskRecord {
  return {
    taskId: TASK_ID,
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('installFencedLeaseMock contract', () => {
  function makeDouble() {
    const task = makeTask();
    const double: Record<string, unknown> = {
      acquireLease: vi.fn(async () => task),
      getTask: vi.fn(async () => task),
      updateTask: vi.fn(async () => undefined),
      markTaskSucceeded: vi.fn(async () => task),
    };
    installFencedLeaseMock(double, { runId: 'run-fixture' });
    return double;
  }

  async function acquire(double: Record<string, unknown>) {
    const acquireDetailed = double.acquireLeaseDetailed as (input: { taskId: string; owner: string }) => Promise<{
      task: TaskRecord;
      runId: string;
      leaseGeneration: number;
    }>;
    const acquired = await acquireDetailed({ taskId: TASK_ID, owner: OWNER });
    const fence: LeaseFence = { taskId: TASK_ID, owner: OWNER, leaseGeneration: acquired.leaseGeneration };
    return { acquired, fence };
  }

  it('renews only a lease it holds and returns the refreshed row', async () => {
    const double = makeDouble();
    const { fence } = await acquire(double);
    const renew = double.renewLease as (fence: LeaseFence) => Promise<TaskRecord>;

    await expect(renew(fence)).resolves.toMatchObject({ taskId: TASK_ID, status: 'leased' });
    await expect(renew({ ...fence, taskId: 'task-without-lease' }))
      .rejects.toThrow('renewLease: no lease held for task-without-lease');
  });

  it('releases a held lease and refuses an unknown one', async () => {
    const double = makeDouble();
    const { fence } = await acquire(double);
    const release = double.releaseLease as (fence: LeaseFence) => Promise<TaskRecord>;

    await expect(release(fence)).resolves.toMatchObject({ taskId: TASK_ID, status: 'leased' });
    await expect(release({ ...fence, taskId: 'task-without-lease' }))
      .rejects.toThrow('releaseLease: no lease held for task-without-lease');
  });

  it('probes generation and owner, not just task identity', async () => {
    const double = makeDouble();
    const { acquired, fence } = await acquire(double);
    const assertOwned = double.assertLeaseOwned as (fence: LeaseFence) => Promise<boolean>;

    expect(await assertOwned(fence)).toBe(true);
    expect(await assertOwned({ ...fence, leaseGeneration: acquired.leaseGeneration + 1 })).toBe(false);
    expect(await assertOwned({ ...fence, owner: 'another-worker' })).toBe(false);
    expect(await assertOwned({ ...fence, taskId: 'task-without-lease' })).toBe(false);
  });
});

describe('installDiagnosticianCommitMock contract', () => {
  it('synthesizes the terminal task when the double has no fenced success writer', async () => {
    const double: Record<string, unknown> = {};
    installDiagnosticianCommitMock(double, {
      runId: 'run-fixture',
      commit: async () => ({ commitId: 'commit-1', artifactId: 'artifact-1', candidateCount: 1 }),
    });

    const commit = double.commitDiagnosticianAndFinalize as (input: {
      fence: LeaseFence;
      runId: string;
      commit: unknown;
    }) => Promise<{ task: TaskRecord; resultRef: string }>;

    const result = await commit({
      fence: { taskId: TASK_ID, owner: OWNER, leaseGeneration: 1 },
      runId: 'run-fixture',
      commit: {},
    });

    expect(result.resultRef).toBe('commit://commit-1');
    expect(result.task).toMatchObject({ taskId: TASK_ID, status: 'succeeded', resultRef: 'commit://commit-1' });
  });
});
