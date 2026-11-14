/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * RuntimeStateManager + BasePeerRunner malformed-run tolerance (PRI-392 follow-up).
 *
 * Verifies the execution/completion path no longer throws when a task has
 * historical schema-malformed run rows, as long as a valid run exists
 * (the one created by acquireLease). This exercises the REAL production
 * path against a real state.db (ERR-025): no mocked helpers.
 *
 * Covers:
 *   - getValidRunsByTaskTolerant returns valid + degraded without throwing
 *   - markTaskSucceeded tolerates malformed historical runs
 *   - markTaskFailed tolerates malformed historical runs
 *   - markTaskRetryWait tolerates malformed historical runs
 *
 * SPEC §5.3 note: terminal writes address the caller's OWN run explicitly, so
 * they no longer resolve "the latest valid run" and therefore no longer emit
 * the malformed-row degradation event. The tolerant reader still reports the
 * degraded rows (covered below).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from './runtime-state-manager.js';
import { StoreEventEmitter } from './event-emitter.js';

function makeTaskInput(taskId: string): { taskId: string; taskKind: 'diagnostician'; status: 'pending'; attemptCount: number; maxAttempts: number } {
  return {
    taskId,
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
  };
}

/**
 * Insert a schema-malformed run row via raw SQL. Invalid runtime_kind 'config'
 * fails TypeBox Value.Check(RunRecordSchema) the same way production
 * malformed rows do (matches the fixture in sqlite-run-store.test.ts).
 */
