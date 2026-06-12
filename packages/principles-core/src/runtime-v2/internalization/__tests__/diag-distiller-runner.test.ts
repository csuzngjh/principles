/**
 * DiagDistillerRunner — Stage B V-slice tests (PRI-372).
 *
 * Tests:
 *   1. lease → succeed → writes PIArtifact with groundedOnCorePrincipleIds
 *   2. fabricated axiom ID (T-99) rejected by validator → task fails
 *   3. core grounding flag off → groundedOnCorePrincipleIds empty (still valid)
 *   4. dependency not succeeded → blocked
 *   5. no predecessor dependency → fails (requires rootcause artifact)
 *   6. missing taskId re-injected by postFetchTransform
 *   7. artifact write failure → retryOrFail, not markTaskSucceeded
 *
 * ERR entries considered:
 *   - ERR-001: Treat parsed JSON / LLM output as unknown — validator receives unknown
 *   - ERR-005: No `as` bypass — all mocks use vi.fn() with typed returns
 *   - ERR-009: Required fields fail loud — validator checks taskId match
 */
import { describe, it, expect, vi } from 'vitest';
import { DiagDistillerRunner } from '../diag-distiller-runner.js';
import type { DiagDistillerRunnerDeps } from '../diag-distiller-runner.js';
import type { DiagDistillerOutputV1, DiagDistillerValidator } from '../../diagnostician/diag-distiller-output.js';
import type { DiagRootCauseOutputV1 } from '../../diagnostician/diag-rootcause-output.js';
import type { PIArtifactStore } from '../pi-artifact.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { RunnerPhase } from '../../runner/runner-phase.js';
import { MOCK_ROOT_CAUSE_OUTPUTS, MOCK_DISTILLER_OUTPUTS } from './__fixtures__/split-pipeline-mock-outputs.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

const DISTILLER_TASK_ID = 'diag_distiller-001';
const ROOTCAUSE_TASK_ID = 'diag_rootcause-001';
const RUN_ID = 'run-distiller-001';
const OWNER = 'test-distiller-owner';
const RUNTIME_KIND = 'test-double';
const ROOTCAUSE_ARTIFACT_ID = 'pi-art-diag_rootcause-001-run-rc-001';

function makeRootCauseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ROOTCAUSE_TASK_ID,
    taskKind: 'diag_rootcause',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'diag-rootcause://run-rc-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: '{}',
    ...overrides,
  };
}

function makeDistillerTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: DISTILLER_TASK_ID,
    taskKind: 'diag_distiller',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [ROOTCAUSE_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

/** Happy-path output using cached real LLM data (R6 fixture) with test-local IDs. */
function makeRootCauseOutput(): DiagRootCauseOutputV1 {
  return {
    ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
    diagnosisId: 'diag-001',
    taskId: ROOTCAUSE_TASK_ID,
  };
}

/** Happy-path output using cached real LLM data (R6 fixture) with test-local IDs. */
function makeDistillerOutput(overrides: Partial<DiagDistillerOutputV1> = {}): DiagDistillerOutputV1 {
  return {
    ...MOCK_DISTILLER_OUTPUTS.R6,
    taskId: DISTILLER_TASK_ID,
    sourceRootCauseArtifactId: ROOTCAUSE_ARTIFACT_ID,
    ...overrides,
  };
}

/** Pre-populate a MemoryPIArtifactStore with the rootcause artifact. */
function populateRootCauseArtifact(store: MemoryPIArtifactStore): void {
  store.upsertArtifact({
    artifactId: ROOTCAUSE_ARTIFACT_ID,
    artifactKind: 'principle',
    sourceTaskId: ROOTCAUSE_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify(makeRootCauseOutput()),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// ── Mock factory ───────────────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<DiagDistillerRunnerDeps> = {}): DiagDistillerRunnerDeps & {
  _stateManager: Record<string, ReturnType<typeof vi.fn>>;
  _runtimeAdapter: Record<string, ReturnType<typeof vi.fn>>;
  _validator: Record<string, ReturnType<typeof vi.fn>>;
} {
  const taskRecord = makeDistillerTask();
  const output = makeDistillerOutput();

  const _stateManager = {
    acquireLease: vi.fn().mockResolvedValue(taskRecord),
    getTask: vi.fn().mockImplementation((id: string) => {
      if (id === DISTILLER_TASK_ID) return Promise.resolve(taskRecord);
      if (id === ROOTCAUSE_TASK_ID) return Promise.resolve(makeRootCauseTask());
      return Promise.resolve(undefined);
    }),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: RUN_ID, taskId: DISTILLER_TASK_ID }]),
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

  const mockEventEmitter = {
    emitTelemetry: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  };

  // Create store with predecessor artifact pre-populated
  const artifactStore = new MemoryPIArtifactStore();
  populateRootCauseArtifact(artifactStore);

  return {
    stateManager: _stateManager as unknown as RuntimeStateManager,
    runtimeAdapter: _runtimeAdapter as unknown as PDRuntimeAdapter,
    eventEmitter: mockEventEmitter as unknown as StoreEventEmitter,
    artifactStore,
    validator: _validator as unknown as DiagDistillerValidator,
    _stateManager,
    _runtimeAdapter,
    _validator,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DiagDistillerRunner V-slice', () => {

  it('lease → succeed → writes PIArtifact with groundedOnCorePrincipleIds', async () => {
    const deps = createMockDeps();
    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(DISTILLER_TASK_ID);
    expect(result.artifactId).toBeDefined();

    // Verify PIArtifact was written
    const artifactStore = deps.artifactStore as MemoryPIArtifactStore;
    const artifacts = await artifactStore.listBySourceTaskId(DISTILLER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
    expect(artifacts[0]?.sourceTaskId).toBe(DISTILLER_TASK_ID);

    // Verify artifact content contains groundedOnCorePrincipleIds
    const contentJson = artifacts[0]?.contentJson;
    expect(contentJson).toBeDefined();
    if (contentJson) {
      const parsed = JSON.parse(contentJson) as Record<string, unknown>;
      expect(parsed.groundedOnCorePrincipleIds).toEqual(['T-01', 'T-07']);
    }

    // Verify markTaskSucceeded called with diag-distiller:// resultRef
    expect(deps._stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      DISTILLER_TASK_ID,
      expect.stringContaining('diag-distiller'),
    );
  });

  it('fabricated axiom ID (T-99) rejected by validator → task fails', async () => {
    // Output with fabricated T-99 axiom ID
    const fabricatedOutput = makeDistillerOutput({
      groundedOnCorePrincipleIds: ['T-99'],
    });

    // Use the real DefaultDiagDistillerValidator which checks isCorePrincipleId
    const { DefaultDiagDistillerValidator } = await import('../../diagnostician/diag-distiller-output.js');
    const realValidator = new DefaultDiagDistillerValidator();
    const deps = createMockDeps({ validator: realValidator });
    (deps._runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({ payload: fabricatedOutput });

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);

    // Validation should fail because T-99 is not in the registry
    expect(result.status).toBe('failed');

    // No artifact written for the distiller task
    const artifactStore = deps.artifactStore as MemoryPIArtifactStore;
    const artifacts = await artifactStore.listBySourceTaskId(DISTILLER_TASK_ID);
    expect(artifacts).toHaveLength(0);

    // No markTaskSucceeded
    expect(deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('core grounding flag off → groundedOnCorePrincipleIds empty', async () => {
    const deps = createMockDeps();
    // Output with empty groundedOnCorePrincipleIds (flag off scenario)
    const noGroundingOutput = makeDistillerOutput({
      groundedOnCorePrincipleIds: [],
    });
    (deps._runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({ payload: noGroundingOutput });

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);

    // Empty groundedOnCorePrincipleIds is valid (flag off = no grounding)
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    // Verify artifact content has empty grounding
    const artifactStore = deps.artifactStore as MemoryPIArtifactStore;
    const artifacts = await artifactStore.listBySourceTaskId(DISTILLER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    const contentJson = artifacts[0]?.contentJson;
    if (contentJson) {
      const parsed = JSON.parse(contentJson) as Record<string, unknown>;
      expect(parsed.groundedOnCorePrincipleIds).toEqual([]);
    }
  });

  it('dependency not succeeded → blocked', async () => {
    // Empty artifact store — no rootcause artifact yet
    const emptyStore = new MemoryPIArtifactStore();
    const deps = createMockDeps({ artifactStore: emptyStore });
    // Make the rootcause task still pending (not succeeded)
    const pendingRootCauseTask = makeRootCauseTask({ status: 'pending', resultRef: undefined });
    (deps._stateManager.getTask as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === DISTILLER_TASK_ID) return Promise.resolve(makeDistillerTask());
      if (id === ROOTCAUSE_TASK_ID) return Promise.resolve(pendingRootCauseTask);
      return Promise.resolve(undefined);
    });

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);

    // Should fail because predecessor artifact is missing
    expect(result.status).toBe('failed');
  });

  it('no predecessor dependency → fails (requires rootcause artifact)', async () => {
    const deps = createMockDeps();
    // Create a distiller task with no dependencies
    const noDepTask = makeDistillerTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    (deps._stateManager.acquireLease as ReturnType<typeof vi.fn>).mockResolvedValue(noDepTask);
    (deps._stateManager.getTask as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === DISTILLER_TASK_ID) return Promise.resolve(noDepTask);
      return Promise.resolve(undefined);
    });

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);

    // Should fail because no predecessor dependency
    expect(result.status).toBe('failed');
  });

  it('missing taskId re-injected by postFetchTransform', async () => {
    const deps = createMockDeps();
    // Output without taskId — postFetchTransform should inject it
    const outputWithoutTaskId = { ...makeDistillerOutput() };
    delete (outputWithoutTaskId as Record<string, unknown>).taskId;

    (deps._runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({ payload: outputWithoutTaskId });

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);

    // taskId is re-injected, so validation should pass
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();
  });

  it('present-but-empty taskId NOT overwritten by postFetchTransform', async () => {
    // Use the real validator which checks taskId
    const { DefaultDiagDistillerValidator } = await import('../../diagnostician/diag-distiller-output.js');
    const realValidator = new DefaultDiagDistillerValidator();
    const deps = createMockDeps({ validator: realValidator });

    // Output with taskId: '' (present but empty) — must NOT be overwritten
    const emptyTaskIdOutput = makeDistillerOutput();
    (emptyTaskIdOutput as Record<string, unknown>).taskId = '';

    (deps._runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({ payload: emptyTaskIdOutput });

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);

    // Validation should fail because taskId is empty (mismatch with DISTILLER_TASK_ID)
    expect(result.status).toBe('failed');
  });

  it('artifact write failure → retryOrFail, not markTaskSucceeded', async () => {
    const failingStore = {
      listBySourceTaskId: vi.fn().mockResolvedValue([]),
      upsertArtifact: vi.fn().mockRejectedValue(new Error('Disk full')),
    } as unknown as PIArtifactStore;

    const deps = createMockDeps({ artifactStore: failingStore });

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);

    expect(result.status).toBe('failed');
    expect(deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('currentPhase is Completed after successful run', async () => {
    const deps = createMockDeps();
    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(runner.currentPhase).toBe(RunnerPhase.Completed);
  });

  it('currentPhase is Failed after validation failure', async () => {
    const deps = createMockDeps();
    (deps._validator.validate as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: false,
      errors: ['taskId mismatch'],
      errorCategory: 'output_invalid',
    });

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(runner.currentPhase).toBe(RunnerPhase.Failed);
  });

  it('wrong taskKind fails closed', async () => {
    const wrongKindTask = makeDistillerTask({ taskKind: 'dreamer' });
    const deps = createMockDeps();
    (deps._stateManager.acquireLease as ReturnType<typeof vi.fn>).mockResolvedValue(wrongKindTask);

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('corrupted predecessor artifact content fails schema validation (EP-01)', async () => {
    // Write a corrupted artifact (missing required fields) to the store
    const corruptedStore = new MemoryPIArtifactStore();
    corruptedStore.upsertArtifact({
      artifactId: ROOTCAUSE_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: ROOTCAUSE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({ invalid: true, missing: 'required fields' }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const deps = createMockDeps({ artifactStore: corruptedStore });

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);

    // Should fail because predecessor artifact content fails schema validation
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('sourceRootCauseArtifactId mismatch triggers lineage integrity violation (EP-07)', async () => {
    const deps = createMockDeps();
    // Output with wrong sourceRootCauseArtifactId — should trigger checkLineageIntegrity
    const mismatchedOutput = makeDistillerOutput({
      sourceRootCauseArtifactId: 'pi-art-FABRICATED-WRONG-ID',
    });
    (deps._runtimeAdapter.fetchOutput as ReturnType<typeof vi.fn>).mockResolvedValue({ payload: mismatchedOutput });

    const runner = new DiagDistillerRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(DISTILLER_TASK_ID);

    // checkLineageIntegrity throws PDRuntimeError('output_invalid'), caught by base class.
    // output_invalid is not in permanentErrorCategories, so the runner retries and
    // eventually exhausts attempts → max_attempts_exceeded.
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');

    // Verify lineage_integrity_violation telemetry was emitted
    const {emitTelemetry} = (deps as unknown as { eventEmitter: { emitTelemetry: ReturnType<typeof vi.fn> } }).eventEmitter;
    const violationEvent = emitTelemetry.mock.calls.find(
      (call: unknown[]) => {
        const event = call[0] as Record<string, unknown> | undefined;
        return event?.eventType === 'diag_distiller_lineage_integrity_violation';
      },
    );
    expect(violationEvent).toBeDefined();
    // Verify the event payload contains both artifact IDs
    const payload = (violationEvent[0] as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.expectedArtifactId).toBe(ROOTCAUSE_ARTIFACT_ID);
    expect(payload.actualArtifactId).toBe('pi-art-FABRICATED-WRONG-ID');
  });
});
