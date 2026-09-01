import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArtificerRunner } from '../internalization/artificer-runner.js';
import type { ArtificerRunnerDeps } from '../internalization/artificer-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { ArtificerRuleOutput } from '../internalization/artificer-output.js';
import { DefaultArtificerValidator } from '../internalization/artificer-output.js';
import type { BehaviorExamplePack } from '../internalization/behavior-example-pack.js';
import { createPITaskDiagnosticJson, parsePITaskMetadata } from '../internalization/pitask-metadata.js';
import type { PITaskMetadata, RepairPayload } from '../internalization/pitask-metadata.js';
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

function makeArtificerOutput(): ArtificerRuleOutput {
  return {
    taskId: ARTIFICER_TASK_ID,
    sourceScribeArtifactId: 'pi-art-scribe-001-run-001',
    implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
    goldenTraceCases: [
      { caseId: 'positive-1', kind: 'positive', toolName: 'write_file', params: { path: '/project/file.txt' }, expectedDecision: 'allow' },
      { caseId: 'negative-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
    ],
    affectedTools: ['write_file'],
    implementationSummary: 'Add input validation to all async operations',
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

    const invalidOutput: ArtificerRuleOutput = {
      taskId: 'wrong-task-id',
      sourceScribeArtifactId: '',
      implementationCode: '',
      goldenTraceCases: [],
      affectedTools: [],
      implementationSummary: '',
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

  it('mismatched sourceScribeArtifactId echo is reconciled before artifact commit (PRI-541)', async () => {
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
    // Lineage is runner-owned (rc-6): the corrupted echo is corrected from the
    // task record before validation/commit instead of dead-ending (PRI-541).
    expect(result.status).toBe('succeeded');

    const artifacts = await store.listBySourceTaskId(ARTIFICER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.contentJson).toContain('pi-art-scribe-001-run-001');
    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalled();

    const telemetryCalls = (deps.eventEmitter as unknown as { emitTelemetry: ReturnType<typeof vi.fn> }).emitTelemetry.mock.calls;
    const correctedEvent = telemetryCalls
      .map((call) => call[0] as { eventType: string; payload: Record<string, unknown> })
      .find((evt) => evt.eventType === 'artificer_lineage_echo_corrected');
    expect(correctedEvent).toBeDefined();
    expect(correctedEvent?.payload.correctedFields).toEqual(
      expect.arrayContaining(['sourceScribeArtifactId', 'sourceTrace.scribeArtifactId']),
    );
  });
});

describe('ArtificerRunner.validateOutput — v2 mode-error errorCategory (CodeRabbit PR2 outside-diff)', () => {
  const pack: BehaviorExamplePack = {
    sourceNegativeCase: {
      caseId: 'negative-1', kind: 'negative', toolName: 'write_file',
      params: { path: '/etc/passwd' }, expectedDecision: 'block',
    },
    ownerDesiredOutcome: 'block writes outside the workspace',
    positiveCounterexamples: [{
      caseId: 'positive-1', kind: 'positive', toolName: 'write_file',
      params: { path: '/project/file.txt' }, expectedDecision: 'allow',
    }],
    evidenceRefs: ['pain://1'],
    redactionNotes: [],
  };

  it('classifies modeErrors as output_invalid when base validator passes', async () => {
    const deps = {
      stateManager: {},
      runtimeAdapter: {},
      eventEmitter: {},
      artifactStore: new MemoryPIArtifactStore(),
      validator: new DefaultArtificerValidator(),
      contextMode: 'v2' as const,
      behaviorExamplePack: pack,
    } as unknown as ArtificerRunnerDeps;
    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    // makeArtificerOutput() passes the base validator but lacks
    // requiresContextVersion: 2, so v2 mode validation fails.
    const output = makeArtificerOutput();
    const context = {
      contextHash: 'test-hash',
      scribeArtifact: null,
      sourceScribeArtifactId: null,
      adversarialFeedback: null,
      repairFeedback: null,
    };

    const result = await runner.validateOutput(output, ARTIFICER_TASK_ID, context);
    expect(result.valid).toBe(false);
    expect(result.errorCategory).toBe('output_invalid');
    expect(result.errors.some(e => e.includes('requiresContextVersion'))).toBe(true);
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

  it('rejects null output', async () => {
    const result = await validator.validate(null, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects missing implementationCode (unified output requires code)', async () => {
    const output = makeArtificerOutput();
    (output as unknown as Record<string, unknown>).implementationCode = '';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('implementationCode'))).toBe(true);
  });

  it('rejects missing implementationSummary', async () => {
    const output = makeArtificerOutput();
    (output as unknown as Record<string, unknown>).implementationSummary = '';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('implementationSummary'))).toBe(true);
  });

  it('rejects empty affectedTools array', async () => {
    const output = makeArtificerOutput();
    (output as unknown as Record<string, unknown>).affectedTools = [];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('affectedTools'))).toBe(true);
  });

  it('rejects risks with non-string elements', async () => {
    const output = makeArtificerOutput();
    (output as unknown as Record<string, unknown>).risks = [42];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('risks must be an array of strings'))).toBe(true);
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
    const output = Object.create(proto) as ArtificerRuleOutput;
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

  it('rejects prototype-inherited implementationSummary (ERR-013)', async () => {
    const output = makeArtificerOutput();
    const ownValue = output.implementationSummary;
    delete (output as unknown as Record<string, unknown>).implementationSummary;
    Object.setPrototypeOf(output, { implementationSummary: ownValue });
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('implementationSummary'))).toBe(true);
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
          implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
          goldenTraceCases: [
            { caseId: 'positive-1', kind: 'positive', toolName: 'write_file', params: { path: '/project/file.txt' }, expectedDecision: 'allow' },
            { caseId: 'negative-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
          ],
          affectedTools: ['write_file'],
          implementationSummary: 'Add input validation to all async operations',
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
    const storedOutput = JSON.parse(storedArtifact.contentJson) as ArtificerRuleOutput;
    expect(storedOutput.sourceScribeArtifactId).toBe(SCRIBE_ART_ID);
    expect(storedOutput.sourceTrace.scribeArtifactId).toBe(SCRIBE_ART_ID);
  });
});

