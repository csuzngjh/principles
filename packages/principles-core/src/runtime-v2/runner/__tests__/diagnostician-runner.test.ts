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

    // inputPayload should be DiagnosticianInvocationInput shape
    const inputPayload = startInput.inputPayload as { agentId: string; taskId: string };
    expect(inputPayload.agentId).toBe('diagnostician');
    expect(inputPayload.taskId).toBe(TASK_ID);

    // contextItems should contain serialized context
    expect(startInput.contextItems).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(startInput.contextItems[0]!.role).toBe('system');
  });

  // 9. Lease conflict
  it('fails permanently on lease conflict', async () => {
    const mocks = createMocks();
    mocks._stateManager.acquireLease.mockRejectedValue(
      new PDRuntimeError('lease_conflict', 'Task already leased'),
    );

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    // lease_conflict is in PERMANENT_ERROR_CATEGORIES, so it fails immediately
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
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
    const inputPayload = startInput.inputPayload as { context: DiagnosticianContextPayload };
    expect(inputPayload.context.conversationWindow).toHaveLength(3);
    expect(inputPayload.context.sourceRefs).toContain('openclaw-history-import-002');

    // contextItems should contain the serialized context
    const [contextItem] = startInput.contextItems;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parsedContext = JSON.parse(contextItem!.content);
    expect(parsedContext.context.conversationWindow).toHaveLength(3);
  });
});
