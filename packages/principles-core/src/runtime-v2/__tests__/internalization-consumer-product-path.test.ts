import { describe, it, expect, vi } from 'vitest';
import type { TaskRecord } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type {
  PDRuntimeAdapter,
  RunHandle,
} from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { DreamerValidator } from '../internalization/dreamer-output.js';
import { InternalizationOrchestrator } from '../internalization/internalization-orchestrator.js';
import { DreamerRunner } from '../internalization/dreamer-runner.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';

const TASK_ID = 'dreamer-ready-001';
const RUN_ID = 'run-dreamer-001';
const OWNER = 'auto-consumer';
const RUNTIME_KIND = 'pi-ai' as const;

function makeRawTask(overrides: {
  taskId?: string;
  taskKind?: string;
  status?: string;
  channel?: string;
  dependencyTaskIds?: string[];
  attemptCount?: number;
} = {}): TaskRecord {
  const {
    taskId = TASK_ID,
    taskKind = 'dreamer',
    status = 'pending',
    channel = 'prompt',
    dependencyTaskIds = [],
    attemptCount = 0,
  } = overrides;

  const piMetadata: Record<string, unknown> = {
    dependencyTaskIds,
    channel,
    timeoutMs: 60000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
  };

  const diagnosticJson = JSON.stringify({ pi_metadata: piMetadata });

  return {
    taskId,
    taskKind,
    status: status as TaskRecord['status'],
    createdAt: '2026-06-13T00:00:00Z',
    updatedAt: '2026-06-13T00:00:00Z',
    attemptCount,
    maxAttempts: 3,
    diagnosticJson,
  } as unknown as TaskRecord;
}

function makeDreamerOutput() {
  return {
    valid: true,
    taskId: TASK_ID,
    candidates: [{
      candidateIndex: 0,
      badDecision: 'Test bad decision',
      betterDecision: 'Test better decision',
      rationale: 'Test rationale',
      confidence: 0.8,
      riskLevel: 'low',
      strategicPerspective: 'conservative_fix',
    }],
    sourcePrincipleId: 'principle-001',
    sourcePainId: 'pain-001',
    contextRefs: ['trajectory-001'],
    generatedAt: '2026-06-13T00:00:00Z',
  };
}

function createMockStateManager(opts: {
  pendingTasks?: TaskRecord[];
  retryWaitTasks?: TaskRecord[];
  noRetry?: boolean;
} = {}) {
  const {
    pendingTasks = [makeRawTask({ status: 'pending' })],
    retryWaitTasks = [],
    noRetry = false,
  } = opts;

  const leasedTask = makeRawTask({ status: 'leased', attemptCount: 1 });
  const succeededTask = makeRawTask({ status: 'succeeded' });

  return {
    listTasks: vi.fn()
      .mockResolvedValueOnce(pendingTasks)
      .mockResolvedValueOnce(retryWaitTasks)
      .mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(succeededTask),
    acquireLease: vi.fn().mockResolvedValue(leasedTask),
    markTaskSucceeded: vi.fn().mockResolvedValue(succeededTask),
    markTaskFailed: vi.fn().mockResolvedValue(makeRawTask({ status: 'pending' })),
    markTaskRetryWait: vi.fn().mockResolvedValue(makeRawTask({ status: 'retry_wait' })),
    updateRunOutput: vi.fn().mockResolvedValue({}),
    getRetryPolicy: vi.fn().mockReturnValue({
      calculateBackoff: vi.fn().mockReturnValue(30_000),
      shouldRetry: vi.fn().mockReturnValue(!noRetry),
    }),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: RUN_ID, taskId: TASK_ID }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: RUN_ID, taskId: TASK_ID }],
      degradedRuns: [],
    }),
    createTask: vi.fn().mockResolvedValue({
      taskId: `philosopher-${TASK_ID}-prompt`,
      taskKind: 'philosopher',
      status: 'pending',
    } as unknown as TaskRecord),
  };
}

