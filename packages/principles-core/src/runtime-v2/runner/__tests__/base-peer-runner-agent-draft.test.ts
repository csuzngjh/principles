/**
 * Task 12: BasePeerRunner permanent-failure agentDraft injection tests.
 *
 * Verifies that when a peer runner reaches a permanent-failure terminal
 * state (permanentErrorCategories hit in retryOrFail), it constructs an
 * AgentDraftPayload from the failure context and writes it to
 * pending_agent_drafts via the injected PendingAgentDraftStore. The write
 * is best-effort: failures are observed via telemetry (rc-9) but never
 * propagate, so the markFailed terminal-state contract is preserved.
 *
 * Scenarios covered (per Task 12 spec):
 *   1. permanent error → pending_agent_drafts table contains exactly one row
 *   2. permanent error → agentDraft.summary contains taskKind + errorCategory
 *   3. permanent error → agentDraft.observedFailure contains redacted error message
 *   4. permanent error → agentDraft.observedFailure does NOT contain raw paths
 *      (constructs an error containing `D:\Code\principles\secret`, asserts redacted)
 *   5. retry-able error (non-permanent) → insertPendingDraft NOT called
 *   6. repeated permanent failure on same taskId → idempotent (no duplicate row,
 *      but agentDraft is updated)
 *   7. pendingAgentDraftStore not injected → no throw, markFailed completes normally
 *   8. insertPendingDraft throws → does not break markFailed flow
 *
 * ERR entries considered:
 *   - EP-01 / ERR-001, ERR-005, ERR-013: diagnosticJson parsed as unknown,
 *     narrowed with typeof + Object.hasOwn. No `as` casts in production code
 *     under test; tests use `as` only for mock construction (mocks are
 *     trusted fixtures, not untrusted runtime data).
 *   - EP-03 / ERR-002: agentDraft injection failure emits telemetry with
 *     reason + nextAction (rc-9-no-silent-fallback).
 *   - EP-03 / ERR-074, ERR-089: every branch (store missing, insert !ok,
 *     insert throws) applies the SAME best-effort contract.
 *   - EP-05 / ERR-015: painId extracted fresh from ctx.task.diagnosticJson
 *     on each call, not cached.
 *   - EP-08 / ERR-003, ERR-024: redactAbsolutePaths / redactTokenLikeValues /
 *     redactEnvLikeValues applied to observedFailure BEFORE persist.
 *
 * @see packages/principles-core/src/runtime-v2/runner/base-peer-runner.ts (retryOrFail, injectAgentDraftOnPermanentFailure)
 * @see packages/principles-core/src/runtime-v2/feedback/pending-agent-draft-store.ts
 * @see packages/principles-core/src/runtime-v2/feedback/redact-sensitive.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { BasePeerRunner } from '../base-peer-runner.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { PIArtifactStore } from '../../internalization/pi-artifact.js';
import type { TaskRecord } from '../../task-status.js';
import type { PDErrorCategory } from '../../error-categories.js';
import type {
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
  FailureContext,
} from '../peer-runner-types.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { PendingAgentDraftStore } from '../../feedback/pending-agent-draft-store.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

interface TestContext {
  contextHash: string;
}

interface TestOutput {
  data: string;
}

const TASK_ID = 'task-agent-draft-001';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    taskKind: 'dreamer',
    status: 'leased',
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestConnection(): SqliteConnection {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-agent-draft-'));
  return new SqliteConnection(tmpDir);
}

/**
 * Test runner that exposes retryOrFail for direct testing.
 * permanentErrorCategories includes 'input_invalid' and 'storage_unavailable'
 * (both treated as permanent — never retried).
 */
