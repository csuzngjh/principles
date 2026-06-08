/**
 * pd runtime internalization wake-once CLI unit tests.
 *
 * Tests the wake-once command handler: dry-run rejection, delegation to
 * InternalizationOrchestrator, JSON/text output formatting, and exit codes.
 * The orchestrator is mocked — its contract is tested in principles-core.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockWakeOnce = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  RuntimeStateManager: vi.fn().mockImplementation(function () {
    return { initialize: vi.fn().mockResolvedValue(undefined), close: mockClose };
  }),
  InternalizationOrchestrator: vi.fn().mockImplementation(function () {
    return { wakeOnce: mockWakeOnce };
  }),
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
}));

import { handleRuntimeInternalizationWakeOnce } from '../../src/commands/runtime-internalization-wake-once.js';

const WS = '/fake/workspace';

describe('handleRuntimeInternalizationWakeOnce', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // ── would_lease ─────────────────────────────────────────────────────────────

  it('would_lease result serialized correctly in JSON', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task_001',
      taskKind: 'dreamer',
      gateResult: { decision: 'proceed', ready: true, blockedBy: [], failedDependencies: [] },
    });

    await handleRuntimeInternalizationWakeOnce({ workspace: WS, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('would_lease');
    expect(output.taskId).toBe('task_001');
    expect(output.taskKind).toBe('dreamer');
  });

  it('would_lease text output is human-readable', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task_001',
      taskKind: 'dreamer',
      gateResult: { decision: 'proceed', ready: true, blockedBy: [], failedDependencies: [] },
    });

    await handleRuntimeInternalizationWakeOnce({ workspace: WS, dryRun: true, json: false });

    const text = consoleLogSpy.mock.calls[0][0];
    expect(text).toContain('would_lease');
    expect(text).toContain('task_001');
  });

  // ── no_ready_tasks ─────────────────────────────────────────────────────────

  it('no_ready_tasks with reason in JSON', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'no_ready_tasks',
      inspectedCount: 5,
      reason: 'all_blocked',
    });

    await handleRuntimeInternalizationWakeOnce({ workspace: WS, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('no_ready_tasks');
    expect(output.reason).toBe('all_blocked');
    expect(output.inspectedCount).toBe(5);
    expect(process.exitCode).toBe(1);
  });

  // ── blocked ────────────────────────────────────────────────────────────────

  it('blocked decision surfaces blockedBy task IDs', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'blocked',
      taskId: 'task_002',
      taskKind: 'philosopher',
      blockedBy: ['task_001'],
    });

    await handleRuntimeInternalizationWakeOnce({ workspace: WS, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('blocked');
    expect(output.blockedBy).toContain('task_001');
  });

  it('blocked text output shows blockedBy', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'blocked',
      taskId: 'task_002',
      taskKind: 'philosopher',
      blockedBy: ['task_001'],
    });

    await handleRuntimeInternalizationWakeOnce({ workspace: WS, dryRun: true, json: false });

    expect(consoleLogSpy.mock.calls[0][0]).toContain('blocked');
    expect(consoleLogSpy.mock.calls[0][0]).toContain('task_001');
  });

  // ── dependency_failed ─────────────────────────────────────────────────────

  it('dependency_failed surfaces failedDependencies', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'dependency_failed',
      taskId: 'task_003',
      taskKind: 'scribe',
      failedDependencies: ['task_002'],
    });

    await handleRuntimeInternalizationWakeOnce({ workspace: WS, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('dependency_failed');
    expect(output.failedDependencies).toContain('task_002');
  });

  // ── non-dry-run rejection ──────────────────────────────────────────────────

  it('non-dry-run invocation exits with error before any state interaction', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await handleRuntimeInternalizationWakeOnce({ workspace: WS, dryRun: false, json: true });

    expect(process.exitCode).toBe(1);
    expect(mockWakeOnce).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  // ── error handling ──────────────────────────────────────────────────────────

  it('orchestrator error leads to exit code 1', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    mockWakeOnce.mockRejectedValue(new Error('store unavailable'));

    await handleRuntimeInternalizationWakeOnce({ workspace: WS, dryRun: true, json: true });

    expect(process.exitCode).toBe(1);

    exitSpy.mockRestore();
  });
});
