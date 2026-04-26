/**
 * DiagnosticianRunner telemetry emission tests.
 *
 * Verifies that DiagnosticianRunner emits the correct telemetry events
 * at each phase transition. Covers 5 scenarios:
 *   1. Happy path: 4 events emitted (leased, context_built, run_started, task_succeeded)
 *   2. Runtime failure: 2 events emitted (run_failed, task_retried)
 *   3. Validation failure: 2 events emitted (output_invalid, task_retried)
 *   4. Max attempts exceeded: 1 event emitted (task_failed with max_attempts_exceeded)
 *   5. Permanent error: 1 event emitted (task_failed with workspace_invalid)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { ContextAssembler } from '../../store/context-assembler.js';
import type { PDRuntimeAdapter, RunHandle } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { DiagnosticianValidator } from '../diagnostician-validator.js';
import type { DiagnosticianCommitter } from '../../store/diagnostician-committer.js';
import type { DiagnosticianContextPayload } from '../../context-payload.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { TaskRecord } from '../../task-status.js';
import { PDRuntimeError } from '../../error-categories.js';
import { DiagnosticianRunner } from '../diagnostician-runner.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

const TASK_ID = 'task-telem-001';
const RUN_ID = 'run-telem-001';
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

function makeContextPayload(): DiagnosticianContextPayload {
  return {
    contextId: 'ctx-telem-001',
    contextHash: 'hashabc123',
    taskId: TASK_ID,
    workspaceDir: '/test/workspace',
    sourceRefs: ['trajectory-001', 'trajectory-002'],
    diagnosisTarget: {
      reasonSummary: 'test diagnosis',
    },
    conversationWindow: [
      { ts: '2026-04-23T00:00:00Z', role: 'user', text: 'hello' },
    ],
  };
}

function makeDiagnosticianOutput(): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-telem-001',
    taskId: TASK_ID,
    summary: 'Test diagnosis summary',
    rootCause: 'Test root cause',
    violatedPrinciples: [],
    evidence: [],
    recommendations: [],
    confidence: 0.9,
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
  startRun: ReturnType<typeof vi.fn>;
  pollRun: ReturnType<typeof vi.fn>;
  cancelRun: ReturnType<typeof vi.fn>;
  fetchOutput: ReturnType<typeof vi.fn>;
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
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue({ runId: RUN_ID, status: 'succeeded' }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    fetchOutput: vi.fn().mockResolvedValue({ runId: RUN_ID, payload: output }),
  };

  const mockValidator: MockValidator = {
    validate: vi.fn().mockResolvedValue({ valid: true, errors: [] as readonly string[] }),
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

/** Extract all eventTypes from emitTelemetry calls. */
function extractEventTypes(mockFn: ReturnType<typeof vi.fn>): string[] {
  return mockFn.mock.calls.map((call: unknown[]) => {
    const event = call[0] as { eventType: string };
    return event.eventType;
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DiagnosticianRunner telemetry emission', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Happy path emits 4 events
  it('emits leased, context_built, run_started, and task_succeeded on happy path', async () => {
    const mocks = createMocks();
    const runner = createRunner(mocks);

    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    const eventTypes = extractEventTypes(mocks._eventEmitter.emitTelemetry);
    expect(eventTypes).toEqual([
      'diagnostician_task_leased',
      'diagnostician_context_built',
      'diagnostician_run_started',
      'output_validation_succeeded',
      'diagnostician_artifact_committed',
      'diagnostician_task_succeeded',
    ]);
  });

  // 2. Runtime failure emits run_failed + task_retried
  it('emits run_failed and task_retried when pollRun returns failed', async () => {
    const mocks = createMocks();
    mocks._runtimeAdapter.pollRun.mockResolvedValue({
      runId: RUN_ID,
      status: 'failed',
      reason: 'agent error',
    });

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('retried');
    const eventTypes = extractEventTypes(mocks._eventEmitter.emitTelemetry);
    expect(eventTypes).toEqual([
      'diagnostician_task_leased',
      'diagnostician_context_built',
      'diagnostician_run_started',
      'diagnostician_run_failed',
      'diagnostician_task_retried',
    ]);
  });

  // 3. Validation failure emits output_invalid + task_retried
  it('emits output_invalid and task_retried when validation fails', async () => {
    const mocks = createMocks();
    mocks._validator.validate.mockResolvedValue({
      valid: false,
      errors: ['Missing diagnosisId', 'Invalid confidence'],
      errorCategory: 'output_invalid',
    });

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('retried');
    const eventTypes = extractEventTypes(mocks._eventEmitter.emitTelemetry);
    expect(eventTypes).toEqual([
      'diagnostician_task_leased',
      'diagnostician_context_built',
      'diagnostician_run_started',
      'diagnostician_output_invalid',
      'output_validation_failed',
      'diagnostician_task_retried',
    ]);
  });

  // 4. Max attempts exceeded emits task_failed (max_attempts_exceeded)
  it('emits task_failed with max_attempts_exceeded when shouldRetry returns false', async () => {
    const mocks = createMocks();
    mocks._stateManager.getRetryPolicy.mockReturnValue({
      calculateBackoff: vi.fn().mockReturnValue(30_000),
      shouldRetry: vi.fn().mockReturnValue(false),
    });
    mocks._runtimeAdapter.pollRun.mockResolvedValue({
      runId: RUN_ID,
      status: 'failed',
      reason: 'agent error',
    });

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');
    const eventTypes = extractEventTypes(mocks._eventEmitter.emitTelemetry);
    expect(eventTypes).toEqual([
      'diagnostician_task_leased',
      'diagnostician_context_built',
      'diagnostician_run_started',
      'diagnostician_run_failed',
      'diagnostician_task_failed',
    ]);
    // Verify the task_failed event has max_attempts_exceeded
    const {calls} = mocks._eventEmitter.emitTelemetry.mock;
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    const lastEvent = (lastCall as unknown[])[0] as { eventType: string; payload: { errorCategory: string } };
    expect(lastEvent.payload.errorCategory).toBe('max_attempts_exceeded');
  });

  // 5. Permanent error emits task_failed (permanent category)
  it('emits task_failed with permanent error category on workspace_invalid', async () => {
    const mocks = createMocks();
    mocks._contextAssembler.assemble.mockRejectedValue(
      new PDRuntimeError('workspace_invalid', 'Workspace not found'),
    );

    const runner = createRunner(mocks);
    const result = await runner.run(TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('workspace_invalid');
    const eventTypes = extractEventTypes(mocks._eventEmitter.emitTelemetry);
    // Only lease event before context build fails (permanent error path skips context_built, run_started)
    expect(eventTypes).toEqual([
      'diagnostician_task_leased',
      'diagnostician_run_failed',
      'diagnostician_task_failed',
    ]);
    // Verify the task_failed event has workspace_invalid
    const {calls} = mocks._eventEmitter.emitTelemetry.mock;
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    const lastEvent = (lastCall as unknown[])[0] as { eventType: string; payload: { errorCategory: string } };
    expect(lastEvent.payload.errorCategory).toBe('workspace_invalid');
  });
});
