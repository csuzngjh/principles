import { describe, it, expect, vi } from 'vitest';
import { EvaluatorRunner } from '../internalization/evaluator-runner.js';
import type { EvaluatorRunnerDeps } from '../internalization/evaluator-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { EvaluatorOutputV1 } from '../internalization/evaluator-output.js';
import { DefaultEvaluatorValidator } from '../internalization/evaluator-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';
import { TestDoubleRuntimeAdapter } from '../adapter/test-double-runtime-adapter.js';
import { RunnerPhase } from '../runner/runner-phase.js';

const ARTIFICER_TASK_ID = 'artificer-001';
const SCRIBE_TASK_ID = 'scribe-001';
const EVALUATOR_TASK_ID = 'evaluator-001';

function makeArtificerTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ARTIFICER_TASK_ID,
    taskKind: 'artificer',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'artificer://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-artificer-001-run-001' }],
    }),
    ...overrides,
  };
}

function makeEvaluatorTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: EVALUATOR_TASK_ID,
    taskKind: 'evaluator',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [ARTIFICER_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-artificer-001-run-001' }],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeScribeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: SCRIBE_TASK_ID,
    taskKind: 'scribe',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'scribe://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-scribe-001' }],
    }),
    ...overrides,
  };
}

function makeScribeArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-scribe-001',
    artifactKind: 'principle',
    sourceTaskId: SCRIBE_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      principleDraft: {
        title: 'Always validate async input',
        statement: 'Every async function must validate its input before processing.',
      },
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeEvaluatorOutput(overrides: Partial<EvaluatorOutputV1> = {}): EvaluatorOutputV1 {
  return {
    taskId: EVALUATOR_TASK_ID,
    sourceArtificerArtifactId: 'pi-art-artificer-001-run-001',
    evaluation: {
      decision: 'approved',
      summary: 'Implementation plan is well-structured and feasible',
      score: 0.85,
      strengths: ['Clear change descriptions', 'Good test coverage plan'],
      concerns: ['Rollout notes could be more specific'],
      requiredChanges: [],
    },
    sourceTrace: {
      artificerArtifactId: 'pi-art-artificer-001-run-001',
      scribeArtifactId: 'pi-art-scribe-001',
    },
    risks: ['May need additional integration tests'],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeArtificerArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-artificer-001-run-001',
    artifactKind: 'principle',
    sourceTaskId: ARTIFICER_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: ARTIFICER_TASK_ID,
      sourceScribeArtifactId: 'pi-art-scribe-001',
      implementationPlan: {
        summary: 'Add input validation to all async operations',
        targetSurface: 'src/async-ops/*.ts',
        changes: ['Add try-catch to asyncOp1', 'Add error boundary to asyncOp2'],
        tests: ['Unit test for asyncOp1 error handling', 'Integration test for error boundary'],
        rolloutNotes: ['Deploy behind feature flag', 'Monitor error rates post-deploy'],
        confidence: 0.85,
      },
      sourceTrace: {
        scribeArtifactId: 'pi-art-scribe-001',
      },
      risks: ['May add latency from error checking'],
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('EvaluatorRunner (vertical slice)', () => {
  function createMockDeps(overrides: Partial<EvaluatorRunnerDeps> = {}): EvaluatorRunnerDeps {
    const artifactStore = overrides.artifactStore ?? new MemoryPIArtifactStore();
    const evaluatorTask = makeEvaluatorTask();
    const artificerTask = makeArtificerTask();

    const scribeTask = makeScribeTask();
    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(evaluatorTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === EVALUATOR_TASK_ID) return Promise.resolve(evaluatorTask);
        if (id === ARTIFICER_TASK_ID) return Promise.resolve(artificerTask);
        if (id === SCRIBE_TASK_ID) return Promise.resolve(scribeTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-evaluator-001',
        taskId: EVALUATOR_TASK_ID,
        runtimeKind: 'evaluator',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-evaluator-001', taskId: EVALUATOR_TASK_ID, runtimeKind: 'evaluator', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const runHandle: RunHandle = { runId: 'run-evaluator-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-evaluator-001' };

    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue(runHandle),
      pollRun: vi.fn().mockResolvedValue(succeededStatus),
      fetchOutput: vi.fn().mockResolvedValue({
        payload: makeEvaluatorOutput(),
      }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter;

    const validator = new DefaultEvaluatorValidator();

    return {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator,
      artifactStore,
      ...overrides,
    };
  }

  it('taskKind not evaluator fails closed and releases lease', async () => {
    const wrongKindTask = makeEvaluatorTask({ taskKind: 'dreamer' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(wrongKindTask);

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain("must be 'evaluator'");
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      EVALUATOR_TASK_ID,
      'input_invalid',
    );
  });

  it('missing artificer dependency blocked/failure', async () => {
    const noDepTask = makeEvaluatorTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(noDepTask);
    (deps.stateManager as unknown as Record<string, unknown>).getTask = vi.fn().mockResolvedValue(noDepTask);

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('artificer dependency not succeeded cannot execute', async () => {
    const pendingArtificer = makeArtificerTask({ status: 'pending' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).getTask = vi.fn().mockImplementation((id: string) => {
      if (id === EVALUATOR_TASK_ID) return Promise.resolve(makeEvaluatorTask());
      if (id === ARTIFICER_TASK_ID) return Promise.resolve(pendingArtificer);
      return Promise.resolve(null);
    });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('artificer artifact missing goes to retry/fail', async () => {
    const emptyArtifactStore = new MemoryPIArtifactStore();
    const deps = createMockDeps({ artifactStore: emptyArtifactStore });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('valid runtime output writes evaluator PIArtifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
  });

  it('valid runtime output marks task succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      EVALUATOR_TASK_ID,
      expect.stringContaining('evaluator://'),
    );
  });

  it('invalid output does not write artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput: EvaluatorOutputV1 = {
      taskId: 'wrong-task-id',
      sourceArtificerArtifactId: '',
      evaluation: {
        decision: 'approved',
        summary: '',
        score: 1.5,
        strengths: [],
        concerns: [],
        requiredChanges: [],
      },
      sourceTrace: {
        artificerArtifactId: '',
      },
      risks: 'not-array' as unknown as string[],
      generatedAt: '',
    };

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('failed');

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  it('artifact write failure goes to retry/fail, not mark succeeded', async () => {
    const failingStore = {
      listBySourceTaskId: vi.fn().mockResolvedValue([makeArtificerArtifact()]),
      upsertArtifact: vi.fn().mockRejectedValue(new Error('Disk full')),
      getArtifactById: vi.fn().mockResolvedValue(null),
    } as unknown as PIArtifactStore;

    const deps = createMockDeps({ artifactStore: failingStore });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('failed');
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('approved evaluator validates scribe principle artifact, not artificer', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    // Scribe artifact should be validated (it carries principleDraft)
    const scribeArtifact = await store.getArtifactById('pi-art-scribe-001');
    expect(scribeArtifact).not.toBeNull();
    expect(scribeArtifact?.validationStatus).toBe('validated');

    // Artificer artifact should remain pending (it's an implementation plan, not principle-bearing)
    const artificerArtifact = await store.getArtifactById('pi-art-artificer-001-run-001');
    expect(artificerArtifact).not.toBeNull();
    expect(artificerArtifact?.validationStatus).toBe('pending');
  });

  it('rejected evaluation does not validate any artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const rejectedOutput = makeEvaluatorOutput({
      evaluation: {
        decision: 'rejected',
        summary: 'Plan is fundamentally flawed',
        score: 0.2,
        strengths: [],
        concerns: ['No test coverage', 'High risk'],
        requiredChanges: ['Rewrite entire plan'],
      },
    });

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: rejectedOutput,
    });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    // Neither artifact should be validated when evaluation is rejected
    const scribeArtifact = await store.getArtifactById('pi-art-scribe-001');
    expect(scribeArtifact?.validationStatus).toBe('pending');

    const artificerArtifact = await store.getArtifactById('pi-art-artificer-001-run-001');
    expect(artificerArtifact?.validationStatus).toBe('pending');
  });

  it('needs_revision evaluation does not validate any artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const needsRevisionOutput = makeEvaluatorOutput({
      evaluation: {
        decision: 'needs_revision',
        summary: 'Plan has issues but is salvageable',
        score: 0.5,
        strengths: ['Good structure'],
        concerns: ['Missing error handling'],
        requiredChanges: ['Add error handling'],
      },
    });

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: needsRevisionOutput,
    });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    // Neither artifact should be validated when evaluation is needs_revision
    const scribeArtifact = await store.getArtifactById('pi-art-scribe-001');
    expect(scribeArtifact?.validationStatus).toBe('pending');
  });

  it('missing scribe artifact emits evaluator_no_principle_bearer_found telemetry', async () => {
    const store = new MemoryPIArtifactStore();
    // Only artificer artifact — no scribe artifact in store
    await store.upsertArtifact(makeArtificerArtifact());

    // Output references a scribe artifact that doesn't exist
    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = 'pi-art-nonexistent';

    const deps = createMockDeps({ artifactStore: store });
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: output,
    });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    // Should have emitted telemetry about missing principle bearer
    const events = (deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> },
    );
    const noBearerEvent = events.find((e) => e.eventType === 'evaluator_no_principle_bearer_found');
    expect(noBearerEvent).toBeDefined();
    expect(noBearerEvent?.payload?.scribeArtifactId).toBe('pi-art-nonexistent');
  });

  it('updateValidationStatus returning false emits evaluator_source_validation_update_not_found', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    // Wrap store to make updateValidationStatus return false for the scribe artifact
    const originalUpdate = store.updateValidationStatus.bind(store);
    const spyStore = {
      ...store,
      updateValidationStatus: vi.fn().mockImplementation(async (id: string, status: 'validated' | 'pending') => {
        if (id === 'pi-art-scribe-001') return false;
        return originalUpdate(id, status);
      }),
      getArtifactById: store.getArtifactById.bind(store),
      listBySourceTaskId: store.listBySourceTaskId.bind(store),
      upsertArtifact: store.upsertArtifact.bind(store),
      createArtifact: store.createArtifact.bind(store),
      listLineage: store.listLineage.bind(store),
    } as unknown as PIArtifactStore;

    const deps = createMockDeps({ artifactStore: spyStore });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    const events = (deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> },
    );
    const notFoundEvent = events.find((e) => e.eventType === 'evaluator_source_validation_update_not_found');
    expect(notFoundEvent).toBeDefined();
    expect(notFoundEvent?.payload?.sourceArtifactId).toBe('pi-art-scribe-001');
    expect(notFoundEvent?.payload?.reason).toBe('principle_artifact_not_found_in_store');
  });

  it('fallback lineage with 1 principle-bearing artifact validates it', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    // Output has no scribeArtifactId — forces fallback to lineage search
    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = undefined;

    // Evaluator must depend on both artificer and scribe tasks for lineage search
    const evaluatorBothDeps = makeEvaluatorTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [ARTIFICER_TASK_ID, SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const artificerTask = makeArtificerTask();
    const scribeTask = makeScribeTask();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(evaluatorBothDeps),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === EVALUATOR_TASK_ID) return Promise.resolve(evaluatorBothDeps);
        if (id === ARTIFICER_TASK_ID) return Promise.resolve(artificerTask);
        if (id === SCRIBE_TASK_ID) return Promise.resolve(scribeTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-evaluator-001',
        taskId: EVALUATOR_TASK_ID,
        runtimeKind: 'evaluator',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-evaluator-001', taskId: EVALUATOR_TASK_ID, runtimeKind: 'evaluator', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const eventEmitter = { emitTelemetry: vi.fn() } as unknown as StoreEventEmitter;

    const deps: EvaluatorRunnerDeps = {
      stateManager,
      runtimeAdapter: {
        startRun: vi.fn().mockResolvedValue({ runId: 'run-evaluator-001', runtimeKind: 'evaluator', startedAt: new Date().toISOString() }),
        pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-evaluator-001' }),
        fetchOutput: vi.fn().mockResolvedValue({ payload: output }),
        cancelRun: vi.fn().mockResolvedValue(undefined),
      } as unknown as PDRuntimeAdapter,
      eventEmitter,
      validator: new DefaultEvaluatorValidator(),
      artifactStore: store,
    };

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    // Scribe artifact should be validated via lineage fallback
    const scribeArtifact = await store.getArtifactById('pi-art-scribe-001');
    expect(scribeArtifact).not.toBeNull();
    expect(scribeArtifact?.validationStatus).toBe('validated');
  });

  it('fallback lineage with 2 principle-bearing artifacts emits ambiguity and validates none', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    // Add a second principle-bearing artifact from a different task
    const SECOND_SCRIBE_TASK_ID = 'scribe-002';
    const secondScribeArtifact: PIArtifactRecord = {
      artifactId: 'pi-art-scribe-002',
      artifactKind: 'principle',
      sourceTaskId: SECOND_SCRIBE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({
        principleDraft: {
          title: 'Always handle errors',
          statement: 'Every function must handle errors gracefully.',
        },
        generatedAt: new Date().toISOString(),
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsertArtifact(secondScribeArtifact);

    // Output has no scribeArtifactId — forces fallback to lineage search
    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = undefined;

    // Mock deps: evaluator depends on both artificer and second scribe task
    const evaluatorTaskBothDeps = makeEvaluatorTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [ARTIFICER_TASK_ID, SCRIBE_TASK_ID, SECOND_SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const artificerTask = makeArtificerTask();
    const scribeTask = makeScribeTask();
    const secondScribeTask: TaskRecord = {
      taskId: SECOND_SCRIBE_TASK_ID,
      taskKind: 'scribe',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'scribe://run-002',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-scribe-002' }],
      }),
    };

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(evaluatorTaskBothDeps),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === EVALUATOR_TASK_ID) return Promise.resolve(evaluatorTaskBothDeps);
        if (id === ARTIFICER_TASK_ID) return Promise.resolve(artificerTask);
        if (id === SCRIBE_TASK_ID) return Promise.resolve(scribeTask);
        if (id === SECOND_SCRIBE_TASK_ID) return Promise.resolve(secondScribeTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-evaluator-001',
        taskId: EVALUATOR_TASK_ID,
        runtimeKind: 'evaluator',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-evaluator-001', taskId: EVALUATOR_TASK_ID, runtimeKind: 'evaluator', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const eventEmitter = { emitTelemetry: vi.fn() } as unknown as StoreEventEmitter;

    const deps: EvaluatorRunnerDeps = {
      stateManager,
      runtimeAdapter: {
        startRun: vi.fn().mockResolvedValue({ runId: 'run-evaluator-001', runtimeKind: 'evaluator', startedAt: new Date().toISOString() }),
        pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-evaluator-001' }),
        fetchOutput: vi.fn().mockResolvedValue({ payload: output }),
        cancelRun: vi.fn().mockResolvedValue(undefined),
      } as unknown as PDRuntimeAdapter,
      eventEmitter,
      validator: new DefaultEvaluatorValidator(),
      artifactStore: store,
    };

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    // Ambiguity telemetry should be emitted
    const events = (eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> },
    );
    const ambiguousEvent = events.find((e) => e.eventType === 'evaluator_principle_bearer_ambiguous');
    expect(ambiguousEvent).toBeDefined();
    expect(ambiguousEvent?.payload?.candidateArtifactIds).toEqual(
      expect.arrayContaining(['pi-art-scribe-001', 'pi-art-scribe-002']),
    );
    expect(ambiguousEvent?.payload?.reason).toBe('multiple_principle_bearing_artifacts_in_lineage');

    // Neither scribe artifact should be validated
    const scribe1 = await store.getArtifactById('pi-art-scribe-001');
    const scribe2 = await store.getArtifactById('pi-art-scribe-002');
    expect(scribe1?.validationStatus).toBe('pending');
    expect(scribe2?.validationStatus).toBe('pending');
  });

  it('hasPrincipleDraftContent rejects malformed JSON, array, null, and inherited properties', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());

    // Artificer artifact has implementationPlan, not principleDraft — should NOT be treated as principle bearer
    const artificerOnly = makeArtificerArtifact();
    artificerOnly.contentJson = JSON.stringify({ implementationPlan: { summary: 'test' } });
    await store.upsertArtifact(artificerOnly);

    // Malformed: array
    const arrayArtifact: PIArtifactRecord = {
      artifactId: 'pi-art-array',
      artifactKind: 'principle',
      sourceTaskId: 'other-task',
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: '[1, 2, 3]',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsertArtifact(arrayArtifact);

    // Malformed: null
    const nullArtifact: PIArtifactRecord = {
      artifactId: 'pi-art-null',
      artifactKind: 'principle',
      sourceTaskId: 'other-task-2',
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: 'null',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsertArtifact(nullArtifact);

    // Malformed: inherited property (toString as principleDraft)
    const inheritedArtifact: PIArtifactRecord = {
      artifactId: 'pi-art-inherited',
      artifactKind: 'principle',
      sourceTaskId: 'other-task-3',
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({ toString: 'not-a-draft' }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsertArtifact(inheritedArtifact);

    // Output has no scribeArtifactId — forces lineage fallback
    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = undefined;

    // Evaluator depends on all the tasks above
    const allDepsTask = makeEvaluatorTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [ARTIFICER_TASK_ID, 'other-task', 'other-task-2', 'other-task-3'],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(allDepsTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === EVALUATOR_TASK_ID) return Promise.resolve(allDepsTask);
        if (id === ARTIFICER_TASK_ID) return Promise.resolve(makeArtificerTask());
        return Promise.resolve(makeScribeTask({ taskId: id }));
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-evaluator-001',
        taskId: EVALUATOR_TASK_ID,
        runtimeKind: 'evaluator',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-evaluator-001', taskId: EVALUATOR_TASK_ID, runtimeKind: 'evaluator', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const eventEmitter = { emitTelemetry: vi.fn() } as unknown as StoreEventEmitter;

    const deps: EvaluatorRunnerDeps = {
      stateManager,
      runtimeAdapter: {
        startRun: vi.fn().mockResolvedValue({ runId: 'run-evaluator-001', runtimeKind: 'evaluator', startedAt: new Date().toISOString() }),
        pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-evaluator-001' }),
        fetchOutput: vi.fn().mockResolvedValue({ payload: output }),
        cancelRun: vi.fn().mockResolvedValue(undefined),
      } as unknown as PDRuntimeAdapter,
      eventEmitter,
      validator: new DefaultEvaluatorValidator(),
      artifactStore: store,
    };

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    // No artifact should be validated — none have valid principleDraft content
    const events = (eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> },
    );
    const noBearerEvent = events.find((e) => e.eventType === 'evaluator_no_principle_bearer_found');
    expect(noBearerEvent).toBeDefined();

    // All artifacts should remain pending
    const arr = await store.getArtifactById('pi-art-array');
    const nil = await store.getArtifactById('pi-art-null');
    const inh = await store.getArtifactById('pi-art-inherited');
    expect(arr?.validationStatus).toBe('pending');
    expect(nil?.validationStatus).toBe('pending');
    expect(inh?.validationStatus).toBe('pending');
  });

  it('mismatched sourceArtificerArtifactId does not write artifact or mark succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const mismatchedOutput = makeEvaluatorOutput();
    (mismatchedOutput as unknown as Record<string, unknown>).sourceArtificerArtifactId = 'wrong-artifact-id';
    (mismatchedOutput.sourceTrace as unknown as Record<string, unknown>).artificerArtifactId = 'wrong-artifact-id';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedOutput,
    });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    expect(artifacts).toHaveLength(0);
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('sourceTrace.artificerArtifactId mismatch does not write artifact or mark succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const mismatchedOutput = makeEvaluatorOutput();
    (mismatchedOutput.sourceTrace as unknown as Record<string, unknown>).artificerArtifactId = 'wrong-trace-id';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedOutput,
    });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    expect(artifacts).toHaveLength(0);
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('malformed output does not update validationStatus', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const malformedOutput = {
      notAnEvaluatorOutput: true,
    };

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: malformedOutput,
    });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('failed');

    // No artifact should be validated when output is malformed
    const scribeArtifact = await store.getArtifactById('pi-art-scribe-001');
    expect(scribeArtifact?.validationStatus).toBe('pending');
  });

  it('valid output after success sets currentPhase to Completed', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(runner.currentPhase).toBe(RunnerPhase.Completed);
  });

  it('failure path does not mark succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    // Runtime fails
    const failedStatus: RunStatus = { status: 'failed', runId: 'run-evaluator-001' };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).pollRun = vi.fn().mockResolvedValue(failedStatus);

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('failed');
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
    expect(runner.currentPhase).toBe(RunnerPhase.Failed);
  });

  it('sourceTrace.scribeArtifactId mismatch with store emits scribe_artifact_not_principle', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    // No scribe artifact in store, but output references one
    const deps = createMockDeps({ artifactStore: store });

    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = 'pi-art-scribe-nonexistent';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: output,
    });

    const runner = new EvaluatorRunner(deps, {
      owner: 'test',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    const events = (deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> },
    );
    const notPrincipleEvent = events.find((e) => e.eventType === 'evaluator_scribe_artifact_not_principle');
    expect(notPrincipleEvent).toBeDefined();
    expect(notPrincipleEvent?.payload?.scribeArtifactId).toBe('pi-art-scribe-nonexistent');
  });

  // ── Telemetry dedup regression test ───────────────────────────────────────

  it('successful run emits exactly 1 evaluator_output_validated and 1 evaluator_decision_recorded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const deps = createMockDeps({ artifactStore: store });
    const emitTelemetry = vi.fn();
    (deps.eventEmitter as unknown as Record<string, unknown>).emitTelemetry = emitTelemetry;

    const runner = new EvaluatorRunner(deps, {
      owner: 'test-dedup',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    // Count telemetry events by type
    const outputValidatedCalls = emitTelemetry.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && 'eventType' in c[0] && c[0].eventType === 'evaluator_output_validated',
    );
    const decisionRecordedCalls = emitTelemetry.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && 'eventType' in c[0] && c[0].eventType === 'evaluator_decision_recorded',
    );

    // Exactly 1 output_validated (from BasePeerRunner), not 2
    expect(outputValidatedCalls).toHaveLength(1);
    // Exactly 1 decision_recorded (from emitSuccessTelemetry)
    expect(decisionRecordedCalls).toHaveLength(1);
  });
});

