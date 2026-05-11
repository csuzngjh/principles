import { describe, it, expect, vi } from 'vitest';
import { RolloutReviewerRunner } from '../internalization/rollout-reviewer-runner.js';
import type { RolloutReviewerRunnerDeps } from '../internalization/rollout-reviewer-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { RolloutReviewerOutputV1 } from '../internalization/rollout-reviewer-output.js';
import { DefaultRolloutReviewerValidator } from '../internalization/rollout-reviewer-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';
import { TestDoubleRuntimeAdapter } from '../adapter/test-double-runtime-adapter.js';

const EVALUATOR_TASK_ID = 'evaluator-001';
const ROLLOUT_REVIEWER_TASK_ID = 'rollout-reviewer-001';

function makeEvaluatorTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: EVALUATOR_TASK_ID,
    taskKind: 'evaluator',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'evaluator://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-evaluator-001-run-001' }],
    }),
    ...overrides,
  };
}

function makeRolloutReviewerTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ROLLOUT_REVIEWER_TASK_ID,
    taskKind: 'rollout_reviewer',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [EVALUATOR_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-evaluator-001-run-001' }],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeRolloutReviewerOutput(): RolloutReviewerOutputV1 {
  return {
    taskId: ROLLOUT_REVIEWER_TASK_ID,
    sourceEvaluatorArtifactId: 'pi-art-evaluator-001-run-001',
    review: {
      decision: 'approve_rollout',
      summary: 'The evaluation is thorough and the plan is safe to proceed',
      confidence: 0.9,
      requiredChanges: [],
      rolloutRisks: ['Feature flag configuration may need adjustment'],
      safetyChecks: ['Verify feature flag is properly configured'],
    },
    sourceTrace: {
      evaluatorArtifactId: 'pi-art-evaluator-001-run-001',
    },
    risks: ['Rollback plan should be tested'],
    generatedAt: new Date().toISOString(),
  };
}

function makeEvaluatorArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-evaluator-001-run-001',
    artifactKind: 'principle',
    sourceTaskId: EVALUATOR_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: EVALUATOR_TASK_ID,
      sourceArtificerArtifactId: 'pi-art-artificer-001',
      evaluation: {
        decision: 'approved',
        summary: 'Implementation plan is well-structured and feasible',
        score: 0.85,
        strengths: ['Clear change descriptions'],
        concerns: [],
        requiredChanges: [],
      },
      sourceTrace: {
        artificerArtifactId: 'pi-art-artificer-001',
      },
      risks: [],
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('RolloutReviewerRunner (vertical slice)', () => {
  function createMockDeps(overrides: Partial<RolloutReviewerRunnerDeps> = {}): RolloutReviewerRunnerDeps {
    const artifactStore = overrides.artifactStore ?? new MemoryPIArtifactStore();
    const rolloutReviewerTask = makeRolloutReviewerTask();
    const evaluatorTask = makeEvaluatorTask();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(rolloutReviewerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === ROLLOUT_REVIEWER_TASK_ID) return Promise.resolve(rolloutReviewerTask);
        if (id === EVALUATOR_TASK_ID) return Promise.resolve(evaluatorTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-rollout-reviewer-001',
        taskId: ROLLOUT_REVIEWER_TASK_ID,
        runtimeKind: 'rollout_reviewer',
        startedAt: new Date().toISOString(),
      }]),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const runHandle: RunHandle = { runId: 'run-rollout-reviewer-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-rollout-reviewer-001' };

    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue(runHandle),
      pollRun: vi.fn().mockResolvedValue(succeededStatus),
      fetchOutput: vi.fn().mockResolvedValue({
        payload: makeRolloutReviewerOutput(),
      }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter;

    const validator = new DefaultRolloutReviewerValidator();

    return {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator,
      artifactStore,
      ...overrides,
    };
  }

  it('taskKind not rollout_reviewer fails closed and releases lease', async () => {
    const wrongKindTask = makeRolloutReviewerTask({ taskKind: 'dreamer' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(wrongKindTask);

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain("must be 'rollout_reviewer'");
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      ROLLOUT_REVIEWER_TASK_ID,
      'input_invalid',
    );
  });

  it('missing evaluator dependency blocked/failure', async () => {
    const noDepTask = makeRolloutReviewerTask({
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

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('evaluator dependency not succeeded cannot execute', async () => {
    const pendingEvaluator = makeEvaluatorTask({ status: 'pending' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).getTask = vi.fn().mockImplementation((id: string) => {
      if (id === ROLLOUT_REVIEWER_TASK_ID) return Promise.resolve(makeRolloutReviewerTask());
      if (id === EVALUATOR_TASK_ID) return Promise.resolve(pendingEvaluator);
      return Promise.resolve(null);
    });

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('evaluator artifact missing goes to retry/fail', async () => {
    const emptyArtifactStore = new MemoryPIArtifactStore();
    const deps = createMockDeps({ artifactStore: emptyArtifactStore });

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('valid runtime output writes rollout_reviewer PIArtifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeEvaluatorArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    const artifacts = await store.listBySourceTaskId(ROLLOUT_REVIEWER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
  });

  it('valid runtime output marks task succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeEvaluatorArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      ROLLOUT_REVIEWER_TASK_ID,
      expect.stringContaining('rollout-reviewer://'),
    );
  });

  it('invalid output does not write artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeEvaluatorArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput: RolloutReviewerOutputV1 = {
      taskId: 'wrong-task-id',
      sourceEvaluatorArtifactId: '',
      review: {
        decision: 'approve_rollout',
        summary: '',
        confidence: 1.5,
        requiredChanges: [],
        rolloutRisks: [],
        safetyChecks: [],
      },
      sourceTrace: {
        evaluatorArtifactId: '',
      },
      risks: 'not-array' as unknown as string[],
      generatedAt: '',
    };

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('failed');

    const artifacts = await store.listBySourceTaskId(ROLLOUT_REVIEWER_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  it('artifact write failure goes to retry/fail, not mark succeeded', async () => {
    const failingStore = {
      listBySourceTaskId: vi.fn().mockResolvedValue([makeEvaluatorArtifact()]),
      upsertArtifact: vi.fn().mockRejectedValue(new Error('Disk full')),
    } as unknown as PIArtifactStore;

    const deps = createMockDeps({ artifactStore: failingStore });

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('output_invalid results in permanent failure', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeEvaluatorArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput: RolloutReviewerOutputV1 = {
      taskId: ROLLOUT_REVIEWER_TASK_ID,
      sourceEvaluatorArtifactId: 'pi-art-evaluator-001-run-001',
      review: {
        decision: 'invalid_decision' as 'approve_rollout',
        summary: 'Test',
        confidence: 0.5,
        requiredChanges: [],
        rolloutRisks: [],
        safetyChecks: [],
      },
      sourceTrace: {
        evaluatorArtifactId: 'pi-art-evaluator-001-run-001',
      },
      risks: [],
      generatedAt: new Date().toISOString(),
    };

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');
  });

  it('mismatched sourceEvaluatorArtifactId does not write artifact or mark succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeEvaluatorArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const mismatchedOutput = makeRolloutReviewerOutput();
    (mismatchedOutput as unknown as Record<string, unknown>).sourceEvaluatorArtifactId = 'wrong-artifact-id';
    (mismatchedOutput.sourceTrace as unknown as Record<string, unknown>).evaluatorArtifactId = 'wrong-artifact-id';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedOutput,
    });

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    const artifacts = await store.listBySourceTaskId(ROLLOUT_REVIEWER_TASK_ID);
    expect(artifacts).toHaveLength(0);
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('sourceTrace.evaluatorArtifactId mismatch does not write artifact or mark succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeEvaluatorArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const mismatchedOutput = makeRolloutReviewerOutput();
    (mismatchedOutput.sourceTrace as unknown as Record<string, unknown>).evaluatorArtifactId = 'wrong-trace-id';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedOutput,
    });

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    const artifacts = await store.listBySourceTaskId(ROLLOUT_REVIEWER_TASK_ID);
    expect(artifacts).toHaveLength(0);
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });
});

describe('DefaultRolloutReviewerValidator (vertical slice)', () => {
  const validator = new DefaultRolloutReviewerValidator();

  it('accepts valid RolloutReviewer output', async () => {
    const result = await validator.validate(makeRolloutReviewerOutput(), ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects taskId mismatch', async () => {
    const output = makeRolloutReviewerOutput();
    (output as unknown as Record<string, unknown>).taskId = 'wrong';
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId mismatch'))).toBe(true);
  });

  it('rejects missing sourceEvaluatorArtifactId', async () => {
    const output = makeRolloutReviewerOutput();
    (output as unknown as Record<string, unknown>).sourceEvaluatorArtifactId = '';
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceEvaluatorArtifactId'))).toBe(true);
  });

  it('rejects mismatched sourceEvaluatorArtifactId when expected is provided', async () => {
    const output = makeRolloutReviewerOutput();
    (output as unknown as Record<string, unknown>).sourceEvaluatorArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID, 'pi-art-evaluator-001-run-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceEvaluatorArtifactId mismatch'))).toBe(true);
  });

  it('rejects mismatched sourceTrace.evaluatorArtifactId when expected is provided', async () => {
    const output = makeRolloutReviewerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).evaluatorArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID, 'pi-art-evaluator-001-run-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.evaluatorArtifactId mismatch'))).toBe(true);
  });

  it('rejects invalid decision value', async () => {
    const output = makeRolloutReviewerOutput();
    (output.review as unknown as Record<string, unknown>).decision = 'invalid';
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('review.decision'))).toBe(true);
  });

  it('rejects confidence as string', async () => {
    const output = makeRolloutReviewerOutput();
    (output.review as unknown as Record<string, unknown>).confidence = '0.9';
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('review.confidence must be number'))).toBe(true);
  });

  it('rejects confidence > 1', async () => {
    const output = makeRolloutReviewerOutput();
    (output.review as unknown as Record<string, unknown>).confidence = 1.5;
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('review.confidence must be in [0, 1]'))).toBe(true);
  });

  it('rejects NaN confidence', async () => {
    const output = makeRolloutReviewerOutput();
    (output.review as unknown as Record<string, unknown>).confidence = NaN;
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('review.confidence must be number'))).toBe(true);
  });

  it('rejects Infinity confidence', async () => {
    const output = makeRolloutReviewerOutput();
    (output.review as unknown as Record<string, unknown>).confidence = Infinity;
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('review.confidence must be number'))).toBe(true);
  });

  it('rejects null output', async () => {
    const result = await validator.validate(null as unknown as RolloutReviewerOutputV1, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects requiredChanges with non-string elements', async () => {
    const output = makeRolloutReviewerOutput();
    (output.review as unknown as Record<string, unknown>).requiredChanges = [42];
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('review.requiredChanges must be an array of strings'))).toBe(true);
  });

  it('rejects rolloutRisks with non-string elements', async () => {
    const output = makeRolloutReviewerOutput();
    (output.review as unknown as Record<string, unknown>).rolloutRisks = [1];
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('review.rolloutRisks must be an array of strings'))).toBe(true);
  });

  it('rejects safetyChecks with non-string elements', async () => {
    const output = makeRolloutReviewerOutput();
    (output.review as unknown as Record<string, unknown>).safetyChecks = [true];
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('review.safetyChecks must be an array of strings'))).toBe(true);
  });

  it('rejects risks with non-string elements', async () => {
    const output = makeRolloutReviewerOutput();
    (output as unknown as Record<string, unknown>).risks = [42];
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('risks must be an array of strings'))).toBe(true);
  });

  it('rejects missing review.summary', async () => {
    const output = makeRolloutReviewerOutput();
    (output.review as unknown as Record<string, unknown>).summary = '';
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('review.summary'))).toBe(true);
  });

  it('rejects missing sourceTrace.evaluatorArtifactId', async () => {
    const output = makeRolloutReviewerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).evaluatorArtifactId = '';
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.evaluatorArtifactId'))).toBe(true);
  });

  it('accepts valid output with matching expectedSourceEvaluatorArtifactId', async () => {
    const output = makeRolloutReviewerOutput();
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID, 'pi-art-evaluator-001-run-001');
    expect(result.valid).toBe(true);
  });

  it('rejects mismatched sourceEvaluatorArtifactId vs sourceTrace.evaluatorArtifactId', async () => {
    const output = makeRolloutReviewerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).evaluatorArtifactId = 'different-id';
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('must match'))).toBe(true);
  });

  it('rejects non-string artificerArtifactId in sourceTrace', async () => {
    const output = makeRolloutReviewerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).artificerArtifactId = 42;
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('artificerArtifactId'))).toBe(true);
  });

  it('rejects non-string scribeArtifactId in sourceTrace', async () => {
    const output = makeRolloutReviewerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = 42;
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('scribeArtifactId'))).toBe(true);
  });

  it('rejects non-string philosopherArtifactId in sourceTrace', async () => {
    const output = makeRolloutReviewerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).philosopherArtifactId = { evil: true };
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('philosopherArtifactId'))).toBe(true);
  });

  it('rejects non-string dreamerArtifactId in sourceTrace', async () => {
    const output = makeRolloutReviewerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).dreamerArtifactId = true;
    const result = await validator.validate(output, ROLLOUT_REVIEWER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('dreamerArtifactId'))).toBe(true);
  });
});

