import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

const VALID_DREAMER_CANDIDATES = [{ candidateIndex: 0, badDecision: 'Ignored validation', betterDecision: 'Validate inputs', rationale: 'Prevents errors', confidence: 0.9, riskLevel: 'low' as const, strategicPerspective: 'defensive-programming' }];

const mockWakeOnce = vi.fn();
const mockRun = vi.fn();
const mockCommitNextTaskProposal = vi.fn().mockResolvedValue({ decision: 'no_successor', sourceTaskId: '', reason: '' });
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

const { mockResolveRuntimeFromPdConfig } = vi.hoisted(() => {
  const mockResolveRuntimeFromPdConfig = vi.fn().mockReturnValue({
    result: {
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_API_KEY',
      timeoutMs: 300_000,
      agentId: 'main',
    },
    legacyWarnings: [],
    configSource: '.pd/config.yaml',
    configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
  });
  return { mockResolveRuntimeFromPdConfig };
});

vi.mock('../../src/services/resolve-runtime-from-pd-config.js', () => ({
  resolveRuntimeFromPdConfig: mockResolveRuntimeFromPdConfig,
}));

// PRI-460: Mock pd-config-loader so the shared resolver's L2 dreamer sub-branch
// doesn't call the real loadPdConfig (which needs fs access).
vi.mock('../../src/services/pd-config-loader.js', () => ({
  loadPdConfig: vi.fn().mockReturnValue({
    ok: true,
    effective: {},
    source: 'defaults',
    configPath: '/fake/workspace/.pd/config.yaml',
    warnings: [],
    legacyFilesDetected: [],
    legacyFileNextActions: [],
  }),
  computeFlagsFromLoadResult: vi.fn().mockReturnValue({
    flags: {},
    enabledChannels: [],
    warnings: [],
  }),
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
    return { wakeOnce: mockWakeOnce, commitNextTaskProposal: mockCommitNextTaskProposal };
  }),
  DreamerRunner: vi.fn().mockImplementation(function () {
    return { run: mockRun };
  }),
  PhilosopherRunner: vi.fn().mockImplementation(function () {
    return { run: mockRun };
  }),
  ScribeRunner: vi.fn().mockImplementation(function () {
    return { run: mockRun };
  }),
  ArtificerRunner: vi.fn().mockImplementation(function () {
    return { run: mockRun };
  }),
  EvaluatorRunner: vi.fn().mockImplementation(function () {
    return { run: mockRun };
  }),
  RolloutReviewerRunner: vi.fn().mockImplementation(function () {
    return { run: mockRun };
  }),
  StoreEventEmitter: vi.fn().mockImplementation(function () {
    return { emitTelemetry: vi.fn() };
  }),
  PassThroughDreamerValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultDreamerValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultPhilosopherValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultScribeValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultArtificerValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultEvaluatorValidator: vi.fn().mockImplementation(function () {
    return { validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }) };
  }),
  DefaultRolloutReviewerValidator: vi.fn().mockImplementation(function () {
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
  isRuntimeConfigError: vi.fn().mockImplementation((result: unknown) => result != null && typeof result === 'object' && Object.hasOwn(result, 'reason') && !Object.hasOwn(result, 'runtimeKind')),
  validateRuntimeConfig: vi.fn(),
  resolveRuntimeConfigFromPdConfig: vi.fn().mockReturnValue({ runtimeKind: 'pi-ai', provider: 'test-provider', model: 'test-model', apiKeyEnv: 'TEST_API_KEY', timeoutMs: 300_000, agentId: 'main' }),
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
}));

