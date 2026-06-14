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
 *   - a degradation_triggered telemetry event is emitted (ERR-002: observable)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from './runtime-state-manager.js';
import { StoreEventEmitter } from './event-emitter.js';
import type { TelemetryEvent } from '../../telemetry-event.js';

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
  let events: TelemetryEvent[];

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `pd-malformed-tol-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    // Use a fresh emitter (not the singleton) so listeners don't leak across tests.
    emitter = new StoreEventEmitter();
    events = [];
    emitter.onTelemetry((ev) => events.push(ev));
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

  function degradationEventsFor(_taskId: string): TelemetryEvent[] {
    return events.filter(
      (e) => e.eventType === 'degradation_triggered'
        && e.payload?.trigger === 'malformed_historical_run_rows',
    );
  }

  /** Runtime-guarded field read from a telemetry payload (no `as` cast on untrusted shape). */
  function payloadField(ev: TelemetryEvent, field: string): unknown {
    const {payload} = ev;
    if (typeof payload !== 'object' || payload === null) {
      throw new Error(`payload is not an object for event ${ev.traceId}`);
    }
    return (payload as Record<string, unknown>)[field];
  }

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
    await mgr.acquireLease({ taskId, owner: 'agent-1', runtimeKind: 'openclaw' });

    // This used to throw MalformedRunError inside markTaskSucceeded.
    const updated = await mgr.markTaskSucceeded(taskId, 'result-ref-1');
    expect(updated.status).toBe('succeeded');

    // The latest VALID run must be updated to succeeded (not the malformed one).
    // Read via the tolerant accessor since the malformed row makes listRunsByTask throw.
    const { runs } = await mgr.getValidRunsByTaskTolerant(taskId);
    const latest = runs[runs.length - 1];
    expect(latest).toBeDefined();
    expect(latest!.executionStatus).toBe('succeeded');
    expect(latest!.outputRef).toBe('result-ref-1');

    // ERR-002: degradation must be observable, not silent.
    const degradations = degradationEventsFor(taskId);
    expect(degradations.length).toBeGreaterThanOrEqual(1);
    const ev = degradations[0]!;
    const caller = payloadField(ev, 'caller');
    expect(caller).toBe('markTaskSucceeded');
    const degradedCount = payloadField(ev, 'degradedCount');
    expect(degradedCount).toBe(1);
    const runIds = payloadField(ev, 'runIds');
    expect(runIds).toEqual(['run_bad_succ']);
  });

  // ── markTaskFailed tolerates malformed historical runs ──────────────────────

  it('markTaskFailed does NOT throw on malformed historical runs and updates the latest valid run', async () => {
    const taskId = 'task-fail-tol';
    await mgr.createTask(makeTaskInput(taskId));
    insertMalformedRun(mgr, { runId: 'run_bad_fail', taskId, attemptNumber: 1 });
    await mgr.acquireLease({ taskId, owner: 'agent-1', runtimeKind: 'openclaw' });

    const updated = await mgr.markTaskFailed(taskId, 'execution_failed', 'model crashed');
    expect(updated.status).toBe('failed');

    const { runs: failRuns } = await mgr.getValidRunsByTaskTolerant(taskId);
    const latest = failRuns[failRuns.length - 1];
    expect(latest).toBeDefined();
    expect(latest!.executionStatus).toBe('failed');
    expect(latest!.errorCategory).toBe('execution_failed');
    expect(latest!.reason).toBe('model crashed');

    const degradations = degradationEventsFor(taskId);
    expect(degradations.length).toBeGreaterThanOrEqual(1);
    expect(payloadField(degradations[0]!, 'caller')).toBe('markTaskFailed');
  });

  // ── markTaskRetryWait tolerates malformed historical runs ───────────────────

  it('markTaskRetryWait does NOT throw on malformed historical runs and updates the latest valid run', async () => {
    const taskId = 'task-retry-tol';
    await mgr.createTask(makeTaskInput(taskId));
    insertMalformedRun(mgr, { runId: 'run_bad_retry', taskId, attemptNumber: 1 });
    await mgr.acquireLease({ taskId, owner: 'agent-1', runtimeKind: 'openclaw' });

    const updated = await mgr.markTaskRetryWait(taskId, 'execution_failed', 'transient');
    expect(updated.status).toBe('retry_wait');

    const { runs: retryRuns } = await mgr.getValidRunsByTaskTolerant(taskId);
    const latest = retryRuns[retryRuns.length - 1];
    expect(latest).toBeDefined();
    expect(latest!.executionStatus).toBe('failed');
    expect(latest!.errorCategory).toBe('execution_failed');

    const degradations = degradationEventsFor(taskId);
    expect(degradations.length).toBeGreaterThanOrEqual(1);
    expect(payloadField(degradations[0]!, 'caller')).toBe('markTaskRetryWait');
  });
});