function createMockAdapter(opts: {
  pollStatus?: string;
} = {}) {
  const {
    pollStatus = 'succeeded',
  } = opts;

  const runHandle: RunHandle = {
    runId: RUN_ID,
    runtimeKind: RUNTIME_KIND,
    startedAt: '2026-06-13T00:00:00Z',
  };

  return {
    kind: vi.fn().mockReturnValue(RUNTIME_KIND),
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue({
      runId: RUN_ID,
      status: pollStatus,
    }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    fetchOutput: vi.fn().mockResolvedValue({
      runId: RUN_ID,
      payload: makeDreamerOutput(),
    }),
    fetchArtifacts: vi.fn(),
  };
}

function createMockEventEmitter(): StoreEventEmitter {
  return {
    emitTelemetry: vi.fn().mockReturnValue(true),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as StoreEventEmitter;
}

function createMockValidator(): DreamerValidator {
  return {
    validate: vi.fn().mockResolvedValue({
      valid: true,
      errors: [] as readonly string[],
    }),
  };
}

describe('PRI-381: Consumer product-path — full cycle integration', () => {
  it('wakeOnce leases ready dreamer → runner.run succeeds → commitNextTaskProposal creates successor', async () => {
    const mockStateManager = createMockStateManager();
    const mockAdapter = createMockAdapter();
    const stateManager = mockStateManager as unknown as RuntimeStateManager;
    const adapter = mockAdapter as unknown as PDRuntimeAdapter;

    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: false },
    );

    const wakeResult = await orchestrator.wakeOnce('dreamer');

    expect(wakeResult.decision).toBe('leased');
    if (wakeResult.decision !== 'leased') {
      throw new Error('wakeOnce did not lease the task');
    }
    expect(wakeResult.taskId).toBe(TASK_ID);
    expect(mockStateManager.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        owner: OWNER,
      }),
    );

    const runner = new DreamerRunner(
      {
        stateManager,
        runtimeAdapter: adapter,
        eventEmitter: createMockEventEmitter(),
        artifactStore: new MemoryPIArtifactStore(),
        validator: createMockValidator(),
      },
      { owner: OWNER, runtimeKind: RUNTIME_KIND },
    );

    const runResult = await runner.run(wakeResult.taskId);

    expect(runResult.status).toBe('succeeded');
    expect(runResult.taskId).toBe(TASK_ID);

    expect(mockStateManager.markTaskSucceeded).toHaveBeenCalled();
    expect(mockAdapter.startRun).toHaveBeenCalled();
    expect(mockAdapter.pollRun).toHaveBeenCalled();
    expect(mockAdapter.fetchOutput).toHaveBeenCalled();

    const commitResult = await orchestrator.commitNextTaskProposal(wakeResult.taskId);

    expect(commitResult.decision).toBe('successor_created');
    if (commitResult.decision !== 'successor_created') {
      throw new Error('commitNextTaskProposal did not create successor');
    }
    expect(commitResult.sourceTaskId).toBe(TASK_ID);
    expect(commitResult.successorKind).toBe('philosopher');
    expect(mockStateManager.createTask).toHaveBeenCalled();
  });

  it('wakeOnce returns no_ready_tasks when queue is empty', async () => {
    const mockStateManager = createMockStateManager({
      pendingTasks: [],
      retryWaitTasks: [],
    });
    const stateManager = mockStateManager as unknown as RuntimeStateManager;

    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: false },
    );

    const wakeResult = await orchestrator.wakeOnce('dreamer');

    expect(wakeResult.decision).toBe('no_ready_tasks');
    expect(mockStateManager.acquireLease).not.toHaveBeenCalled();
    expect(mockStateManager.createTask).not.toHaveBeenCalled();
  });

  it('runner.run failure → retried (retry policy allows retry)', async () => {
    const mockStateManager = createMockStateManager({ noRetry: false });
    const mockAdapter = createMockAdapter({ pollStatus: 'failed' });
    const stateManager = mockStateManager as unknown as RuntimeStateManager;
    const adapter = mockAdapter as unknown as PDRuntimeAdapter;

    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: false },
    );

    const wakeResult = await orchestrator.wakeOnce('dreamer');
    expect(wakeResult.decision).toBe('leased');
    if (wakeResult.decision !== 'leased') {
      throw new Error('wakeOnce did not lease the task');
    }

    const runner = new DreamerRunner(
      {
        stateManager,
        runtimeAdapter: adapter,
        eventEmitter: createMockEventEmitter(),
        artifactStore: new MemoryPIArtifactStore(),
        validator: createMockValidator(),
      },
      { owner: OWNER, runtimeKind: RUNTIME_KIND },
    );

    const runResult = await runner.run(wakeResult.taskId);

    expect(runResult.status).toBe('retried');
    expect(mockStateManager.markTaskRetryWait).toHaveBeenCalledWith(
      wakeResult.taskId,
      'execution_failed',
      expect.stringContaining('Runtime execution ended with status: failed'),
    );
    expect(mockStateManager.createTask).not.toHaveBeenCalled();
  });

  it('runner.run failure → failed (max attempts exhausted)', async () => {
    const pendingTaskMaxed = makeRawTask({ status: 'pending', attemptCount: 3 });
    const leasedTaskMaxed = makeRawTask({ status: 'leased', attemptCount: 3 });
    const succeededTask = makeRawTask({ status: 'succeeded', attemptCount: 3 });

    const mockStateManager = createMockStateManager({
      pendingTasks: [pendingTaskMaxed],
      noRetry: true,
    });
    mockStateManager.acquireLease.mockResolvedValue(leasedTaskMaxed);
    mockStateManager.getTask.mockResolvedValue(succeededTask);

    const mockAdapter = createMockAdapter({ pollStatus: 'failed' });
    const stateManager = mockStateManager as unknown as RuntimeStateManager;
    const adapter = mockAdapter as unknown as PDRuntimeAdapter;

    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: false },
    );

    const wakeResult = await orchestrator.wakeOnce('dreamer');
    expect(wakeResult.decision).toBe('leased');
    if (wakeResult.decision !== 'leased') {
      throw new Error('wakeOnce did not lease the task');
    }

    const runner = new DreamerRunner(
      {
        stateManager,
        runtimeAdapter: adapter,
        eventEmitter: createMockEventEmitter(),
        artifactStore: new MemoryPIArtifactStore(),
        validator: createMockValidator(),
      },
      { owner: OWNER, runtimeKind: RUNTIME_KIND },
    );

    const runResult = await runner.run(wakeResult.taskId);

    expect(runResult.status).toBe('failed');
    expect(mockStateManager.markTaskFailed).toHaveBeenCalledWith(
      wakeResult.taskId,
      'max_attempts_exceeded',
      expect.stringContaining('Max attempts exceeded: Runtime execution ended with status: failed'),
    );
    expect(mockStateManager.createTask).not.toHaveBeenCalled();
  });
});