function insertMalformedRun(mgr: RuntimeStateManager, opts: { runId: string; taskId: string; attemptNumber: number }): void {
  const now = new Date().toISOString();
  mgr.connection.getDb().prepare(
    `INSERT INTO runs (run_id, task_id, runtime_kind, started_at, attempt_number, execution_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(opts.runId, opts.taskId, 'config', now, opts.attemptNumber, 'failed', now, now);
}

describe('RuntimeStateManager malformed-run tolerance', () => {
  let testDir: string;
  let mgr: RuntimeStateManager;
  let emitter: StoreEventEmitter;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `pd-malformed-tol-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    // Use a fresh emitter (not the singleton) so listeners don't leak across tests.
    emitter = new StoreEventEmitter();
    mgr = new RuntimeStateManager({ workspaceDir: testDir, emitter });
    await mgr.initialize();
  });

  afterEach(async () => {
    await mgr.close();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore Windows cleanup errors
    }
  });

  // ── getValidRunsByTaskTolerant ──────────────────────────────────────────────

  it('getValidRunsByTaskTolerant returns valid + degraded without throwing', async () => {
    await mgr.createTask(makeTaskInput('task-tol'));
    // malformed historical run
    insertMalformedRun(mgr, { runId: 'run_bad_1', taskId: 'task-tol', attemptNumber: 1 });
    // fresh valid run (as acquireLease would create)
    await mgr.runStore.createRun({
      runId: 'run_good_2',
      taskId: 'task-tol',
      runtimeKind: 'openclaw',
      executionStatus: 'running',
      startedAt: new Date().toISOString(),
      attemptNumber: 2,
    });

    const result = await mgr.getValidRunsByTaskTolerant('task-tol');
    expect(result.runs.map((r) => r.runId)).toEqual(['run_good_2']);
    expect(result.degradedRuns.map((r) => r.runId)).toEqual(['run_bad_1']);
  });

  // ── markTaskSucceeded tolerates malformed historical runs ───────────────────

  it('markTaskSucceeded does NOT throw on malformed historical runs and updates the latest valid run', async () => {
    const taskId = 'task-succ-tol';
    await mgr.createTask(makeTaskInput(taskId));
    insertMalformedRun(mgr, { runId: 'run_bad_succ', taskId, attemptNumber: 1 });

    // acquireLease creates a valid running run (attempt 2)
    const __lease1 = await mgr.acquireLeaseDetailed({ taskId, owner: 'agent-1', runtimeKind: 'openclaw' });

    // This used to throw MalformedRunError inside markTaskSucceeded.
    const updated = await mgr.markTaskSucceeded(taskId, 'result-ref-1', { taskId: taskId, owner: 'agent-1', leaseGeneration: __lease1.leaseGeneration }, __lease1.runId);
    expect(updated.status).toBe('succeeded');
    // SPEC §5.3: the durable completion reference now lives on the task row.
    expect(updated.resultRef).toBe('result-ref-1');

    // The latest VALID run must be updated to succeeded (not the malformed one).
    // Read via the tolerant accessor since the malformed row makes listRunsByTask throw.
    const { runs } = await mgr.getValidRunsByTaskTolerant(taskId);
    const latest = runs[runs.length - 1];
    expect(latest).toBeDefined();
    expect(latest!.executionStatus).toBe('succeeded');
    // The malformed historical row is untouched.
    const malformed = mgr.connection.getDb()
      .prepare('SELECT execution_status FROM runs WHERE run_id = ?')
      .get('run_bad_succ') as { execution_status: string } | undefined;
    expect(malformed?.execution_status).toBe('failed');
  });

  // ── markTaskFailed tolerates malformed historical runs ──────────────────────

  it('markTaskFailed does NOT throw on malformed historical runs and updates the latest valid run', async () => {
    const taskId = 'task-fail-tol';
    await mgr.createTask(makeTaskInput(taskId));
    insertMalformedRun(mgr, { runId: 'run_bad_fail', taskId, attemptNumber: 1 });
    const __lease2 = await mgr.acquireLeaseDetailed({ taskId, owner: 'agent-1', runtimeKind: 'openclaw' });

    const updated = await mgr.markTaskFailed(taskId, 'execution_failed', 'model crashed', { taskId: taskId, owner: 'agent-1', leaseGeneration: __lease2.leaseGeneration }, __lease2.runId);
    expect(updated.status).toBe('failed');
    expect(updated.lastError).toBe('execution_failed');

    const { runs: failRuns } = await mgr.getValidRunsByTaskTolerant(taskId);
    const latest = failRuns[failRuns.length - 1];
    expect(latest).toBeDefined();
    expect(latest!.executionStatus).toBe('failed');
    expect(latest!.errorCategory).toBe('execution_failed');
    // SPEC §5.3: the fenced writer records the terminal reason, not the
    // free-text failureReason (that text lives on the task's last_error path).
    expect(latest!.reason).toBe('task_failed');

    // The malformed historical row is untouched by the terminal write.
    const malformed = mgr.connection.getDb()
      .prepare('SELECT execution_status FROM runs WHERE run_id = ?')
      .get('run_bad_fail') as { execution_status: string } | undefined;
    expect(malformed?.execution_status).toBe('failed');
  });

  // ── markTaskRetryWait tolerates malformed historical runs ───────────────────

  it('markTaskRetryWait does NOT throw on malformed historical runs and updates the latest valid run', async () => {
    const taskId = 'task-retry-tol';
    await mgr.createTask(makeTaskInput(taskId));
    insertMalformedRun(mgr, { runId: 'run_bad_retry', taskId, attemptNumber: 1 });
    const __lease3 = await mgr.acquireLeaseDetailed({ taskId, owner: 'agent-1', runtimeKind: 'openclaw' });

    const updated = await mgr.markTaskRetryWait(taskId, 'execution_failed', 'transient', { taskId: taskId, owner: 'agent-1', leaseGeneration: __lease3.leaseGeneration }, __lease3.runId);
    expect(updated.status).toBe('retry_wait');

    const { runs: retryRuns } = await mgr.getValidRunsByTaskTolerant(taskId);
    const latest = retryRuns[retryRuns.length - 1];
    expect(latest).toBeDefined();
    expect(latest!.executionStatus).toBe('failed');
    expect(latest!.errorCategory).toBe('execution_failed');

    // The malformed historical row is untouched by the terminal write.
    const malformed = mgr.connection.getDb()
      .prepare('SELECT execution_status FROM runs WHERE run_id = ?')
      .get('run_bad_retry') as { execution_status: string } | undefined;
    expect(malformed?.execution_status).toBe('failed');
  });
});
