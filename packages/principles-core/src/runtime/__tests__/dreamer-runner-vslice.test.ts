import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DreamerRunner } from '../internalization/dreamer-runner.js';
import type { DreamerRunnerDeps } from '../internalization/dreamer-runner.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { DreamerOutput } from '../internalization/dreamer-output.js';
import { DefaultDreamerValidator } from '../internalization/dreamer-output.js';
import type { TaskRecord } from '../task-status.js';
import { createMinimalPITaskRecord } from '../internalization/peer-runner-contracts.js';
import { serializePITaskMetadata } from '../internalization/pitask-metadata.js';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const base = createMinimalPITaskRecord('task-dreamer-001', 'dreamer', 'prompt');
  return {
    ...base,
    ...overrides,
    status: overrides.status ?? 'leased',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

function makeDreamerOutput(): DreamerOutput {
  return {
    valid: true,
    taskId: 'task-dreamer-001',
    candidates: [
      {
        candidateIndex: 0,
        badDecision: 'Ignored error handling',
        betterDecision: 'Add try/catch around async calls',
        rationale: 'Error handling prevents unhandled rejections',
        confidence: 0.85,
        riskLevel: 'low',
        strategicPerspective: 'reliability',
      },
    ],
    contextRefs: [],
    generatedAt: new Date().toISOString(),
  };
}

function createMockDeps(artifactStore: PIArtifactStore): DreamerRunnerDeps {
  const mockTask = makeTask();

  const stateManager = {
    acquireLease: vi.fn().mockResolvedValue(mockTask),
    getTask: vi.fn().mockResolvedValue(mockTask),
    getRunsByTask: vi.fn().mockResolvedValue([{
      runId: 'run-001',
      taskId: 'task-dreamer-001',
      runtimeKind: 'dreamer' as const,
      startedAt: new Date().toISOString(),
    }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-001', taskId: 'task-dreamer-001', runtimeKind: 'dreamer' as const, startedAt: new Date().toISOString() }],
      degradedRuns: [],
    }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  } as unknown as RuntimeStateManager;

  const runHandle: RunHandle = { runId: 'run-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-001' };

  const runtimeAdapter = {
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue(succeededStatus),
    fetchOutput: vi.fn().mockResolvedValue({
      payload: makeDreamerOutput(),
    }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as PDRuntimeAdapter;

  const eventEmitter = {
    emitTelemetry: vi.fn(),
  } as unknown as StoreEventEmitter;

  const validator = {
    validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  };

  return { stateManager, runtimeAdapter, eventEmitter, validator, artifactStore };
}

describe('DreamerRunner vertical slice (PRI-85)', () => {
  let artifactStore: PIArtifactStore = new MemoryPIArtifactStore();
  let deps: DreamerRunnerDeps = createMockDeps(artifactStore);

  beforeEach(() => {
    artifactStore = new MemoryPIArtifactStore();
    deps = createMockDeps(artifactStore);
  });

  it('success path: creates PIArtifact via PIArtifactStore and marks task succeeded with dreamer:// resultRef', async () => {
    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe('task-dreamer-001');
    expect(result.runId).toBe('run-001');
    expect(result.artifactId).toBe('pi-art-task-dreamer-001-run-001');
    expect(result.resultRef).toContain('dreamer://');

    const artifacts = await artifactStore.listBySourceTaskId('task-dreamer-001');
    expect(artifacts.length).toBeGreaterThanOrEqual(1);

    const [artifact] = artifacts;
    if (artifact) {
      expect(artifact.artifactKind).toBe('principle');
      expect(artifact.sourceTaskId).toBe('task-dreamer-001');
      expect(artifact.validationStatus).toBe('pending');
      expect(artifact.contentJson).toBeDefined();
    }

    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      'task-dreamer-001',
      expect.stringContaining('dreamer://'),
    );
  });

  it('adapter failure: task retried, no artifact created', async () => {
    vi.mocked(deps.runtimeAdapter.startRun).mockRejectedValue(
      new Error('Runtime unavailable'),
    );

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');

    expect(result.status).toBe('failed');

    const artifacts = await artifactStore.listBySourceTaskId('task-dreamer-001');
    expect(artifacts).toHaveLength(0);
  });

  it('validation failure: task retried, no artifact created', async () => {
    vi.mocked(deps.validator.validate).mockResolvedValue({
      valid: false,
      errors: ['Missing badDecision'],
    });

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');

    expect(result.status).toBe('failed');

    const artifacts = await artifactStore.listBySourceTaskId('task-dreamer-001');
    expect(artifacts).toHaveLength(0);
  });

  it('idempotent execution: calling run() twice for same task does not create duplicate artifacts', async () => {
    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    await runner.run('task-dreamer-001');

    const firstArtifacts = await artifactStore.listBySourceTaskId('task-dreamer-001');
    expect(firstArtifacts).toHaveLength(1);

    await runner.run('task-dreamer-001');

    const secondArtifacts = await artifactStore.listBySourceTaskId('task-dreamer-001');
    expect(secondArtifacts).toHaveLength(1);
  });

  it('artifact lineage: artifact has lineageArtifactIds from predecessor context', async () => {
    await artifactStore.createArtifact({
      artifactId: 'pre-art-001',
      artifactKind: 'principle',
      sourceTaskId: 'task-pre-001',
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: '{}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const baseTask = makeTask();
    const taskWithDeps = Object.assign({}, baseTask, {
      diagnosticJson: serializePITaskMetadata({
        dependencyTaskIds: ['task-pre-001'],
        channel: 'prompt',
        timeoutMs: 30000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const depTask = Object.assign({}, makeTask(), {
      taskId: 'task-pre-001',
      resultRef: 'dreamer://run-pre',
    });

    const getTaskMock = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'task-pre-001') return depTask;
      return taskWithDeps;
    });
    (deps.stateManager as unknown as Record<string, unknown>).getTask = getTaskMock;

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');

    expect(result.status).toBe('succeeded');

    const artifacts = await artifactStore.listBySourceTaskId('task-dreamer-001');
    expect(artifacts.length).toBeGreaterThanOrEqual(1);

    if (artifacts[0]) {
      expect(artifacts[0].lineageArtifactIds).toContain('pre-art-001');
    }
  });

  it('artifact write failure: task is retried/failed, NOT marked succeeded', async () => {
    const failingStore = {
      createArtifact: vi.fn().mockRejectedValue(new Error('store write failed')),
      upsertArtifact: vi.fn().mockRejectedValue(new Error('store write failed')),
      getArtifactById: vi.fn().mockResolvedValue(null),
      listBySourceTaskId: vi.fn().mockResolvedValue([]),
      listLineage: vi.fn().mockResolvedValue([]),
    } as unknown as PIArtifactStore;

    const failingDeps = createMockDeps(failingStore);

    const runner = new DreamerRunner(failingDeps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');

    expect(result.status).toBe('failed');

    expect(failingDeps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('lineage with rejected artifact queries: emits dreamer_lineage_partial telemetry, task still succeeds with partial lineage', async () => {
    const partialStore = {
      createArtifact: vi.fn().mockResolvedValue({}),
      upsertArtifact: vi.fn().mockResolvedValue({}),
      getArtifactById: vi.fn().mockResolvedValue(null),
      listBySourceTaskId: vi.fn().mockImplementation(async (depId: string) => {
        if (depId === 'task-pre-fail') {
          throw new Error('artifact store unavailable');
        }
        return [{ artifactId: 'pre-art-ok', sourceTaskId: depId }];
      }),
      listLineage: vi.fn().mockResolvedValue([]),
    } as unknown as PIArtifactStore;

    const partialDeps = createMockDeps(partialStore);

    const baseTask = makeTask();
    const taskWithDeps = Object.assign({}, baseTask, {
      diagnosticJson: serializePITaskMetadata({
        dependencyTaskIds: ['task-pre-ok', 'task-pre-fail'],
        channel: 'prompt',
        timeoutMs: 30000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const getTaskMock = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'task-pre-ok') return Object.assign({}, makeTask(), { taskId: 'task-pre-ok', resultRef: 'dreamer://run-ok' });
      if (id === 'task-pre-fail') return Object.assign({}, makeTask(), { taskId: 'task-pre-fail', resultRef: 'dreamer://run-fail' });
      return taskWithDeps;
    });
    (partialDeps.stateManager as unknown as Record<string, unknown>).getTask = getTaskMock;

    const runner = new DreamerRunner(partialDeps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');

    expect(result.status).toBe('succeeded');

    const lineagePartialEvents = (partialDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[0] as { eventType: string }).eventType === 'dreamer_lineage_partial',
    );
    expect(lineagePartialEvents.length).toBeGreaterThanOrEqual(1);
    const [firstEvent] = lineagePartialEvents;
    expect(firstEvent).toBeDefined();
    expect((firstEvent?.[0] as { payload: { resolvedCount: number } }).payload.resolvedCount).toBe(1);
  });

  it('taskKind not dreamer fails closed and releases lease', async () => {
    const wrongKindTask = makeTask({ taskKind: 'philosopher' });
    (deps.stateManager as unknown as Record<string, unknown>).acquireLease = vi.fn().mockResolvedValue(wrongKindTask);

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain("must be 'dreamer'");
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      'task-dreamer-001',
      'input_invalid',
    );
  });
});

describe('DreamerRunner with DefaultDreamerValidator (PRI-87)', () => {
  let artifactStore: PIArtifactStore = new MemoryPIArtifactStore();

  beforeEach(() => {
    artifactStore = new MemoryPIArtifactStore();
  });

  function createMockDepsWithStrictValidator(artifactStoreOverride?: PIArtifactStore): DreamerRunnerDeps {
    const store = artifactStoreOverride ?? artifactStore;
    const mockTask = makeTask();

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(mockTask),
      getTask: vi.fn().mockResolvedValue(mockTask),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-001',
        taskId: 'task-dreamer-001',
        runtimeKind: 'dreamer' as const,
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-001', taskId: 'task-dreamer-001', runtimeKind: 'dreamer' as const, startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const runHandle: RunHandle = { runId: 'run-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-001' };

    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue(runHandle),
      pollRun: vi.fn().mockResolvedValue(succeededStatus),
      fetchOutput: vi.fn().mockResolvedValue({
        payload: makeDreamerOutput(),
      }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter;

    const validator = new DefaultDreamerValidator();

    return { stateManager, runtimeAdapter, eventEmitter, validator, artifactStore: store };
  }

  it('valid Dreamer output is accepted by DefaultDreamerValidator', async () => {
    const deps = createMockDepsWithStrictValidator();
    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');
    expect(result.status).toBe('succeeded');
  });

  it('taskId wrong echo is reconciled from the authoritative task record, artifact written (PRI-541)', async () => {
    const deps = createMockDepsWithStrictValidator();
    const malformedOutput: DreamerOutput = {
      valid: true,
      taskId: 'wrong-task-id',
      candidates: [{
        candidateIndex: 0,
        badDecision: 'Bad',
        betterDecision: 'Better',
        rationale: 'Why',
        confidence: 0.5,
        riskLevel: 'low',
        strategicPerspective: 'test',
      }],
      contextRefs: [],
      generatedAt: new Date().toISOString(),
    };

    (deps.runtimeAdapter as unknown as { fetchOutput: ReturnType<typeof vi.fn> }).fetchOutput
      = vi.fn().mockResolvedValue({ payload: malformedOutput });

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');
    // taskId is runner-owned lineage (rc-6): a wrong echo is corrected from the
    // task record instead of dead-ending as output_invalid (PRI-541).
    expect(result.status).toBe('succeeded');

    const artifacts = await artifactStore.listBySourceTaskId('task-dreamer-001');
    expect(artifacts).toHaveLength(1);

    expect(deps.stateManager.markTaskSucceeded).toHaveBeenCalled();

    // Persisted output carries the authoritative taskId, not the LLM echo.
    const outputCalls = (deps.stateManager as unknown as Record<string, { mock?: { calls?: unknown[][] } }>).updateRunOutput?.mock?.calls ?? [];
    const persisted = JSON.parse(outputCalls[0]?.[1] as string) as Record<string, unknown>;
    expect(persisted.taskId).toBe('task-dreamer-001');

    const telemetryCalls = (deps.eventEmitter as unknown as { emitTelemetry: ReturnType<typeof vi.fn> }).emitTelemetry.mock.calls;
    const correctedEvent = telemetryCalls
      .map((call) => call[0] as { eventType: string; payload: Record<string, unknown> })
      .find((evt) => evt.eventType === 'dreamer_lineage_echo_corrected');
    expect(correctedEvent).toBeDefined();
    expect(correctedEvent?.payload.correctedFields).toEqual(['taskId']);
  });

  it('malformed output with invalid confidence is rejected, no artifact written', async () => {
    const deps = createMockDepsWithStrictValidator();
    const malformedOutput = makeDreamerOutput();
    (malformedOutput.candidates[0] as unknown as Record<string, unknown>).confidence = 1.5;

    (deps.runtimeAdapter as unknown as { fetchOutput: ReturnType<typeof vi.fn> }).fetchOutput
      = vi.fn().mockResolvedValue({ payload: malformedOutput });

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');
    expect(result.status).toBe('failed');

    const artifacts = await artifactStore.listBySourceTaskId('task-dreamer-001');
    expect(artifacts).toHaveLength(0);
  });

  it('malformed output with unknown riskLevel is rejected, no artifact written', async () => {
    const deps = createMockDepsWithStrictValidator();
    const malformedOutput = makeDreamerOutput();
    (malformedOutput.candidates[0] as unknown as Record<string, unknown>).riskLevel = 'critical';

    (deps.runtimeAdapter as unknown as { fetchOutput: ReturnType<typeof vi.fn> }).fetchOutput
      = vi.fn().mockResolvedValue({ payload: malformedOutput });

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');
    expect(result.status).toBe('failed');

    const artifacts = await artifactStore.listBySourceTaskId('task-dreamer-001');
    expect(artifacts).toHaveLength(0);
  });

  it('malformed output does not mark task succeeded, goes to retry/fail', async () => {
    const deps = createMockDepsWithStrictValidator();
    const malformedOutput: DreamerOutput = {
      valid: true,
      taskId: 'task-dreamer-001',
      candidates: [],
      contextRefs: [],
      generatedAt: new Date().toISOString(),
    };

    (deps.runtimeAdapter as unknown as { fetchOutput: ReturnType<typeof vi.fn> }).fetchOutput
      = vi.fn().mockResolvedValue({ payload: malformedOutput });

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-001');
    expect(result.status).toBe('failed');
    expect(deps.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });
});

describe('DreamerRunner output_extraction_failed telemetry', () => {
  function createMinimalDeps() {
    const artifactStore = new MemoryPIArtifactStore();
    const task: TaskRecord = {
      taskId: 'task-dreamer-ext-001',
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const stateManager = {
      acquireLease: vi.fn().mockResolvedValue(task),
      getTask: vi.fn().mockResolvedValue(task),
      getRunsByTask: vi.fn().mockResolvedValue([{
        runId: 'run-ext-001',
        taskId: 'task-dreamer-ext-001',
        runtimeKind: 'dreamer',
        startedAt: new Date().toISOString(),
      }]),
      getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
        runs: [{ runId: 'run-ext-001', taskId: 'task-dreamer-ext-001', runtimeKind: 'dreamer', startedAt: new Date().toISOString() }],
        degradedRuns: [],
      }),
      updateRunOutput: vi.fn().mockResolvedValue(undefined),
      markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
      getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
    } as unknown as RuntimeStateManager;

    const runHandle: RunHandle = { runId: 'run-ext-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-ext-001' };

    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue(runHandle),
      pollRun: vi.fn().mockResolvedValue(succeededStatus),
      fetchOutput: vi.fn().mockResolvedValue({ payload: null }),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as PDRuntimeAdapter;

    const eventEmitter = {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter;

    return { stateManager, runtimeAdapter, eventEmitter, validator: new DefaultDreamerValidator(), artifactStore };
  }

  it('emits dreamer_output_extraction_failed when fetchOutput returns null payload', async () => {
    const deps = createMinimalDeps();
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({ payload: null });

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-ext-001');
    expect(result.status).toBe('failed');

    const telemetryCalls = (deps.eventEmitter as unknown as { emitTelemetry: ReturnType<typeof vi.fn> }).emitTelemetry.mock.calls;
    const extractionFailedCalls = telemetryCalls.filter((call: unknown[]) => {
      const evt = call[0] as Record<string, unknown>;
      return evt && evt.eventType === 'dreamer_output_extraction_failed';
    });
    expect(extractionFailedCalls.length).toBeGreaterThanOrEqual(1);
    const evt = extractionFailedCalls[0]?.[0] as Record<string, unknown>;
    expect(evt).toBeDefined();
    const evtPayload = evt?.payload as Record<string, unknown> | undefined;
    expect(evtPayload?.stage).toBe('payload_missing');
  });

  it('emits dreamer_output_extraction_failed when fetchOutput returns non-object payload', async () => {
    const deps = createMinimalDeps();
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({ payload: 'not-json' });

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-ext-001');
    expect(result.status).toBe('failed');

    const telemetryCalls = (deps.eventEmitter as unknown as { emitTelemetry: ReturnType<typeof vi.fn> }).emitTelemetry.mock.calls;
    const extractionFailedCalls = telemetryCalls.filter((call: unknown[]) => {
      const evt = call[0] as Record<string, unknown>;
      return evt && evt.eventType === 'dreamer_output_extraction_failed';
    });
    expect(extractionFailedCalls.length).toBeGreaterThanOrEqual(1);
    const evt = extractionFailedCalls[0]?.[0] as Record<string, unknown>;
    expect(evt).toBeDefined();
    const evtPayload = evt?.payload as Record<string, unknown> | undefined;
    expect(evtPayload?.stage).toBe('payload_not_object');
  });

  it('emits dreamer_output_extraction_failed when fetchOutput throws', async () => {
    const deps = createMinimalDeps();
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockRejectedValue(new Error('Network timeout'));

    const runner = new DreamerRunner(deps, {
      owner: 'test',
      runtimeKind: 'dreamer',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    const result = await runner.run('task-dreamer-ext-001');
    expect(result.status).toBe('failed');

    const telemetryCalls = (deps.eventEmitter as unknown as { emitTelemetry: ReturnType<typeof vi.fn> }).emitTelemetry.mock.calls;
    const extractionFailedCalls = telemetryCalls.filter((call: unknown[]) => {
      const evt = call[0] as Record<string, unknown>;
      return evt && evt.eventType === 'dreamer_output_extraction_failed';
    });
    expect(extractionFailedCalls.length).toBeGreaterThanOrEqual(1);
    const evt = extractionFailedCalls[0]?.[0] as Record<string, unknown>;
    expect(evt).toBeDefined();
    const evtPayload = evt?.payload as Record<string, unknown> | undefined;
    expect(evtPayload?.stage).toBe('fetchOutput');
  });
});
