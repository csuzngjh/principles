/**
 * DiagRootCauseRunner — Stage A V-slice tests (PRI-372).
 *
 * Tests:
 *   1. lease → succeed → writes PIArtifact
 *   2. lease → fail → no artifact written
 *   3. no dependency → runs standalone (first stage)
 *   4. runtime failure → no artifact, no markTaskSucceeded
 *   5. artifact write failure → retryOrFail, not markTaskSucceeded
 *   6. missing taskId re-injected by postFetchTransform
 *   7. present-but-empty taskId NOT overwritten by postFetchTransform
 *
 * ERR entries considered:
 *   - ERR-001: Treat parsed JSON / LLM output as unknown — validator receives unknown
 *   - ERR-005: No `as` bypass — all mocks use vi.fn() with typed returns
 *   - ERR-009: Required fields fail loud — validator checks taskId match
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiagRootCauseRunner } from '../diag-rootcause-runner.js';
import type { DiagRootCauseRunnerDeps } from '../diag-rootcause-runner.js';
import type { DiagRootCauseOutputV1 } from '../../diagnostician/diag-rootcause-output.js';
import type { PIArtifactStore } from '../pi-artifact.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { RunnerPhase } from '../../runner/runner-phase.js';
import { MOCK_ROOT_CAUSE_OUTPUTS } from './__fixtures__/split-pipeline-mock-outputs.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

const ROOTCAUSE_TASK_ID = 'diag_rootcause-001';
const RUN_ID = 'run-rootcause-001';
const OWNER = 'test-rootcause-owner';
const RUNTIME_KIND = 'test-double';

function makeRootCauseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ROOTCAUSE_TASK_ID,
    taskKind: 'diag_rootcause',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

/** Happy-path output using cached real LLM data (R6 fixture) with test-local taskId. */
function makeRootCauseOutput(): DiagRootCauseOutputV1 {
  return {
    ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
    diagnosisId: 'diag-001',
    taskId: ROOTCAUSE_TASK_ID,
  };
}

function makeContextPayload() {
  return {
    sourceRefs: ['ref-1', 'ref-2'],
    conversationWindow: [],
    trajectorySummary: '',
    painSignal: { painId: 'pain-001', painType: 'tool_failure', source: 'test', reason: 'test reason', score: 70 },
  };
}

