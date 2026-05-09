import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DreamerRunner } from '../internalization/dreamer-runner.js';
import type { DreamerRunnerDeps } from '../internalization/dreamer-runner.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { DreamerOutput, DreamerValidationResult } from '../internalization/dreamer-output.js';
import type { TaskRecord } from '../task-status.js';
import { createMinimalPITaskRecord } from '../internalization/peer-runner-contracts.js';
import { serializePITaskMetadata } from '../internalization/pitask-metadata.js';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const base = createMinimalPITaskRecord('task-dreamer-001', 'dreamer', 'prompt');
  return {
    ...base,
    status: overrides.status ?? 'leased',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    attemptCount: overrides.attemptCount ?? 1,
    maxAttempts: overrides.maxAttempts ?? 3,
    resultRef: overrides.resultRef,
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
    validate: vi.fn().mockResolvedValue({ valid: true, errors: [] } as DreamerValidationResult),
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
});
