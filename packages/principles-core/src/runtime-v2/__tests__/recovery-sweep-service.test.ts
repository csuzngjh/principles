import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRecoverySweepService } from '../recovery-sweep-service.js';
import type { TaskRecord } from '../task-status.js';

const mockDetectExpiredLeases = vi.fn();
const mockRecoverTask = vi.fn();
const mockStateManagerClose = vi.fn();
const mockInitialize = vi.fn();
const mockAssertInitialized = vi.fn();
const mockListTasks = vi.fn();
const mockGetTask = vi.fn();
const mockUpdateTask = vi.fn();

vi.mock('../store/runtime-state-manager.js', () => ({
  RuntimeStateManager: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.initialize = mockInitialize;
    this.close = mockStateManagerClose;
    this.detectExpiredLeases = mockDetectExpiredLeases;
    this.recoverTask = mockRecoverTask;
    this.assertInitialized = mockAssertInitialized;
    this.isInitialized = true;
    this.listTasks = mockListTasks;
    this.getTask = mockGetTask;
    this.updateTask = mockUpdateTask;
  }),
}));

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-x',
    taskKind: 'dreamer',
    status: 'failed',
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    attemptCount: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

describe('createRecoverySweepService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockDetectExpiredLeases.mockResolvedValue([]);
    mockRecoverTask.mockResolvedValue(null);
    mockStateManagerClose.mockResolvedValue(undefined);
    mockAssertInitialized.mockReturnValue(undefined);
  });

  it('creates service with stateManager and close handle', async () => {
    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    expect(handle.service).toBeDefined();
    expect(typeof handle.close).toBe('function');
  });

  it('detectExpiredLeases delegates to stateManager', async () => {
    mockDetectExpiredLeases.mockResolvedValue(['task-1', 'task-2']);
    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    const expired = await handle.service.detectExpiredLeases();
    expect(expired).toEqual(['task-1', 'task-2']);
    expect(mockDetectExpiredLeases).toHaveBeenCalledTimes(1);
  });

  it('recoverTask delegates to stateManager and returns full RecoveryResult', async () => {
    mockRecoverTask.mockResolvedValue({
      taskId: 'task-1',
      recoveredAt: '2026-05-21T00:00:00.000Z',
      previousStatus: 'leased',
      newStatus: 'retry_wait',
      wasLeaseExpired: true,
    });
    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    const result = await handle.service.recoverTask('task-1');
    expect(result).toEqual({
      taskId: 'task-1',
      recoveredAt: '2026-05-21T00:00:00.000Z',
      previousStatus: 'leased',
      newStatus: 'retry_wait',
      wasLeaseExpired: true,
    });
    expect(mockRecoverTask).toHaveBeenCalledWith('task-1');
  });

  it('close is idempotent via RuntimeStateHandle', async () => {
    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    await handle.close();
    await handle.close();
    await handle.close();
    expect(mockStateManagerClose).toHaveBeenCalledTimes(1);
  });

  it('recoverTask returns null when stateManager returns null', async () => {
    mockRecoverTask.mockResolvedValue(null);
    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    const result = await handle.service.recoverTask('nonexistent-task');
    expect(result).toBeNull();
  });

  it('service close is no-op (managed by handle)', async () => {
    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    await handle.service.close();
    expect(mockStateManagerClose).not.toHaveBeenCalled();
  });

  it('propagates initialization failure from RuntimeStateManager', async () => {
    mockInitialize.mockRejectedValueOnce(new Error('DB init failed'));
    await expect(createRecoverySweepService({ workspaceDir: '/tmp/test-ws' }))
      .rejects.toThrow('DB init failed');
  });
});

describe('detectFailedTasks — recovery discovery (PRI-674)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockStateManagerClose.mockResolvedValue(undefined);
    mockAssertInitialized.mockReturnValue(undefined);
    mockListTasks.mockResolvedValue([]);
  });

  it('returns failed diagnostician parent and diag_* stage tasks (GAP-1 regression)', async () => {
    mockListTasks.mockResolvedValue([
      makeTask({ taskId: 'diag-parent', taskKind: 'diagnostician' }),
      makeTask({ taskId: 'diag-a', taskKind: 'diag_rootcause' }),
      makeTask({ taskId: 'diag-b', taskKind: 'diag_distiller' }),
      makeTask({ taskId: 'diag-c', taskKind: 'diag_router' }),
    ]);

    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    const results = await handle.service.detectFailedTasks();

    expect(results.map((r) => r.taskId).sort())
      .toEqual(['diag-a', 'diag-b', 'diag-c', 'diag-parent']);
  });

  it('still returns peer runner kinds with isExhausted computed', async () => {
    mockListTasks.mockResolvedValue([
      makeTask({ taskId: 'peer-dreamer', taskKind: 'dreamer', attemptCount: 1, maxAttempts: 3 }),
      makeTask({ taskId: 'peer-rollout', taskKind: 'rollout_reviewer', attemptCount: 3, maxAttempts: 3 }),
    ]);

    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    const results = await handle.service.detectFailedTasks();

    expect(results.map((r) => r.taskId).sort()).toEqual(['peer-dreamer', 'peer-rollout']);
    expect(results.find((r) => r.taskId === 'peer-dreamer')?.isExhausted).toBe(false);
    expect(results.find((r) => r.taskId === 'peer-rollout')?.isExhausted).toBe(true);
  });

  it('excludes failed tasks of unrelated kinds', async () => {
    mockListTasks.mockResolvedValue([
      makeTask({ taskId: 'other', taskKind: 'principle_candidate_intake' }),
    ]);

    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    const results = await handle.service.detectFailedTasks();

    expect(results).toEqual([]);
  });
});

describe('recoverFailedTask — reset semantics unchanged (PRI-674)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockStateManagerClose.mockResolvedValue(undefined);
    mockAssertInitialized.mockReturnValue(undefined);
  });

  it('resets a failed diagnostician task to pending with lease/attempts/result cleared', async () => {
    mockGetTask.mockResolvedValue(makeTask({
      taskId: 'diag-parent',
      taskKind: 'diagnostician',
      attemptCount: 1,
      maxAttempts: 3,
      lastError: 'max_attempts_exceeded',
      leaseOwner: 'runner-1',
      leaseExpiresAt: '2026-09-08T01:00:00.000Z',
      resultRef: 'artifact://partial',
    }));
    mockUpdateTask.mockImplementation(async (taskId: string, patch: Partial<TaskRecord>) =>
      makeTask({ taskId, taskKind: 'diagnostician', ...patch }));

    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    const result = await handle.service.recoverFailedTask('diag-parent');

    expect(mockUpdateTask).toHaveBeenCalledWith('diag-parent', {
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      resultRef: null,
    });
    expect(result).toMatchObject({
      taskId: 'diag-parent',
      previousStatus: 'failed',
      newStatus: 'pending',
      forceApplied: false,
    });
  });

  it('refuses an exhausted task without force (retry guard unchanged)', async () => {
    mockGetTask.mockResolvedValue(makeTask({
      taskId: 'diag-exhausted',
      taskKind: 'diagnostician',
      attemptCount: 3,
      maxAttempts: 3,
    }));

    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    await expect(handle.service.recoverFailedTask('diag-exhausted'))
      .rejects.toThrow(/exhausted max attempts/);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('returns null for a task that is not failed', async () => {
    mockGetTask.mockResolvedValue(makeTask({ taskId: 'diag-ok', status: 'succeeded' }));

    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    const result = await handle.service.recoverFailedTask('diag-ok');

    expect(result).toBeNull();
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });
});