vi.mock('../../src/config-reader.js', () => ({
  readOutputLanguageFromWorkspace: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
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
      output: { valid: true, taskId: 'task-dreamer-001', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
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
      output: { valid: true, taskId: 'task-dreamer-001', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'test-double', allowTestDouble: true, json: true });

    expect(mockWakeOnce).toHaveBeenCalled();
  });

  it('unsupported runner kind: exits 1 with error', async () => {
    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'invalid-runner', runtime: 'test-double', allowTestDouble: true });

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
      output: { valid: true, taskId: 'task-dreamer-001', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
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
      output: { valid: true, taskId: 'task-dreamer-003', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
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
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: {
        runtimeKind: 'openclaw-cli',
        openclawMode: 'local',
        timeoutMs: 300_000,
        agentId: 'main',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
    });

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

  it('--runtime config resolves adapter from .pd/config.yaml with workspace path (PRI-393)', async () => {
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

    // PRI-393: verify resolveRuntimeFromPdConfig was called with workspace dir
    expect(mockResolveRuntimeFromPdConfig).toHaveBeenCalledWith(
      expect.stringContaining('test-workspace'),
    );
  });

  it('--runner philosopher dispatches PhilosopherRunner', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-phil-001',
      taskKind: 'philosopher',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-phil-001',
      runId: 'run-phil-001',
      artifactId: 'pi-art-task-phil-001-run-phil-001',
      resultRef: 'philosopher://run-phil-001',
      contextHash: 'ctx-phil-abc',
      output: {
        taskId: 'task-phil-001',
        sourceDreamerArtifactId: 'pi-art-dreamer-001',
        thesis: 'Test thesis',
        principleCandidate: { title: 'T', rationale: 'R', scope: 'S', confidence: 0.9 },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'philosopher', runtime: 'test-double', allowTestDouble: true, json: true });

    const PhilosopherRunnerMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.PhilosopherRunner),
    );
    expect(PhilosopherRunnerMock).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith('task-phil-001');

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.runnerKind).toBe('philosopher');
    expect(output.taskId).toBe('task-phil-001');
    expect(output.runId).toBe('run-phil-001');
    expect(output.artifactId).toBe('pi-art-task-phil-001-run-phil-001');
    expect(output.resultRef).toBe('philosopher://run-phil-001');
    expect(output.runnerResult.status).toBe('succeeded');
  });

  it('--runner philosopher with text output includes key IDs', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-phil-002',
      taskKind: 'philosopher',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-phil-002',
      runId: 'run-phil-002',
      artifactId: 'pi-art-task-phil-002-run-phil-002',
      resultRef: 'philosopher://run-phil-002',
      contextHash: 'ctx-phil-def',
      output: {
        taskId: 'task-phil-002',
        sourceDreamerArtifactId: 'pi-art-dreamer-002',
        thesis: 'Test thesis',
        principleCandidate: { title: 'T', rationale: 'R', scope: 'S', confidence: 0.9 },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'philosopher', runtime: 'test-double', allowTestDouble: true, json: false });

    const text = consoleLogSpy.mock.calls.map((c: string[]) => c[0]).join('\n');
    expect(text).toContain('task-phil-002');
    expect(text).toContain('succeeded');
    expect(text).toContain('runId: run-phil-002');
    expect(text).toContain('artifactId: pi-art-task-phil-002-run-phil-002');
    expect(text).toContain('resultRef: philosopher://run-phil-002');
  });

  it('auto-enqueue: successful dreamer returns successor info by default', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-enq-001',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-enq-001',
      runId: 'run-enq-001',
      artifactId: 'pi-art-enq-001',
      resultRef: 'dreamer://run-enq-001',
      contextHash: 'ctx-enq',
      output: { valid: true, taskId: 'task-dreamer-enq-001', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'task-dreamer-enq-001',
      successorTaskId: 'task-phil-enq-001',
      successorKind: 'philosopher',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, enqueueNext: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.enqueueDecision).toBe('successor_created');
    expect(output.successorTaskIds![0]).toBe('task-phil-enq-001');
    expect(output.successorKind).toBe('philosopher');
  });

  it('auto-enqueue: repeated run returns existing successorTaskId', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-enq-002',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-enq-002',
      runId: 'run-enq-002',
      artifactId: 'pi-art-enq-002',
      resultRef: 'dreamer://run-enq-002',
      contextHash: 'ctx-enq2',
      output: { valid: true, taskId: 'task-dreamer-enq-002', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_exists',
      sourceTaskId: 'task-dreamer-enq-002',
      successorTaskId: 'task-phil-enq-002',
      successorKind: 'philosopher',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, enqueueNext: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.enqueueDecision).toBe('successor_exists');
    expect(output.successorTaskIds![0]).toBe('task-phil-enq-002');
    expect(output.successorKind).toBe('philosopher');
  });

  it('auto-enqueue: no_successor does not set successor info', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-enq-003',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-enq-003',
      runId: 'run-enq-003',
      artifactId: 'pi-art-enq-003',
      resultRef: 'dreamer://run-enq-003',
      contextHash: 'ctx-enq3',
      output: { valid: true, taskId: 'task-dreamer-enq-003', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'no_successor',
      sourceTaskId: 'task-dreamer-enq-003',
      reason: 'terminal runner',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, enqueueNext: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.enqueueDecision).toBe('no_successor');
    expect(output.successorTaskIds).toEqual([]);
  });

  it('auto-enqueue: failed run does not call commitNextTaskProposal', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-enq-004',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'failed',
      taskId: 'task-dreamer-enq-004',
      errorCategory: 'execution_failed',
      failureReason: 'Runtime unavailable',
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, enqueueNext: true, json: true });

    expect(mockCommitNextTaskProposal).not.toHaveBeenCalled();
  });

  it('auto-enqueue without --allow-test-double still blocked', async () => {
    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', enqueueNext: true });

    expect(process.exitCode).toBe(1);
    expect(mockWakeOnce).not.toHaveBeenCalled();
  });

  it('test-double with --runner philosopher requires --allow-test-double', async () => {
    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'philosopher', runtime: 'test-double' });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy.mock.calls.some((c: string[]) => c[0].includes('test-double runtime mutates real queue state'))).toBe(true);
    expect(mockWakeOnce).not.toHaveBeenCalled();
  });

  it('JSON output includes runnerKind field', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-rk',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-rk',
      runId: 'run-rk',
      artifactId: 'pi-art-rk',
      resultRef: 'dreamer://run-rk',
      contextHash: 'ctx-rk',
      output: { valid: true, taskId: 'task-dreamer-rk', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.runnerKind).toBe('dreamer');
    expect(output.decision).toBe('would_lease');
    expect(output.taskId).toBe('task-dreamer-rk');
    expect(output.runId).toBe('run-rk');
    expect(output.artifactId).toBe('pi-art-rk');
    expect(output.resultRef).toBe('dreamer://run-rk');
  });

  it('--timeout-ms passes effectiveTimeoutMs to DreamerRunner and output', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-tm',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-tm',
      runId: 'run-tm',
      artifactId: 'pi-art-tm',
      resultRef: 'dreamer://run-tm',
      contextHash: 'ctx-tm',
      output: { valid: true, taskId: 'task-dreamer-tm', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, timeoutMs: 180_000, json: true });

    const DreamerRunnerMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.DreamerRunner),
    );
    const lastCall = DreamerRunnerMock.mock.calls[DreamerRunnerMock.mock.calls.length - 1];
    if (lastCall) {
      const opts = lastCall[1] as { timeoutMs?: number };
      expect(opts.timeoutMs).toBe(180_000);
    }

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.effectiveTimeoutMs).toBe(180_000);
  });

  it('default timeoutMs is 300000 when --timeout-ms not provided', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-dt',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-dt',
      runId: 'run-dt',
      artifactId: 'pi-art-dt',
      resultRef: 'dreamer://run-dt',
      contextHash: 'ctx-dt',
      output: { valid: true, taskId: 'task-dreamer-dt', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, json: true });

    const DreamerRunnerMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.DreamerRunner),
    );
    const lastCall = DreamerRunnerMock.mock.calls[DreamerRunnerMock.mock.calls.length - 1];
    if (lastCall) {
      const opts = lastCall[1] as { timeoutMs?: number };
      expect(opts.timeoutMs).toBe(300_000);
    }

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.effectiveTimeoutMs).toBe(300_000);
  });

  it('PRI-670: profile timeoutMs is the runner deadline when --timeout-ms not provided', async () => {
    // The shared resolver returns the diagnostician binding's runtimeProfile
    // timeout (mocked here to 600_000 — the local-llamacpp lab shape). Without
    // the PRI-670 fix the runner deadline stayed hardcoded at 300s and the
    // profile value only reached the adapter as a per-request timeout.
    const coreModule = await import('@principles/core/runtime-v2');
    vi.mocked(coreModule.resolveRuntimeConfigFromPdConfig).mockReturnValue({
      runtimeKind: 'pi-ai', provider: 'test-provider', model: 'test-model',
      apiKeyEnv: 'TEST_API_KEY', timeoutMs: 600_000, agentId: 'main',
    } as never);

    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-pt',
      taskKind: 'dreamer',
    });
    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-pt',
      runId: 'run-pt',
      artifactId: 'pi-art-pt',
      resultRef: 'dreamer://run-pt',
      contextHash: 'ctx-pt',
      output: { valid: true, taskId: 'task-dreamer-pt', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    try {
      await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, json: true });

      const DreamerRunnerMock = vi.mocked(coreModule.DreamerRunner);
      const lastCall = DreamerRunnerMock.mock.calls[DreamerRunnerMock.mock.calls.length - 1];
      if (lastCall) {
        const opts = lastCall[1] as { timeoutMs?: number };
        expect(opts.timeoutMs).toBe(600_000);
      }
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.effectiveTimeoutMs).toBe(600_000);
    } finally {
      vi.mocked(coreModule.resolveRuntimeConfigFromPdConfig).mockReturnValue({
        runtimeKind: 'pi-ai', provider: 'test-provider', model: 'test-model',
        apiKeyEnv: 'TEST_API_KEY', timeoutMs: 300_000, agentId: 'main',
      } as never);
    }
  });

  it('PRI-670: --timeout-ms still wins over the profile timeoutMs', async () => {
    const coreModule = await import('@principles/core/runtime-v2');
    vi.mocked(coreModule.resolveRuntimeConfigFromPdConfig).mockReturnValue({
      runtimeKind: 'pi-ai', provider: 'test-provider', model: 'test-model',
      apiKeyEnv: 'TEST_API_KEY', timeoutMs: 600_000, agentId: 'main',
    } as never);

    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-pt2',
      taskKind: 'dreamer',
    });
    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-pt2',
      runId: 'run-pt2',
      artifactId: 'pi-art-pt2',
      resultRef: 'dreamer://run-pt2',
      contextHash: 'ctx-pt2',
      output: { valid: true, taskId: 'task-dreamer-pt2', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    try {
      await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, timeoutMs: 120_000, json: true });
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.effectiveTimeoutMs).toBe(120_000);
    } finally {
      vi.mocked(coreModule.resolveRuntimeConfigFromPdConfig).mockReturnValue({
        runtimeKind: 'pi-ai', provider: 'test-provider', model: 'test-model',
        apiKeyEnv: 'TEST_API_KEY', timeoutMs: 300_000, agentId: 'main',
      } as never);
    }
  });

  it('timeout source extracted from failureReason on timeout', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-ts',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'failed',
      taskId: 'task-dreamer-ts',
      errorCategory: 'timeout',
      failureReason: '[timeout] LLM request timed out after 300000ms (timeoutSource=provider_request)',
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, timeoutMs: 300_000, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.timeoutSource).toBe('provider_request');
    expect(output.effectiveTimeoutMs).toBe(300_000);
  });

  it('timeout source extracted as runner_poll from abort timeout', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-rp',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'failed',
      taskId: 'task-dreamer-rp',
      errorCategory: 'timeout',
      failureReason: '[timeout] LLM request timed out after 300000ms (timeoutSource=runner_poll)',
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.timeoutSource).toBe('runner_poll');
  });

  it('--timeout-ms overrides .pd/config.yaml timeoutMs for PiAiRuntimeAdapter (PRI-393)', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-ov',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-ov',
      runId: 'run-ov',
      artifactId: 'pi-art-ov',
      resultRef: 'dreamer://run-ov',
      contextHash: 'ctx-ov',
      output: { valid: true, taskId: 'task-dreamer-ov', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'config', timeoutMs: 240_000, json: true });

    const PiAiMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.PiAiRuntimeAdapter),
    );
    const lastCall = PiAiMock.mock.calls[PiAiMock.mock.calls.length - 1];
    if (lastCall) {
      const config = lastCall[0] as { timeoutMs?: number };
      expect(config.timeoutMs).toBe(240_000);
    }

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.effectiveTimeoutMs).toBe(240_000);
  });

  it('--runner scribe dispatches ScribeRunner', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-scribe-001',
      taskKind: 'scribe',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-scribe-001',
      runId: 'run-scribe-001',
      artifactId: 'pi-art-task-scribe-001-run-scribe-001',
      resultRef: 'scribe://run-scribe-001',
      contextHash: 'ctx-scribe-abc',
      output: {
        taskId: 'task-scribe-001',
        sourcePhilosopherArtifactId: 'pi-art-phil-001',
        principleDraft: { title: 'T', statement: 'S', rationale: 'R', applicability: [], antiPatterns: [], confidence: 0.9 },
        sourceTrace: { philosopherArtifactId: 'pi-art-phil-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'scribe', runtime: 'test-double', allowTestDouble: true, json: true });

    const ScribeRunnerMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.ScribeRunner),
    );
    expect(ScribeRunnerMock).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith('task-scribe-001');

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.runnerKind).toBe('scribe');
    expect(output.taskId).toBe('task-scribe-001');
    expect(output.runId).toBe('run-scribe-001');
    expect(output.artifactId).toBe('pi-art-task-scribe-001-run-scribe-001');
    expect(output.resultRef).toBe('scribe://run-scribe-001');
    expect(output.runnerResult.status).toBe('succeeded');
  });

  it('auto-enqueue: --runner scribe creates artificer successor', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-scribe-enq-001',
      taskKind: 'scribe',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-scribe-enq-001',
      runId: 'run-scribe-enq-001',
      artifactId: 'pi-art-scribe-enq-001',
      resultRef: 'scribe://run-scribe-enq-001',
      contextHash: 'ctx-enq',
      output: {
        taskId: 'task-scribe-enq-001',
        sourcePhilosopherArtifactId: 'pi-art-phil-enq-001',
        principleDraft: { title: 'T', statement: 'S', rationale: 'R', applicability: [], antiPatterns: [], confidence: 0.9 },
        sourceTrace: { philosopherArtifactId: 'pi-art-phil-enq-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'task-scribe-enq-001',
      successorTaskId: 'task-artificer-enq-001',
      successorKind: 'artificer',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'scribe', runtime: 'test-double', allowTestDouble: true, enqueueNext: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.enqueueDecision).toBe('successor_created');
    expect(output.successorTaskIds![0]).toBe('task-artificer-enq-001');
    expect(output.successorKind).toBe('artificer');
  });

  it('run-once source imports EvaluatorRunner for dispatch', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const srcPath = resolve(__dirname, '../../src/commands/runtime-internalization-run-once.ts');
    if (!existsSync(srcPath)) return;
    const src = readFileSync(srcPath, 'utf-8');
    expect(src).toContain('EvaluatorRunner');
    expect(src).toContain('DefaultEvaluatorValidator');
  });

  it('--runner artificer dispatches ArtificerRunner', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-artificer-001',
      taskKind: 'artificer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-artificer-001',
      runId: 'run-artificer-001',
      artifactId: 'pi-art-task-artificer-001-run-artificer-001',
      resultRef: 'artificer://run-artificer-001',
      contextHash: 'ctx-artificer-abc',
      output: {
        taskId: 'task-artificer-001',
        sourceScribeArtifactId: 'pi-art-scribe-001',
        implementationPlan: {
          summary: 'Test implementation summary',
          targetSurface: 'src/test/*.ts',
          changes: ['Add validation'],
          tests: ['Unit test for validation'],
          rolloutNotes: ['Deploy behind feature flag'],
          confidence: 0.8,
        },
        sourceTrace: { scribeArtifactId: 'pi-art-scribe-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'artificer', runtime: 'test-double', allowTestDouble: true, json: true });

    const ArtificerRunnerMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.ArtificerRunner),
    );
    expect(ArtificerRunnerMock).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith('task-artificer-001');

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.runnerKind).toBe('artificer');
    expect(output.taskId).toBe('task-artificer-001');
    expect(output.runId).toBe('run-artificer-001');
    expect(output.artifactId).toBe('pi-art-task-artificer-001-run-artificer-001');
    expect(output.resultRef).toBe('artificer://run-artificer-001');
    expect(output.runnerResult.status).toBe('succeeded');
  });

  it('auto-enqueue: --runner artificer returns successor decision', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-artificer-enq-001',
      taskKind: 'artificer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-artificer-enq-001',
      runId: 'run-artificer-enq-001',
      artifactId: 'pi-art-artificer-enq-001',
      resultRef: 'artificer://run-artificer-enq-001',
      contextHash: 'ctx-enq',
      output: {
        taskId: 'task-artificer-enq-001',
        sourceScribeArtifactId: 'pi-art-scribe-enq-001',
        implementationPlan: {
          summary: 'Test implementation summary',
          targetSurface: 'src/test/*.ts',
          changes: ['Add validation'],
          tests: ['Unit test for validation'],
          rolloutNotes: ['Deploy behind feature flag'],
          confidence: 0.8,
        },
        sourceTrace: { scribeArtifactId: 'pi-art-scribe-enq-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'task-artificer-enq-001',
      successorTaskId: 'task-evaluator-enq-001',
      successorKind: 'evaluator',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'artificer', runtime: 'test-double', allowTestDouble: true, enqueueNext: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.enqueueDecision).toBe('successor_created');
    expect(output.successorTaskIds![0]).toBe('task-evaluator-enq-001');
    expect(output.successorKind).toBe('evaluator');
  });

  it('wakeOnce is called with runnerKind as taskKind filter', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-artificer-filter',
      taskKind: 'artificer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-artificer-filter',
      runId: 'run-filter',
      artifactId: 'pi-art-filter',
      resultRef: 'artificer://run-filter',
      contextHash: 'ctx-filter',
      output: {
        taskId: 'task-artificer-filter',
        sourceScribeArtifactId: 'pi-art-scribe-filter',
        implementationPlan: {
          summary: 'Test',
          targetSurface: 'src/test.ts',
          changes: [],
          tests: [],
          rolloutNotes: [],
          confidence: 0.8,
        },
        sourceTrace: { scribeArtifactId: 'pi-art-scribe-filter' },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'artificer', runtime: 'test-double', allowTestDouble: true, json: true });

    expect(mockWakeOnce).toHaveBeenCalledWith('artificer');
  });

  it('--runner evaluator dispatches EvaluatorRunner', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-evaluator-001',
      taskKind: 'evaluator',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-evaluator-001',
      runId: 'run-evaluator-001',
      artifactId: 'pi-art-task-evaluator-001-run-evaluator-001',
      resultRef: 'evaluator://run-evaluator-001',
      contextHash: 'ctx-evaluator-abc',
      output: {
        taskId: 'task-evaluator-001',
        sourceArtificerArtifactId: 'pi-art-artificer-001',
        evaluation: {
          decision: 'approved',
          summary: 'Test evaluation summary',
          score: 0.85,
          strengths: ['Well-structured plan'],
          concerns: [],
          requiredChanges: [],
        },
        sourceTrace: { artificerArtifactId: 'pi-art-artificer-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'evaluator', runtime: 'test-double', allowTestDouble: true, json: true });

    const EvaluatorRunnerMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.EvaluatorRunner),
    );
    expect(EvaluatorRunnerMock).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith('task-evaluator-001');

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.runnerKind).toBe('evaluator');
    expect(output.taskId).toBe('task-evaluator-001');
    expect(output.runId).toBe('run-evaluator-001');
    expect(output.artifactId).toBe('pi-art-task-evaluator-001-run-evaluator-001');
    expect(output.resultRef).toBe('evaluator://run-evaluator-001');
    expect(output.runnerResult.status).toBe('succeeded');
  });

  it('auto-enqueue: --runner evaluator returns successor decision', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-evaluator-enq-001',
      taskKind: 'evaluator',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-evaluator-enq-001',
      runId: 'run-evaluator-enq-001',
      artifactId: 'pi-art-evaluator-enq-001',
      resultRef: 'evaluator://run-evaluator-enq-001',
      contextHash: 'ctx-enq',
      output: {
        taskId: 'task-evaluator-enq-001',
        sourceArtificerArtifactId: 'pi-art-artificer-enq-001',
        evaluation: {
          decision: 'approved',
          summary: 'Test evaluation summary',
          score: 0.85,
          strengths: ['Well-structured plan'],
          concerns: [],
          requiredChanges: [],
        },
        sourceTrace: { artificerArtifactId: 'pi-art-artificer-enq-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'task-evaluator-enq-001',
      successorTaskId: 'task-rollout-reviewer-enq-001',
      successorKind: 'rollout_reviewer',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'evaluator', runtime: 'test-double', allowTestDouble: true, enqueueNext: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.enqueueDecision).toBe('successor_created');
    expect(output.successorTaskIds![0]).toBe('task-rollout-reviewer-enq-001');
    expect(output.successorKind).toBe('rollout_reviewer');
  });

  it('--runner rollout_reviewer dispatches RolloutReviewerRunner', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-rollout-reviewer-001',
      taskKind: 'rollout_reviewer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-rollout-reviewer-001',
      runId: 'run-rollout-reviewer-001',
      artifactId: 'pi-art-task-rollout-reviewer-001-run-rollout-reviewer-001',
      resultRef: 'rollout-reviewer://run-rollout-reviewer-001',
      contextHash: 'ctx-rr-abc',
      output: {
        taskId: 'task-rollout-reviewer-001',
        sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
        review: {
          decision: 'approve_rollout',
          summary: 'Test rollout review summary',
          confidence: 0.9,
          requiredChanges: [],
          rolloutRisks: [],
          safetyChecks: ['Verify feature flag is properly configured'],
        },
        sourceTrace: { evaluatorArtifactId: 'pi-art-evaluator-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'rollout_reviewer', runtime: 'test-double', allowTestDouble: true, json: true });

    const RolloutReviewerRunnerMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.RolloutReviewerRunner),
    );
    expect(RolloutReviewerRunnerMock).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith('task-rollout-reviewer-001');

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.runnerKind).toBe('rollout_reviewer');
    expect(output.taskId).toBe('task-rollout-reviewer-001');
    expect(output.runId).toBe('run-rollout-reviewer-001');
    expect(output.artifactId).toBe('pi-art-task-rollout-reviewer-001-run-rollout-reviewer-001');
    expect(output.resultRef).toBe('rollout-reviewer://run-rollout-reviewer-001');
    expect(output.runnerResult.status).toBe('succeeded');
  });

  it('auto-enqueue: --runner rollout_reviewer returns no_successor for prompt channel', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-rollout-reviewer-enq-001',
      taskKind: 'rollout_reviewer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-rollout-reviewer-enq-001',
      runId: 'run-rollout-reviewer-enq-001',
      artifactId: 'pi-art-rollout-reviewer-enq-001',
      resultRef: 'rollout-reviewer://run-rollout-reviewer-enq-001',
      contextHash: 'ctx-enq',
      output: {
        taskId: 'task-rollout-reviewer-enq-001',
        sourceEvaluatorArtifactId: 'pi-art-evaluator-enq-001',
        review: {
          decision: 'approve_rollout',
          summary: 'Test rollout review summary',
          confidence: 0.9,
          requiredChanges: [],
          rolloutRisks: [],
          safetyChecks: ['Verify feature flag is properly configured'],
        },
        sourceTrace: { evaluatorArtifactId: 'pi-art-evaluator-enq-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'no_successor',
      sourceTaskId: 'task-rollout-reviewer-enq-001',
      reason: 'No valid successor in job graph for this task kind and channel',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'rollout_reviewer', runtime: 'test-double', allowTestDouble: true, enqueueNext: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.enqueueDecision).toBe('no_successor');
  });

  it('--runtime config with missing config outputs structured JSON error', async () => {
    // PRI-393: mock resolveRuntimeFromPdConfig to return config error
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: {
        reason: 'explicit_config_missing',
        message: 'runtime=config requested but no .pd/config.yaml runtime binding found',
        nextAction: 'Add runtime binding to .pd/config.yaml',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: false, effective: {}, defaults: {}, legacyFilesDetected: [] },
    });

    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-cfg-err',
      taskKind: 'dreamer',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'config', json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('config_error');
    expect(output.reason).toContain('explicit_config_missing');
    expect(output.nextAction).toBeTruthy();
    expect(process.exitCode).toBe(1);
  });

  it('--runtime config with missing config outputs text error', async () => {
    // PRI-393: mock resolveRuntimeFromPdConfig to return config error
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: {
        reason: 'explicit_config_missing',
        message: 'runtime=config requested but no .pd/config.yaml runtime binding found',
        nextAction: 'Add runtime binding to .pd/config.yaml',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: false, effective: {}, defaults: {}, legacyFilesDetected: [] },
    });

    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-cfg-err2',
      taskKind: 'dreamer',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runtime: 'config', json: false });

    expect(consoleErrorSpy.mock.calls.some((c: string[]) => c[0].includes('explicit_config_missing'))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('runtime execution error outputs runtime_error in JSON mode', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-rt-err',
      taskKind: 'dreamer',
    });
    mockRun.mockRejectedValueOnce(new Error('artifact write failed: disk full'));

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('runtime_error');
    expect(output.reason).toContain('artifact write failed');
    expect(output.nextAction).toBeTruthy();
    expect(process.exitCode).toBe(1);
  });

  // === Default enqueue successor tests ===

  it('default behavior (no --no-enqueue-next) auto-enqueues successor on runner success', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-auto-001',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-auto-001',
      runId: 'run-auto-001',
      artifactId: 'pi-art-auto-001',
      resultRef: 'dreamer://run-auto-001',
      contextHash: 'ctx-auto',
      output: { valid: true, taskId: 'task-dreamer-auto-001', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'task-dreamer-auto-001',
      successorTaskId: 'task-phil-auto-001',
      successorKind: 'philosopher',
    });

    // No enqueueNext specified — default should auto-enqueue
    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.successorEnqueueAttempted).toBe(true);
    expect(output.successorTasksCreated).toBe(1);
    expect(output.successorTaskIds).toContain('task-phil-auto-001');
    expect(output.enqueueDecision).toBe('successor_created');
    expect(output.successorKind).toBe('philosopher');
    expect(mockCommitNextTaskProposal).toHaveBeenCalledWith('task-dreamer-auto-001');
  });

  it('--no-enqueue-next (enqueueNext: false) skips successor enqueue', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-skip-001',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-skip-001',
      runId: 'run-skip-001',
      artifactId: 'pi-art-skip-001',
      resultRef: 'dreamer://run-skip-001',
      contextHash: 'ctx-skip',
      output: { valid: true, taskId: 'task-dreamer-skip-001', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, enqueueNext: false, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.successorEnqueueAttempted).toBe(false);
    expect(output.nextAction).toContain('--no-enqueue-next');
    expect(mockCommitNextTaskProposal).not.toHaveBeenCalled();
  });

  it('successor enqueue failure outputs partial_success with reason and nextAction', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-fail-001',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-fail-001',
      runId: 'run-fail-001',
      artifactId: 'pi-art-fail-001',
      resultRef: 'dreamer://run-fail-001',
      contextHash: 'ctx-fail',
      output: { valid: true, taskId: 'task-dreamer-fail-001', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockRejectedValue(new Error('database locked'));

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('partial_success');
    expect(output.successorEnqueueAttempted).toBe(true);
    expect(output.enqueueDecision).toBe('enqueue_failed');
    expect(output.enqueueReason).toContain('database locked');
    expect(output.nextAction).toContain('enqueue-successors');
    expect(output.successorTasksCreated).toBe(0);
    expect(output.successorTaskIds).toEqual([]);
  });

  it('runner failure never enqueues successor (default behavior)', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-nofail-001',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'failed',
      taskId: 'task-dreamer-nofail-001',
      errorCategory: 'execution_failed',
      failureReason: 'Runtime unavailable',
      attemptCount: 1,
    });

    // Default behavior (no --no-enqueue-next)
    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, json: true });

    expect(mockCommitNextTaskProposal).not.toHaveBeenCalled();
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.successorEnqueueAttempted).toBeUndefined();
  });

  it('JSON output is single parseable JSON with successor fields', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-json-001',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-json-001',
      runId: 'run-json-001',
      artifactId: 'pi-art-json-001',
      resultRef: 'dreamer://run-json-001',
      contextHash: 'ctx-json',
      output: { valid: true, taskId: 'task-dreamer-json-001', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'task-dreamer-json-001',
      successorTaskId: 'task-phil-json-001',
      successorKind: 'philosopher',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, json: true });

    const rawOutput = consoleLogSpy.mock.calls[0][0];
    // Must be single parseable JSON
    const output = JSON.parse(rawOutput);
    expect(output).toHaveProperty('successorEnqueueAttempted');
    expect(output).toHaveProperty('successorTasksCreated');
    expect(output).toHaveProperty('successorTaskIds');
    // nextAction may be undefined when successor is successfully created
    // but must be present on partial_success / no_successor / skipped
  });

  it('text output for auto-enqueue shows successor info', async () => {
    mockWakeOnce.mockResolvedValue({
      decision: 'would_lease',
      taskId: 'task-dreamer-text-001',
      taskKind: 'dreamer',
    });

    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'task-dreamer-text-001',
      runId: 'run-text-001',
      artifactId: 'pi-art-text-001',
      resultRef: 'dreamer://run-text-001',
      contextHash: 'ctx-text',
      output: { valid: true, taskId: 'task-dreamer-text-001', candidates: VALID_DREAMER_CANDIDATES, contextRefs: [], generatedAt: new Date().toISOString() },
      attemptCount: 1,
    });

    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'task-dreamer-text-001',
      successorTaskId: 'task-phil-text-001',
      successorKind: 'philosopher',
    });

    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, json: false });

    const text = consoleLogSpy.mock.calls.map((c: string[]) => c[0]).join('\n');
    expect(text).toContain('successor: task-phil-text-001');
    expect(text).toContain('enqueue_attempted: true');
    expect(text).toContain('successors_created: 1');
  });
});

