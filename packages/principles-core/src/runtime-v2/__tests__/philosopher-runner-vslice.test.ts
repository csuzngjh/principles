import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhilosopherRunner } from '../internalization/philosopher-runner.js';
import type { PhilosopherRunnerDeps } from '../internalization/philosopher-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { PhilosopherOutputV1 } from '../internalization/philosopher-output.js';
import { DefaultPhilosopherValidator } from '../internalization/philosopher-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';

import { PDRuntimeError } from '../error-categories.js';

const DREAMER_TASK_ID = 'dreamer-001';
const PHILOSOPHER_TASK_ID = 'philosopher-001';

function makeDreamerTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
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
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-dreamer-001-run-001' }],
    }),
    ...overrides,
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
      inputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-dreamer-001-run-001' }],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makePhilosopherOutput(): PhilosopherOutputV1 {
  return {
    taskId: PHILOSOPHER_TASK_ID,
    sourceDreamerArtifactId: 'pi-art-dreamer-001-run-001',
    thesis: 'Error handling should be systematic and comprehensive',
    principleCandidate: {
      title: 'Systematic Error Handling',
      rationale: 'Uncaught errors cascade into system instability',
      scope: 'All async operations',
      confidence: 0.9,
    },
    risks: ['May add latency from error checking'],
    generatedAt: new Date().toISOString(),
  };
}

function makeDreamerArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-dreamer-001-run-001',
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

describe('PhilosopherRunner (PRI-90)', () => {
  let artifactStore: PIArtifactStore = new MemoryPIArtifactStore();

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
        runId: 'run-phil-001',
        taskId: PHILOSOPHER_TASK_ID,
        runtimeKind: 'philosopher',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-phil-001', taskId: PHILOSOPHER_TASK_ID, runtimeKind: 'philosopher', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const runHandle: RunHandle = { runId: 'run-phil-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-phil-001' };

    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue(runHandle),
      pollRun: vi.fn().mockResolvedValue(succeededStatus),
      fetchOutput: vi.fn().mockResolvedValue({
        payload: makePhilosopherOutput(),
      }),
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

  it('taskKind not philosopher fails closed and releases lease', async () => {
    const wrongKindTask = makePhilosopherTask({ taskKind: 'dreamer' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(wrongKindTask);

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain("must be 'philosopher'");
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      PHILOSOPHER_TASK_ID,
      'input_invalid',
    );
  });

  it('lease conflict is non-mutating', async () => {
    const deps = createMockDeps();
    const leaseError = new PDRuntimeError('lease_conflict', 'Another runner holds the lease');
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockRejectedValue(leaseError);

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

  it('missing Dreamer dependency blocked/failure', async () => {
    const noDepTask = makePhilosopherTask({
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

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('Dreamer dependency not succeeded cannot execute', async () => {
    const pendingDreamer = makeDreamerTask({ status: 'pending' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).getTask = vi.fn().mockImplementation((id: string) => {
      if (id === PHILOSOPHER_TASK_ID) return Promise.resolve(makePhilosopherTask());
      if (id === DREAMER_TASK_ID) return Promise.resolve(pendingDreamer);
      return Promise.resolve(null);
    });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('Dreamer artifact missing goes to retry/fail', async () => {
    const emptyArtifactStore = new MemoryPIArtifactStore();
    const deps = createMockDeps({ artifactStore: emptyArtifactStore });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('valid runtime output writes Philosopher PIArtifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    const artifacts = await store.listBySourceTaskId(PHILOSOPHER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
  });

  it('valid runtime output marks task succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new PhilosopherRunner(deps, {
      owner: 'test',
      runtimeKind: 'philosopher',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(PHILOSOPHER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      PHILOSOPHER_TASK_ID,
      expect.stringContaining('philosopher://'),
    );
  });

  it('invalid output does not write artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeDreamerArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput: PhilosopherOutputV1 = {
      taskId: 'wrong-task-id',
      sourceDreamerArtifactId: '',
      thesis: '',
      principleCandidate: {
        title: '',
        rationale: '',
        scope: '',
        confidence: 1.5,
      },
      risks: 'not-array' as unknown as string[],
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

    const artifacts = await store.listBySourceTaskId(PHILOSOPHER_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  it('artifact write failure goes to retry/fail, not mark succeeded', async () => {
    const failingStore = {
      listBySourceTaskId: vi.fn().mockResolvedValue([makeDreamerArtifact()]),
      upsertArtifact: vi.fn().mockRejectedValue(new Error('Disk full')),
    } as unknown as PIArtifactStore;

    const deps = createMockDeps({ artifactStore: failingStore });

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
});

describe('DefaultPhilosopherValidator (PRI-90)', () => {
  const validator = new DefaultPhilosopherValidator();

  it('accepts valid Philosopher output', async () => {
    const result = await validator.validate(makePhilosopherOutput(), PHILOSOPHER_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects taskId mismatch', async () => {
    const output = makePhilosopherOutput();
    (output as unknown as Record<string, unknown>).taskId = 'wrong';
    const result = await validator.validate(output, PHILOSOPHER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId mismatch'))).toBe(true);
  });

  it('rejects empty thesis', async () => {
    const output = makePhilosopherOutput();
    (output as unknown as Record<string, unknown>).thesis = '';
    const result = await validator.validate(output, PHILOSOPHER_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects confidence out of range', async () => {
    const output = makePhilosopherOutput();
    (output.principleCandidate as unknown as Record<string, unknown>).confidence = 1.5;
    const result = await validator.validate(output, PHILOSOPHER_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects null output', async () => {
    const result = await validator.validate(null as unknown as PhilosopherOutputV1, PHILOSOPHER_TASK_ID);
    expect(result.valid).toBe(false);
  });
});
