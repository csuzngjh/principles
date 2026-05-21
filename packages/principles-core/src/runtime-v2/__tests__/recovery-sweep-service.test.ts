import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RuntimeStateHandle } from '../runtime-state-handle.js';
import { createRecoverySweepService } from '../recovery-sweep-service.js';

const mockDetectExpiredLeases = vi.fn();
const mockRecoverTask = vi.fn();
const mockStateManagerClose = vi.fn();

vi.mock('../store/runtime-state-manager.js', () => ({
  RuntimeStateManager: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.initialize = vi.fn().mockResolvedValue(undefined);
    this.close = mockStateManagerClose;
    this.detectExpiredLeases = mockDetectExpiredLeases;
    this.recoverTask = mockRecoverTask;
    this.isInitialized = true;
  }),
}));

describe('createRecoverySweepService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockDetectExpiredLeases.mockResolvedValue([]);
    mockRecoverTask.mockResolvedValue(null);
    mockStateManagerClose.mockResolvedValue(undefined);
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

  it('recoverTask delegates to stateManager', async () => {
    mockRecoverTask.mockResolvedValue({ previousStatus: 'leased', newStatus: 'retry_wait' });
    const handle = await createRecoverySweepService({ workspaceDir: '/tmp/test-ws' });
    const result = await handle.service.recoverTask('task-1');
    expect(result).toEqual({ previousStatus: 'leased', newStatus: 'retry_wait' });
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
});