describe('RolloutReviewerRunner integration: test-double captures sourceEvaluatorArtifactId from prompt', () => {
  it('seed evaluator artifact -> run rollout_reviewer with test-double -> succeeded with correct sourceEvaluatorArtifactId', async () => {
    const EVALUATOR_ART_ID = 'pi-art-evaluator-real-001';
    const artifactStore = new MemoryPIArtifactStore();

    const evaluatorArtifact: PIArtifactRecord = {
      artifactId: EVALUATOR_ART_ID,
      artifactKind: 'principle',
      sourceTaskId: EVALUATOR_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({
        taskId: EVALUATOR_TASK_ID,
        sourceArtificerArtifactId: 'pi-art-artificer-001',
        evaluation: {
          decision: 'approved',
          summary: 'Implementation plan is well-structured',
          score: 0.85,
          strengths: ['Clear change descriptions'],
          concerns: [],
          requiredChanges: [],
        },
        sourceTrace: { artificerArtifactId: 'pi-art-artificer-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await artifactStore.upsertArtifact(evaluatorArtifact);

    const rolloutReviewerTask = makeRolloutReviewerTask();

    let capturedSourceEvaluatorArtifactId: string | undefined = undefined;
    const runtimeAdapter = new TestDoubleRuntimeAdapter({
      onStartRun: (input) => {
        try {
          const payloadStr = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
          const parsed = JSON.parse(payloadStr);
          if (typeof parsed.sourceEvaluatorArtifactId === 'string' && parsed.sourceEvaluatorArtifactId.trim() !== '') {
            capturedSourceEvaluatorArtifactId = parsed.sourceEvaluatorArtifactId;
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
            taskId: ROLLOUT_REVIEWER_TASK_ID,
            sourceEvaluatorArtifactId: capturedSourceEvaluatorArtifactId ?? EVALUATOR_ART_ID,
            review: {
              decision: 'approve_rollout',
              summary: 'The evaluation is thorough and the plan is safe to proceed',
              confidence: 0.9,
              requiredChanges: [],
              rolloutRisks: [],
              safetyChecks: ['Verify feature flag is properly configured'],
            },
            sourceTrace: {
              evaluatorArtifactId: capturedSourceEvaluatorArtifactId ?? EVALUATOR_ART_ID,
            },
            risks: [],
            generatedAt: new Date().toISOString(),
          },
        }),
    });

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(rolloutReviewerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === ROLLOUT_REVIEWER_TASK_ID) return Promise.resolve(rolloutReviewerTask);
        if (id === EVALUATOR_TASK_ID) return Promise.resolve(makeEvaluatorTask());
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-integration-001',
        taskId: ROLLOUT_REVIEWER_TASK_ID,
        runtimeKind: 'rollout_reviewer',
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

    const deps: RolloutReviewerRunnerDeps = {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator: new DefaultRolloutReviewerValidator(),
      artifactStore,
    };

    const runner = new RolloutReviewerRunner(deps, {
      owner: 'test-integration',
      runtimeKind: 'rollout_reviewer',
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });

    const result = await runner.run(ROLLOUT_REVIEWER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(capturedSourceEvaluatorArtifactId).toBe(EVALUATOR_ART_ID);
    expect(result.output?.sourceEvaluatorArtifactId).toBe(EVALUATOR_ART_ID);
    expect(result.output?.sourceTrace.evaluatorArtifactId).toBe(EVALUATOR_ART_ID);

    const artifacts = await artifactStore.listBySourceTaskId(ROLLOUT_REVIEWER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');

    const [storedArtifact] = artifacts;
    expect(storedArtifact).toBeDefined();
    if (!storedArtifact) return;
    const storedOutput = JSON.parse(storedArtifact.contentJson) as RolloutReviewerOutputV1;
    expect(storedOutput.sourceEvaluatorArtifactId).toBe(EVALUATOR_ART_ID);
    expect(storedOutput.sourceTrace.evaluatorArtifactId).toBe(EVALUATOR_ART_ID);
  });
});
