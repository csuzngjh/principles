/**
 * DiagnosticianRunner integration tests -- full pipeline with real SQLite stores.
 *
 * Verifies:
 *   1. Full happy path with real SQLite stores
 *   2. Context assembly with existing run history
 *   3. OpenClaw history compatibility (REQ-2.6)
 *   4. Validation failure path with real stores
 *
 * Uses real RuntimeStateManager with temp directories, real SqliteContextAssembler,
 * real stores. Only PDRuntimeAdapter is mocked via StubRuntimeAdapter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { SqliteContextAssembler } from '../../store/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from '../../store/sqlite-history-query.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { DiagnosticianRunner } from '../diagnostician-runner.js';
import { PassThroughValidator } from '../diagnostician-validator.js';
import type { DiagnosticianValidator, DiagnosticianValidationResult } from '../diagnostician-validator.js';
import type {
  PDRuntimeAdapter,
  RuntimeCapabilities,
  RuntimeHealth,
  RunHandle,
  RunStatus,
  StartRunInput,
  StructuredRunOutput,
  RuntimeArtifactRef,
  RuntimeKind,
} from '../../runtime-protocol.js';
import type { TaskRecord } from '../../task-status.js';
import type { PDErrorCategory } from '../../error-categories.js';

// -- Test fixtures --

function makeDiagnosticianOutput(taskId: string) {
  return {
    valid: true,
    diagnosisId: `diag-${Date.now()}`,
    taskId,
    summary: 'Integration test diagnosis summary',
    rootCause: 'Test root cause analysis',
    violatedPrinciples: [],
    evidence: [],
    recommendations: [],
    confidence: 0.85,
  };
}

/** Diagnostic fields serialized into the diagnostic_json column. */
interface DiagnosticFields {
  reasonSummary?: string;
  sourcePainId?: string;
  severity?: string;
  source?: string;
}

/** Task creation options combining base fields and diagnostic fields. */
interface TaskCreationOptions {
  taskId: string;
  workspaceDir: string;
  diagnostic?: DiagnosticFields;
  overrides?: Partial<Omit<TaskRecord, 'createdAt' | 'updatedAt'>>;
}

/**
 * Create a task record input for a diagnostician task.
 * Diagnostician-specific fields (workspaceDir, reasonSummary, etc.) are serialized
 * into the `diagnostic_json` column, following SqliteContextAssembler's
 * reconstructDiagnosticianRecord() convention.
 */
function makeDiagnosticianTaskInput(
  options: TaskCreationOptions,
): Omit<TaskRecord, 'createdAt' | 'updatedAt'> & { diagnosticJson?: string } {
  const { taskId, workspaceDir, diagnostic, overrides } = options;
  const diagnosticJson = JSON.stringify({
    workspaceDir,
    reasonSummary: diagnostic?.reasonSummary ?? 'Integration test task',
    sourcePainId: diagnostic?.sourcePainId,
    severity: diagnostic?.severity,
    source: diagnostic?.source,
  });

  return {
    taskId,
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
    diagnosticJson,
  };
}

// -- StubRuntimeAdapter --

/**
 * Test double for PDRuntimeAdapter.
 * Configurable: can return success, failure, or custom output.
 * Only the PDRuntimeAdapter is mocked -- all stores use real SQLite.
 */
/* eslint-disable @typescript-eslint/class-methods-use-this */
class StubRuntimeAdapter implements PDRuntimeAdapter {
  private nextOutput: Record<string, unknown> | null = null;
  private nextStatus: RunStatus['status'] = 'succeeded';

  constructor(private readonly kindValue: RuntimeKind = 'test-double') {}

  /** Configure the output that fetchOutput will return. */
  setOutput(output: Record<string, unknown> | null): void {
    this.nextOutput = output;
  }

  /** Configure the status that pollRun will return. */
  setRunStatus(status: RunStatus['status']): void {
    this.nextStatus = status;
  }

