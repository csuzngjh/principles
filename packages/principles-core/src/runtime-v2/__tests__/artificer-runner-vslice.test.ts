import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArtificerRunner } from '../internalization/artificer-runner.js';
import type { ArtificerRunnerDeps } from '../internalization/artificer-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { ArtificerOutputV1 } from '../internalization/artificer-output.js';
import { DefaultArtificerValidator } from '../internalization/artificer-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';
import { TestDoubleRuntimeAdapter } from '../adapter/test-double-runtime-adapter.js';

import { PDRuntimeError } from '../error-categories.js';

const SCRIBE_TASK_ID = 'scribe-001';
const ARTIFICER_TASK_ID = 'artificer-001';

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
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-scribe-001-run-001' }],
    }),
    ...overrides,
  };
}

function makeArtificerTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ARTIFICER_TASK_ID,
    taskKind: 'artificer',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [SCRIBE_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-scribe-001-run-001' }],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeArtificerOutput(): ArtificerOutputV1 {
  return {
    taskId: ARTIFICER_TASK_ID,
    sourceScribeArtifactId: 'pi-art-scribe-001-run-001',
    implementationPlan: {
      summary: 'Add input validation to all async operations',
      targetSurface: 'src/async-ops/*.ts',
      changes: ['Add try-catch to asyncOp1', 'Add error boundary to asyncOp2'],
      tests: ['Unit test for asyncOp1 error handling', 'Integration test for error boundary'],
      rolloutNotes: ['Deploy behind feature flag', 'Monitor error rates post-deploy'],
      confidence: 0.85,
    },
    sourceTrace: {
      scribeArtifactId: 'pi-art-scribe-001-run-001',
    },
    risks: ['May add latency from error checking'],
    generatedAt: new Date().toISOString(),
  };
}

function makeScribeArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-scribe-001-run-001',
    artifactKind: 'principle',
    sourceTaskId: SCRIBE_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: SCRIBE_TASK_ID,
      sourcePhilosopherArtifactId: 'pi-art-philosopher-001',
      principleDraft: {
        title: 'Systematic Error Handling',
        statement: 'All async operations must include explicit error handling',
        rationale: 'Uncaught errors cascade into system instability',
        applicability: ['All async operations'],
        antiPatterns: ['Ignoring promise rejections'],
        confidence: 0.9,
      },
      sourceTrace: {
        philosopherArtifactId: 'pi-art-philosopher-001',
      },
      risks: [],
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('ArtificerRunner (PRI-111)', () => {
  let artifactStore: PIArtifactStore = new MemoryPIArtifactStore();

  beforeEach(() => {
    artifactStore = new MemoryPIArtifactStore();
  });

  function createMockDeps(overrides: Partial<ArtificerRunnerDeps> = {}): ArtificerRunnerDeps {
    const artificerTask = makeArtificerTask();
    const scribeTask = makeScribeTask();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(artificerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === ARTIFICER_TASK_ID) return Promise.resolve(artificerTask);
        if (id === SCRIBE_TASK_ID) return Promise.resolve(scribeTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-artificer-001',
        taskId: ARTIFICER_TASK_ID,
        runtimeKind: 'artificer',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-artificer-001', taskId: ARTIFICER_TASK_ID, runtimeKind: 'artificer', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const runHandle: RunHandle = { runId: 'run-artificer-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-artificer-001' };

    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue(runHandle),
      pollRun: vi.fn().mockResolvedValue(succeededStatus),
      fetchOutput: vi.fn().mockResolvedValue({
        payload: makeArtificerOutput(),
      }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter;

    const validator = new DefaultArtificerValidator();

    return {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator,
      artifactStore,
      ...overrides,
    };
  }

  it('taskKind not artificer fails closed and releases lease', async () => {
    const wrongKindTask = makeArtificerTask({ taskKind: 'dreamer' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(wrongKindTask);

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain("must be 'artificer'");
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      ARTIFICER_TASK_ID,
      'input_invalid',
    );
  });

  it('lease conflict is non-mutating', async () => {
    const deps = createMockDeps();
    const leaseError = new PDRuntimeError('lease_conflict', 'Another runner holds the lease');
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockRejectedValue(leaseError);

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    expect(deps.stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(deps.stateManager.markTaskRetryWait).not.toHaveBeenCalled();
  });

  it('missing scribe dependency blocked/failure', async () => {
    const noDepTask = makeArtificerTask({
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

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('scribe dependency not succeeded cannot execute', async () => {
    const pendingScribe = makeScribeTask({ status: 'pending' });
    const deps = createMockDeps();
    (deps.stateManager as unknown as Record<string, unknown>).getTask = vi.fn().mockImplementation((id: string) => {
      if (id === ARTIFICER_TASK_ID) return Promise.resolve(makeArtificerTask());
      if (id === SCRIBE_TASK_ID) return Promise.resolve(pendingScribe);
      return Promise.resolve(null);
    });

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('scribe artifact missing goes to retry/fail', async () => {
    const emptyArtifactStore = new MemoryPIArtifactStore();
    const deps = createMockDeps({ artifactStore: emptyArtifactStore });

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
  });

  it('valid runtime output writes artificer PIArtifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    const artifacts = await store.listBySourceTaskId(ARTIFICER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
  });

  it('valid runtime output marks task succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      ARTIFICER_TASK_ID,
      expect.stringContaining('artificer://'),
    );
  });

  it('invalid output does not write artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const invalidOutput: ArtificerOutputV1 = {
      taskId: 'wrong-task-id',
      sourceScribeArtifactId: '',
      implementationPlan: {
        summary: '',
        targetSurface: '',
        changes: [],
        tests: [],
        rolloutNotes: [],
        confidence: 1.5,
      },
      sourceTrace: {
        scribeArtifactId: '',
      },
      risks: 'not-array' as unknown as string[],
      generatedAt: '',
    };

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: invalidOutput,
    });

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);
    expect(result.status).toBe('failed');

    const artifacts = await store.listBySourceTaskId(ARTIFICER_TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  it('artifact write failure goes to retry/fail, not mark succeeded', async () => {
    const failingStore = {
      listBySourceTaskId: vi.fn().mockResolvedValue([makeScribeArtifact()]),
      upsertArtifact: vi.fn().mockRejectedValue(new Error('Disk full')),
    } as unknown as PIArtifactStore;

    const deps = createMockDeps({ artifactStore: failingStore });

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('mismatched sourceScribeArtifactId does not write artifact or mark succeeded', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    const mismatchedOutput = makeArtificerOutput();
    (mismatchedOutput as unknown as Record<string, unknown>).sourceScribeArtifactId = 'wrong-artifact-id';
    (mismatchedOutput.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = 'wrong-artifact-id';

    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({
      payload: mismatchedOutput,
    });

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');

    const artifacts = await store.listBySourceTaskId(ARTIFICER_TASK_ID);
    expect(artifacts).toHaveLength(0);
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });
});

describe('DefaultArtificerValidator (PRI-111)', () => {
  const validator = new DefaultArtificerValidator();

  it('accepts valid Artificer output', async () => {
    const result = await validator.validate(makeArtificerOutput(), ARTIFICER_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects taskId mismatch', async () => {
    const output = makeArtificerOutput();
    (output as unknown as Record<string, unknown>).taskId = 'wrong';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId mismatch'))).toBe(true);
  });

  it('rejects missing sourceScribeArtifactId', async () => {
    const output = makeArtificerOutput();
    (output as unknown as Record<string, unknown>).sourceScribeArtifactId = '';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceScribeArtifactId'))).toBe(true);
  });

  it('rejects mismatched sourceScribeArtifactId when expected is provided', async () => {
    const output = makeArtificerOutput();
    (output as unknown as Record<string, unknown>).sourceScribeArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, ARTIFICER_TASK_ID, 'pi-art-scribe-001-run-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceScribeArtifactId mismatch'))).toBe(true);
  });

  it('rejects mismatched sourceTrace.scribeArtifactId when expected is provided', async () => {
    const output = makeArtificerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = 'wrong-artifact-id';
    const result = await validator.validate(output, ARTIFICER_TASK_ID, 'pi-art-scribe-001-run-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.scribeArtifactId mismatch'))).toBe(true);
  });

  it('rejects confidence as string', async () => {
    const output = makeArtificerOutput();
    (output.implementationPlan as unknown as Record<string, unknown>).confidence = '0.85';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be number'))).toBe(true);
  });

  it('rejects confidence > 1', async () => {
    const output = makeArtificerOutput();
    (output.implementationPlan as unknown as Record<string, unknown>).confidence = 1.5;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be in [0, 1]'))).toBe(true);
  });

  it('rejects NaN confidence', async () => {
    const output = makeArtificerOutput();
    (output.implementationPlan as unknown as Record<string, unknown>).confidence = NaN;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be number'))).toBe(true);
  });

  it('rejects Infinity confidence', async () => {
    const output = makeArtificerOutput();
    (output.implementationPlan as unknown as Record<string, unknown>).confidence = Infinity;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be number'))).toBe(true);
  });

  it('rejects null output', async () => {
    const result = await validator.validate(null as unknown as ArtificerOutputV1, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects changes with non-string elements', async () => {
    const output = makeArtificerOutput();
    (output.implementationPlan as unknown as Record<string, unknown>).changes = [1, 2];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('changes must be an array of strings'))).toBe(true);
  });

  it('rejects tests with non-string elements', async () => {
    const output = makeArtificerOutput();
    (output.implementationPlan as unknown as Record<string, unknown>).tests = [true];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('tests must be an array of strings'))).toBe(true);
  });

  it('rejects rolloutNotes with non-string elements', async () => {
    const output = makeArtificerOutput();
    (output.implementationPlan as unknown as Record<string, unknown>).rolloutNotes = [42];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('rolloutNotes must be an array of strings'))).toBe(true);
  });

  it('rejects risks with non-string elements', async () => {
    const output = makeArtificerOutput();
    (output as unknown as Record<string, unknown>).risks = [42];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('risks must be an array of strings'))).toBe(true);
  });

  it('rejects missing implementationPlan.summary', async () => {
    const output = makeArtificerOutput();
    (output.implementationPlan as unknown as Record<string, unknown>).summary = '';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('implementationPlan.summary'))).toBe(true);
  });

  it('rejects missing implementationPlan.targetSurface', async () => {
    const output = makeArtificerOutput();
    (output.implementationPlan as unknown as Record<string, unknown>).targetSurface = '';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('implementationPlan.targetSurface'))).toBe(true);
  });

  it('rejects missing sourceTrace.scribeArtifactId', async () => {
    const output = makeArtificerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = '';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.scribeArtifactId'))).toBe(true);
  });

  it('accepts valid output with matching expectedSourceScribeArtifactId', async () => {
    const output = makeArtificerOutput();
    const result = await validator.validate(output, ARTIFICER_TASK_ID, 'pi-art-scribe-001-run-001');
    expect(result.valid).toBe(true);
  });

  it('rejects non-string philosopherArtifactId in sourceTrace', async () => {
    const output = makeArtificerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).philosopherArtifactId = 42;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('philosopherArtifactId'))).toBe(true);
  });

  it('rejects non-string dreamerArtifactId in sourceTrace', async () => {
    const output = makeArtificerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).dreamerArtifactId = { evil: true };
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('dreamerArtifactId'))).toBe(true);
  });

  it('rejects mismatched sourceScribeArtifactId vs sourceTrace.scribeArtifactId', async () => {
    const output = makeArtificerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId = 'different-id';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('must match'))).toBe(true);
  });

  it('rejects prototype-inherited taskId (ERR-013)', async () => {
    const proto = { taskId: ARTIFICER_TASK_ID };
    const output = Object.create(proto) as ArtificerOutputV1;
    // Copy all own properties from a valid output except taskId
    const valid = makeArtificerOutput();
    Object.assign(output, { ...valid, taskId: undefined });
    delete (output as unknown as Record<string, unknown>).taskId;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId'))).toBe(true);
  });

  it('rejects prototype-inherited sourceScribeArtifactId (ERR-013)', async () => {
    const output = makeArtificerOutput();
    const ownValue = output.sourceScribeArtifactId;
    delete (output as unknown as Record<string, unknown>).sourceScribeArtifactId;
    Object.setPrototypeOf(output, { sourceScribeArtifactId: ownValue });
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceScribeArtifactId'))).toBe(true);
  });

  it('rejects prototype-inherited sourceTrace.scribeArtifactId (ERR-013)', async () => {
    const output = makeArtificerOutput();
    const ownValue = output.sourceTrace.scribeArtifactId;
    delete (output.sourceTrace as unknown as Record<string, unknown>).scribeArtifactId;
    Object.setPrototypeOf(output.sourceTrace, { scribeArtifactId: ownValue });
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceTrace.scribeArtifactId'))).toBe(true);
  });

  it('rejects prototype-inherited implementationPlan.summary (ERR-013)', async () => {
    const output = makeArtificerOutput();
    const ownValue = output.implementationPlan.summary;
    delete (output.implementationPlan as unknown as Record<string, unknown>).summary;
    Object.setPrototypeOf(output.implementationPlan, { summary: ownValue });
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('implementationPlan.summary'))).toBe(true);
  });

  it('rejects empty string sourceTrace.philosopherArtifactId when present', async () => {
    const output = makeArtificerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).philosopherArtifactId = '';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('philosopherArtifactId'))).toBe(true);
  });

  it('rejects empty string sourceTrace.dreamerArtifactId when present', async () => {
    const output = makeArtificerOutput();
    (output.sourceTrace as unknown as Record<string, unknown>).dreamerArtifactId = '';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('dreamerArtifactId'))).toBe(true);
  });
});