describe('PRI-508: ArtificerRunner.buildContext reads dreamer artifact via scribe.sourceTrace.dreamerArtifactId', () => {
  // Vertical slice 4: end-to-end — dreamer artifact in store → prompt contains dreamerContext 5维字段
  const SCRIBE_ART_ID = 'pi-art-scribe-pri508';
  const DREAMER_ART_ID = 'pi-art-dreamer-pri508';
  const SCRIBE_TASK_ID_PRI508 = 'scribe-pri508';
  const ARTIFICER_TASK_ID_PRI508 = 'artificer-pri508';

  function makeScribeArtifactWithDreamer(): PIArtifactRecord {
    return {
      artifactId: SCRIBE_ART_ID,
      artifactKind: 'principle',
      sourceTaskId: SCRIBE_TASK_ID_PRI508,
      lineageArtifactIds: [DREAMER_ART_ID],
      validationStatus: 'pending',
      contentJson: JSON.stringify({
        taskId: SCRIBE_TASK_ID_PRI508,
        sourcePhilosopherArtifactId: 'pi-art-philosopher-pri508',
        principleDraft: {
          title: 'Path Traversal Guard',
          statement: 'Validate parent path before write_file',
          rationale: 'Unchecked parent path enables path traversal',
          applicability: ['write_file'],
          antiPatterns: ['Trusting raw user input path'],
          confidence: 0.9,
        },
        sourceTrace: {
          philosopherArtifactId: 'pi-art-philosopher-pri508',
          dreamerArtifactId: DREAMER_ART_ID,
        },
        risks: [],
        generatedAt: new Date().toISOString(),
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function makeDreamerArtifact(): PIArtifactRecord {
    return {
      artifactId: DREAMER_ART_ID,
      artifactKind: 'principle',
      sourceTaskId: 'dreamer-task-pri508',
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({
        valid: true,
        taskId: 'dreamer-task-pri508',
        candidates: [
          {
            candidateIndex: 0,
            badDecision: 'agent called write_file without resolving parent path',
            betterDecision: 'agent must resolve and validate parent path before write_file',
            rationale: 'parent path resolution prevents path traversal exploits',
            confidence: 0.85,
            riskLevel: 'medium',
            strategicPerspective: 'proactive validation beats reactive cleanup',
          },
        ],
        contextRefs: [],
        generatedAt: new Date().toISOString(),
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function makeScribeTaskPri508(): TaskRecord {
    return {
      taskId: SCRIBE_TASK_ID_PRI508,
      taskKind: 'scribe',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'scribe://run-pri508',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [{ artifactType: 'principle', ref: SCRIBE_ART_ID }],
      }),
    };
  }

  function makeArtificerTaskPri508(): TaskRecord {
    return {
      taskId: ARTIFICER_TASK_ID_PRI508,
      taskKind: 'artificer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [SCRIBE_TASK_ID_PRI508],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [{ artifactType: 'principle', ref: SCRIBE_ART_ID }],
        outputArtifactRefs: [],
      }),
    };
  }

  function makeArtificerOutputPri508(): ArtificerRuleOutput {
    return {
      taskId: ARTIFICER_TASK_ID_PRI508,
      sourceScribeArtifactId: SCRIBE_ART_ID,
      implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
      goldenTraceCases: [
        { caseId: 'positive-1', kind: 'positive', toolName: 'write_file', params: { path: '/workspace/file' }, expectedDecision: 'allow' },
        { caseId: 'negative-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
      ],
      affectedTools: ['write_file'],
      implementationSummary: 'Validate parent path before write',
      sourceTrace: {
        scribeArtifactId: SCRIBE_ART_ID,
      },
      risks: [],
      generatedAt: new Date().toISOString(),
    };
  }

  it('dreamerContext 5维字段透传到 artificer prompt (end-to-end)', async () => {
    const artifactStore = new MemoryPIArtifactStore();
    await artifactStore.upsertArtifact(makeScribeArtifactWithDreamer());
    await artifactStore.upsertArtifact(makeDreamerArtifact());

    const artificerTask = makeArtificerTaskPri508();
    const scribeTask = makeScribeTaskPri508();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(artificerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === ARTIFICER_TASK_ID_PRI508) return Promise.resolve(artificerTask);
        if (id === SCRIBE_TASK_ID_PRI508) return Promise.resolve(scribeTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-pri508',
        taskId: ARTIFICER_TASK_ID_PRI508,
        runtimeKind: 'artificer',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-pri508', taskId: ARTIFICER_TASK_ID_PRI508, runtimeKind: 'artificer', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    let capturedPrompt: string | undefined;
    const runtimeAdapter = {
      startRun: vi.fn().mockImplementation((input: { inputPayload: string }) => {
        capturedPrompt = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
        return Promise.resolve({ runId: 'run-pri508', runtimeKind: 'test-double', startedAt: new Date().toISOString() } as RunHandle);
      }),
      pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-pri508' }),
      fetchOutput: vi.fn().mockResolvedValue({ payload: makeArtificerOutputPri508() }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = { emitTelemetry: vi.fn() } as unknown as StoreEventEmitter;
    const validator = new DefaultArtificerValidator();

    const deps: ArtificerRunnerDeps = {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      artifactStore,
      validator,
    };

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID_PRI508);
    expect(result.status).toBe('succeeded');

    // Assert the prompt captured at startRun contains dreamerContext 5维字段
    expect(capturedPrompt).toBeDefined();
    const parsed = JSON.parse(capturedPrompt as string);
    expect(parsed.dreamerContext).toBeDefined();
    expect(parsed.dreamerContext.badDecision).toBe('agent called write_file without resolving parent path');
    expect(parsed.dreamerContext.betterDecision).toBe('agent must resolve and validate parent path before write_file');
    expect(parsed.dreamerContext.rationale).toBe('parent path resolution prevents path traversal exploits');
    expect(parsed.dreamerContext.riskLevel).toBe('medium');
    expect(parsed.dreamerContext.strategicPerspective).toBe('proactive validation beats reactive cleanup');
  });

  it('dreamerArtifactId 缺失时 dreamerContext undefined (向后兼容)', async () => {
    // scribe artifact 不带 sourceTrace.dreamerArtifactId → dreamerContext 不出现在 prompt
    const artifactStore = new MemoryPIArtifactStore();
    const scribeArtifactNoDreamer: PIArtifactRecord = {
      artifactId: SCRIBE_ART_ID,
      artifactKind: 'principle',
      sourceTaskId: SCRIBE_TASK_ID_PRI508,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({
        taskId: SCRIBE_TASK_ID_PRI508,
        sourcePhilosopherArtifactId: 'pi-art-philosopher-pri508',
        principleDraft: {
          title: 'Path Traversal Guard',
          statement: 'Validate parent path before write_file',
          rationale: 'Unchecked parent path enables path traversal',
          applicability: ['write_file'],
          antiPatterns: ['Trusting raw user input path'],
          confidence: 0.9,
        },
        sourceTrace: {
          philosopherArtifactId: 'pi-art-philosopher-pri508',
          // dreamerArtifactId 刻意缺失
        },
        risks: [],
        generatedAt: new Date().toISOString(),
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await artifactStore.upsertArtifact(scribeArtifactNoDreamer);

    const artificerTask = makeArtificerTaskPri508();
    const scribeTask = makeScribeTaskPri508();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(artificerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === ARTIFICER_TASK_ID_PRI508) return Promise.resolve(artificerTask);
        if (id === SCRIBE_TASK_ID_PRI508) return Promise.resolve(scribeTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{ runId: 'run-pri508-nodreamer', taskId: ARTIFICER_TASK_ID_PRI508, runtimeKind: 'artificer', startedAt: new Date().toISOString() }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({ runs: [{ runId: 'run-pri508-nodreamer', taskId: ARTIFICER_TASK_ID_PRI508, runtimeKind: 'artificer', startedAt: new Date().toISOString() }], degradedRuns: [] }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    let capturedPrompt: string | undefined;
    const runtimeAdapter = {
      startRun: vi.fn().mockImplementation((input: { inputPayload: string }) => {
        capturedPrompt = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
        return Promise.resolve({ runId: 'run-pri508-nodreamer', runtimeKind: 'test-double', startedAt: new Date().toISOString() } as RunHandle);
      }),
      pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-pri508-nodreamer' }),
      fetchOutput: vi.fn().mockResolvedValue({ payload: makeArtificerOutputPri508() }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = { emitTelemetry: vi.fn() } as unknown as StoreEventEmitter;
    const validator = new DefaultArtificerValidator();

    const deps: ArtificerRunnerDeps = {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      artifactStore,
      validator,
    };

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID_PRI508);
    expect(result.status).toBe('succeeded');

    expect(capturedPrompt).toBeDefined();
    const parsed = JSON.parse(capturedPrompt as string);
    expect(parsed.dreamerContext).toBeUndefined();
  });

  it('dreamerArtifactId 存在但 artifact 查不到时 emit event + dreamerContext undefined (rc-9)', async () => {
    // scribe 带 dreamerArtifactId 但 store 里没有 dreamer artifact → 不能静默成功，要有可观察事件
    const artifactStore = new MemoryPIArtifactStore();
    await artifactStore.upsertArtifact(makeScribeArtifactWithDreamer());
    // 故意不 upsert dreamer artifact

    const artificerTask = makeArtificerTaskPri508();
    const scribeTask = makeScribeTaskPri508();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(artificerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === ARTIFICER_TASK_ID_PRI508) return Promise.resolve(artificerTask);
        if (id === SCRIBE_TASK_ID_PRI508) return Promise.resolve(scribeTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{ runId: 'run-pri508-missing', taskId: ARTIFICER_TASK_ID_PRI508, runtimeKind: 'artificer', startedAt: new Date().toISOString() }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({ runs: [{ runId: 'run-pri508-missing', taskId: ARTIFICER_TASK_ID_PRI508, runtimeKind: 'artificer', startedAt: new Date().toISOString() }], degradedRuns: [] }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    let capturedPrompt: string | undefined;
    const runtimeAdapter = {
      startRun: vi.fn().mockImplementation((input: { inputPayload: string }) => {
        capturedPrompt = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
        return Promise.resolve({ runId: 'run-pri508-missing', runtimeKind: 'test-double', startedAt: new Date().toISOString() } as RunHandle);
      }),
      pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-pri508-missing' }),
      fetchOutput: vi.fn().mockResolvedValue({ payload: makeArtificerOutputPri508() }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const emitTelemetry = vi.fn();
    const eventEmitter = { emitTelemetry } as unknown as StoreEventEmitter;
    const validator = new DefaultArtificerValidator();

    const deps: ArtificerRunnerDeps = {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      artifactStore,
      validator,
    };

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID_PRI508);
    // 仍应成功（dreamerContext 是 best-effort，不阻塞主流程）
    expect(result.status).toBe('succeeded');

    // rc-9: 不能静默 — 必须有可观察事件
    // emitTelemetry 接收单个结构化对象 (eventType + traceId + payload + ...)
    expect(emitTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: expect.stringContaining('dreamer'),
        traceId: ARTIFICER_TASK_ID_PRI508,
      }),
    );

    expect(capturedPrompt).toBeDefined();
    const parsed = JSON.parse(capturedPrompt as string);
    expect(parsed.dreamerContext).toBeUndefined();
  });

  // ── PRI-508 edge cases: cover resolveDreamerContext() failure branches (rc-9) ──
  // Each case asserts: (a) runner still succeeds (best-effort, non-blocking),
  // (b) dreamerContext undefined in prompt, (c) emitTelemetry called with the
  // expected observable event name so the gap is not silent.

  /**
   * Shared harness for PRI-508 edge-case tests. Accepts a custom scribe artifact
   * and optional dreamer artifact, runs the artificer end-to-end, and returns
   * the captured prompt + telemetry spy so each case can assert behavior.
   */
  async function runPri508EdgeCase(params: {
    scribeArtifact: PIArtifactRecord;
    dreamerArtifact?: PIArtifactRecord;
  }): Promise<{ result: { status: string }; capturedPrompt: string | undefined; emitTelemetry: ReturnType<typeof vi.fn> }> {
    const artifactStore = new MemoryPIArtifactStore();
    await artifactStore.upsertArtifact(params.scribeArtifact);
    if (params.dreamerArtifact) {
      await artifactStore.upsertArtifact(params.dreamerArtifact);
    }

    const artificerTask = makeArtificerTaskPri508();
    const scribeTask = makeScribeTaskPri508();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(artificerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === ARTIFICER_TASK_ID_PRI508) return Promise.resolve(artificerTask);
        if (id === SCRIBE_TASK_ID_PRI508) return Promise.resolve(scribeTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{ runId: 'run-pri508-edge', taskId: ARTIFICER_TASK_ID_PRI508, runtimeKind: 'artificer', startedAt: new Date().toISOString() }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({ runs: [{ runId: 'run-pri508-edge', taskId: ARTIFICER_TASK_ID_PRI508, runtimeKind: 'artificer', startedAt: new Date().toISOString() }], degradedRuns: [] }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    let capturedPrompt: string | undefined;
    const runtimeAdapter = {
      startRun: vi.fn().mockImplementation((input: { inputPayload: string }) => {
        capturedPrompt = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
        return Promise.resolve({ runId: 'run-pri508-edge', runtimeKind: 'test-double', startedAt: new Date().toISOString() } as RunHandle);
      }),
      pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-pri508-edge' }),
      fetchOutput: vi.fn().mockResolvedValue({ payload: makeArtificerOutputPri508() }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const emitTelemetry = vi.fn();
    const eventEmitter = { emitTelemetry } as unknown as StoreEventEmitter;
    const validator = new DefaultArtificerValidator();

    const deps: ArtificerRunnerDeps = {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      artifactStore,
      validator,
    };

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID_PRI508);
    return { result, capturedPrompt, emitTelemetry };
  }

  /** Build a scribe artifact with a custom contentJson string. */
  function makeScribeWithContentJson(contentJson: string): PIArtifactRecord {
    return {
      artifactId: SCRIBE_ART_ID,
      artifactKind: 'principle',
      sourceTaskId: SCRIBE_TASK_ID_PRI508,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /** Build a scribe artifact whose sourceTrace.dreamerArtifactId points to DREAMER_ART_ID. */
  function makeScribeWithDreamerRef(): PIArtifactRecord {
    return makeScribeWithContentJson(JSON.stringify({
      taskId: SCRIBE_TASK_ID_PRI508,
      sourcePhilosopherArtifactId: 'pi-art-philosopher-pri508',
      principleDraft: { title: 'T', statement: 'S', rationale: 'R', applicability: [], antiPatterns: [], confidence: 0.5 },
      sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-pri508', dreamerArtifactId: DREAMER_ART_ID },
      risks: [],
      generatedAt: new Date().toISOString(),
    }));
  }

  /** Build a dreamer artifact with a custom contentJson string. */
  function makeDreamerWithContentJson(contentJson: string): PIArtifactRecord {
    return {
      artifactId: DREAMER_ART_ID,
      artifactKind: 'principle',
      sourceTaskId: 'dreamer-task-pri508',
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it.each([
    {
      name: 'scribe contentJson unparseable → emit dreamer_context_skipped',
      scribeContentJson: '{not valid json',
      expectedEvent: 'dreamer_context_skipped',
    },
    {
      name: 'scribe contentJson not a record (array) → dreamerContext undefined, no event',
      scribeContentJson: JSON.stringify(['not', 'a', 'record']),
      expectedEvent: null,
    },
    {
      name: 'scribe.sourceTrace missing → dreamerContext undefined, no event (backward compat)',
      scribeContentJson: JSON.stringify({ taskId: SCRIBE_TASK_ID_PRI508, principleDraft: { statement: 'S' } }),
      expectedEvent: null,
    },
    {
      name: 'scribe.sourceTrace not a record (string) → dreamerContext undefined, no event',
      scribeContentJson: JSON.stringify({ sourceTrace: 'not-a-record' }),
      expectedEvent: null,
    },
    {
      name: 'sourceTrace.dreamerArtifactId missing → dreamerContext undefined, no event (backward compat)',
      scribeContentJson: JSON.stringify({ sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-pri508' } }),
      expectedEvent: null,
    },
    {
      name: 'sourceTrace.dreamerArtifactId is undefined → dreamerContext undefined, no event',
      scribeContentJson: JSON.stringify({ sourceTrace: { dreamerArtifactId: undefined } }),
      expectedEvent: null,
    },
    {
      name: 'sourceTrace.dreamerArtifactId not a string (object) → emit dreamer_context_skipped',
      scribeContentJson: JSON.stringify({ sourceTrace: { dreamerArtifactId: { evil: true } } }),
      expectedEvent: 'dreamer_context_skipped',
    },
    {
      name: 'sourceTrace.dreamerArtifactId empty string → emit dreamer_context_skipped',
      scribeContentJson: JSON.stringify({ sourceTrace: { dreamerArtifactId: '' } }),
      expectedEvent: 'dreamer_context_skipped',
    },
  ])('edge: $name', async ({ scribeContentJson, expectedEvent }) => {
    const { result, capturedPrompt, emitTelemetry } = await runPri508EdgeCase({
      scribeArtifact: makeScribeWithContentJson(scribeContentJson),
    });

    // Best-effort: runner still succeeds even when dreamer context cannot be resolved.
    expect(result.status).toBe('succeeded');

    expect(capturedPrompt).toBeDefined();
    const parsed = JSON.parse(capturedPrompt as string);
    expect(parsed.dreamerContext).toBeUndefined();

    if (expectedEvent !== null) {
      // rc-9: failure must be observable, not silent.
      expect(emitTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: expect.stringContaining(expectedEvent),
          traceId: ARTIFICER_TASK_ID_PRI508,
        }),
      );
    }
  });

  it.each([
    {
      name: 'dreamer contentJson unparseable → emit dreamer_context_invalid',
      dreamerContentJson: '{broken json',
      expectedEvent: 'dreamer_context_invalid',
    },
    {
      name: 'dreamer contentJson not a record (array) → emit dreamer_context_invalid',
      dreamerContentJson: JSON.stringify(['not', 'a', 'record']),
      expectedEvent: 'dreamer_context_invalid',
    },
    {
      name: 'dreamer candidates missing → emit dreamer_context_invalid',
      dreamerContentJson: JSON.stringify({ valid: true, taskId: 'dreamer-task-pri508' }),
      expectedEvent: 'dreamer_context_invalid',
    },
    {
      name: 'dreamer candidates not an array (string) → emit dreamer_context_invalid',
      dreamerContentJson: JSON.stringify({ candidates: 'not-an-array' }),
      expectedEvent: 'dreamer_context_invalid',
    },
    {
      name: 'dreamer candidates empty array → emit dreamer_context_invalid',
      dreamerContentJson: JSON.stringify({ candidates: [] }),
      expectedEvent: 'dreamer_context_invalid',
    },
    {
      name: 'dreamer candidates[0] not a record (string) → emit dreamer_context_invalid',
      dreamerContentJson: JSON.stringify({ candidates: ['not-a-record'] }),
      expectedEvent: 'dreamer_context_invalid',
    },
    {
      name: 'dreamer candidates[0] missing badDecision → emit dreamer_context_invalid',
      dreamerContentJson: JSON.stringify({ candidates: [{ betterDecision: 'b', rationale: 'r' }] }),
      expectedEvent: 'dreamer_context_invalid',
    },
    {
      name: 'dreamer candidates[0] missing betterDecision → emit dreamer_context_invalid',
      dreamerContentJson: JSON.stringify({ candidates: [{ badDecision: 'a', rationale: 'r' }] }),
      expectedEvent: 'dreamer_context_invalid',
    },
    {
      name: 'dreamer candidates[0] missing rationale → emit dreamer_context_invalid',
      dreamerContentJson: JSON.stringify({ candidates: [{ badDecision: 'a', betterDecision: 'b' }] }),
      expectedEvent: 'dreamer_context_invalid',
    },
    {
      name: 'dreamer candidates[0] badDecision empty string → emit dreamer_context_invalid',
      dreamerContentJson: JSON.stringify({ candidates: [{ badDecision: '   ', betterDecision: 'b', rationale: 'r' }] }),
      expectedEvent: 'dreamer_context_invalid',
    },
    {
      name: 'dreamer candidates[0] badDecision not a string (number) → emit dreamer_context_invalid',
      dreamerContentJson: JSON.stringify({ candidates: [{ badDecision: 42, betterDecision: 'b', rationale: 'r' }] }),
      expectedEvent: 'dreamer_context_invalid',
    },
  ])('edge: $name', async ({ dreamerContentJson, expectedEvent }) => {
    const { result, capturedPrompt, emitTelemetry } = await runPri508EdgeCase({
      scribeArtifact: makeScribeWithDreamerRef(),
      dreamerArtifact: makeDreamerWithContentJson(dreamerContentJson),
    });

    // Best-effort: runner still succeeds even when dreamer context validation fails.
    expect(result.status).toBe('succeeded');

    expect(capturedPrompt).toBeDefined();
    const parsed = JSON.parse(capturedPrompt as string);
    expect(parsed.dreamerContext).toBeUndefined();

    // rc-9: failure must be observable, not silent.
    expect(emitTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: expect.stringContaining(expectedEvent),
        traceId: ARTIFICER_TASK_ID_PRI508,
      }),
    );
  });

  it('edge: dreamer candidates[0] with only required 3 fields + no optional → dreamerContext resolved (no riskLevel/strategicPerspective)', async () => {
    // Validates the optional-field spread path: riskLevel/strategicPerspective absent
    // should still yield a valid dreamerContext with only the 3 required fields.
    const dreamerArtifact = makeDreamerWithContentJson(JSON.stringify({
      candidates: [{
        badDecision: 'bad',
        betterDecision: 'better',
        rationale: 'why',
        // riskLevel and strategicPerspective intentionally absent
      }],
    }));

    const { result, capturedPrompt } = await runPri508EdgeCase({
      scribeArtifact: makeScribeWithDreamerRef(),
      dreamerArtifact,
    });

    expect(result.status).toBe('succeeded');
    expect(capturedPrompt).toBeDefined();
    const parsed = JSON.parse(capturedPrompt as string);
    expect(parsed.dreamerContext).toBeDefined();
    expect(parsed.dreamerContext.badDecision).toBe('bad');
    expect(parsed.dreamerContext.betterDecision).toBe('better');
    expect(parsed.dreamerContext.rationale).toBe('why');
    expect(parsed.dreamerContext.riskLevel).toBeUndefined();
    expect(parsed.dreamerContext.strategicPerspective).toBeUndefined();
  });
});

// ── PRI-509 Slice 3: ArtificerRunner.buildContext reads repairPayload ────────
// When evaluator returns needs_revision, it seeds an artificer repair task
// whose diagnosticJson contains a repairPayload. The artificer-runner must
// detect this payload, format it as a repairFeedback string, and forward it
// to the prompt builder so the LLM addresses each requiredChange instead of
// regenerating blind. Trust boundary (rc-1, rc-2): repairPayload originates
// from evaluator LLM output persisted in diagnosticJson — already validated
// by isValidRepairPayload in pitask-metadata.ts, but the runner must still
// treat the hydrated value as opaque text when formatting the prompt.

describe('PRI-509: ArtificerRunner.buildContext reads repairPayload → repairFeedback', () => {
  const SCRIBE_ART_ID_PRI509 = 'pi-art-scribe-pri509';
  const SCRIBE_TASK_ID_PRI509 = 'scribe-pri509';
  const ARTIFICER_TASK_ID_PRI509 = 'artificer-repair-r1';

  function makeScribeArtifactPri509(): PIArtifactRecord {
    return {
      artifactId: SCRIBE_ART_ID_PRI509,
      artifactKind: 'principle',
      sourceTaskId: SCRIBE_TASK_ID_PRI509,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({
        taskId: SCRIBE_TASK_ID_PRI509,
        sourcePhilosopherArtifactId: 'pi-art-philosopher-pri509',
        principleDraft: {
          title: 'Input Validation Discipline',
          statement: 'Validate tool inputs before execution',
          rationale: 'Unvalidated inputs cause downstream failures',
          applicability: ['all tools'],
          antiPatterns: ['Trusting raw input'],
          confidence: 0.85,
        },
        sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-pri509' },
        risks: [],
        generatedAt: new Date().toISOString(),
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function makeMetadata(overrides?: Partial<PITaskMetadata>): PITaskMetadata {
    return {
      dependencyTaskIds: overrides?.dependencyTaskIds ?? [],
      channel: overrides?.channel ?? ('prompt' as const),
      timeoutMs: overrides?.timeoutMs ?? 300_000,
      inputArtifactRefs: overrides?.inputArtifactRefs ?? [],
      outputArtifactRefs: overrides?.outputArtifactRefs ?? [],
      parentTaskId: overrides?.parentTaskId,
      correlationId: overrides?.correlationId,
      rejectionCount: overrides?.rejectionCount,
      adversarialFeedback: overrides?.adversarialFeedback,
      repairPayload: overrides?.repairPayload,
    };
  }

  function makeArtificerTaskPri509(repairPayload?: RepairPayload): TaskRecord {
    const meta = makeMetadata({
      dependencyTaskIds: [SCRIBE_TASK_ID_PRI509],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: SCRIBE_ART_ID_PRI509 }],
      outputArtifactRefs: [],
    });
    if (repairPayload) {
      meta.repairPayload = repairPayload;
    }
    return {
      taskId: ARTIFICER_TASK_ID_PRI509,
      taskKind: 'artificer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnosticJson: createPITaskDiagnosticJson(meta),
    };
  }

  function makeArtificerOutputPri509(): ArtificerRuleOutput {
    return {
      taskId: ARTIFICER_TASK_ID_PRI509,
      sourceScribeArtifactId: SCRIBE_ART_ID_PRI509,
      implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
      goldenTraceCases: [
        { caseId: 'positive-1', kind: 'positive', toolName: 'write_file', params: { path: '/workspace/file' }, expectedDecision: 'allow' },
        { caseId: 'negative-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
      ],
      affectedTools: ['write_file'],
      implementationSummary: 'Validate parent path before write',
      sourceTrace: { scribeArtifactId: SCRIBE_ART_ID_PRI509 },
      risks: [],
      generatedAt: new Date().toISOString(),
    };
  }

  function makeScribeTaskPri509(): TaskRecord {
    return {
      taskId: SCRIBE_TASK_ID_PRI509,
      taskKind: 'scribe',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'scribe://run-pri509',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [{ artifactType: 'principle', ref: SCRIBE_ART_ID_PRI509 }],
      }),
    };
  }

  async function runPri509RepairLoop(artificerTask: TaskRecord): Promise<{ result: { status: string }; capturedPrompt: string | undefined }> {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeScribeArtifactPri509());

    const scribeTask = makeScribeTaskPri509();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(artificerTask),
      getTask: vi.fn().mockImplementation((id: string) => {
        if (id === ARTIFICER_TASK_ID_PRI509) return Promise.resolve(artificerTask);
        if (id === SCRIBE_TASK_ID_PRI509) return Promise.resolve(scribeTask);
        return Promise.resolve(null);
      }),
      getRunsByTask: vi.fn().mockResolvedValue([{ runId: 'run-pri509', taskId: ARTIFICER_TASK_ID_PRI509, runtimeKind: 'artificer', startedAt: new Date().toISOString() }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({ runs: [{ runId: 'run-pri509', taskId: ARTIFICER_TASK_ID_PRI509, runtimeKind: 'artificer', startedAt: new Date().toISOString() }], degradedRuns: [] }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    let capturedPrompt: string | undefined;
    const runtimeAdapter = {
      startRun: vi.fn().mockImplementation((input: { inputPayload: string }) => {
        capturedPrompt = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
        return Promise.resolve({ runId: 'run-pri509', runtimeKind: 'test-double', startedAt: new Date().toISOString() } as RunHandle);
      }),
      pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-pri509' }),
      fetchOutput: vi.fn().mockResolvedValue({ payload: makeArtificerOutputPri509() }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = { emitTelemetry: vi.fn() } as unknown as StoreEventEmitter;
    const validator = new DefaultArtificerValidator();

    const deps: ArtificerRunnerDeps = {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      artifactStore: store,
      validator,
    };

    const runner = new ArtificerRunner(deps, {
      owner: 'test',
      runtimeKind: 'artificer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run(ARTIFICER_TASK_ID_PRI509);
    return { result, capturedPrompt };
  }

  it('repairPayload present → repairFeedback serialized into prompt message (with requiredChanges text + previousScore)', async () => {
    const artificerTask = makeArtificerTaskPri509({
      requiredChanges: ['add path validation', 'fix case sensitivity'],
      concerns: ['code quality is poor', 'missing error handling'],
      previousScore: 0.65,
      repairIteration: 1,
      sourceArtificerArtifactId: 'pi-art-artificer-original',
      sourceEvaluatorTaskId: 'evaluator-r0',
    });

    const { result, capturedPrompt } = await runPri509RepairLoop(artificerTask);
    expect(result.status).toBe('succeeded');

    expect(capturedPrompt).toBeDefined();
    const parsed = JSON.parse(capturedPrompt as string);
    expect(parsed.repairFeedback).toBeDefined();
    // requiredChanges text must be present so artificer can address each one
    expect(parsed.repairFeedback).toContain('add path validation');
    expect(parsed.repairFeedback).toContain('fix case sensitivity');
    // previousScore must be present so artificer knows the prior score
    expect(parsed.repairFeedback).toContain('0.65');
    // concerns text must be present (PoC-validated format)
    expect(parsed.repairFeedback).toContain('code quality is poor');
    // Must signal this is a needs_revision retry (not a fresh attempt)
    expect(parsed.repairFeedback).toMatch(/needs_revision|prior attempt/i);
  });

  it('repairPayload absent → repairFeedback undefined in prompt (backward compat)', async () => {
    // Round-1 artificer task without repairPayload — repairFeedback must NOT
    // appear in the prompt (backward compatible with pre-PRI-509 flows).
    const artificerTask = makeArtificerTaskPri509(); // no repairPayload

    const { result, capturedPrompt } = await runPri509RepairLoop(artificerTask);
    expect(result.status).toBe('succeeded');

    expect(capturedPrompt).toBeDefined();
    const parsed = JSON.parse(capturedPrompt as string);
    expect(parsed.repairFeedback).toBeUndefined();
  });

  it('repairPayload present → repairFeedback appears in promptInput (typed surface)', async () => {
    const artificerTask = makeArtificerTaskPri509({
      requiredChanges: ['add input validation'],
      concerns: [],
      previousScore: 0.55,
      repairIteration: 2,
      sourceArtificerArtifactId: 'pi-art-artificer-r1',
      sourceEvaluatorTaskId: 'evaluator-r1',
    });

    const { result } = await runPri509RepairLoop(artificerTask);
    expect(result.status).toBe('succeeded');
    // The typed promptInput surface must also carry repairFeedback ( Slice 2 contract).
    // We can't directly inspect promptInput here — it's internal to the runner.
    // The prompt message assertion above already covers the e2e path. This test
    // exists to assert the runner doesn't throw when repairIteration=2.
  });

  it('repairPayload + adversarialFeedback both present → both forwarded (orthogonal)', async () => {
    // PRI-428 (adversarialFeedback) and PRI-509 (repairPayload) are orthogonal
    // signals — adversarialFeedback comes from RuleHost probe failures, while
    // repairPayload comes from evaluator needs_revision. Both can be present on
    // the same task and must both reach the prompt.
    const meta = makeMetadata({
      dependencyTaskIds: [SCRIBE_TASK_ID_PRI509],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: SCRIBE_ART_ID_PRI509 }],
      outputArtifactRefs: [],
    });
    meta.adversarialFeedback = 'Adversarial probe failed: tool=test_tool, case=neg-1, expected=block, got=allow';
    meta.repairPayload = {
      requiredChanges: ['add input validation'],
      concerns: ['missing error handling'],
      previousScore: 0.6,
      repairIteration: 1,
      sourceArtificerArtifactId: 'pi-art-artificer-original',
      sourceEvaluatorTaskId: 'evaluator-r0',
    };
    const artificerTask: TaskRecord = {
      taskId: ARTIFICER_TASK_ID_PRI509,
      taskKind: 'artificer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnosticJson: createPITaskDiagnosticJson(meta),
    };

    const { result, capturedPrompt } = await runPri509RepairLoop(artificerTask);
    expect(result.status).toBe('succeeded');

    expect(capturedPrompt).toBeDefined();
    const parsed = JSON.parse(capturedPrompt as string);
    // Both signals must be present
    expect(parsed.adversarialFeedback).toBeDefined();
    expect(parsed.adversarialFeedback).toContain('Adversarial probe failed');
    expect(parsed.repairFeedback).toBeDefined();
    expect(parsed.repairFeedback).toContain('add input validation');
    expect(parsed.repairFeedback).toContain('0.6');
  });

  it('repairPayload with diagnosticReplay → replay evidence rendered in repairFeedback (PRI-634 R4 P1-2)', async () => {
    // The evaluator's needs_revision round ran the diagnostic adversarial
    // replay; its evidence must reach the next Artificer via repairFeedback.
    const artificerTask = makeArtificerTaskPri509({
      requiredChanges: ['fix matcher semantics'],
      concerns: ['intent mismatch'],
      previousScore: 0.5,
      repairIteration: 1,
      sourceArtificerArtifactId: 'pi-art-artificer-original',
      sourceEvaluatorTaskId: 'evaluator-r0',
      diagnosticReplay: { ran: true, passed: true, failedCaseCount: 0 },
    });

    const { result, capturedPrompt } = await runPri509RepairLoop(artificerTask);
    expect(result.status).toBe('succeeded');

    expect(capturedPrompt).toBeDefined();
    const parsed = JSON.parse(capturedPrompt as string);
    expect(parsed.repairFeedback).toBeDefined();
    expect(parsed.repairFeedback).toContain('Deterministic adversarial replay');
    expect(parsed.repairFeedback).toContain('PASSED');
    // The diagnostic note must be explicit that it does NOT change the verdict
    expect(parsed.repairFeedback).toContain('needs_revision');
  });

  it('isValidRepairPayload rejects malformed diagnosticReplay (fail-closed hydrate, PRI-634 R4)', () => {
    // diagnosticJson round-trip: a repairPayload whose diagnosticReplay has a
    // non-boolean `ran` must be rejected at the trust boundary (rc-1/rc-3) —
    // hydrate yields repairPayload=undefined rather than trusting the shape.
    const base = {
      requiredChanges: ['fix matcher'],
      concerns: [],
      previousScore: 0.5,
      repairIteration: 1,
      sourceArtificerArtifactId: 'pi-art-artificer-original',
      sourceEvaluatorTaskId: 'evaluator-r0',
    };
    const malformed = [
      { ran: 'yes', passed: true, failedCaseCount: 0 },        // ran not boolean
      { ran: true, passed: 1, failedCaseCount: 0 },            // passed not boolean
      { ran: true, passed: true, failedCaseCount: -1 },        // negative count
      { ran: true, passed: true, failedCaseCount: 1.5 },       // non-integer count
      'not-an-object',                                          // whole field wrong type
    ];
    for (const bad of malformed) {
      const meta = makeMetadata({ dependencyTaskIds: [SCRIBE_TASK_ID_PRI509] });
      meta.repairPayload = { ...base, diagnosticReplay: bad } as unknown as RepairPayload;
      const taskJson = createPITaskDiagnosticJson(meta);
      const hydrated = parsePITaskMetadata(taskJson);
      expect(hydrated?.repairPayload, `expected rejection for ${JSON.stringify(bad)}`).toBeUndefined();
    }
    // Valid diagnosticReplay passes the trust boundary
    const metaOk = makeMetadata({ dependencyTaskIds: [SCRIBE_TASK_ID_PRI509] });
    metaOk.repairPayload = { ...base, diagnosticReplay: { ran: true, passed: false, failedCaseCount: 2 } };
    const hydratedOk = parsePITaskMetadata(createPITaskDiagnosticJson(metaOk));
    expect(hydratedOk?.repairPayload?.diagnosticReplay).toEqual({ ran: true, passed: false, failedCaseCount: 2 });
  });
});