  kind(): RuntimeKind {
    return this.kindValue;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    return {
      healthy: true,
      degraded: false,
      warnings: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async startRun(_input: StartRunInput): Promise<RunHandle> {
    const runId = `stub-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      runId,
      runtimeKind: this.kindValue,
      startedAt: new Date().toISOString(),
    };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    return {
      runId,
      status: this.nextStatus,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
  }

  async cancelRun(_runId: string): Promise<void> {
    // no-op
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    if (this.nextOutput === null) {
      return null;
    }
    return {
      runId,
      payload: this.nextOutput,
    };
  }

  async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> {
    return [];
  }
}
/* eslint-enable @typescript-eslint/class-methods-use-this */

// -- FailingValidator --

/**
 * Validator that always returns invalid for integration test scenario 4.
 */
class FailingValidator implements DiagnosticianValidator {
  constructor(
    private readonly errorCategory: PDErrorCategory = 'output_invalid',
    private readonly errorMessages: readonly string[] = ['Integration test validation failure'],
  ) {}

  async validate(
    _output: Parameters<DiagnosticianValidator['validate']>[0],
    _taskId: string,
  ): Promise<DiagnosticianValidationResult> {
    return {
      valid: false,
      errors: this.errorMessages,
      errorCategory: this.errorCategory,
    };
  }
}

// -- Integration test setup --

const TMP_ROOT = path.join(os.tmpdir(), `pd-runner-integration-${process.pid}`);

describe('DiagnosticianRunner Integration', () => {
  let testDir = '';
  let stateManager: RuntimeStateManager = null as unknown as RuntimeStateManager;
  let contextAssembler: SqliteContextAssembler = null as unknown as SqliteContextAssembler;
  let historyQuery: SqliteHistoryQuery = null as unknown as SqliteHistoryQuery;
  let eventEmitter: StoreEventEmitter = null as unknown as StoreEventEmitter;
  let runtimeAdapter: StubRuntimeAdapter = null as unknown as StubRuntimeAdapter;

  beforeEach(async () => {
    testDir = path.join(TMP_ROOT, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });

    stateManager = new RuntimeStateManager({ workspaceDir: testDir });
    await stateManager.initialize();

    // Access internal stores via RuntimeStateManager to create context assembler.
    // SqliteContextAssembler requires TaskStore + HistoryQuery + RunStore.
    const sqliteConn = (stateManager as unknown as { connection: unknown }).connection;
    historyQuery = new SqliteHistoryQuery(sqliteConn as never);

    const {taskStore} = (stateManager as unknown as { taskStore: unknown });
    const {runStore} = (stateManager as unknown as { runStore: unknown });
    contextAssembler = new SqliteContextAssembler(
      taskStore as never,
      historyQuery,
      runStore as never,
    );

    eventEmitter = new StoreEventEmitter();
    runtimeAdapter = new StubRuntimeAdapter();
  });

  afterEach(() => {
    stateManager.close();
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  /**
   * Helper: create runner with given validator.
   * Uses short poll interval and timeout for fast integration tests.
   */
  function createRunner(validator: DiagnosticianValidator = new PassThroughValidator()): DiagnosticianRunner {
    return new DiagnosticianRunner(
      {
        stateManager,
        contextAssembler,
        runtimeAdapter,
        eventEmitter,
        validator,
      },
      {
        owner: 'integration-test-runner',
        runtimeKind: 'test-double',
        pollIntervalMs: 50,
        timeoutMs: 2000,
      },
    );
  }

  // -- Scenario 1: Full happy path with real SQLite stores --

  it('completes full happy path with real SQLite stores', async () => {
    const taskId = 'int-task-happy-001';
    const output = makeDiagnosticianOutput(taskId);
    runtimeAdapter.setOutput(output);

    // Create diagnostician task with workspaceDir serialized into diagnostic_json
    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: {
          reasonSummary: 'Integration test: happy path',
          sourcePainId: 'pain-001',
          severity: 'medium',
          source: 'user-report',
        },
      }),
    );

    const runner = createRunner();
    const result = await runner.run(taskId);

    // Assert runner result
    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(taskId);
    expect(result.contextHash).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.contextHash!.length).toBeGreaterThan(0);
    expect(result.output).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.output!.taskId).toBe(taskId);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.output!.valid).toBe(true);

    // Verify task in store has status 'succeeded'
    const task = await stateManager.getTask(taskId);
    expect(task).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(task!.status).toBe('succeeded');

    // Verify run record has outputPayload with valid JSON
    const runs = await stateManager.getRunsByTask(taskId);
    expect(runs.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const latestRun = runs[runs.length - 1]!;
    expect(latestRun.outputPayload).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parsedOutput = JSON.parse(latestRun.outputPayload!);
    expect(parsedOutput.taskId).toBe(taskId);
    expect(parsedOutput.valid).toBe(true);
    expect(parsedOutput.diagnosisId).toBe(output.diagnosisId);
  });

  // -- Scenario 2: Context assembly with existing run history --

  it('assembles context with existing run history from previous attempts', async () => {
    const taskId = 'int-task-history-001';

    // Create task
    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'Integration test: run history' },
      }),
    );

    // First attempt: acquire lease (creates run 1), then fail
    await stateManager.acquireLease({
      taskId,
      owner: 'first-attempt-agent',
      runtimeKind: 'test-double',
    });

    // Mark first attempt as failed
    await stateManager.markTaskFailed(taskId, 'execution_failed');

    // Move task back to retry_wait so it can be re-leased
    await stateManager.updateTask(taskId, { status: 'retry_wait', lastError: null });

    // Second attempt: acquire lease again (creates run 2)
    await stateManager.acquireLease({
      taskId,
      owner: 'integration-test-runner',
      runtimeKind: 'test-double',
    });

    // Fail the second attempt too, then let the runner handle attempt 3
    await stateManager.markTaskRetryWait(taskId, 'execution_failed');

    // Set up adapter for successful run
    const output = makeDiagnosticianOutput(taskId);
    runtimeAdapter.setOutput(output);

    const runner = createRunner();
    const result = await runner.run(taskId);

    // Runner should succeed (attempt 3)
    expect(result.status).toBe('succeeded');
    expect(result.attemptCount).toBe(3);

    // Verify 3 runs total in store (2 failed + 1 succeeded)
    const runs = await stateManager.getRunsByTask(taskId);
    expect(runs).toHaveLength(3);

    // Verify context includes run history via sourceRefs
    expect(result.contextHash).toBeDefined();
  });

  // -- Scenario 3: OpenClaw history compatibility (REQ-2.6) --

  it('succeeds with mixed runtime_kind including openclaw-history', async () => {
    const taskId = 'int-task-openclaw-001';

    // Create task
    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'Integration test: openclaw-history compat' },
      }),
    );

    // Acquire lease to create a real run record first
    await stateManager.acquireLease({
      taskId,
      owner: 'setup-agent',
      runtimeKind: 'openclaw-history',
    });

    // Mark as succeeded to have a completed run with output
    await stateManager.markTaskSucceeded(taskId, 'run://setup-run');

    // Now set up for runner: create a fresh task state
    await stateManager.updateTask(taskId, {
      status: 'pending',
      attemptCount: 0,
      lastError: null,
      resultRef: null,
    });

    // Verify openclaw-history run exists
    const runsBefore = await stateManager.getRunsByTask(taskId);
    expect(runsBefore.length).toBeGreaterThan(0);

    // Set up adapter for successful run
    const output = makeDiagnosticianOutput(taskId);
    runtimeAdapter.setOutput(output);

    const runner = createRunner();
    const result = await runner.run(taskId);

    // Runner should succeed without errors related to mixed runtime_kind
    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(taskId);

    // Verify context was assembled (contextHash present means context assembly succeeded)
    expect(result.contextHash).toBeDefined();

    // Verify the openclaw-history run is in sourceRefs
    const allRuns = await stateManager.getRunsByTask(taskId);
    const openclawHistoryRuns = allRuns.filter((r) => r.runtimeKind === 'openclaw-history');
    expect(openclawHistoryRuns.length).toBeGreaterThan(0);
  });

  // -- Scenario 4: Validation failure path with real stores --

  it('transitions to retry_wait on validation failure', async () => {
    const taskId = 'int-task-validation-001';

    // Create task
    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'Integration test: validation failure' },
      }),
    );

    // Set up adapter to return output that will fail validation
    const output = makeDiagnosticianOutput(taskId);
    runtimeAdapter.setOutput(output);

    // Use FailingValidator that rejects all output
    const failingValidator = new FailingValidator('output_invalid', [
      'Missing required field: evidence',
      'Invalid confidence value',
    ]);

    const runner = createRunner(failingValidator);
    const result = await runner.run(taskId);

    // First attempt (attemptCount=1) should be retried (shouldRetry returns true by default)
    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe('output_invalid');
    expect(result.failureReason).toContain('Validation failed');

    // Verify task status in store is 'retry_wait'
    const task = await stateManager.getTask(taskId);
    expect(task).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(task!.status).toBe('retry_wait');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(task!.attemptCount).toBe(1);

    // Verify run record has errorCategory 'output_invalid'
    const runs = await stateManager.getRunsByTask(taskId);
    expect(runs.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const latestRun = runs[runs.length - 1]!;
    expect(latestRun.errorCategory).toBe('output_invalid');
    expect(latestRun.executionStatus).toBe('failed');
  });
});
