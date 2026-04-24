/**
 * Lease expiration recovery integration tests.
 *
 * Verifies forceExpire allows another runner to acquire a task whose lease became stale:
 *   1. forceExpire clears the lease and returns task to 'pending'
 *   2. Another runner can acquireLease without lease_conflict
 *   3. Only one runner can hold a lease at any time (lease conflict)
 *   4. The new runner's attempt completes successfully
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

const TMP_ROOT = path.join(os.tmpdir(), `pd-m4-04-lease-expire-${process.pid}`);

describe('lease expiration recovery integration', () => {
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

  it('forceExpire clears stale lease allowing another runner to acquire', async () => {
    const taskId = 'lease-expire-task-001';

    // Create task with maxAttempts=3
    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'lease expiration recovery test' },
        overrides: { maxAttempts: 3 },
      }),
    );

    // Runner A acquires lease (attemptCount 0 → 1)
    await stateManager.acquireLease({
      taskId,
      owner: 'runner-A',
      runtimeKind: 'test-double',
    });

    let task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('leased');
    expect(task!.leaseOwner).toBe('runner-A');
    expect(task!.attemptCount).toBe(1);

    // Force-expire the lease (simulates runner-A crash)
    await stateManager.forceExpireLease(taskId);

    task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('pending');
    expect(task!.leaseOwner).toBeFalsy();
    expect(task!.leaseExpiresAt).toBeFalsy();

    // Runner B acquires the same task — should succeed without lease_conflict
    await stateManager.acquireLease({
      taskId,
      owner: 'runner-B',
      runtimeKind: 'test-double',
    });

    task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('leased');
    expect(task!.leaseOwner).toBe('runner-B');
    expect(task!.attemptCount).toBe(2);

    // Verify 2 run records (one from Runner A, one from Runner B)
    const runs = await stateManager.getRunsByTask(taskId);
    expect(runs).toHaveLength(2);
  });

  it('runner completes task after forceExpire recovery', async () => {
    const taskId = 'lease-expire-task-002';

    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'runner recovery after force expire' },
        overrides: { maxAttempts: 3 },
      }),
    );

    // Runner A acquires lease then crashes
    await stateManager.acquireLease({
      taskId,
      owner: 'runner-A',
      runtimeKind: 'test-double',
    });

    await stateManager.forceExpireLease(taskId);

    // Set up adapter for Runner B's successful attempt
    const output = makeDiagnosticianOutput(taskId);
    runtimeAdapter.setOutput(output);

    // Runner B picks up the task via DiagnosticianRunner.run()
    const runner = createRunner();
    const result = await runner.run(taskId);

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(taskId);

    const task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('succeeded');
  });

  it('prevents concurrent lease holders — lease conflict enforced', async () => {
    const taskId = 'lease-expire-task-003';

    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'concurrent lease conflict test' },
        overrides: { maxAttempts: 3 },
      }),
    );

    // Runner A acquires lease
    await stateManager.acquireLease({
      taskId,
      owner: 'runner-A',
      runtimeKind: 'test-double',
    });

    // Runner B tries to acquire while Runner A holds the lease → lease_conflict
    await expect(
      stateManager.acquireLease({ taskId, owner: 'runner-B', runtimeKind: 'test-double' }),
    ).rejects.toThrow();

    try {
      await stateManager.acquireLease({ taskId, owner: 'runner-B', runtimeKind: 'test-double' });
    } catch (err) {
      expect(err).toBeInstanceOf(PDRuntimeError);
      expect((err as PDRuntimeError).category).toBe('lease_conflict');
    }

    // Verify Runner A still holds the lease
    const task = await stateManager.getTask(taskId);
    expect(task!.status).toBe('leased');
    expect(task!.leaseOwner).toBe('runner-A');
  });
});
