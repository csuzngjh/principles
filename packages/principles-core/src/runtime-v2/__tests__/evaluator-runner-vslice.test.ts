import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const ARTIFICER_TASK_ID = 'artificer-001';
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

function makeEvaluatorOutput(): EvaluatorOutputV1 {
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
    },
    risks: ['May need additional integration tests'],
    generatedAt: new Date().toISOString(),
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
  let artifactStore: PIArtifactStore = new MemoryPIArtifactStore();

  beforeEach(() => {
    artifactStore = new MemoryPIArtifactStore();
  });

  function createMockDeps(overrides: Partial<EvaluatorRunnerDeps> = {}): EvaluatorRunnerDeps {
    const evaluatorTask = makeEvaluatorTask();
    const artificerTask = makeArtificerTask();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(evaluatorTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === EVALUATOR_TASK_ID) return Promise.resolve(evaluatorTask);
        if (id === ARTIFICER_TASK_ID) return Promise.resolve(artificerTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-evaluator-001',
        taskId: EVALUATOR_TASK_ID,
        runtimeKind: 'evaluator',
        startedAt: new Date().toISOString(),
      }]),
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

    const evaluatorTask = makeEvaluatorTask();

    let capturedSourceArtificerArtifactId: string = ARTIFICER_ART_ID;
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
          sourceArtificerArtifactId: capturedSourceArtificerArtifactId,
          evaluation: {
            decision: 'approved',
            summary: 'Implementation plan is well-structured',
            score: 0.85,
            strengths: ['Clear change descriptions'],
            concerns: [],
            requiredChanges: [],
          },
          sourceTrace: {
            artificerArtifactId: capturedSourceArtificerArtifactId,
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
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-integration-001',
        taskId: EVALUATOR_TASK_ID,
        runtimeKind: 'evaluator',
        startedAt: new Date().toISOString(),
      }]),
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
  });
});