// === Commander parser-level tests for --no-enqueue-next ===
// These tests verify that Commander correctly maps --no-enqueue-next to opts.enqueueNext.
// They exercise the real Commander parsing path, NOT the handler directly.
// See ERR-063: previous code used opts.noEnqueueNext (always undefined) instead of opts.enqueueNext.

describe('Commander --no-enqueue-next parser wiring', () => {
  function buildRunOnceCommand(capturedOpts: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Command } = require('commander') as typeof import('commander');
    const program = new Command();
    program.exitOverride(); // prevent process.exit during tests

    const internalizationCmd = program.command('internalization');
    internalizationCmd
      .command('run-once')
      .description('Wake-and-run: lease the next PI task and execute it')
      .option('-w, --workspace <path>', 'Workspace directory')
      .option('--runner <kind>', 'Runner kind', 'dreamer')
      .option('--runtime <kind>', 'Runtime adapter kind', 'config')
      .option('--allow-test-double', 'Acknowledge test-double runtime')
      .option('--no-enqueue-next', 'Skip successor enqueue after successful runner')
      .option('--timeout-ms <ms>', 'Runner timeout', parseInt)
      .option('--json', 'Output raw JSON')
      .action(async (opts) => {
        Object.assign(capturedOpts, opts);
      });

    return program;
  }

  it('with --no-enqueue-next, Commander sets enqueueNext=false', async () => {
    const captured: Record<string, unknown> = {};
    const program = buildRunOnceCommand(captured);

    await program.parseAsync([
      'node', 'pd', 'internalization', 'run-once',
      '--no-enqueue-next',
      '--workspace', '/tmp/test',
      '--runtime', 'test-double',
      '--allow-test-double',
      '--json',
    ]);

    expect(captured).toHaveProperty('enqueueNext', false);
    expect(captured).not.toHaveProperty('noEnqueueNext');
  });

  it('without --no-enqueue-next, Commander sets enqueueNext=true (default)', async () => {
    const captured: Record<string, unknown> = {};
    const program = buildRunOnceCommand(captured);

    await program.parseAsync([
      'node', 'pd', 'internalization', 'run-once',
      '--workspace', '/tmp/test',
      '--runtime', 'test-double',
      '--allow-test-double',
      '--json',
    ]);

    expect(captured).toHaveProperty('enqueueNext', true);
  });

  it('opts has no noEnqueueNext property regardless of flag presence', async () => {
    const capturedWith: Record<string, unknown> = {};
    const programWith = buildRunOnceCommand(capturedWith);
    await programWith.parseAsync([
      'node', 'pd', 'internalization', 'run-once',
      '--no-enqueue-next', '--workspace', '/tmp/test',
    ]);

    const capturedWithout: Record<string, unknown> = {};
    const programWithout = buildRunOnceCommand(capturedWithout);
    await programWithout.parseAsync([
      'node', 'pd', 'internalization', 'run-once',
      '--workspace', '/tmp/test',
    ]);

    expect(capturedWith).not.toHaveProperty('noEnqueueNext');
    expect(capturedWithout).not.toHaveProperty('noEnqueueNext');
  });
});
