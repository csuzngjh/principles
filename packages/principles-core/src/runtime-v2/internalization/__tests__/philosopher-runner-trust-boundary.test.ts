/**
 * PhilosopherRunner trust-boundary and behavior parity tests (PRI-new).
 *
 * Proves that after BasePeerRunner migration:
 * 1. Malformed runtime payload never reaches typed hooks or artifact commit
 * 2. Validation failure does not call success commit
 * 3. Successful run creates expected artifact and marks task succeeded
 * 4. Lease conflict is non-mutating
 * 5. postFetchTransform receives untrusted data, checkLineageIntegrity receives validated output
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhilosopherRunner } from '../philosopher-runner.js';
import type { PhilosopherRunnerDeps } from '../philosopher-runner.js';
import type { PhilosopherOutputV1 } from '../philosopher-output.js';
import { DefaultPhilosopherValidator } from '../philosopher-output.js';
import type { PIArtifactRecord } from '../pi-artifact.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { TaskRecord } from '../../task-status.js';
import { PDRuntimeError } from '../../error-categories.js';
import { RunnerPhase } from '../../runner/runner-phase.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';

const DREAMER_TASK_ID = 'dreamer-tb-001';
const PHILOSOPHER_TASK_ID = 'philosopher-tb-001';

function makeDreamerArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-dreamer-tb-001-run-001',
    artifactKind: 'principle',
    sourceTaskId: DREAMER_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      valid: true,
      taskId: DREAMER_TASK_ID,
      candidates: [{
        candidateIndex: 0,
        badDecision: 'Ignored error handling',
        betterDecision: 'Add try/catch',
        rationale: 'Prevents unhandled rejections',
        confidence: 0.85,
        riskLevel: 'low',
        strategicPerspective: 'reliability',
      }],
      contextRefs: [],
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makePhilosopherOutput(): PhilosopherOutputV1 {
  return {
    taskId: PHILOSOPHER_TASK_ID,
    sourceDreamerArtifactId: 'pi-art-dreamer-tb-001-run-001',
    thesis: 'Error handling should be systematic',
    principleCandidate: {
      title: 'Systematic Error Handling',
      rationale: 'Uncaught errors cascade',
      scope: 'All async operations',
      confidence: 0.9,
    },
    risks: ['May add latency'],
    generatedAt: new Date().toISOString(),
  };
}

function makePhilosopherTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: PHILOSOPHER_TASK_ID,
    taskKind: 'philosopher',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [DREAMER_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-dreamer-tb-001-run-001' }],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeDreamerTask(): TaskRecord {
  return {
    taskId: DREAMER_TASK_ID,
    taskKind: 'dreamer',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'dreamer://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-dreamer-tb-001-run-001' }],
    }),
  };
}

describe('PhilosopherRunner trust boundary (PRI-new)', () => {
  let artifactStore: MemoryPIArtifactStore;

  beforeEach(() => {
    artifactStore = new MemoryPIArtifactStore();
  });

  function createMockDeps(overrides: Partial<PhilosopherRunnerDeps> = {}): PhilosopherRunnerDeps {
    const philosopherTask = makePhilosopherTask();
    const dreamerTask = makeDreamerTask();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(philosopherTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === PHILOSOPHER_TASK_ID) return Promise.resolve(philosopherTask);
        if (id === DREAMER_TASK_ID) return Promise.resolve(dreamerTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-phil-tb-001',
        taskId: PHILOSOPHER_TASK_ID,
        runtimeKind: 'philosopher',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-phil-tb-001', taskId: PHILOSOPHER_TASK_ID, runtimeKind: 'philosopher', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const runHandle: RunHandle = { runId: 'run-phil-tb-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-phil-tb-001' };

    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue(runHandle),
      pollRun: vi.fn().mockResolvedValue(succeededStatus),
      fetchOutput: vi.fn().mockResolvedValue({ payload: makePhilosopherOutput() }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter;

    const validator = new DefaultPhilosopherValidator();

    return {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator,
      artifactStore,
      ...overrides,
    };
  }

  /** Extract recorded mock calls from a vi.fn() reached through an unknown-typed object. */
  function getMockCalls(holder: unknown, method: string): unknown[][] {
    const record = holder as Record<string, { mock?: { calls?: unknown[][] } }>;
    return record[method]?.mock?.calls ?? [];
  }

  /** Find telemetry payloads emitted for a given eventType. */
  function telemetryPayloadsFor(deps: PhilosopherRunnerDeps, eventType: string): Record<string, unknown>[] {
    return getMockCalls(deps.eventEmitter, 'emitTelemetry')
      .map((call) => call[0] as { eventType: string; payload: Record<string, unknown> })
      .filter((evt) => evt.eventType === eventType)
      .map((evt) => evt.payload);
  }

  it('malformed payload (non-object) does not write artifact or mark succeeded', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore });
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: 'not-an-object',
    });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();

    const artifacts = await artifactStore.listBySourceTaskId(PHILOSOPHER_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  it('malformed payload (null) does not write artifact or mark succeeded', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore });
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: null,
    });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('validation failure does not write artifact or mark succeeded', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore });

    const invalidOutput = {
      taskId: 'wrong-id',
      sourceDreamerArtifactId: '',
      thesis: '',
      principleCandidate: { title: '', rationale: '', scope: '', confidence: 2.0 },
      risks: 'not-array',
      generatedAt: '',
    };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();

    const artifacts = await artifactStore.listBySourceTaskId(PHILOSOPHER_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  it('valid output goes through full success path — artifact written and task succeeded', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();
    expect(result.output).toBeDefined();
    expect(result.output?.principleCandidate.title).toBe('Systematic Error Handling');
    expect(runner.currentPhase).toBe(RunnerPhase.Completed);

    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      PHILOSOPHER_TASK_ID,
      expect.stringContaining('philosopher://'),
    );

    const artifacts = await artifactStore.listBySourceTaskId(PHILOSOPHER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
  });

  it('lease conflict does not mutate task state', async () => {
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockRejectedValue(
      new PDRuntimeError('lease_conflict', 'Another runner holds the lease'),
    );

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    expect(deps.stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(deps.stateManager.markTaskRetryWait).not.toHaveBeenCalled();
  });

  it('taskId wrong echo in output is reconciled from the authoritative task record (PRI-541)', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore });

    const mismatchedOutput = { ...makePhilosopherOutput(), taskId: 'wrong-task-id' };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedOutput,
    });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    // Lineage is runner-owned (rc-6): a corrupted echo is corrected from the task
    // record instead of dead-ending the candidate as output_invalid.
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalled();

    const outputCalls = getMockCalls(deps.stateManager, 'updateRunOutput');
    const persisted = JSON.parse(outputCalls[0]?.[1] as string) as Record<string, unknown>;
    expect(persisted.taskId).toBe(PHILOSOPHER_TASK_ID);

    // The correction is observable, not silent (rc-9).
    const payloads = telemetryPayloadsFor(deps, 'philosopher_lineage_echo_corrected');
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.correctedFields).toEqual(['taskId']);
  });

  it('validation failure does not set phase to Completed', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore });

    const invalidOutput = {
      taskId: 'wrong-id',
      sourceDreamerArtifactId: '',
      thesis: '',
      principleCandidate: { title: '', rationale: '', scope: '', confidence: 2.0 },
      risks: 'not-array',
      generatedAt: '',
    };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(runner.currentPhase).not.toBe(RunnerPhase.Completed);
    expect(runner.currentPhase).toBe(RunnerPhase.Failed);
  });

  it('postFetchTransform re-injects taskId when stripped — phase is Completed', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore });

    // Simulate adapter stripping lineage fields (PRI-272)
    const strippedOutput = { ...makePhilosopherOutput() };
    delete (strippedOutput as Record<string, unknown>).taskId;
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: strippedOutput,
    });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    // postFetchTransform should re-inject taskId, then validation should pass
    expect(result.status).toBe('succeeded');
    expect(runner.currentPhase).toBe(RunnerPhase.Completed);
  });

  it('present-but-empty taskId echo is reconciled with telemetry, never silently (PRI-541)', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore });

    const emptyTaskIdOutput = { ...makePhilosopherOutput(), taskId: '' };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: emptyTaskIdOutput,
    });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    // An empty echo is a corrupted echo of a runner-owned value: reconciled from
    // the authoritative task record, with telemetry keeping it observable (rc-9).
    expect(result.status).toBe('succeeded');

    const outputCalls = getMockCalls(deps.stateManager, 'updateRunOutput');
    const persisted = JSON.parse(outputCalls[0]?.[1] as string) as Record<string, unknown>;
    expect(persisted.taskId).toBe(PHILOSOPHER_TASK_ID);

    const payloads = telemetryPayloadsFor(deps, 'philosopher_lineage_echo_corrected');
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.correctedFields).toEqual(['taskId']);
  });

  it('risks with non-string elements fails validation (ERR-005 Rule 4)', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore });

    const badRisksOutput = { ...makePhilosopherOutput(), risks: [1, {}] };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: badRisksOutput,
    });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('risks must contain only strings');
  });

  it('sourceDreamerArtifactId wrong echo is reconciled before artifact commit (PRI-541, ERR-004)', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore });

    const mismatchedIdOutput = { ...makePhilosopherOutput(), sourceDreamerArtifactId: 'wrong-artifact-id' };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedIdOutput,
    });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    // The committed artifact carries the authoritative lineage (rc-6), not the
    // LLM's corrupted echo — a wrong echo no longer dead-ends the candidate.
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalled();

    const artifacts = await artifactStore.listBySourceTaskId(PHILOSOPHER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.contentJson).toContain('pi-art-dreamer-tb-001-run-001');

    const payloads = telemetryPayloadsFor(deps, 'philosopher_lineage_echo_corrected');
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.correctedFields).toEqual(['sourceDreamerArtifactId']);
  });

  it('invalid errorCategory from custom validator fails loud and does not leak through', async () => {
    await artifactStore.upsertArtifact(makeDreamerArtifact());

    // Custom validator returning an invalid errorCategory string
    const rogueValidator = {
      validate: vi.fn().mockResolvedValue({
        valid: false,
        errors: ['some validation error'],
        errorCategory: 'not_a_real_category',
      }),
    };

    const deps = createMockDeps({ artifactStore, validator: rogueValidator });
    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    // The invalid category must NOT leak into result.errorCategory
    expect(result.errorCategory).not.toBe('not_a_real_category');
    // errorCategory should be a valid PDErrorCategory (output_invalid from the guard,
    // then escalated by retryOrFail to max_attempts_exceeded since output_invalid is transient
    // and retry policy returns shouldRetry=false)
    expect(result.errorCategory).toBe('max_attempts_exceeded');
    // failureReason must mention the invalid errorCategory
    expect(result.failureReason).toContain('invalid errorCategory');
    expect(result.failureReason).toContain('not_a_real_category');
    // No artifact written, no task marked succeeded
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
    const artifacts = await artifactStore.listBySourceTaskId(PHILOSOPHER_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });
});
