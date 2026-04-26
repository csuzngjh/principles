/**
 * max_attempts_exceeded integration tests.
 *
 * Verifies DiagnosticianRunner correctly handles max attempts enforcement:
 *   1. Task fails with max_attempts_exceeded when RetryPolicy.shouldRetry returns false
 *   2. attemptCount correctly reflects total attempts at the boundary
 *   3. Subsequent acquireLease calls are rejected after max_attempts_exceeded
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
import type { DiagnosticianCommitter } from '../../store/diagnostician-committer.js';
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
import { PDRuntimeError } from '../../error-categories.js';

/* eslint-disable @typescript-eslint/no-non-null-assertion */

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

interface DiagnosticFields {
  reasonSummary?: string;
  sourcePainId?: string;
  severity?: string;
  source?: string;
}

interface TaskCreationOptions {
  taskId: string;
  workspaceDir: string;
  diagnostic?: DiagnosticFields;
  overrides?: Partial<Omit<TaskRecord, 'createdAt' | 'updatedAt'>>;
}

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

// -- FailingValidator --

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

// -- StubRuntimeAdapter --

/* eslint-disable @typescript-eslint/class-methods-use-this */
class StubRuntimeAdapter implements PDRuntimeAdapter {
  private nextOutput: Record<string, unknown> | null = null;
  private nextStatus: RunStatus['status'] = 'succeeded';

  constructor(private readonly kindValue: RuntimeKind = 'test-double') {}

  setOutput(output: Record<string, unknown> | null): void {
    this.nextOutput = output;
  }

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

  async cancelRun(_runId: string): Promise<void> { /* no-op */ }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    if (this.nextOutput === null) return null;
    return { runId, payload: this.nextOutput };
  }

  async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> {
    return [];
  }
}
/* eslint-enable @typescript-eslint/class-methods-use-this */

// -- Integration test setup --

const TMP_ROOT = path.join(os.tmpdir(), `pd-m4-04-max-attempts-${process.pid}`);

describe('max_attempts_exceeded integration', () => {
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

    const sqliteConn = (stateManager as unknown as { connection: unknown }).connection;
    historyQuery = new SqliteHistoryQuery(sqliteConn as never);

    const { taskStore } = (stateManager as unknown as { taskStore: unknown });
    const { runStore } = (stateManager as unknown as { runStore: unknown });
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

  function createRunner(validator: DiagnosticianValidator = new PassThroughValidator(),
    committer: DiagnosticianCommitter = { commit: async () => ({ commitId: "mock-commit-id", artifactId: "mock-artifact-id", candidateCount: 0 }) }): DiagnosticianRunner {
    return new DiagnosticianRunner(
      {
        stateManager,
        contextAssembler,
        runtimeAdapter,
        eventEmitter,
        validator,
      committer,
      },
      {
        owner: 'integration-test-runner',
        runtimeKind: 'test-double',
        pollIntervalMs: 50,
        timeoutMs: 2000,
      },
    );
  }

  it('transitions to max_attempts_exceeded when attemptCount reaches maxAttempts', async () => {
    const taskId = 'max-attempts-task-001';

    // Create task with maxAttempts=2
    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'max attempts exceeded test' },
        overrides: { maxAttempts: 2 },
      }),
    );

    // First attempt: acquire lease, then fail validation → retry_wait
    const output = makeDiagnosticianOutput(taskId);
    runtimeAdapter.setOutput(output);

    const failingValidator = new FailingValidator('output_invalid', ['Validation failure on attempt 1']);
    const runner = createRunner(failingValidator);

    const result1 = await runner.run(taskId);
    expect(result1.status).toBe('retried');
    expect(result1.attemptCount).toBe(1);

    let task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('retry_wait');
    expect(task!.attemptCount).toBe(1);

    // Second attempt: runner re-acquires lease (attemptCount becomes 2), fails validation again
    // shouldRetry returns false because attemptCount (2) >= maxAttempts (2)
    const runner2 = createRunner(failingValidator);
    const result2 = await runner2.run(taskId);
    expect(result2.status).toBe('failed');
    expect(result2.errorCategory).toBe('max_attempts_exceeded');

    task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('failed');
    expect(task!.lastError).toBe('max_attempts_exceeded');
  });

  it('rejects subsequent acquireLease after max_attempts_exceeded', async () => {
    const taskId = 'max-attempts-task-002';

    // Create task with maxAttempts=1 — single attempt then done
    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'single attempt max test' },
        overrides: { maxAttempts: 1 },
      }),
    );

    // First attempt: acquire + fail validation
    runtimeAdapter.setOutput(makeDiagnosticianOutput(taskId));
    const runner = createRunner(new FailingValidator('output_invalid', ['Always fails']));
    const result = await runner.run(taskId);

    // With maxAttempts=1, shouldRetry returns false immediately → max_attempts_exceeded
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');

    const task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('failed');

    // Subsequent acquireLease should throw lease_conflict (task is 'failed', not 'pending'/'retry_wait')
    await expect(
      stateManager.acquireLease({ taskId, owner: 'late-runner', runtimeKind: 'test-double' }),
    ).rejects.toThrow();

    try {
      await stateManager.acquireLease({ taskId, owner: 'late-runner', runtimeKind: 'test-double' });
    } catch (err) {
      expect(err).toBeInstanceOf(PDRuntimeError);
      expect((err as PDRuntimeError).category).toBe('lease_conflict');
    }
  });

  it('tracks correct attemptCount at boundary with manual state transitions', async () => {
    const taskId = 'max-attempts-task-003';

    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'boundary attemptCount test' },
        overrides: { maxAttempts: 2 },
      }),
    );

    // Manual cycle 1: acquire → retry_wait
    await stateManager.acquireLease({ taskId, owner: 'runner-1', runtimeKind: 'test-double' });
    let task = await stateManager.getTask(taskId);
    expect(task!.attemptCount).toBe(1);

    await stateManager.markTaskRetryWait(taskId, 'execution_failed');
    task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('retry_wait');
    expect(task!.attemptCount).toBe(1);

    // Manual cycle 2: acquire → attemptCount becomes 2
    await stateManager.acquireLease({ taskId, owner: 'runner-2', runtimeKind: 'test-double' });
    task = await stateManager.getTask(taskId);
    expect(task!.attemptCount).toBe(2);

    // Mark retry_wait — shouldRetry returns false (2 >= 2)
    // The runner's retryOrFail would call markTaskFailed, but we test at stateManager level
    await stateManager.markTaskRetryWait(taskId, 'execution_failed');
    task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('retry_wait');
    expect(task!.attemptCount).toBe(2);

    // Verify RetryPolicy correctly reports shouldRetry = false
    const shouldRetry = stateManager.getRetryPolicy().shouldRetry(task!);
    expect(shouldRetry).toBe(false);

    // Verify 2 run records exist
    const runs = await stateManager.getRunsByTask(taskId);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.attemptNumber).toBe(1);
    expect(runs[1]!.attemptNumber).toBe(2);
  });
});
