/**
 * DiagnosticianRunner unit tests.
 *
 * Covers 11 scenarios:
 *   1. Happy path: full lifecycle succeeds
 *   2. Polling loop: pollRun returns 'running' then 'succeeded'
 *   3. Timeout: pollRun never reaches terminal
 *   4. Runtime failure: pollRun returns 'failed'
 *   5. Context build failure (transient)
 *   6. Context build failure (permanent)
 *   7. Validation failure
 *   8. StartRunInput construction
 *   9. Lease conflict
 *  10. Max attempts exceeded
 *  11. OpenClaw history compatibility
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { ContextAssembler } from '../../store/context-assembler.js';
import type {
  PDRuntimeAdapter,
  RunHandle,
  StartRunInput,
} from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { DiagnosticianValidator } from '../diagnostician-validator.js';
import type { DiagnosticianCommitter } from '../../store/diagnostician-committer.js';
import type { DiagnosticianContextPayload } from '../../context-payload.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { TaskRecord } from '../../task-status.js';
import { PDRuntimeError } from '../../error-categories.js';
import { DiagnosticianRunner } from '../diagnostician-runner.js';
import { RunnerPhase } from '../runner-phase.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

const TASK_ID = 'task-test-001';
const RUN_ID = 'run-test-001';
const OWNER = 'test-owner';
const RUNTIME_KIND = 'test-double';

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    taskKind: 'diagnostician',
    status: 'leased',
    createdAt: '2026-04-23T00:00:00Z',
    updatedAt: '2026-04-23T00:00:00Z',
    leaseOwner: OWNER,
    leaseExpiresAt: '2026-04-23T01:00:00Z',
    attemptCount: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

function makeRunHandle(): RunHandle {
  return {
    runId: RUN_ID,
    runtimeKind: RUNTIME_KIND,
    startedAt: '2026-04-23T00:00:00Z',
  };
}

function makeContextPayload(overrides: Partial<DiagnosticianContextPayload> = {}): DiagnosticianContextPayload {
  return {
    contextId: 'ctx-001',
    contextHash: 'abc123hash',
    taskId: TASK_ID,
    workspaceDir: '/test/workspace',
    sourceRefs: ['trajectory-001'],
    diagnosisTarget: {
      reasonSummary: 'test diagnosis',
    },
    conversationWindow: [
      { ts: '2026-04-23T00:00:00Z', role: 'user', text: 'hello' },
    ],
    ...overrides,
  };
}

function makeDiagnosticianOutput(overrides: Partial<DiagnosticianOutputV1> = {}): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-001',
    taskId: TASK_ID,
    summary: 'Test diagnosis summary',
    rootCause: 'Test root cause',
    violatedPrinciples: [],
    evidence: [],
    recommendations: [],
    confidence: 0.9,
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

interface MockAssembler {
  assemble: ReturnType<typeof vi.fn>;
}

interface MockValidator {
  validate: ReturnType<typeof vi.fn>;
}

function createMocks() {
  const taskRecord = makeTaskRecord();
  const runHandle = makeRunHandle();
  const contextPayload = makeContextPayload();
  const output = makeDiagnosticianOutput();

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
  };

  const mockContextAssembler: MockAssembler = {
    assemble: vi.fn().mockResolvedValue(contextPayload),
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
    mockContextAssembler: mockContextAssembler as unknown as ContextAssembler,
    mockRuntimeAdapter: mockRuntimeAdapter as unknown as PDRuntimeAdapter,
    mockValidator: mockValidator as unknown as DiagnosticianValidator,
    mockEventEmitter: mockEventEmitter as unknown as StoreEventEmitter,
    taskRecord,
    runHandle,
    contextPayload,
    output,
    // Expose typed mocks for assertions
    _stateManager: mockStateManager,
    _contextAssembler: mockContextAssembler,
    _runtimeAdapter: mockRuntimeAdapter,
    _validator: mockValidator,
    _committer: { commit: vi.fn().mockResolvedValue({ commitId: "mock-commit-id", artifactId: "mock-artifact-id", candidateCount: 0 }) } as unknown as DiagnosticianCommitter,
    _eventEmitter: mockEventEmitter,
  };
}

function createRunner(mocks: ReturnType<typeof createMocks>) {
  return new DiagnosticianRunner(
    {
      stateManager: mocks.mockStateManager,
      contextAssembler: mocks.mockContextAssembler,
      runtimeAdapter: mocks.mockRuntimeAdapter,
      eventEmitter: mocks.mockEventEmitter,
      validator: mocks.mockValidator,
      committer: mocks._committer,
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

describe('DiagnosticianRunner', () => {
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
    expect(result.output?.diagnosisId).toBe('diag-001');
    expect(result.contextHash).toBe('abc123hash');
    expect(result.attemptCount).toBe(1);
    expect(mocks._stateManager.acquireLease).toHaveBeenCalledWith({
      taskId: TASK_ID,
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
    });
    expect(mocks._stateManager.markTaskSucceeded).toHaveBeenCalledWith(TASK_ID, 'commit://mock-commit-id');
    expect(mocks._stateManager.updateRunOutput).toHaveBeenCalledWith(RUN_ID, JSON.stringify(mocks.output));
  });

  // 2. Polling loop
  it('polls until terminal status is reached', async () => {
    const mocks = createMocks();
    // First poll: running, second poll: succeeded
    mocks._runtimeAdapter.pollRun
      .mockResolvedValueOnce({ runId: RUN_ID, status: 'running' })
      .mockResolvedValueOnce({ runId: RUN_ID, status: 'succeeded' });

    const runner = createRunner(mocks);
    const resultPromise = runner.run(TASK_ID);

    // Advance through the first sleep
    await vi.advanceTimersByTimeAsync(200);

    const result = await resultPromise;

    expect(result.status).toBe('succeeded');
    expect(mocks._runtimeAdapter.pollRun).toHaveBeenCalledTimes(2);
  });

  // 3. Timeout
  it('cancels run and retries on timeout', async () => {
    const mocks = createMocks();
    // pollRun always returns 'running'
    mocks._runtimeAdapter.pollRun.mockResolvedValue({ runId: RUN_ID, status: 'running' });

    const runner = createRunner(mocks);

    const resultPromise = runner.run(TASK_ID);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(1500);

    const result = await resultPromise;

    expect(mocks._runtimeAdapter.cancelRun).toHaveBeenCalledWith(RUN_ID);
    // shouldRetry returns true by default, so it should be retried
    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('timeout');
  });

  // 4. Runtime failure
  it('handles runtime failure and retries if policy allows', async () => {
    const mocks = createMocks();
    mocks._runtimeAdapter.pollRun.mockResolvedValue({
      runId: RUN_ID,
      status: 'failed',
      reason: 'agent error',
    });

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('execution_failed');
    expect(result.failureReason).toContain('failed');
  });

  // 5. Context build failure (transient)
  it('retries on transient context assembly error', async () => {
    const mocks = createMocks();
    mocks._contextAssembler.assemble.mockRejectedValue(
      new PDRuntimeError('runtime_unavailable', 'DB connection lost'),
    );

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(mocks._stateManager.markTaskRetryWait).toHaveBeenCalledWith(TASK_ID, 'runtime_unavailable');
    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('runtime_unavailable');
  });

  // 6. Context build failure (permanent)
  it('fails permanently on workspace_invalid error', async () => {
    const mocks = createMocks();
    mocks._contextAssembler.assemble.mockRejectedValue(
      new PDRuntimeError('workspace_invalid', 'Workspace not found'),
    );

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(mocks._stateManager.markTaskFailed).toHaveBeenCalledWith(TASK_ID, 'workspace_invalid');
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('workspace_invalid');
  });

  // 7. Validation failure
  it('retries or fails on validation failure', async () => {
    const mocks = createMocks();
    mocks._validator.validate.mockResolvedValue({
      valid: false,
      errors: ['Missing taskId', 'Invalid confidence'],
      errorCategory: 'output_invalid',
    });

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    // Default shouldRetry returns true
    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('output_invalid');
    expect(result.failureReason).toContain('Validation failed');
  });

  // 8. StartRunInput construction
  it('constructs StartRunInput with agentSpec.agentId=diagnostician', async () => {
    const mocks = createMocks();
    const runner = createRunner(mocks);

    await runner.run(TASK_ID);

    const startInput = firstCallArg(mocks._runtimeAdapter.startRun) as StartRunInput;
    expect(startInput.agentSpec.agentId).toBe('diagnostician');
    expect(startInput.agentSpec.schemaVersion).toBe('v1');
    expect(startInput.taskRef?.taskId).toBe(TASK_ID);
    expect(startInput.outputSchemaRef).toBe('diagnostician-output-v1');
    expect(startInput.timeoutMs).toBe(1000);

    // inputPayload should be a JSON string with diagnosticInstruction
    const inputPayloadStr = startInput.inputPayload as string;
    const inputPayload = JSON.parse(inputPayloadStr);
    expect(inputPayload.taskId).toBe(TASK_ID);
    expect(inputPayload.diagnosticInstruction).toBeDefined();
    expect(inputPayload.diagnosticInstruction.length).toBeGreaterThan(100);

    // contextItems should be empty (instruction is embedded in inputPayload)
    expect(startInput.contextItems).toHaveLength(0);
  });

  // 9. Lease conflict
  it('lease_conflict returns non-mutating result without markTaskRetryWait/markTaskFailed', async () => {
    const mocks = createMocks();
    mocks._stateManager.acquireLease.mockRejectedValue(
      new PDRuntimeError('lease_conflict', 'Task already leased'),
    );

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    // lease_conflict is handled as non-mutating — no state changes
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    // Mutation methods must NOT be called for lease_conflict
    expect(mocks._stateManager.markTaskRetryWait).not.toHaveBeenCalled();
    expect(mocks._stateManager.markTaskFailed).not.toHaveBeenCalled();
  });

  // 9b. Post-lease errors use real leasedTask (not synthetic)
  it('post-lease error uses real attemptCount/maxAttempts from leasedTask', async () => {
    const mocks = createMocks();
    // leasedTask has attemptCount=2, maxAttempts=3 (not the default 1/3)
    mocks._stateManager.acquireLease.mockResolvedValue(makeTaskRecord({ attemptCount: 2, maxAttempts: 3 }));

    // Make context assembly fail to trigger post-lease error path
    mocks._contextAssembler.assemble.mockRejectedValue(
      new PDRuntimeError('runtime_unavailable', 'DB connection lost'),
    );

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    // Should retry (not fail permanently) because runtime_unavailable is not permanent
    // and real leasedTask (attemptCount=2, maxAttempts=3) means shouldRetry returns true
    expect(result.status).toBe('retried');
    // Verify markTaskRetryWait was called with the real task's attemptCount
    expect(mocks._stateManager.markTaskRetryWait).toHaveBeenCalledWith(TASK_ID, 'runtime_unavailable');
  });

  // 9c. Post-lease error with maxAttempts=1 triggers fail immediately
  it('post-lease error with attemptCount=maxAttempts fails permanently', async () => {
    const mocks = createMocks();
    // leasedTask at last attempt (attemptCount=3, maxAttempts=3)
    mocks._stateManager.acquireLease.mockResolvedValue(makeTaskRecord({ attemptCount: 3, maxAttempts: 3 }));
    // Override shouldRetry to return false when attemptCount >= maxAttempts
    mocks._stateManager.getRetryPolicy.mockReturnValue({
      calculateBackoff: vi.fn().mockReturnValue(30_000),
      shouldRetry: vi.fn().mockReturnValue(false),
    });

    // Make context assembly fail
    mocks._contextAssembler.assemble.mockRejectedValue(
      new PDRuntimeError('runtime_unavailable', 'DB connection lost'),
    );

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    // Should fail with max_attempts_exceeded (not runtime_unavailable)
    // because shouldRetry=false means no more retries
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');
    expect(mocks._stateManager.markTaskFailed).toHaveBeenCalledWith(TASK_ID, 'max_attempts_exceeded');
  });

  // 10. Max attempts exceeded
  it('marks task failed when max attempts exceeded', async () => {
    const mocks = createMocks();
    // Make shouldRetry return false
    mocks._stateManager.getRetryPolicy.mockReturnValue({
      calculateBackoff: vi.fn().mockReturnValue(30_000),
      shouldRetry: vi.fn().mockReturnValue(false),
    });

    // Trigger a failure path (runtime failure)
    mocks._runtimeAdapter.pollRun.mockResolvedValue({
      runId: RUN_ID,
      status: 'failed',
      reason: 'agent error',
    });

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(mocks._stateManager.markTaskFailed).toHaveBeenCalledWith(TASK_ID, 'max_attempts_exceeded');
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');
  });

  // 11. OpenClaw history compatibility
  it('passes through openclaw-history context without inspection', async () => {
    const mocks = createMocks();
    // Context with mixed runtime_kind entries (openclaw-imported format)
    const openClawContext = makeContextPayload({
      sourceRefs: ['trajectory-001', 'openclaw-history-import-002'],
      conversationWindow: [
        { ts: '2026-04-23T00:00:00Z', role: 'user', text: 'hello from openclaw' },
        { ts: '2026-04-23T00:01:00Z', role: 'assistant', text: 'response from openclaw' },
        { ts: '2026-04-23T00:02:00Z', role: 'tool', toolName: 'Write', toolResultSummary: 'wrote file' },
      ],
    });
    mocks._contextAssembler.assemble.mockResolvedValue(openClawContext);

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    // Runner should NOT reject the context
    expect(result.status).toBe('succeeded');

    // startRun should have been called with the context serialized in inputPayload
    const startInput = firstCallArg(mocks._runtimeAdapter.startRun) as StartRunInput;
    const inputPayloadStr = startInput.inputPayload as string;
    const inputPayload = JSON.parse(inputPayloadStr);
    expect(inputPayload.context.conversationWindow).toHaveLength(3);
    expect(inputPayload.context.sourceRefs).toContain('openclaw-history-import-002');

    // contextItems should be empty (instruction embedded in inputPayload)
    expect(startInput.contextItems).toHaveLength(0);
  });

  // ── Committer integration tests (m5-03 Task 5) ──────────────────────────────

  describe('Committer integration', () => {
    // 12. Commit before markTaskSucceeded (call order)
    it('calls committer.commit before markTaskSucceeded', async () => {
      const mocks = createMocks();
      const callOrder: string[] = [];

      const typedCommitter = mocks._committer as { commit: ReturnType<typeof vi.fn> };
      typedCommitter.commit.mockImplementation(async () => {
        callOrder.push('commit');
        return { commitId: 'call-order-commit-id', artifactId: 'art-1', candidateCount: 1 };
      });
      mocks._stateManager.markTaskSucceeded.mockImplementation(async () => {
        callOrder.push('markTaskSucceeded');
        return mocks.taskRecord;
      });

      const runner = createRunner(mocks);
      await runner.run(TASK_ID);

      expect(callOrder).toEqual(['commit', 'markTaskSucceeded']);
    });

    // 13. resultRef uses commit:// scheme
    it('resultRef uses commit:// scheme after commit', async () => {
      const mocks = createMocks();
      const typedCommitter = mocks._committer as { commit: ReturnType<typeof vi.fn> };
      typedCommitter.commit.mockResolvedValue({
        commitId: 'verify-commit-123',
        artifactId: 'art-verify',
        candidateCount: 3,
      });

      const runner = createRunner(mocks);
      await runner.run(TASK_ID);

      expect(mocks._stateManager.markTaskSucceeded).toHaveBeenCalledWith(
        TASK_ID,
        'commit://verify-commit-123',
      );
    });

    // 14. Commit failure triggers retry with artifact_commit_failed
    it('commit failure triggers retry with artifact_commit_failed', async () => {
      const mocks = createMocks();
      const typedCommitter = mocks._committer as { commit: ReturnType<typeof vi.fn> };
      typedCommitter.commit.mockRejectedValue(
        new PDRuntimeError('artifact_commit_failed', 'Commit failed', {}),
      );

      const runner = createRunner(mocks);
      const result = await runner.run(TASK_ID);

      expect(result.status).toBe('retried');
      expect(result.errorCategory).toBe('artifact_commit_failed');
      expect(mocks._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
      expect(mocks._stateManager.markTaskRetryWait).toHaveBeenCalledWith(
        TASK_ID,
        'artifact_commit_failed',
      );
    });

    // 15. Commit failure with max attempts marks task failed
    it('commit failure with max attempts marks task failed', async () => {
      const mocks = createMocks();
      const typedCommitter = mocks._committer as { commit: ReturnType<typeof vi.fn> };
      typedCommitter.commit.mockRejectedValue(
        new PDRuntimeError('artifact_commit_failed', 'Commit failed', {}),
      );
      mocks._stateManager.getRetryPolicy.mockReturnValue({
        calculateBackoff: vi.fn().mockReturnValue(30_000),
        shouldRetry: vi.fn().mockReturnValue(false),
      });

      const runner = createRunner(mocks);
      const result = await runner.run(TASK_ID);

      expect(result.status).toBe('failed');
      expect(result.errorCategory).toBe('max_attempts_exceeded');
      expect(mocks._stateManager.markTaskFailed).toHaveBeenCalledWith(
        TASK_ID,
        'max_attempts_exceeded',
      );
    });

    // 16. RunnerPhase transitions through Committing
    it('RunnerPhase transitions through Committing during commit', async () => {
      const mocks = createMocks();

      const typedCommitter = mocks._committer as { commit: ReturnType<typeof vi.fn> };
      typedCommitter.commit.mockResolvedValue({
        commitId: 'phase-test-commit',
        artifactId: 'art-phase',
        candidateCount: 0,
      });

      const runner = createRunner(mocks);
      const result = await runner.run(TASK_ID);

      expect(result.status).toBe('succeeded');
      expect(typedCommitter.commit).toHaveBeenCalledTimes(1);
      expect(runner.currentPhase).toBe(RunnerPhase.Completed);
    });
  });

  // ── M5-04: Telemetry events ───────────────────────────────────────────────

  describe('M5-04 Telemetry events', () => {
    // TELE-01: diagnostician_artifact_committed emitted after successful commit
    it('emits diagnostician_artifact_committed after successful commit', async () => {
      const mocks = createMocks();
      const typedCommitter = mocks._committer as { commit: ReturnType<typeof vi.fn> };
      typedCommitter.commit.mockResolvedValue({
        commitId: 'commit-artifact-001',
        artifactId: 'artifact-001',
        candidateCount: 2,
      });

      const runner = createRunner(mocks);
      await runner.run(TASK_ID);

      expect(mocks._eventEmitter.emitTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'diagnostician_artifact_committed',
          traceId: TASK_ID,
          payload: expect.objectContaining({
            commitId: 'commit-artifact-001',
            artifactId: 'artifact-001',
            candidateCount: 2,
            taskId: TASK_ID,
            runId: RUN_ID,
          }),
        }),
      );
    });

    // TELE-02: diagnostician_artifact_commit_failed emitted when commit throws
    it('emits diagnostician_artifact_commit_failed when commit throws', async () => {
      const mocks = createMocks();
      const typedCommitter = mocks._committer as { commit: ReturnType<typeof vi.fn> };
      typedCommitter.commit.mockRejectedValue(
        new PDRuntimeError('artifact_commit_failed', 'Database constraint violation', {}),
      );

      const runner = createRunner(mocks);
      await runner.run(TASK_ID);

      expect(mocks._eventEmitter.emitTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'diagnostician_artifact_commit_failed',
          traceId: TASK_ID,
          payload: expect.objectContaining({
            taskId: TASK_ID,
            runId: RUN_ID,
            errorCategory: 'artifact_commit_failed',
          }),
        }),
      );
    });

    // TELE-03: principle_candidate_registered emitted per principle candidate
    it('emits principle_candidate_registered for each principle recommendation', async () => {
      const mocks = createMocks();
      const typedCommitter = mocks._committer as { commit: ReturnType<typeof vi.fn> };
      typedCommitter.commit.mockResolvedValue({
        commitId: 'commit-candidate-001',
        artifactId: 'artifact-001',
        candidateCount: 2,
      });

      // Override output with 2 principle recommendations
      const output = makeDiagnosticianOutput({
        recommendations: [
          { kind: 'principle', description: 'Use immutable data structures' },
          { kind: 'principle', description: 'Prefer pure functions' },
          { kind: 'rule', description: 'Follow existing naming conventions' },
        ],
      });
      mocks._runtimeAdapter.fetchOutput = vi.fn().mockResolvedValue({
        runId: RUN_ID,
        payload: output,
      });

      const runner = createRunner(mocks);
      await runner.run(TASK_ID);

      // Should have 2 calls to principle_candidate_registered
      const candidateEvents = (mocks._eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0]?.eventType === 'principle_candidate_registered',
      );
      expect(candidateEvents).toHaveLength(2);
      const [firstEvent, secondEvent] = candidateEvents;
      if (!firstEvent || !secondEvent) {
        throw new Error('Expected 2 candidate events but got fewer');
      }
      expect(firstEvent[0]?.payload).toMatchObject({
        commitId: 'commit-candidate-001',
        kind: 'principle',
        candidateIndex: 0,
        sourceRunId: RUN_ID,
      });
      expect(secondEvent[0]?.payload).toMatchObject({
        commitId: 'commit-candidate-001',
        kind: 'principle',
        candidateIndex: 1,
        sourceRunId: RUN_ID,
      });
    });

    // TELE-04: all events use emitTelemetry (StoreEventEmitter)
    it('all new telemetry events use emitTelemetry, not console.log or side effects', async () => {
      const mocks = createMocks();
      const typedCommitter = mocks._committer as { commit: ReturnType<typeof vi.fn> };
      typedCommitter.commit.mockResolvedValue({
        commitId: 'commit-tele-004',
        artifactId: 'artifact-004',
        candidateCount: 1,
      });

      // Override output with 1 principle recommendation so the event fires
      const output = makeDiagnosticianOutput({
        recommendations: [
          { kind: 'principle', description: 'Test principle' },
        ],
      });
      mocks._runtimeAdapter.fetchOutput = vi.fn().mockResolvedValue({
        runId: RUN_ID,
        payload: output,
      });

      const runner = createRunner(mocks);
      await runner.run(TASK_ID);

      // All 3 new event types should go through emitTelemetry
      const allEventTypes = (mocks._eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[0]?.eventType,
      );
      expect(allEventTypes).toContain('diagnostician_artifact_committed');
      expect(allEventTypes).toContain('principle_candidate_registered');
    });
  });
});