class AgentDraftTestRunner extends BasePeerRunner<TestContext, TestOutput> {
  constructor(deps: PeerRunnerDeps) {
    super(
      deps,
      { owner: 'test', runtimeKind: 'test-double' },
      {
        runnerName: 'test',
        expectedTaskKind: 'dreamer',
        defaultAgentId: 'test',
        resultRefPrefix: 'test',
      },
    );
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set([
      'storage_unavailable',
      'workspace_invalid',
      'capability_missing',
      'cancelled',
      'input_invalid',
      'output_invalid',
    ]);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async buildContext(): Promise<TestContext> {
    return { contextHash: 'test-hash' };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async invokeRuntime(): Promise<RunHandle> {
    return { runId: 'run-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validateOutput(): Promise<PeerRunnerValidationResult> {
    return { valid: true, errors: [] };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/max-params
  async succeedTask(taskId: string, runId: string, _output: TestOutput, task: TaskRecord): Promise<PeerRunnerResult<TestOutput>> {
    return { status: 'succeeded', taskId, runId, attemptCount: task.attemptCount };
  }

  /** Expose protected retryOrFail for direct testing. */
  async callRetryOrFail(ctx: FailureContext): Promise<PeerRunnerResult<TestOutput>> {
    return this.retryOrFail(ctx);
  }
}

function createMockDeps(overrides?: Partial<PeerRunnerDeps>): PeerRunnerDeps {
  return {
    stateManager: {
      getRetryPolicy: vi.fn().mockReturnValue({
        // Default: do NOT retry — so non-permanent errors flow to
        // max_attempts_exceeded rather than retry_wait. Tests that need
        // retry_wait override shouldRetry to true.
        shouldRetry: vi.fn().mockReturnValue(false),
      }),
      markTaskFailed: vi.fn().mockResolvedValue({}),
      markTaskRetryWait: vi.fn().mockResolvedValue({}),
      markTaskSucceeded: vi.fn().mockResolvedValue({}),
      updateRunOutput: vi.fn().mockResolvedValue({}),
    } as unknown as RuntimeStateManager,
    runtimeAdapter: {} as unknown as PDRuntimeAdapter,
    eventEmitter: {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter,
    artifactStore: {} as unknown as PIArtifactStore,
    ...overrides,
  };
}

// Telemetry call arg narrowing (mirrors rate-limit-degradation test pattern)
type TelemetryCallsArg = { eventType: string; payload?: Record<string, unknown> };
function telemetryCalls(mock: ReturnType<typeof vi.fn>): TelemetryCallsArg[] {
  return (mock.mock.calls as unknown[][]).map((call) => call[0] as TelemetryCallsArg);
}

/**
 * Narrow `T | null` to `T` after a preceding `expect(x).not.toBeNull()`.
 * Replaces `x!.prop` (forbidden by @typescript-eslint/no-non-null-assertion)
 * with type-safe access. The throw branch is unreachable after the expect,
 * but TypeScript needs it for control-flow narrowing.
 */
function unwrap<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('unwrap: value is null/undefined');
  }
  return value;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Task 12: BasePeerRunner permanent-failure agentDraft injection', () => {
  let connection = null as unknown as SqliteConnection;
  let store = null as unknown as PendingAgentDraftStore;
  let mockDeps: PeerRunnerDeps;
  let runner: AgentDraftTestRunner;
  let task: TaskRecord;

  beforeEach(() => {
    connection = createTestConnection();
    // Touch getDb() so initSchema() runs (creates pending_agent_drafts table).
    connection.getDb();
    store = new PendingAgentDraftStore(connection);
    mockDeps = createMockDeps({ pendingAgentDraftStore: store });
    runner = new AgentDraftTestRunner(mockDeps);
    task = makeTask();
  });

  afterEach(() => {
    connection?.close();
  });

  it('permanent error → pending_agent_drafts table contains exactly one row', async () => {
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: 'Task input was malformed',
    };

    const result = await runner.callRetryOrFail(ctx);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');

    // The store should have exactly one unconsumed row for this taskId.
    const row = store.getUnconsumedByTaskId(TASK_ID);
    expect(row).not.toBeNull();
    expect(unwrap(row).taskId).toBe(TASK_ID);

    // And exactly one row total in the table.
    const allRows = store.listPending();
    expect(allRows).toHaveLength(1);
  });

  it('permanent error → agentDraft.summary contains taskKind + errorCategory', async () => {
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: 'malformed input',
    };

    await runner.callRetryOrFail(ctx);

    const row = store.getUnconsumedByTaskId(TASK_ID);
    expect(row).not.toBeNull();
    // summary format: `${taskKind} failed with category=${errorCategory} at ${isoTimestamp}`
    expect(unwrap(row).agentDraft.summary).toContain('dreamer');
    expect(unwrap(row).agentDraft.summary).toContain('input_invalid');
    expect(unwrap(row).agentDraft.summary).toMatch(/\bfailed with category=/);
    // ISO timestamp at the end
    expect(unwrap(row).agentDraft.summary).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('permanent error → agentDraft.observedFailure contains redacted error message', async () => {
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: 'Task input was malformed: missing required field "principleId"',
    };

    await runner.callRetryOrFail(ctx);

    const row = store.getUnconsumedByTaskId(TASK_ID);
    expect(row).not.toBeNull();
    expect(unwrap(row).agentDraft.observedFailure).toBeDefined();
    // The error message text is preserved (it contains no paths/tokens/env, so redaction is a no-op).
    expect(unwrap(row).agentDraft.observedFailure).toContain('Task input was malformed');
    expect(unwrap(row).agentDraft.observedFailure).toContain('principleId');
  });

  it('permanent error → agentDraft.observedFailure does NOT contain raw absolute paths (redacted)', async () => {
    // Construct a failure reason containing a Windows absolute path that
    // redactAbsolutePaths MUST scrub. If redaction is skipped, this test
    // fails — proving the redactor is wired into the injection path.
    //
    // Note: we deliberately avoid key-like tokens (e.g. "secret:") in the
    // path suffix because redactTokenLikeValues' KEY_ASSIGN regex would
    // also redact them — that would conflate two redactors. We want this
    // test to isolate path redaction. Use a plain filename suffix.
    const secretPath = 'D:\\Code\\principles\\secret\\config.json';
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: `Failed to read config from ${secretPath} - file not found`,
    };

    await runner.callRetryOrFail(ctx);

    const row = store.getUnconsumedByTaskId(TASK_ID);
    expect(row).not.toBeNull();
    expect(unwrap(row).agentDraft.observedFailure).toBeDefined();
    // The raw path MUST NOT appear verbatim in the persisted draft.
    expect(unwrap(row).agentDraft.observedFailure).not.toContain(secretPath);
    expect(unwrap(row).agentDraft.observedFailure).not.toContain('D:\\Code');
    // The redacted marker SHOULD appear instead.
    expect(unwrap(row).agentDraft.observedFailure).toContain('<redacted-path>');
    // Non-path content is preserved.
    expect(unwrap(row).agentDraft.observedFailure).toContain('Failed to read config from');
    expect(unwrap(row).agentDraft.observedFailure).toContain('file not found');
  });

  it('retry-able error (non-permanent) → insertPendingDraft NOT called, no row in table', async () => {
    // Override the retry policy to return TRUE (shouldRetry) so the error
    // flows to markTaskRetryWait instead of markTaskFailed. The agentDraft
    // injection must NOT fire on the retry_wait path.
    (mockDeps.stateManager.getRetryPolicy as ReturnType<typeof vi.fn>).mockReturnValue({
      shouldRetry: vi.fn().mockReturnValue(true),
    });

    // 'execution_failed' is NOT in permanentErrorCategories for this runner.
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'execution_failed',
      failureReason: 'transient network error',
    };

    const result = await runner.callRetryOrFail(ctx);

    // Should be retried, not failed.
    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('execution_failed');
    expect(mockDeps.stateManager.markTaskRetryWait).toHaveBeenCalled();

    // NO row should exist in pending_agent_drafts.
    const row = store.getUnconsumedByTaskId(TASK_ID);
    expect(row).toBeNull();

    // NO agent_draft_inserted telemetry event.
    const calls = telemetryCalls(mockDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    expect(calls.find((c) => c.eventType === 'test_agent_draft_inserted')).toBeUndefined();
    expect(calls.find((c) => c.eventType === 'test_agent_draft_insert_failed')).toBeUndefined();
  });

  it('repeated permanent failure on same taskId → idempotent (no duplicate row, agentDraft updated)', async () => {
    // First permanent failure.
    const ctx1: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: 'first failure reason text',
    };
    const result1 = await runner.callRetryOrFail(ctx1);
    expect(result1.status).toBe('failed');

    // Verify one row exists. summary does NOT carry the failure reason
    // (only taskKind + errorCategory + timestamp); the reason lives in
    // observedFailure.
    const row1 = store.getUnconsumedByTaskId(TASK_ID);
    expect(row1).not.toBeNull();
    expect(unwrap(row1).agentDraft.summary).toContain('input_invalid');
    expect(unwrap(row1).agentDraft.observedFailure).toContain('first failure reason text');
    const firstId = unwrap(row1).id;

    // Second permanent failure on the SAME taskId (e.g., task was re-leased
    // after manual recovery and failed again with a different reason).
    const ctx2: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'output_invalid',
      failureReason: 'second failure with different reason',
    };
    const result2 = await runner.callRetryOrFail(ctx2);
    expect(result2.status).toBe('failed');

    // Still exactly one unconsumed row (idempotent UPDATE, not INSERT).
    const row2 = store.getUnconsumedByTaskId(TASK_ID);
    expect(row2).not.toBeNull();
    expect(unwrap(row2).id).toBe(firstId); // same row id preserved

    // The agentDraft should reflect the LATEST failure (UPDATE overwrote it).
    // summary now carries the new errorCategory (output_invalid, not input_invalid).
    expect(unwrap(row2).agentDraft.summary).toContain('output_invalid');
    expect(unwrap(row2).agentDraft.summary).not.toContain('input_invalid');
    // observedFailure carries the new failure reason, not the old one.
    expect(unwrap(row2).agentDraft.observedFailure).toContain('second failure with different reason');
    expect(unwrap(row2).agentDraft.observedFailure).not.toContain('first failure reason text');

    // Exactly one row total in the table.
    const allRows = store.listPending();
    expect(allRows).toHaveLength(1);
  });

  it('pendingAgentDraftStore not injected → no throw, markFailed completes normally', async () => {
    // Build a runner WITHOUT a pendingAgentDraftStore — simulates legacy
    // callers that have not yet been upgraded to inject the store.
    // createMockDeps() with no overrides does NOT set pendingAgentDraftStore,
    // so the field is undefined on the resulting deps object.
    const depsWithoutStore = createMockDeps();
    const legacyRunner = new AgentDraftTestRunner(depsWithoutStore);

    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: 'permanent failure without draft store',
    };

    // Must NOT throw — backward compatible.
    const result = await legacyRunner.callRetryOrFail(ctx);

    // markTaskFailed still called with the original errorCategory.
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(depsWithoutStore.stateManager.markTaskFailed).toHaveBeenCalledWith(
      TASK_ID,
      'input_invalid',
      'permanent failure without draft store',
    );

    // NO agent_draft telemetry events (store was not injected).
    const calls = telemetryCalls(depsWithoutStore.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    expect(calls.find((c) => c.eventType === 'test_agent_draft_inserted')).toBeUndefined();
    expect(calls.find((c) => c.eventType === 'test_agent_draft_insert_failed')).toBeUndefined();
  });

  it('insertPendingDraft throws → does not break markFailed flow; telemetry emitted (rc-9)', async () => {
    // Construct a store mock that throws synchronously when insertPendingDraft
    // is called. This simulates a misbehaving store implementation.
    const throwingStore = {
      insertPendingDraft: vi.fn().mockImplementation(() => {
        throw new Error('simulated store corruption');
      }),
    } as unknown as PendingAgentDraftStore;

    const depsWithThrowingStore = createMockDeps({ pendingAgentDraftStore: throwingStore });
    const runnerWithThrowingStore = new AgentDraftTestRunner(depsWithThrowingStore);

    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: 'permanent failure with throwing store',
    };

    // Must NOT throw — the markFailed contract is preserved even when the
    // draft store throws unexpectedly.
    const result = await runnerWithThrowingStore.callRetryOrFail(ctx);

    // markTaskFailed still called and result is the expected failed status.
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(depsWithThrowingStore.stateManager.markTaskFailed).toHaveBeenCalled();

    // rc-9: telemetry event MUST be emitted with the error reason + nextAction
    // (never silent).
    const calls = telemetryCalls(depsWithThrowingStore.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    const failedEvent = calls.find((c) => c.eventType === 'test_agent_draft_insert_failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.payload?.errorMessage).toContain('simulated store corruption');
    expect(failedEvent?.payload).toHaveProperty('nextAction');
    expect(typeof failedEvent?.payload?.nextAction).toBe('string');
  });
});

