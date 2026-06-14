import { describe, it, expect, vi } from 'vitest';
import { TrainerRunner } from '../internalization/trainer-runner.js';
import type { TrainerRunnerDeps } from '../internalization/trainer-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { TrainerOutputV1 } from '../internalization/trainer-output.js';
import { DefaultTrainerValidator } from '../internalization/trainer-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';
import { TestDoubleRuntimeAdapter } from '../adapter/test-double-runtime-adapter.js';

const ROLLOUT_REVIEWER_TASK_ID = 'rollout-reviewer-001';
const TRAINER_TASK_ID = 'trainer-001';

function makeRolloutReviewerTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ROLLOUT_REVIEWER_TASK_ID,
    taskKind: 'rollout_reviewer',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'rollout-reviewer://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'model_training',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-rollout-reviewer-001-run-001' }],
    }),
    ...overrides,
  };
}

function makeTrainerTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TRAINER_TASK_ID,
    taskKind: 'trainer',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [ROLLOUT_REVIEWER_TASK_ID],
      channel: 'model_training',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-rollout-reviewer-001-run-001' }],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeTrainerOutput(sourceRolloutReviewerArtifactId: string): TrainerOutputV1 {
  return {
    taskId: TRAINER_TASK_ID,
    sourceRolloutReviewerArtifactId,
    ruleCandidate: {
      toolScope: 'tool_call',
      triggerCondition: 'When a tool is called with invalid parameters',
      proposedDecision: 'auto_correct',
      proposedCorrection: {
        description: 'Use default parameters instead',
        proposedParams: { defaultTimeout: 5000 },
      },
      rationale: 'Safe to auto-correct with sensible defaults',
      confidence: 0.88,
    },
    safety: {
      limitations: ['Requires feature flag enabled'],
      falsePositiveRisks: ['May incorrectly auto-correct edge case inputs'],
      requiredReplayCases: ['tool_call with null params', 'tool_call with empty toolName'],
    },
    sourceTrace: {
      rolloutReviewerArtifactId: sourceRolloutReviewerArtifactId,
    },
    goldenTraceRefs: ['gt-case-001'],
    generatedAt: new Date().toISOString(),
  };
}

function makeRolloutReviewerArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-rollout-reviewer-001-run-001',
    artifactKind: 'principle',
    sourceTaskId: ROLLOUT_REVIEWER_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: ROLLOUT_REVIEWER_TASK_ID,
      sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
      review: {
        decision: 'approve_rollout',
        summary: 'The rollout plan is safe to proceed',
        confidence: 0.9,
        requiredChanges: [],
        rolloutRisks: ['Feature flag configuration may need adjustment'],
        safetyChecks: ['Verify feature flag is properly configured'],
      },
      sourceTrace: {
        evaluatorArtifactId: 'pi-art-evaluator-001',
      },
      risks: ['Rollback plan should be tested before deployment'],
      generatedAt: '2026-05-11T12:00:00.000Z',
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('TrainerRunner (vertical slice)', () => {
  function createMockDeps(overrides: Partial<TrainerRunnerDeps> = {}): TrainerRunnerDeps {
    const artifactStore = overrides.artifactStore ?? new MemoryPIArtifactStore();
    const trainerTask = makeTrainerTask();
    const rolloutReviewerTask = makeRolloutReviewerTask();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(trainerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === TRAINER_TASK_ID) return Promise.resolve(trainerTask);
        if (id === ROLLOUT_REVIEWER_TASK_ID) return Promise.resolve(rolloutReviewerTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-trainer-001',
        taskId: TRAINER_TASK_ID,
        runtimeKind: 'trainer',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-trainer-001', taskId: TRAINER_TASK_ID, runtimeKind: 'trainer', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const runHandle: RunHandle = { runId: 'run-trainer-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-trainer-001' };

    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue(runHandle),
      pollRun: vi.fn().mockResolvedValue(succeededStatus),
      fetchOutput: vi.fn().mockResolvedValue({
        payload: makeTrainerOutput('pi-art-rollout-reviewer-001-run-001'),
      }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter;

    const validator = new DefaultTrainerValidator();

    return {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator,
      artifactStore,
      ...overrides,
    };
  }

  it('taskKind not trainer fails closed and releases lease', async () => {
    const wrongKindTask = makeTrainerTask({ taskKind: 'dreamer' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(wrongKindTask);

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain("must be 'trainer'");
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      TRAINER_TASK_ID,
      'input_invalid',
    );
  });

  it('missing rollout_reviewer dependency blocked/failure', async () => {
    const noDepTask = makeTrainerTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'model_training',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(noDepTask);
    (deps.stateManager as unknown as Record<string, unknown>).getTask = vi.fn().mockResolvedValue(noDepTask);

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('rollout_reviewer dependency not succeeded cannot execute', async () => {
    const pendingRolloutReviewer = makeRolloutReviewerTask({ status: 'pending' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).getTask = vi.fn().mockImplementation((id: string) => {
      if (id === TRAINER_TASK_ID) return Promise.resolve(makeTrainerTask());
      if (id === ROLLOUT_REVIEWER_TASK_ID) return Promise.resolve(pendingRolloutReviewer);
      return Promise.resolve(null);
    });

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('rollout_reviewer artifact missing goes to retry/fail', async () => {
    const emptyArtifactStore = new MemoryPIArtifactStore();
    const deps = createMockDeps({ artifactStore: emptyArtifactStore });

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('valid runtime output writes trainer PIArtifact with artifactKind rule', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeRolloutReviewerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    const artifacts = await store.listBySourceTaskId(TRAINER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('rule');
  });

  it('valid runtime output marks task succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeRolloutReviewerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      TRAINER_TASK_ID,
      expect.stringContaining('trainer://'),
    );
  });

  it('invalid output does not write artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeRolloutReviewerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput: TrainerOutputV1 = {
      taskId: 'wrong-task-id',
      sourceRolloutReviewerArtifactId: '',
      ruleCandidate: {
        toolScope: '',
        triggerCondition: '',
        proposedDecision: 'invalid' as 'allow',
        rationale: '',
        confidence: 1.5,
      },
      safety: {
        limitations: [],
        falsePositiveRisks: [],
        requiredReplayCases: [],
      },
      sourceTrace: {
        rolloutReviewerArtifactId: '',
      },
      generatedAt: '',
    };

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('failed');

    const artifacts = await store.listBySourceTaskId(TRAINER_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  it('artifact write failure goes to retry/fail, not mark succeeded', async () => {
    const failingStore = {
      listBySourceTaskId: vi.fn().mockImplementation(async (sourceTaskId: string) => {
        return sourceTaskId === ROLLOUT_REVIEWER_TASK_ID ? [makeRolloutReviewerArtifact()] : [];
      }),
      upsertArtifact: vi.fn().mockRejectedValue(new Error('Disk full')),
    } as unknown as PIArtifactStore;

    const deps = createMockDeps({ artifactStore: failingStore });

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(failingStore.listBySourceTaskId).toHaveBeenCalledWith(ROLLOUT_REVIEWER_TASK_ID);
    expect(failingStore.upsertArtifact).toHaveBeenCalled();
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('mismatched sourceRolloutReviewerArtifactId does not write artifact or mark succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeRolloutReviewerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const mismatchedOutput = makeTrainerOutput('wrong-artifact-id');
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedOutput,
    });

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    const artifacts = await store.listBySourceTaskId(TRAINER_TASK_ID);
    expect(artifacts).toHaveLength(0);
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('sourceTrace.rolloutReviewerArtifactId mismatch does not write artifact or mark succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeRolloutReviewerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const mismatchedOutput = makeTrainerOutput('pi-art-rollout-reviewer-001-run-001');
    (mismatchedOutput.sourceTrace as unknown as Record<string, unknown>).rolloutReviewerArtifactId = 'wrong-trace-id';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedOutput,
    });

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    const artifacts = await store.listBySourceTaskId(TRAINER_TASK_ID);
    expect(artifacts).toHaveLength(0);
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('output_invalid is permanent failure', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeRolloutReviewerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput = makeTrainerOutput('pi-art-rollout-reviewer-001-run-001');
    (invalidOutput.ruleCandidate as unknown as Record<string, unknown>).proposedDecision = 'invalid';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new TrainerRunner(deps, {
      owner: 'test',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(TRAINER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith(TRAINER_TASK_ID, 'output_invalid');
  });
});

describe('TrainerRunner integration: test-double captures sourceRolloutReviewerArtifactId from prompt', () => {
  it('seed rollout_reviewer artifact -> run trainer with test-double -> succeeded with correct sourceRolloutReviewerArtifactId', async () => {
    const ROLLOUT_REVIEWER_ART_ID = 'pi-art-rollout-reviewer-real-001';
    const artifactStore = new MemoryPIArtifactStore();

    const rolloutReviewerArtifact: PIArtifactRecord = {
      artifactId: ROLLOUT_REVIEWER_ART_ID,
      artifactKind: 'principle',
      sourceTaskId: ROLLOUT_REVIEWER_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({
        taskId: ROLLOUT_REVIEWER_TASK_ID,
        sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
        review: {
          decision: 'approve_rollout',
          summary: 'The rollout plan is safe to proceed',
          confidence: 0.9,
          requiredChanges: [],
          rolloutRisks: [],
          safetyChecks: [],
        },
        sourceTrace: {
          evaluatorArtifactId: 'pi-art-evaluator-001',
        },
        risks: [],
        generatedAt: new Date().toISOString(),
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await artifactStore.upsertArtifact(rolloutReviewerArtifact);

    const trainerTask = makeTrainerTask();

    let capturedSourceRolloutReviewerArtifactId: string | undefined = undefined;
    const runtimeAdapter = new TestDoubleRuntimeAdapter({
      onStartRun: (input) => {
        try {
          const payloadStr = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
          const parsed = JSON.parse(payloadStr);
          if (typeof parsed.sourceRolloutReviewerArtifactId === 'string' && parsed.sourceRolloutReviewerArtifactId.trim() !== '') {
            capturedSourceRolloutReviewerArtifactId = parsed.sourceRolloutReviewerArtifactId;
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
          taskId: TRAINER_TASK_ID,
          sourceRolloutReviewerArtifactId: capturedSourceRolloutReviewerArtifactId ?? ROLLOUT_REVIEWER_ART_ID,
          ruleCandidate: {
            toolScope: 'tool_call',
            triggerCondition: 'When a tool is called',
            proposedDecision: 'allow',
            rationale: 'Safe operation',
            confidence: 0.85,
          },
          safety: {
            limitations: [],
            falsePositiveRisks: [],
            requiredReplayCases: [],
          },
          sourceTrace: {
            rolloutReviewerArtifactId: capturedSourceRolloutReviewerArtifactId ?? ROLLOUT_REVIEWER_ART_ID,
          },
          generatedAt: new Date().toISOString(),
        },
      }),
    });

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(trainerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === TRAINER_TASK_ID) return Promise.resolve(trainerTask);
        if (id === ROLLOUT_REVIEWER_TASK_ID) return Promise.resolve(makeRolloutReviewerTask());
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-integration-001',
        taskId: TRAINER_TASK_ID,
        runtimeKind: 'trainer',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-integration-001', taskId: TRAINER_TASK_ID, runtimeKind: 'trainer', startedAt: new Date().toISOString() }],
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

    const deps: TrainerRunnerDeps = {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator: new DefaultTrainerValidator(),
      artifactStore,
    };

    const runner = new TrainerRunner(deps, {
      owner: 'test-integration',
      runtimeKind: 'trainer',
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });

    const result = await runner.run(TRAINER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(capturedSourceRolloutReviewerArtifactId).toBe(ROLLOUT_REVIEWER_ART_ID);
    expect(result.output?.sourceRolloutReviewerArtifactId).toBe(ROLLOUT_REVIEWER_ART_ID);
    expect(result.output?.sourceTrace.rolloutReviewerArtifactId).toBe(ROLLOUT_REVIEWER_ART_ID);

    const artifacts = await artifactStore.listBySourceTaskId(TRAINER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('rule');

    const [storedArtifact] = artifacts;
    expect(storedArtifact).toBeDefined();
    if (!storedArtifact) return;
    const storedOutput = JSON.parse(storedArtifact.contentJson) as TrainerOutputV1;
    expect(storedOutput.sourceRolloutReviewerArtifactId).toBe(ROLLOUT_REVIEWER_ART_ID);
    expect(storedOutput.sourceTrace.rolloutReviewerArtifactId).toBe(ROLLOUT_REVIEWER_ART_ID);
  });
});