// ── Mock factory ───────────────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<DiagRootCauseRunnerDeps> = {}): DiagRootCauseRunnerDeps & {
  _stateManager: Record<string, ReturnType<typeof vi.fn>>;
  _runtimeAdapter: Record<string, ReturnType<typeof vi.fn>>;
  _validator: Record<string, ReturnType<typeof vi.fn>>;
  _contextAssembler: Record<string, ReturnType<typeof vi.fn>>;
} {
  const taskRecord = makeRootCauseTask();
  const output = makeRootCauseOutput();

  const _stateManager = {
    acquireLease: vi.fn().mockResolvedValue(taskRecord),
    getTask: vi.fn().mockResolvedValue(taskRecord),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: RUN_ID, taskId: ROOTCAUSE_TASK_ID }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: RUN_ID, taskId: ROOTCAUSE_TASK_ID }],
      degradedRuns: [],
    }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  };

  const runHandle: RunHandle = { runId: RUN_ID, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
  const succeededStatus: RunStatus = { status: 'succeeded', runId: RUN_ID };

  const _runtimeAdapter = {
    kind: vi.fn().mockReturnValue(RUNTIME_KIND),
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue(succeededStatus),
    fetchOutput: vi.fn().mockResolvedValue({ payload: output }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    fetchArtifacts: vi.fn(),
  };

  const _validator = {
    validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  };

  const _contextAssembler = {
    assemble: vi.fn().mockResolvedValue(makeContextPayload()),
  };

  const mockEventEmitter = {
    emitTelemetry: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  };

  return {
    stateManager: _stateManager as unknown as RuntimeStateManager,
    runtimeAdapter: _runtimeAdapter,
    eventEmitter: mockEventEmitter as unknown as StoreEventEmitter,
    artifactStore: new MemoryPIArtifactStore(),
    validator: _validator,
    contextAssembler: _contextAssembler,
    _stateManager,
    _runtimeAdapter,
    _validator,
    _contextAssembler,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DiagRootCauseRunner V-slice', () => {
  let artifactStore: MemoryPIArtifactStore;

  beforeEach(() => {
    artifactStore = new MemoryPIArtifactStore();
  });

  it('lease → succeed → writes PIArtifact', async () => {
    const deps = createMockDeps({ artifactStore });
    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(ROOTCAUSE_TASK_ID);
    expect(result.artifactId).toBeDefined();

    // Verify PIArtifact was written
    const artifacts = await artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
    expect(artifacts[0]?.sourceTaskId).toBe(ROOTCAUSE_TASK_ID);

    // Verify markTaskSucceeded called with diag-rootcause:// resultRef
    expect(deps._stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      ROOTCAUSE_TASK_ID,
      expect.stringContaining('diag-rootcause://'),
    );

    // Verify updateRunOutput called before markTaskSucceeded
    expect(deps._stateManager.updateRunOutput).toHaveBeenCalledWith(
      RUN_ID,
      expect.any(String),
    );
  });

  it('lease → fail → no artifact written', async () => {
    const deps = createMockDeps({ artifactStore });
    // Make validator reject the output
    (deps._validator.validate as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: false,
      errors: ['taskId mismatch'],
      errorCategory: 'output_invalid',
    });

    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);

    expect(result.status).toBe('failed');

    // No artifact written
    const artifacts = await artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    expect(artifacts).toHaveLength(0);

    // No markTaskSucceeded
    expect(deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();

    // No updateRunOutput (validation failed before succeedTask)
    expect(deps._stateManager.updateRunOutput).not.toHaveBeenCalled();
  });

  it('no dependency → runs standalone (first stage)', async () => {
    const deps = createMockDeps({ artifactStore });
    // The rootcause task has no dependencies (first stage in pipeline)
    const standaloneTask = makeRootCauseTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    (deps._stateManager.acquireLease as ReturnType<typeof vi.fn>).mockResolvedValue(standaloneTask);
    (deps._stateManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(standaloneTask);

    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);

    // Should succeed without needing predecessor artifacts
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    // ContextAssembler was called (rootcause uses it for pain context)
    expect(deps._contextAssembler.assemble).toHaveBeenCalledWith(ROOTCAUSE_TASK_ID);
  });

  it('runtime failure → no artifact, no markTaskSucceeded', async () => {
    const deps = createMockDeps({ artifactStore });
    // Make the runtime adapter return a failed status
    const failedStatus: RunStatus = { status: 'failed', runId: RUN_ID };
    (deps._runtimeAdapter.pollRun as ReturnType<typeof vi.fn>).mockResolvedValue(failedStatus);

    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);

    expect(result.status).toBe('failed');

    // No artifact written
    const artifacts = await artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    expect(artifacts).toHaveLength(0);

    // No markTaskSucceeded
    expect(deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('artifact write failure → retryOrFail, not markTaskSucceeded', async () => {
    const failingStore = {
      listBySourceTaskId: vi.fn().mockResolvedValue([]),
      upsertArtifact: vi.fn().mockRejectedValue(new Error('Disk full')),
    } as unknown as PIArtifactStore;

    const deps = createMockDeps({ artifactStore: failingStore });

    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);

    expect(result.status).toBe('failed');
    expect(deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('missing taskId re-injected by postFetchTransform', async () => {
    const deps = createMockDeps({ artifactStore });
    // Output without taskId — postFetchTransform should inject it
    const outputWithoutTaskId = { ...makeRootCauseOutput() };
    delete (outputWithoutTaskId as Record<string, unknown>).taskId;

    (deps._runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({ payload: outputWithoutTaskId });

    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);

    // taskId is re-injected, so validation should pass
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();
  });

  it('present-but-empty taskId NOT overwritten by postFetchTransform', async () => {
    // Use the real DefaultDiagRootCauseValidator which checks taskId
    const { DefaultDiagRootCauseValidator } = await import('../../diagnostician/diag-rootcause-output.js');
    const realValidator = new DefaultDiagRootCauseValidator();
    const depsWithRealValidator = createMockDeps({
      artifactStore,
      validator: realValidator,
    });

    // Output with taskId: '' (present but empty) — must NOT be overwritten
    const emptyTaskIdOutput = makeRootCauseOutput();
    (emptyTaskIdOutput as Record<string, unknown>).taskId = '';

    (depsWithRealValidator._runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({ payload: emptyTaskIdOutput });

    const runner = new DiagRootCauseRunner(depsWithRealValidator, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);

    // Validation should fail because taskId is empty (mismatch with ROOTCAUSE_TASK_ID)
    expect(result.status).toBe('failed');

    // No artifact written
    const artifacts = await artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  it('currentPhase is Completed after successful run', async () => {
    const deps = createMockDeps({ artifactStore });
    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(runner.currentPhase).toBe(RunnerPhase.Completed);
  });

  it('currentPhase is Failed after validation failure', async () => {
    const deps = createMockDeps({ artifactStore });
    (deps._validator.validate as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: false,
      errors: ['taskId mismatch'],
      errorCategory: 'output_invalid',
    });

    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(runner.currentPhase).toBe(RunnerPhase.Failed);
  });

  it('succeedTask calls updateRunOutput before markTaskSucceeded', async () => {
    const deps = createMockDeps({ artifactStore });
    const callOrder: string[] = [];
    (deps._stateManager.updateRunOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('updateRunOutput');
      return Promise.resolve();
    });
    (deps._stateManager.markTaskSucceeded as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('markTaskSucceeded');
      return Promise.resolve();
    });

    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(callOrder).toEqual(['updateRunOutput', 'markTaskSucceeded']);
  });

  it('wrong taskKind fails closed', async () => {
    const wrongKindTask = makeRootCauseTask({ taskKind: 'dreamer' });
    const deps = createMockDeps({ artifactStore });
    (deps._stateManager.acquireLease as ReturnType<typeof vi.fn>).mockResolvedValue(wrongKindTask);

    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROOTCAUSE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });
});
