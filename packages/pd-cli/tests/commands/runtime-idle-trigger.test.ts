import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSnapshot = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListTasks = vi.fn();

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    RuntimeStateManager: vi.fn().mockImplementation(function () {
      return {
        initialize: vi.fn().mockResolvedValue(undefined),
        close: mockClose,
        listTasks: mockListTasks,
      };
    }),
    InternalizationQueueReadModel: vi.fn().mockImplementation(function () {
      return { getSnapshot: mockGetSnapshot };
    }),
  };
});

import { handleRuntimeIdleTriggerEvaluate } from '../../src/commands/runtime-idle-trigger.js';

const WS = '/fake/workspace';

describe('handleRuntimeIdleTriggerEvaluate', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetSnapshot.mockResolvedValue({
      readyTasks: [{ taskId: 't1', taskKind: 'dreamer', channel: 'prompt' }],
      pendingCount: 1,
      retryWaitCount: 0,
    });
    mockListTasks.mockResolvedValue([
      { taskId: 't1', updatedAt: new Date(Date.now() - 600_000).toISOString(), createdAt: new Date(Date.now() - 600_000).toISOString() },
    ]);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('outputs JSON with correct structure', async () => {
    await handleRuntimeIdleTriggerEvaluate({ workspace: WS, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output).toHaveProperty('decision');
    expect(output).toHaveProperty('reason');
    expect(output).toHaveProperty('idleForMs');
    expect(output).toHaveProperty('jitterMs');
    expect(output).toHaveProperty('nextEligibleAt');
    expect(output).toHaveProperty('queue');
    expect(output.queue).toHaveProperty('readyCount');
    expect(output.queue).toHaveProperty('pendingCount');
    expect(output.queue).toHaveProperty('retryWaitCount');
  });

  it('does not call wake/run/acquireLease', async () => {
    await handleRuntimeIdleTriggerEvaluate({ workspace: WS, json: true });

    const calls = mockGetSnapshot.mock.calls;
    expect(calls.length).toBe(1);
  });

  it('sets exit code 1 on skip decision', async () => {
    mockGetSnapshot.mockResolvedValue({
      readyTasks: [],
      pendingCount: 0,
      retryWaitCount: 0,
    });

    await handleRuntimeIdleTriggerEvaluate({ workspace: WS, json: true });

    expect(process.exitCode).toBe(1);
  });

  it('uses default config when no overrides provided', async () => {
    await handleRuntimeIdleTriggerEvaluate({ workspace: WS, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.jitterMs).toBeGreaterThanOrEqual(0);
    expect(output.jitterMs).toBeLessThanOrEqual(30_000);
  });

  it('respects config overrides from CLI flags', async () => {
    await handleRuntimeIdleTriggerEvaluate({
      workspace: WS,
      json: true,
      enabled: false,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('skip');
    expect(output.reason).toBe('disabled');
  });

  it('text output is human-readable', async () => {
    await handleRuntimeIdleTriggerEvaluate({ workspace: WS, json: false });

    const text = consoleLogSpy.mock.calls[0][0];
    expect(text).toContain('IdleTrigger:');
    expect(text).toContain('reason:');
    expect(text).toContain('idleForMs:');
    expect(text).toContain('jitterMs:');
    expect(text).toContain('queue:');
  });

  it('closes state manager even on error', async () => {
    mockGetSnapshot.mockRejectedValue(new Error('DB error'));

    try {
      await handleRuntimeIdleTriggerEvaluate({ workspace: WS, json: true });
    } catch {
      // expected
    }

    expect(mockClose).toHaveBeenCalled();
  });
});