// ── Supplemental: painId linkage from diagnosticJson (rc-1, rc-5, rc-7) ──────

describe('Task 12: agentDraft painId linkage from diagnosticJson', () => {
  let connection = null as unknown as SqliteConnection;
  let store = null as unknown as PendingAgentDraftStore;
  let mockDeps: PeerRunnerDeps;
  let runner: AgentDraftTestRunner;

  beforeEach(() => {
    connection = createTestConnection();
    connection.getDb();
    store = new PendingAgentDraftStore(connection);
    mockDeps = createMockDeps({ pendingAgentDraftStore: store });
    runner = new AgentDraftTestRunner(mockDeps);
  });

  afterEach(() => {
    connection?.close();
  });

  it('diagnosticJson with sourcePainId → painId linked in pending_agent_drafts', async () => {
    const task = makeTask({
      diagnosticJson: JSON.stringify({ sourcePainId: 'pain-from-diag-001', other: 'metadata' }),
    });
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: 'failure with pain linkage',
    };

    await runner.callRetryOrFail(ctx);

    const row = store.getUnconsumedByTaskId(TASK_ID);
    expect(row).not.toBeNull();
    expect(unwrap(row).painId).toBe('pain-from-diag-001');

    // agent_draft_inserted telemetry should report painIdLinked: true.
    const calls = telemetryCalls(mockDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    const inserted = calls.find((c) => c.eventType === 'test_agent_draft_inserted');
    expect(inserted).toBeDefined();
    expect(inserted?.payload?.painIdLinked).toBe(true);
  });

  it('diagnosticJson without sourcePainId → painId is null in pending_agent_drafts', async () => {
    const task = makeTask({
      diagnosticJson: JSON.stringify({ unrelated: 'field' }),
    });
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: 'failure without pain linkage',
    };

    await runner.callRetryOrFail(ctx);

    const row = store.getUnconsumedByTaskId(TASK_ID);
    expect(row).not.toBeNull();
    expect(unwrap(row).painId).toBeNull();

    const calls = telemetryCalls(mockDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    const inserted = calls.find((c) => c.eventType === 'test_agent_draft_inserted');
    expect(inserted).toBeDefined();
    expect(inserted?.payload?.painIdLinked).toBe(false);
  });

  it('diagnosticJson undefined → painId is null (graceful, no throw)', async () => {
    const task = makeTask(); // no diagnosticJson field
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: 'failure with undefined diagnosticJson',
    };

    await runner.callRetryOrFail(ctx);

    const row = store.getUnconsumedByTaskId(TASK_ID);
    expect(row).not.toBeNull();
    expect(unwrap(row).painId).toBeNull();
  });

  it('diagnosticJson is malformed JSON → painId is null (rc-9 graceful degradation, no throw)', async () => {
    const task = makeTask({
      diagnosticJson: '{not valid json',
    });
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'input_invalid',
      failureReason: 'failure with corrupt diagnosticJson',
    };

    // Must NOT throw — corrupt JSON yields null painId, not an exception.
    const result = await runner.callRetryOrFail(ctx);

    expect(result.status).toBe('failed');
    const row = store.getUnconsumedByTaskId(TASK_ID);
    expect(row).not.toBeNull();
    expect(unwrap(row).painId).toBeNull();
  });
});
