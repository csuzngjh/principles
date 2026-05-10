import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScribeRunner } from '../internalization/scribe-runner.js';
import type { ScribeRunnerDeps } from '../internalization/scribe-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { ScribeOutputV1 } from '../internalization/scribe-output.js';
import { DefaultScribeValidator } from '../internalization/scribe-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';

import { PDRuntimeError } from '../error-categories.js';

const PHILOSOPHER_TASK_ID = 'philosopher-001';
const SCRIBE_TASK_ID = 'scribe-001';

function makePhilosopherTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: PHILOSOPHER_TASK_ID,
    taskKind: 'philosopher',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'philosopher://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-philosopher-001-run-001' }],
    }),
    ...overrides,
  };
}

function makeScribeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: SCRIBE_TASK_ID,
    taskKind: 'scribe',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [PHILOSOPHER_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-philosopher-001-run-001' }],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeScribeOutput(): ScribeOutputV1 {
  return {
    taskId: SCRIBE_TASK_ID,
    sourcePhilosopherArtifactId: 'pi-art-philosopher-001-run-001',
    principleDraft: {
      title: 'Systematic Error Handling',
      statement: 'All async operations must include explicit error handling',
      rationale: 'Uncaught errors cascade into system instability',
      applicability: ['All async operations'],
      antiPatterns: ['Ignoring promise rejections'],
      confidence: 0.9,
    },
    sourceTrace: {
      philosopherArtifactId: 'pi-art-philosopher-001-run-001',
    },
    risks: ['May add latency from error checking'],
    generatedAt: new Date().toISOString(),
  };
}

function makePhilosopherArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-philosopher-001-run-001',
    artifactKind: 'principle',
    sourceTaskId: PHILOSOPHER_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: PHILOSOPHER_TASK_ID,
      sourceDreamerArtifactId: 'pi-art-dreamer-001',
      thesis: 'Error handling should be systematic',
      principleCandidate: {
        title: 'Systematic Error Handling',
        rationale: 'Uncaught errors cascade',
        scope: 'All async operations',
        confidence: 0.9,
      },
      risks: [],
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('ScribeRunner (PRI-109)', () => {
  let artifactStore: PIArtifactStore = new MemoryPIArtifactStore();

  beforeEach(() => {
    artifactStore = new MemoryPIArtifactStore();
  });

  function createMockDeps(overrides: Partial<ScribeRunnerDeps> = {}): ScribeRunnerDeps {
    const scribeTask = makeScribeTask();
    const philosopherTask = makePhilosopherTask();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(scribeTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === SCRIBE_TASK_ID) return Promise.resolve(scribeTask);
        if (id === PHILOSOPHER_TASK_ID) return Promise.resolve(philosopherTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-scribe-001',
        taskId: SCRIBE_TASK_ID,
        runtimeKind: 'scribe',
        startedAt: new Date().toISOString(),
      }]),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const runHandle: RunHandle = { runId: 'run-scribe-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-scribe-001' };

    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue(runHandle),
      pollRun: vi.fn().mockResolvedValue(succeededStatus),
      fetchOutput: vi.fn().mockResolvedValue({
        payload: makeScribeOutput(),
      }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter;

    const validator = new DefaultScribeValidator();

    return {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator,
      artifactStore,
      ...overrides,
    };
  }

  it('taskKind not scribe fails closed and releases lease', async () => {
    const wrongKindTask = makeScribeTask({ taskKind: 'dreamer' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(wrongKindTask);

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain("must be 'scribe'");
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      SCRIBE_TASK_ID,
      'input_invalid',
    );
  });

  it('lease conflict is non-mutating', async () => {
    const deps = createMockDeps();
    const leaseError = new PDRuntimeError('lease_conflict', 'Another runner holds the lease');
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockRejectedValue(leaseError);

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    expect(deps.stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(deps.stateManager.markTaskRetryWait).not.toHaveBeenCalled();
  });

  it('missing philosopher dependency blocked/failure', async () => {
    const noDepTask = makeScribeTask({
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

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('philosopher dependency not succeeded cannot execute', async () => {
    const pendingPhilosopher = makePhilosopherTask({ status: 'pending' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).getTask = vi.fn().mockImplementation((id: string) => {
      if (id === SCRIBE_TASK_ID) return Promise.resolve(makeScribeTask());
      if (id === PHILOSOPHER_TASK_ID) return Promise.resolve(pendingPhilosopher);
      return Promise.resolve(null);
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('philosopher artifact missing goes to retry/fail', async () => {
    const emptyArtifactStore = new MemoryPIArtifactStore();
    const deps = createMockDeps({ artifactStore: emptyArtifactStore });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('valid runtime output writes scribe PIArtifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    const artifacts = await store.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
  });

  it('valid runtime output marks task succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      SCRIBE_TASK_ID,
      expect.stringContaining('scribe://'),
    );
  });

  it('invalid output does not write artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput: ScribeOutputV1 = {
      taskId: 'wrong-task-id',
      sourcePhilosopherArtifactId: '',
      principleDraft: {
        title: '',
        statement: '',
        rationale: '',
        applicability: [],
        antiPatterns: [],
        confidence: 1.5,
      },
      sourceTrace: {
        philosopherArtifactId: '',
      },
      risks: 'not-array' as unknown as string[],
      generatedAt: '',
    };

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');

    const artifacts = await store.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  it('artifact write failure goes to retry/fail, not mark succeeded', async () => {
    const failingStore = {
      listBySourceTaskId: vi.fn().mockResolvedValue([makePhilosopherArtifact()]),
      upsertArtifact: vi.fn().mockRejectedValue(new Error('Disk full')),
    } as unknown as PIArtifactStore;

    const deps = createMockDeps({ artifactStore: failingStore });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('mismatched sourcePhilosopherArtifactId does not write artifact or mark succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makePhilosopherArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const mismatchedOutput = makeScribeOutput();
    (mismatchedOutput as unknown as Record<string, unknown>).sourcePhilosopherArtifactId = 'wrong-artifact-id';
    (mismatchedOutput.sourceTrace as unknown as Record<string, unknown>).philosopherArtifactId = 'wrong-artifact-id';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedOutput,
    });

    const runner = new ScribeRunner(deps, {
      owner: 'test',
      runtimeKind: 'scribe',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    const artifacts = await store.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifacts).toHaveLength(0);
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });
});

describe('DefaultScribeValidator (PRI-109)', () => {
  const validator = new DefaultScribeValidator();

  it('accepts valid Scribe output', async () => {
    const result = await validator.validate(makeScribeOutput(), SCRIBE_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects taskId mismatch', async () => {
    const output = makeScribeOutput();
    (output as unknown as Record<string, unknown>).taskId = 'wrong';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId mismatch'))).toBe(true);
  });

  it('rejects missing sourcePhilosopherArtifactId', async () => {
    const output = makeScribeOutput();
    (output as unknown as Record<string, unknown>).sourcePhilosopherArtifactId = '';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourcePhilosopherArtifactId'))).toBe(true);
  });

  it('rejects confidence as string', async () => {
    const output = makeScribeOutput();
    (output.principleDraft as unknown as Record<string, unknown>).confidence = '0.9';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be number'))).toBe(true);
  });

  it('rejects confidence > 1', async () => {
    const output = makeScribeOutput();
    (output.principleDraft as unknown as Record<string, unknown>).confidence = 1.5;
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be in [0, 1]'))).toBe(true);
  });

  it('rejects null output', async () => {
    const result = await validator.validate(null as unknown as ScribeOutputV1, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects missing principleDraft.title', async () => {
    const output = makeScribeOutput();
    (output.principleDraft as unknown as Record<string, unknown>).title = '';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('principleDraft.title'))).toBe(true);
  });

  it('rejects missing sourceTrace.philosopherArtifactId', async () => {
    const output = makeScribeOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).philosopherArtifactId = '';
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.philosopherArtifactId'))).toBe(true);
  });

  it('rejects applicability with non-string elements', async () => {
    const output = makeScribeOutput();
    (output.principleDraft as unknown as Record<string, unknown>).applicability = [1, 2];
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('applicability must be an array of strings'))).toBe(true);
  });

  it('rejects antiPatterns with non-string elements', async () => {
    const output = makeScribeOutput();
    (output.principleDraft as unknown as Record<string, unknown>).antiPatterns = [true];
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('antiPatterns must be an array of strings'))).toBe(true);
  });

  it('rejects risks with non-string elements', async () => {
    const output = makeScribeOutput();
    (output as unknown as Record<string, unknown>).risks = [42];
    const result = await validator.validate(output, SCRIBE_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('risks must be an array of strings'))).toBe(true);
  });

  it('rejects mismatched sourcePhilosopherArtifactId when expected is provided', async () => {
    const output = makeScribeOutput();
    (output as unknown as Record<string, unknown>).sourcePhilosopherArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, SCRIBE_TASK_ID, 'pi-art-philosopher-001-run-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourcePhilosopherArtifactId mismatch'))).toBe(true);
  });

  it('rejects mismatched sourceTrace.philosopherArtifactId when expected is provided', async () => {
    const output = makeScribeOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).philosopherArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, SCRIBE_TASK_ID, 'pi-art-philosopher-001-run-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.philosopherArtifactId mismatch'))).toBe(true);
  });

  it('accepts valid output with matching expectedSourcePhilosopherArtifactId', async () => {
    const output = makeScribeOutput();
    const result = await validator.validate(output, SCRIBE_TASK_ID, 'pi-art-philosopher-001-run-001');
    expect(result.valid).toBe(true);
  });
});
