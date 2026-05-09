import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

const mockWakeOnce = vi.fn();
const mockRun = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockPiArtifactStore = {
  createArtifact: vi.fn().mockResolvedValue({}),
  upsertArtifact: vi.fn().mockResolvedValue({}),
  getArtifactById: vi.fn().mockResolvedValue(null),
  listBySourceTaskId: vi.fn().mockResolvedValue([]),
  listLineage: vi.fn().mockResolvedValue([]),
};

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  RuntimeStateManager: vi.fn().mockImplementation(function () {
    return {
      initialize: mockInitialize,
      close: mockClose,
      connection: {},
      taskStore: {},
      runStore: {},
      piArtifactStore: mockPiArtifactStore,
    };
  }),
  InternalizationOrchestrator: vi.fn().mockImplementation(function () {
    return { wakeOnce: mockWakeOnce };
  }),
  DreamerRunner: vi.fn().mockImplementation(function () {
    return { run: mockRun };
  }),
  StoreEventEmitter: vi.fn().mockImplementation(function () {
    return { emitTelemetry: vi.fn() };
  }),
  PassThroughDreamerValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  TestDoubleRuntimeAdapter: vi.fn().mockImplementation(function () {
    return {
      kind: vi.fn().mockReturnValue('test-double'),
      getCapabilities: vi.fn(),
      healthCheck: vi.fn(),
      startRun: vi.fn().mockResolvedValue({ runId: 'run-test-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
      pollRun: vi.fn().mockResolvedValue({ runId: 'run-test-001', status: 'succeeded' }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
      fetchOutput: vi.fn().mockResolvedValue({ runId: 'run-test-001', payload: {} }),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    };
  }),
  PiAiRuntimeAdapter: vi.fn().mockImplementation(function () {
    return {
      kind: vi.fn().mockReturnValue('pi-ai'),
      getCapabilities: vi.fn(),
      healthCheck: vi.fn(),
      startRun: vi.fn().mockResolvedValue({ runId: 'run-pi-001', runtimeKind: 'pi-ai', startedAt: new Date().toISOString() }),
      pollRun: vi.fn().mockResolvedValue({ runId: 'run-pi-001', status: 'succeeded' }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
      fetchOutput: vi.fn().mockResolvedValue({ runId: 'run-pi-001', payload: {} }),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    };
  }),
  OpenClawCliRuntimeAdapter: vi.fn().mockImplementation(function () {
    return {
      kind: vi.fn().mockReturnValue('openclaw-cli'),
      getCapabilities: vi.fn(),
      healthCheck: vi.fn(),
      startRun: vi.fn().mockResolvedValue({ runId: 'run-oc-001', runtimeKind: 'openclaw-cli', startedAt: new Date().toISOString() }),
      pollRun: vi.fn().mockResolvedValue({ runId: 'run-oc-001', status: 'succeeded' }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
      fetchOutput: vi.fn().mockResolvedValue({ runId: 'run-oc-001', payload: {} }),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    };
  }),
  resolveRuntimeConfig: vi.fn().mockReturnValue({
    runtimeKind: 'pi-ai',
    timeoutMs: 300_000,
    agentId: 'main',
    provider: 'test-provider',
    model: 'test-model',
    apiKeyEnv: 'TEST_API_KEY',
  }),
  validateRuntimeConfig: vi.fn(),
}));

import { handleRuntimeInternalizationRunOnce } from '../../src/commands/runtime-internalization-run-once.js';

const WS = '/fake/workspace';

describe('handleRuntimeInternalizationRunOnce', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = 0;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('test-double without --allow-test-double: refuses to execute and exits 1', async () => {
    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: false });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy.mock.calls.some((c: string[]) => c[0].includes('test-double runtime mutates real queue state'))).toBe(true);
    expect(mockWakeOnce).not.toHaveBeenCalled();
  });

  it('default runtime (config) does not require --allow-test-double', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-001',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-001',
      runId: 'run-001',
      artifactId: 'pi-art-task-dreamer-001-run-001',
      resultRef: 'dreamer://run-001',
      contextHash: 'ctx-abc',
      output: { valid: true, taskId: 'task-dreamer-001', candidates: [], contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, json: true });

    expect(mockWakeOnce).toHaveBeenCalled();
  });

  it('test-double with --allow-test-double: proceeds normally', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-001',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-001',
      runId: 'run-001',
      artifactId: 'pi-art-task-dreamer-001-run-001',
      resultRef: 'dreamer://run-001',
      contextHash: 'ctx-abc',
      output: { valid: true, taskId: 'task-dreamer-001', candidates: [], contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: true, json: true });

    expect(mockWakeOnce).toHaveBeenCalled();
  });

  it('unsupported runner kind: exits 1 with error', async () => {
    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'philosopher', runtime: 'test-double', allowTestDouble: true });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy.mock.calls.some((c: string[]) => c[0].includes('unsupported runner kind'))).toBe(true);
  });

  it('no_ready_tasks: reports no leasable task and exits 1', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'no_ready_tasks',
      inspectedCount: 3,
      reason: 'all_blocked',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('no_ready_tasks');
    expect(process.exitCode).toBe(1);
  });

  it('would_lease dreamer task: uses dryRun wakeOnce then DreamerRunner.run leases and executes', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-001',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-001',
      runId: 'run-001',
      artifactId: 'pi-art-task-dreamer-001-run-001',
      resultRef: 'dreamer://run-001',
      contextHash: 'ctx-abc',
      output: { valid: true, taskId: 'task-dreamer-001', candidates: [], contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: true, json: true });

    expect(mockRun).toHaveBeenCalledWith('task-dreamer-001');

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('would_lease');
    expect(output.taskId).toBe('task-dreamer-001');
    expect(output.runId).toBe('run-001');
    expect(output.artifactId).toBe('pi-art-task-dreamer-001-run-001');
    expect(output.resultRef).toBe('dreamer://run-001');
    expect(output.runnerResult.status).toBe('succeeded');
  });

  it('would_lease dreamer task with runner failure: reports failed result', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-002',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'failed',
      taskId: 'task-dreamer-002',
      errorCategory: 'execution_failed',
      failureReason: 'Runtime unavailable',
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.runnerResult.status).toBe('failed');
    expect(output.runnerResult.errorCategory).toBe('execution_failed');
  });

  it('would_lease non-dreamer task: no lease acquired, reports unsupported (no stuck lease)', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-phil-001',
      taskKind: 'philosopher',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: true, json: true });

    expect(mockRun).not.toHaveBeenCalled();

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('would_lease');
    expect(output.taskId).toBe('task-phil-001');
    expect(output.runnerResult).toBeUndefined();
    expect(output.skipReason).toBe('unsupported_runner_kind');
  });

  it('text output for succeeded dreamer run includes runId/artifactId/resultRef', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-003',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-003',
      runId: 'run-003',
      artifactId: 'pi-art-task-dreamer-003-run-003',
      resultRef: 'dreamer://run-003',
      contextHash: 'ctx-def',
      output: { valid: true, taskId: 'task-dreamer-003', candidates: [], contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: true, json: false });

    const text = consoleLogSpy.mock.calls.map((c: string[]) => c[0]).join('\n');
    expect(text).toContain('task-dreamer-003');
    expect(text).toContain('succeeded');
    expect(text).toContain('runId: run-003');
    expect(text).toContain('artifactId: pi-art-task-dreamer-003-run-003');
    expect(text).toContain('resultRef: dreamer://run-003');
  });

  it('lease_conflict: reports conflict and exits 1', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'lease_conflict',
      taskId: 'task-dreamer-004',
      conflictReason: 'Already leased by another runner',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('lease_conflict');
    expect(process.exitCode).toBe(1);
  });

  it('orchestrator error: exits 1 with error message', async () => {
    mockWakeOnce.mockRejectedValue(new Error('store unavailable'));

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: true, json: true });

    expect(process.exitCode).toBe(1);
  });

  it('uses stateManager.piArtifactStore (durable SQLite) not MemoryPIArtifactStore', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-005',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-005',
      runId: 'run-005',
      artifactId: 'pi-art-task-dreamer-005-run-005',
      resultRef: 'dreamer://run-005',
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: true, json: true });

    const DreamerRunnerMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.DreamerRunner),
    );
    const lastCall = DreamerRunnerMock.mock.calls[DreamerRunnerMock.mock.calls.length - 1];
    if (lastCall) {
      const deps = lastCall[0] as { artifactStore?: unknown };
      expect(deps.artifactStore).toBe(mockPiArtifactStore);
    }
  });

  it('--runtime pi-ai resolves PiAiRuntimeAdapter', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-006',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-006',
      runId: 'run-006',
      artifactId: 'pi-art-task-dreamer-006-run-006',
      resultRef: 'dreamer://run-006',
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'pi-ai', json: true });

    const PiAiMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.PiAiRuntimeAdapter),
    );
    expect(PiAiMock).toHaveBeenCalled();
  });

  it('--runtime openclaw-cli resolves OpenClawCliRuntimeAdapter', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-007',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-007',
      runId: 'run-007',
      artifactId: 'pi-art-task-dreamer-007-run-007',
      resultRef: 'dreamer://run-007',
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'openclaw-cli', json: true });

    const OpenClawMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.OpenClawCliRuntimeAdapter),
    );
    expect(OpenClawMock).toHaveBeenCalled();
  });

  it('--runtime config resolves adapter from workflows.yaml', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-008',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-008',
      runId: 'run-008',
      artifactId: 'pi-art-task-dreamer-008-run-008',
      resultRef: 'dreamer://run-008',
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'config', json: true });

    const ResolveConfigMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.resolveRuntimeConfig),
    );
    expect(ResolveConfigMock).toHaveBeenCalled();
  });

  it('--runtime config reads from workspaceDir/.state (not .pd)', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-009',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-009',
      runId: 'run-009',
      artifactId: 'pi-art-task-dreamer-009-run-009',
      resultRef: 'dreamer://run-009',
      attemptCount: 1,
    });

    const customWs = '/tmp/test-workspace';
    await handleRuntimeInternalizationRunOnce({ workspace: customWs, runtime: 'config', json: true });

    const ResolveConfigMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.resolveRuntimeConfig),
    );
    const resolvedWorkspace = path.resolve(customWs);
    const expectedStateDir = path.join(resolvedWorkspace, '.state');
    expect(ResolveConfigMock).toHaveBeenCalledWith(expectedStateDir);
  });
});