describe('ArtificerRunner integration: test-double captures sourceScribeArtifactId from prompt', () => {
  it('seed scribe artifact -> run artificer with test-double -> succeeded with correct sourceScribeArtifactId', async () => {
    const SCRIBE_ART_ID = 'pi-art-scribe-real-001';
    const artifactStore = new MemoryPIArtifactStore();

    const scribeArtifact: PIArtifactRecord = {
      artifactId: SCRIBE_ART_ID,
      artifactKind: 'principle',
      sourceTaskId: SCRIBE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({
        taskId: SCRIBE_TASK_ID,
        sourcePhilosopherArtifactId: 'pi-art-philosopher-001',
        principleDraft: {
          title: 'Systematic Error Handling',
          statement: 'All async operations must include explicit error handling',
          rationale: 'Uncaught errors cascade into system instability',
          applicability: ['All async operations'],
          antiPatterns: ['Ignoring promise rejections'],
          confidence: 0.9,
        },
        sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-001' },
        risks: [],
        generatedAt: new Date().toISOString(),
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await artifactStore.upsertArtifact(scribeArtifact);

    const artificerTask = makeArtificerTask();

    let capturedSourceScribeArtifactId: string = SCRIBE_ART_ID;
    const runtimeAdapter = new TestDoubleRuntimeAdapter({
      onStartRun: (input) => {
        try {
          const payloadStr = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
          const parsed = JSON.parse(payloadStr);
          if (typeof parsed.sourceScribeArtifactId === 'string' && parsed.sourceScribeArtifactId.trim() !== '') {
            capturedSourceScribeArtifactId = parsed.sourceScribeArtifactId;
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
          taskId: ARTIFICER_TASK_ID,
          sourceScribeArtifactId: capturedSourceScribeArtifactId,
          implementationPlan: {
            summary: 'Add input validation to all async operations',
            targetSurface: 'src/async-ops/*.ts',
            changes: ['Add try-catch to asyncOp1'],
            tests: ['Unit test for asyncOp1 error handling'],
            rolloutNotes: ['Deploy behind feature flag'],
            confidence: 0.85,
          },
          sourceTrace: {
            scribeArtifactId: capturedSourceScribeArtifactId,
          },
          risks: ['May add latency from error checking'],
          generatedAt: new Date().toISOString(),
        },
      }),
    });

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(artificerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === ARTIFICER_TASK_ID) return Promise.resolve(artificerTask);
        if (id === SCRIBE_TASK_ID) return Promise.resolve(makeScribeTask());
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-integration-001',
        taskId: ARTIFICER_TASK_ID,
        runtimeKind: 'artificer',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-integration-001', taskId: ARTIFICER_TASK_ID, runtimeKind: 'artificer', startedAt: new Date().toISOString() }],
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

    const deps: ArtificerRunnerDeps = {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator: new DefaultArtificerValidator(),
      artifactStore,
    };

    const runner = new ArtificerRunner(deps, {
      owner: 'test-integration',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(capturedSourceScribeArtifactId).toBe(SCRIBE_ART_ID);
    expect(result.output?.sourceScribeArtifactId).toBe(SCRIBE_ART_ID);
    expect(result.output?.sourceTrace.scribeArtifactId).toBe(SCRIBE_ART_ID);

    const artifacts = await artifactStore.listBySourceTaskId(ARTIFICER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');

    const [storedArtifact] = artifacts;
    expect(storedArtifact).toBeDefined();
    if (!storedArtifact) return;
    const storedOutput = JSON.parse(storedArtifact.contentJson) as ArtificerOutputV1;
    expect(storedOutput.sourceScribeArtifactId).toBe(SCRIBE_ART_ID);
    expect(storedOutput.sourceTrace.scribeArtifactId).toBe(SCRIBE_ART_ID);
  });
});