describe('DefaultEvaluatorValidator (vertical slice)', () => {
  const validator = new DefaultEvaluatorValidator();

  it('accepts valid Evaluator output', async () => {
    const result = await validator.validate(makeEvaluatorOutput(), EVALUATOR_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects taskId mismatch', async () => {
    const output = makeEvaluatorOutput();
    (output as unknown as Record<string, unknown>).taskId = 'wrong';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId mismatch'))).toBe(true);
  });

  it('rejects missing sourceArtificerArtifactId', async () => {
    const output = makeEvaluatorOutput();
    (output as unknown as Record<string, unknown>).sourceArtificerArtifactId = '';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceArtificerArtifactId'))).toBe(true);
  });

  it('rejects mismatched sourceArtificerArtifactId when expected is provided', async () => {
    const output = makeEvaluatorOutput();
    (output as unknown as Record<string, unknown>).sourceArtificerArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, EVALUATOR_TASK_ID, 'pi-art-artificer-001-run-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceArtificerArtifactId mismatch'))).toBe(true);
  });

  it('rejects mismatched sourceTrace.artificerArtifactId when expected is provided', async () => {
    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).artificerArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, EVALUATOR_TASK_ID, 'pi-art-artificer-001-run-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.artificerArtifactId mismatch'))).toBe(true);
  });

  it('rejects invalid decision value', async () => {
    const output = makeEvaluatorOutput();
    (output.evaluation as unknown as Record<string, unknown>).decision = 'invalid';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluation.decision'))).toBe(true);
  });

  it('rejects score as string', async () => {
    const output = makeEvaluatorOutput();
    (output.evaluation as unknown as Record<string, unknown>).score = '0.85';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluation.score must be number'))).toBe(true);
  });

  it('rejects score > 1', async () => {
    const output = makeEvaluatorOutput();
    (output.evaluation as unknown as Record<string, unknown>).score = 1.5;
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluation.score must be in [0, 1]'))).toBe(true);
  });

  it('rejects NaN score', async () => {
    const output = makeEvaluatorOutput();
    (output.evaluation as unknown as Record<string, unknown>).score = NaN;
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluation.score must be number'))).toBe(true);
  });

  it('rejects Infinity score', async () => {
    const output = makeEvaluatorOutput();
    (output.evaluation as unknown as Record<string, unknown>).score = Infinity;
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluation.score must be number'))).toBe(true);
  });

  it('rejects null output', async () => {
    const result = await validator.validate(null as unknown as EvaluatorOutputV1, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects strengths with non-string elements', async () => {
    const output = makeEvaluatorOutput();
    (output.evaluation as unknown as Record<string, unknown>).strengths = [1, 2];
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluation.strengths must be an array of strings'))).toBe(true);
  });

  it('rejects concerns with non-string elements', async () => {
    const output = makeEvaluatorOutput();
    (output.evaluation as unknown as Record<string, unknown>).concerns = [true];
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluation.concerns must be an array of strings'))).toBe(true);
  });

  it('rejects requiredChanges with non-string elements', async () => {
    const output = makeEvaluatorOutput();
    (output.evaluation as unknown as Record<string, unknown>).requiredChanges = [42];
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluation.requiredChanges must be an array of strings'))).toBe(true);
  });

  it('rejects risks with non-string elements', async () => {
    const output = makeEvaluatorOutput();
    (output as unknown as Record<string, unknown>).risks = [42];
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('risks must be an array of strings'))).toBe(true);
  });

  it('rejects missing evaluation.summary', async () => {
    const output = makeEvaluatorOutput();
    (output.evaluation as unknown as Record<string, unknown>).summary = '';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluation.summary'))).toBe(true);
  });

  it('rejects missing sourceTrace.artificerArtifactId', async () => {
    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).artificerArtifactId = '';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.artificerArtifactId'))).toBe(true);
  });

  it('accepts valid output with matching expectedSourceArtificerArtifactId', async () => {
    const output = makeEvaluatorOutput();
    const result = await validator.validate(output, EVALUATOR_TASK_ID, 'pi-art-artificer-001-run-001');
    expect(result.valid).toBe(true);
  });

  it('rejects mismatched sourceArtificerArtifactId vs sourceTrace.artificerArtifactId', async () => {
    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).artificerArtifactId = 'different-id';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('must match'))).toBe(true);
  });

  it('rejects non-string scribeArtifactId in sourceTrace', async () => {
    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = 42;
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('scribeArtifactId'))).toBe(true);
  });

  it('rejects non-string philosopherArtifactId in sourceTrace', async () => {
    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).philosopherArtifactId = { evil: true };
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('philosopherArtifactId'))).toBe(true);
  });

  it('rejects non-string dreamerArtifactId in sourceTrace', async () => {
    const output = makeEvaluatorOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).dreamerArtifactId = true;
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('dreamerArtifactId'))).toBe(true);
  });

  it('rejects prototype-inherited taskId (ERR-013)', async () => {
    const proto = { taskId: EVALUATOR_TASK_ID };
    const output = Object.create(proto) as Record<string, unknown>;
    // Copy all own properties from a valid output except taskId
    const valid = makeEvaluatorOutput();
    output.sourceArtificerArtifactId = valid.sourceArtificerArtifactId;
    output.evaluation = valid.evaluation;
    output.sourceTrace = valid.sourceTrace;
    output.risks = valid.risks;
    output.generatedAt = valid.generatedAt;
    // taskId is only on prototype, not own property
    expect(Object.hasOwn(output, 'taskId')).toBe(false);

    const result = await validator.validate(output as unknown, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId'))).toBe(true);
  });

  it('rejects prototype-inherited sourceArtificerArtifactId (ERR-013)', async () => {
    const output = makeEvaluatorOutput() as unknown as Record<string, unknown>;
    const validValue = output.sourceArtificerArtifactId as string;
    delete output.sourceArtificerArtifactId;
    const proto = { sourceArtificerArtifactId: validValue };
    Object.setPrototypeOf(output, proto);
    // sourceArtificerArtifactId is now only on prototype, not own property
    expect(Object.hasOwn(output, 'sourceArtificerArtifactId')).toBe(false);

    const result = await validator.validate(output as unknown, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceArtificerArtifactId'))).toBe(true);
  });

  it('rejects prototype-inherited sourceTrace.artificerArtifactId (ERR-013)', async () => {
    const output = makeEvaluatorOutput();
    const sourceTrace = output.sourceTrace as unknown as Record<string, unknown>;
    const validValue = sourceTrace.artificerArtifactId as string;
    delete sourceTrace.artificerArtifactId;
    const proto = { artificerArtifactId: validValue };
    Object.setPrototypeOf(sourceTrace, proto);
    // artificerArtifactId is now only on prototype, not own property
    expect(Object.hasOwn(sourceTrace, 'artificerArtifactId')).toBe(false);

    const result = await validator.validate(output as unknown, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.artificerArtifactId'))).toBe(true);
  });

  it('rejects prototype-inherited evaluation.decision (ERR-013)', async () => {
    const output = makeEvaluatorOutput();
    const evaluation = output.evaluation as unknown as Record<string, unknown>;
    delete evaluation.decision;
    const proto = { decision: 'approved' };
    Object.setPrototypeOf(evaluation, proto);
    // decision is now only on prototype, not own property
    expect(Object.hasOwn(evaluation, 'decision')).toBe(false);

    const result = await validator.validate(output as unknown, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluation.decision'))).toBe(true);
  });

  it('accepts unknown input that is structurally valid (ERR-001)', async () => {
    // Build a plain object (not typed as EvaluatorOutputV1) and verify
    // the unknown-typed validate interface works correctly
    const plainObject: unknown = {
      taskId: EVALUATOR_TASK_ID,
      sourceArtificerArtifactId: 'pi-art-artificer-001-run-001',
      evaluation: {
        decision: 'approved',
        summary: 'Implementation plan is well-structured and feasible',
        score: 0.85,
        strengths: ['Clear change descriptions', 'Good test coverage plan'],
        concerns: ['Rollout notes could be more specific'],
        requiredChanges: [],
      },
      sourceTrace: {
        artificerArtifactId: 'pi-art-artificer-001-run-001',
        scribeArtifactId: 'pi-art-scribe-001',
      },
      risks: ['May need additional integration tests'],
      generatedAt: new Date().toISOString(),
    };

    const result = await validator.validate(plainObject, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(true);
  });

});

describe('EvaluatorRunner integration: test-double captures sourceArtificerArtifactId from prompt', () => {
  it('seed artificer artifact -> run evaluator with test-double -> succeeded with correct sourceArtificerArtifactId', async () => {
    const ARTIFICER_ART_ID = 'pi-art-artificer-real-001';
    const artifactStore = new MemoryPIArtifactStore();

    const artificerArtifact: PIArtifactRecord = {
      artifactId: ARTIFICER_ART_ID,
      artifactKind: 'principle',
      sourceTaskId: ARTIFICER_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({
        taskId: ARTIFICER_TASK_ID,
        sourceScribeArtifactId: 'pi-art-scribe-001',
        implementationPlan: {
          summary: 'Add input validation to all async operations',
          targetSurface: 'src/async-ops/*.ts',
          changes: ['Add try-catch to asyncOp1'],
          tests: ['Unit test for asyncOp1 error handling'],
          rolloutNotes: ['Deploy behind feature flag'],
          confidence: 0.85,
        },
        sourceTrace: { scribeArtifactId: 'pi-art-scribe-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await artifactStore.upsertArtifact(artificerArtifact);
    await artifactStore.upsertArtifact(makeScribeArtifact());

    const evaluatorTask = makeEvaluatorTask();

    let capturedSourceArtificerArtifactId: string | undefined = undefined;
    const runtimeAdapter = new TestDoubleRuntimeAdapter({
      onStartRun: (input) => {
        try {
          const payloadStr = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
          const parsed = JSON.parse(payloadStr);
          if (typeof parsed.sourceArtificerArtifactId === 'string' && parsed.sourceArtificerArtifactId.trim() !== '') {
            capturedSourceArtificerArtifactId = parsed.sourceArtificerArtifactId;
          }
        } catch { /* ignore */ }
        return { runId: 'run-integration-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
      },
      onPollRun: (_runId: string) => ({
        runId: _runId,
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
      onFetchOutput: (_runId: string) => ({
          runId: _runId,
          payload: {
            taskId: EVALUATOR_TASK_ID,
            sourceArtificerArtifactId: capturedSourceArtificerArtifactId ?? ARTIFICER_ART_ID,
            evaluation: {
              decision: 'approved',
              summary: 'Implementation plan is well-structured',
              score: 0.85,
              strengths: ['Clear change descriptions'],
              concerns: [],
              requiredChanges: [],
            },
            sourceTrace: {
              artificerArtifactId: capturedSourceArtificerArtifactId ?? ARTIFICER_ART_ID,
              scribeArtifactId: 'pi-art-scribe-001',
            },
            risks: [],
            generatedAt: new Date().toISOString(),
          },
        }),
    });

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(evaluatorTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === EVALUATOR_TASK_ID) return Promise.resolve(evaluatorTask);
        if (id === ARTIFICER_TASK_ID) return Promise.resolve(makeArtificerTask());
        if (id === SCRIBE_TASK_ID) return Promise.resolve(makeScribeTask());
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-integration-001',
        taskId: EVALUATOR_TASK_ID,
        runtimeKind: 'evaluator',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-integration-001', taskId: EVALUATOR_TASK_ID, runtimeKind: 'evaluator', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const eventEmitter = {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter;

    const deps: EvaluatorRunnerDeps = {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator: new DefaultEvaluatorValidator(),
      artifactStore,
    };

    const runner = new EvaluatorRunner(deps, {
      owner: 'test-integration',
      runtimeKind: 'evaluator',
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });

    const result = await runner.run(EVALUATOR_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(capturedSourceArtificerArtifactId).toBe(ARTIFICER_ART_ID);
    expect(result.output?.sourceArtificerArtifactId).toBe(ARTIFICER_ART_ID);
    expect(result.output?.sourceTrace.artificerArtifactId).toBe(ARTIFICER_ART_ID);

    const artifacts = await artifactStore.listBySourceTaskId(EVALUATOR_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');

    const [storedArtifact] = artifacts;
    expect(storedArtifact).toBeDefined();
    if (!storedArtifact) return;
    const storedOutput = JSON.parse(storedArtifact.contentJson) as EvaluatorOutputV1;
    expect(storedOutput.sourceArtificerArtifactId).toBe(ARTIFICER_ART_ID);
    expect(storedOutput.sourceTrace.artificerArtifactId).toBe(ARTIFICER_ART_ID);

    // Scribe artifact should be validated (principle bearer)
    const validatedScribe = await artifactStore.getArtifactById('pi-art-scribe-001');
    expect(validatedScribe).not.toBeNull();
    expect(validatedScribe?.validationStatus).toBe('validated');

    // Artificer artifact should remain pending
    const pendingArtificer = await artifactStore.getArtifactById(ARTIFICER_ART_ID);
    expect(pendingArtificer).not.toBeNull();
    expect(pendingArtificer?.validationStatus).toBe('pending');
  });
});
