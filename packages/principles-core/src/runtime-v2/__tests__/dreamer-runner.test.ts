/**
 * DreamerRunner unit tests (PRI-67).
 *
 * Test scenarios:
 *   1. Happy path: full lifecycle succeeds with valid DreamerOutput
 *   2. Runtime method call order: startRun → pollRun → fetchOutput in sequence
 *   3. Invalid output: validation fails → retried, no accepted artifact
 *   4. Runtime failure: pollRun returns 'failed' → retried
 *   4b. Timeout handling: pollRun returns 'running' → timeout → retried
 *   5. Lease conflict: acquireLease throws lease_conflict → non-mutating result
 *   6. Source guard: no forbidden imports (openclaw-plugin, nocturnal-trinity, etc.)
 *   6b. Source guard: no scheduling infrastructure
 *   7. No direct task creation: no createTask/enqueueTask calls
 *   7b. Result does not contain next task — only artifact/proposal
 *   7c. Validation failure with permanent error → markTaskFailed
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type {
  PDRuntimeAdapter,
  RunHandle,
  StartRunInput,
} from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { DreamerOutput, DreamerCandidate, DreamerValidator } from '../internalization/dreamer-output.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError } from '../error-categories.js';
import { DreamerRunner } from '../internalization/dreamer-runner.js';
import { createMinimalPITaskRecord } from '../internalization/peer-runner-contracts.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

const TASK_ID = 'task-dreamer-001';
const RUN_ID = 'run-dreamer-001';
const OWNER = 'test-dreamer-owner';
const RUNTIME_KIND = 'test-double';

function makePITaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const base = createMinimalPITaskRecord(TASK_ID, 'dreamer', 'prompt');
  return {
    ...base,
    status: 'leased',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    leaseOwner: OWNER,
    leaseExpiresAt: '2026-05-01T01:00:00Z',
    attemptCount: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

function makeRunHandle(): RunHandle {
  return {
    runId: RUN_ID,
    runtimeKind: RUNTIME_KIND,
    startedAt: '2026-05-01T00:00:00Z',
  };
}

function makeDreamerCandidate(index: number): DreamerCandidate {
  return {
    candidateIndex: index,
    badDecision: `Test bad decision ${index}`,
    betterDecision: `Test better decision ${index}`,
    rationale: `Test rationale ${index}`,
    confidence: 0.8,
    riskLevel: 'low',
    strategicPerspective: 'conservative_fix',
  };
}

function makeDreamerOutput(overrides: Partial<DreamerOutput> = {}): DreamerOutput {
  return {
    valid: true,
    taskId: TASK_ID,
    candidates: [makeDreamerCandidate(0), makeDreamerCandidate(1)],
    sourcePrincipleId: 'principle-001',
    sourcePainId: 'pain-001',
    contextRefs: ['trajectory-001'],
    generatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

// ── Mock factory ───────────────────────────────────────────────────────────────

interface MockStateful {
  acquireLease: ReturnType<typeof vi.fn>;
  markTaskSucceeded: ReturnType<typeof vi.fn>;
  markTaskFailed: ReturnType<typeof vi.fn>;
  markTaskRetryWait: ReturnType<typeof vi.fn>;
  updateRunOutput: ReturnType<typeof vi.fn>;
  getRetryPolicy: ReturnType<typeof vi.fn>;
  getRunsByTask: ReturnType<typeof vi.fn>;
  getValidRunsByTaskTolerant: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
}

interface MockAdapter {
  kind: ReturnType<typeof vi.fn>;
  getCapabilities: ReturnType<typeof vi.fn>;
  healthCheck: ReturnType<typeof vi.fn>;
  startRun: ReturnType<typeof vi.fn>;
  pollRun: ReturnType<typeof vi.fn>;
  cancelRun: ReturnType<typeof vi.fn>;
  fetchOutput: ReturnType<typeof vi.fn>;
  fetchArtifacts: ReturnType<typeof vi.fn>;
}

interface MockValidator {
  validate: ReturnType<typeof vi.fn>;
}

function createMocks() {
  const taskRecord = makePITaskRecord();
  const runHandle = makeRunHandle();
  const output = makeDreamerOutput();

  const mockStateManager: MockStateful = {
    acquireLease: vi.fn().mockResolvedValue(taskRecord),
    markTaskSucceeded: vi.fn().mockResolvedValue(taskRecord),
    markTaskFailed: vi.fn().mockResolvedValue(taskRecord),
    markTaskRetryWait: vi.fn().mockResolvedValue(taskRecord),
    updateRunOutput: vi.fn().mockResolvedValue({}),
    getRetryPolicy: vi.fn().mockReturnValue({
      calculateBackoff: vi.fn().mockReturnValue(30_000),
      shouldRetry: vi.fn().mockReturnValue(true),
    }),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: RUN_ID, taskId: TASK_ID }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: RUN_ID, taskId: TASK_ID }],
      degradedRuns: [],
    }),
    getTask: vi.fn().mockResolvedValue({ ...taskRecord, dependencyTaskIds: [] }),
  };

  const mockRuntimeAdapter: MockAdapter = {
    kind: vi.fn().mockReturnValue(RUNTIME_KIND),
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue({
      runId: RUN_ID,
      status: 'succeeded',
    }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    fetchOutput: vi.fn().mockResolvedValue({
      runId: RUN_ID,
      payload: output,
    }),
    fetchArtifacts: vi.fn(),
  };

  const mockValidator: MockValidator = {
    validate: vi.fn().mockResolvedValue({
      valid: true,
      errors: [] as readonly string[],
    }),
  };

  const mockEventEmitter = {
    emitTelemetry: vi.fn().mockReturnValue(true),
    on: vi.fn(),
    emit: vi.fn(),
  };

  return {
    mockStateManager: mockStateManager as unknown as RuntimeStateManager,
    mockRuntimeAdapter: mockRuntimeAdapter as unknown as PDRuntimeAdapter,
    mockValidator: mockValidator as unknown as DreamerValidator,
    mockEventEmitter: mockEventEmitter as unknown as StoreEventEmitter,
    taskRecord,
    runHandle,
    output,
    _stateManager: mockStateManager,
    _runtimeAdapter: mockRuntimeAdapter,
    _validator: mockValidator,
    _eventEmitter: mockEventEmitter,
  };
}

function createRunner(mocks: ReturnType<typeof createMocks>) {
  return new DreamerRunner(
    {
      stateManager: mocks.mockStateManager,
      runtimeAdapter: mocks.mockRuntimeAdapter,
      eventEmitter: mocks.mockEventEmitter,
      validator: mocks.mockValidator,
      artifactStore: new MemoryPIArtifactStore(),
    },
    {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 100,
      timeoutMs: 1000,
    },
  );
}

/** Type-safe helper to extract the first call argument from a mock. */
function firstCallArg(mockFn: ReturnType<typeof vi.fn>): unknown {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return mockFn.mock.calls[0]![0];
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DreamerRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Happy path
  it('succeeds end-to-end when all phases complete normally', async () => {
    const mocks = createMocks();
    const runner = createRunner(mocks);

    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(TASK_ID);
    expect(result.output).toBeDefined();
    expect(result.output?.candidates).toHaveLength(2);
    expect(result.attemptCount).toBe(1);
    expect(mocks._stateManager.acquireLease).toHaveBeenCalledWith({
      taskId: TASK_ID,
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
    });
    expect(mocks._stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining('dreamer://'),
    );
    expect(mocks._stateManager.updateRunOutput).toHaveBeenCalledWith(
      RUN_ID,
      expect.any(String),
    );
  });

  // 2. Runtime method call order
  it('calls startRun → pollRun → fetchOutput in correct order', async () => {
    const mocks = createMocks();
    const callOrder: string[] = [];

    mocks._runtimeAdapter.startRun.mockImplementation(async () => {
      callOrder.push('startRun');
      return mocks.runHandle;
    });
    mocks._runtimeAdapter.pollRun.mockImplementation(async () => {
      callOrder.push('pollRun');
      return { runId: RUN_ID, status: 'succeeded' };
    });
    mocks._runtimeAdapter.fetchOutput.mockImplementation(async () => {
      callOrder.push('fetchOutput');
      return { runId: RUN_ID, payload: mocks.output };
    });

    const runner = createRunner(mocks);
    await runner.run(TASK_ID);

    expect(callOrder).toEqual(['startRun', 'pollRun', 'fetchOutput']);
  });

  it('sets agentSpec.agentId to dreamer and outputSchemaRef to dreamer-output-v1', async () => {
    const mocks = createMocks();
    const runner = createRunner(mocks);

    await runner.run(TASK_ID);

    const startInput = firstCallArg(mocks._runtimeAdapter.startRun) as StartRunInput;
    expect(startInput.agentSpec.agentId).toBe('dreamer');
    expect(startInput.outputSchemaRef).toBe('dreamer-output-v1');
    expect(startInput.taskRef?.taskId).toBe(TASK_ID);
  });

  // 3. Invalid output — validation fails → retried, no accepted artifact
  it('retries when validator returns valid:false and does not store accepted artifact', async () => {
    const mocks = createMocks();
    mocks._validator.validate.mockResolvedValue({
      valid: false,
      errors: ['No candidates provided'],
      errorCategory: 'output_invalid',
    });

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('output_invalid');
    expect(result.failureReason).toContain('Validation failed');
    // markTaskSucceeded must NOT be called (no accepted artifact)
    expect(mocks._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
    // markTaskRetryWait must be called (retryable)
    expect(mocks._stateManager.markTaskRetryWait).toHaveBeenCalledWith(TASK_ID, 'output_invalid', expect.stringContaining('Validation failed: No candidates provided'));
  });

  // 4. Runtime failure — pollRun returns 'failed' → retried
  it('retries on runtime failure with execution_failed', async () => {
    const mocks = createMocks();
    mocks._runtimeAdapter.pollRun.mockResolvedValue({
      runId: RUN_ID,
      status: 'failed',
      reason: 'LLM error',
    });

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('execution_failed');
    expect(result.failureReason).toContain('failed');
    expect(mocks._stateManager.markTaskRetryWait).toHaveBeenCalledWith(TASK_ID, 'execution_failed', expect.stringContaining('Runtime execution ended with status: failed. Reason: LLM error'));
  });

  // 4b. Timeout handling
  it('retries on timeout with timeout error', async () => {
    const mocks = createMocks();
    mocks._runtimeAdapter.pollRun.mockResolvedValue({ runId: RUN_ID, status: 'running' });

    const runner = createRunner(mocks);
    const resultPromise = runner.run(TASK_ID);

    await vi.advanceTimersByTimeAsync(1500);

    const result = await resultPromise;
    expect(mocks._runtimeAdapter.cancelRun).toHaveBeenCalledWith(RUN_ID);
    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('timeout');
  });

  // 5. Lease conflict — non-mutating structured result
  it('lease_conflict returns non-mutating result without markTaskRetryWait/markTaskFailed', async () => {
    const mocks = createMocks();
    mocks._stateManager.acquireLease.mockRejectedValue(
      new PDRuntimeError('lease_conflict', 'Task already leased by another runner'),
    );

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    // Mutation methods must NOT be called for lease_conflict
    expect(mocks._stateManager.markTaskRetryWait).not.toHaveBeenCalled();
    expect(mocks._stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(mocks._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  // 6. Source guard — static analysis for forbidden imports
  describe('Source guard', () => {
    it('dreamer-runner.ts has no forbidden imports', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(
        resolve(__dirname, '..', 'internalization', 'dreamer-runner.ts'),
        'utf-8',
      );

      const forbidden = [
        'openclaw-plugin',
        'nocturnal-trinity',
        'runTrinity',
        'philosopher',
        'scribe',
        'InternalizationOrchestrator',
        'createTask',
        'enqueueTask',
      ];

      for (const term of forbidden) {
        expect(src).not.toContain(term);
      }
    });

    it('dreamer-runner.ts has no scheduling infrastructure', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(
        resolve(__dirname, '..', 'internalization', 'dreamer-runner.ts'),
        'utf-8',
      );

      expect(src).not.toContain('node:cron');
      expect(src).not.toContain('setInterval');
      // setTimeout for sleep() in polling loop is allowed
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
    });
  });

  // 7. No direct task creation — runner only returns artifact/proposal
  it('does not call createTask or enqueueTask on stateManager', async () => {
    const mocks = createMocks();
    const runner = createRunner(mocks);

    await runner.run(TASK_ID);

    // Verify no task creation methods are called
    const stateManagerCalls = Object.keys(mocks._stateManager).filter((key) => {
      const fn = mocks._stateManager[key as keyof MockStateful];
      return typeof fn === 'function' && (fn).mock.calls.length > 0;
    });

    expect(stateManagerCalls).not.toContain('createTask');
    expect(stateManagerCalls).not.toContain('enqueueTask');

    // Confirm only the expected state manager methods are called.
    // resolveStoreRunId now reads via the tolerant accessor (malformed-run tolerance).
    const expectedCalls = [
      'acquireLease',
      'markTaskSucceeded',
      'updateRunOutput',
      'getValidRunsByTaskTolerant',
    ];
    for (const call of expectedCalls) {
      expect(mocks._stateManager[call as keyof MockStateful]).toHaveBeenCalled();
    }
  });

  // 7b. Result does not contain next task — only artifact/proposal
  it('returns succeeded result with output and artifact ref, not next task', async () => {
    const mocks = createMocks();
    const runner = createRunner(mocks);

    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(result.output).toBeDefined();
    // Output must be DreamerOutput (not a next task proposal)
    expect(result.output?.candidates).toBeDefined();
    expect(result.output?.candidates.length).toBeGreaterThan(0);
    // No task creation in result — host layer handles that via orchestrator
    expect(result).not.toHaveProperty('nextTaskId');
    expect(result).not.toHaveProperty('proposal');
  });

  // 7c. Validation failure with permanent error → markTaskFailed
  it('fails permanently on output_invalid after max attempts', async () => {
    const mocks = createMocks();
    mocks._validator.validate.mockResolvedValue({
      valid: false,
      errors: ['Invalid output'],
      errorCategory: 'output_invalid',
    });
    mocks._stateManager.getRetryPolicy.mockReturnValue({
      calculateBackoff: vi.fn().mockReturnValue(30_000),
      shouldRetry: vi.fn().mockReturnValue(false),
    });

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');
    expect(mocks._stateManager.markTaskFailed).toHaveBeenCalledWith(TASK_ID, 'max_attempts_exceeded', expect.stringContaining('Max attempts exceeded: Validation failed: Invalid output'));
  });
});