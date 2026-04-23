/**
 * retry_wait recovery integration tests.
 *
 * Verifies DiagnosticianRunner correctly handles retry_wait → leased recovery:
 *   1. Task in retry_wait can be re-acquired via acquireLease
 *   2. attemptCount increments correctly on each lease acquisition
 *   3. Multiple RunRecords are created (one per lease cycle)
 *   4. Runner can complete the task after recovery
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
import type { DiagnosticianValidator } from '../diagnostician-validator.js';
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

const TMP_ROOT = path.join(os.tmpdir(), `pd-m4-04-retry-wait-${process.pid}`);

describe('retry_wait recovery integration', () => {
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

  it('re-acquires task in retry_wait state and increments attemptCount', async () => {
    const taskId = 'retry-wait-task-001';

    // Create diagnostician task with maxAttempts=3
    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'retry_wait recovery test' },
        overrides: { maxAttempts: 3 },
      }),
    );

    // First acquireLease — attemptCount becomes 1 (first run created)
    await stateManager.acquireLease({
      taskId,
      owner: 'first-runner',
      runtimeKind: 'test-double',
    });

    let task = await stateManager.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('leased');
    expect(task!.attemptCount).toBe(1);

    // Mark task as retry_wait (simulates first attempt failure)
    await stateManager.markTaskRetryWait(taskId, 'execution_failed');

    task = await stateManager.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('retry_wait');
    expect(task!.attemptCount).toBe(1);

    // Second acquireLease — task in retry_wait should be re-acquirable
    await stateManager.acquireLease({
      taskId,
      owner: 'second-runner',
      runtimeKind: 'test-double',
    });

    task = await stateManager.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('leased');
    expect(task!.attemptCount).toBe(2);

    // Verify 2 RunRecords exist (one per lease acquisition)
    const runs = await stateManager.getRunsByTask(taskId);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.attemptNumber).toBe(1);
    expect(runs[1]!.attemptNumber).toBe(2);
  });

  it('runner completes task after retry_wait recovery', async () => {
    const taskId = 'retry-wait-task-002';

    // Create task
    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'runner recovery test' },
        overrides: { maxAttempts: 3 },
      }),
    );

    // First attempt: acquire → fail → retry_wait
    await stateManager.acquireLease({
      taskId,
      owner: 'first-runner',
      runtimeKind: 'test-double',
    });
    await stateManager.markTaskRetryWait(taskId, 'execution_failed');

    // Set up adapter for successful run on second attempt
    const output = makeDiagnosticianOutput(taskId);
    runtimeAdapter.setOutput(output);

    // Runner should re-acquire (retry_wait → leased) and complete successfully
    const runner = createRunner();
    const result = await runner.run(taskId);

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(taskId);

    // Verify final task state
    const task = await stateManager.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('succeeded');

    // Verify total runs: 1 (first failed attempt) + 1 (second attempt created by runner) = 2
    const runs = await stateManager.getRunsByTask(taskId);
    expect(runs).toHaveLength(2);
  });

  it('supports multiple retry_wait cycles with correct attemptCount tracking', async () => {
    const taskId = 'retry-wait-task-003';

    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'multi-cycle recovery test' },
        overrides: { maxAttempts: 5 },
      }),
    );

    // Cycle 1: acquire → retry_wait
    await stateManager.acquireLease({ taskId, owner: 'runner-1', runtimeKind: 'test-double' });
    await stateManager.markTaskRetryWait(taskId, 'execution_failed');

    let task = await stateManager.getTask(taskId);
    expect(task!.attemptCount).toBe(1);
    expect(task!.status).toBe('retry_wait');

    // Cycle 2: re-acquire → retry_wait
    await stateManager.acquireLease({ taskId, owner: 'runner-2', runtimeKind: 'test-double' });
    await stateManager.markTaskRetryWait(taskId, 'execution_failed');

    task = await stateManager.getTask(taskId);
    expect(task!.attemptCount).toBe(2);
    expect(task!.status).toBe('retry_wait');

    // Cycle 3: re-acquire → succeed
    const output = makeDiagnosticianOutput(taskId);
    runtimeAdapter.setOutput(output);

    const runner = createRunner();
    const result = await runner.run(taskId);

    expect(result.status).toBe('succeeded');

    task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('succeeded');

    // Total runs: 2 (cycles 1+2) + 1 (runner in cycle 3) = 3
    const runs = await stateManager.getRunsByTask(taskId);
    expect(runs).toHaveLength(3);
  });
});
