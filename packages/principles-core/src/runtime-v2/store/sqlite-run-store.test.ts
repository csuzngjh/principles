/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * SqliteRunStore integration tests.
 *
 * Uses an in-memory SQLite tmpdir for isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './task/sqlite-task-store.js';
import type { MalformedRunError } from './run/sqlite-run-store.js';
import { SqliteRunStore } from './run/sqlite-run-store.js';
import type { RunRecord } from '../runtime-protocol.js';

function makeTaskInput(taskId: string) {
  return {
    taskId,
    taskKind: 'diagnostician' as const,
    status: 'pending' as const,
    attemptCount: 0,
    maxAttempts: 3,
  };
}

function makeRunInput(taskId: string, attemptNumber = 1): Omit<RunRecord, 'createdAt' | 'updatedAt'> {
  const now = new Date().toISOString();
  return {
    runId: `run_${taskId}_${attemptNumber}`,
    taskId,
    runtimeKind: 'openclaw' as const,
    executionStatus: 'queued',
    startedAt: now,
    attemptNumber,
    
    
  };
}

describe('SqliteRunStore', () => {
  const tmpDir = path.join(os.tmpdir(), `pd-test-${process.pid}-${Date.now()}`);
   
  let conn: SqliteConnection;
  let taskStore: SqliteTaskStore;
  let runStore: SqliteRunStore;
   

  beforeEach(() => {
    const testDir = path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    conn = new SqliteConnection(testDir);
    taskStore = new SqliteTaskStore(conn);
    runStore = new SqliteRunStore(conn);
  });

  afterEach(() => {
    conn.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  describe('createRun', () => {
    it('creates a run record and returns it', async () => {
      const taskId = 'task-run-create';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = makeRunInput(taskId, 1);
      const result = await runStore.createRun(run);
      expect(result.runId).toBe(`run_${taskId}_1`);
      expect(result.taskId).toBe(taskId);
      expect(result.attemptNumber).toBe(1);
      expect(result.executionStatus).toBe('queued');
    });

    it('rejects duplicate runId', async () => {
      const taskId = 'task-run-dup';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = makeRunInput(taskId, 1);
      await runStore.createRun(run);
      await expect(runStore.createRun(run)).rejects.toThrow();
    });
  });

  describe('getRun', () => {
    it('returns null for non-existent run', async () => {
      const result = await runStore.getRun('non-existent');
      expect(result).toBeNull();
    });

    it('returns created run', async () => {
      const taskId = 'task-run-get';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = makeRunInput(taskId, 1);
      await runStore.createRun(run);
      const result = await runStore.getRun(`run_${taskId}_1`);
      expect(result?.runId).toBe(`run_${taskId}_1`);
      expect(result?.taskId).toBe(taskId);
    });
  });

  describe('listRunsByTask', () => {
    it('returns all runs for a task ordered by started_at', async () => {
      const taskId = 'task-runs-list';
      await taskStore.createTask(makeTaskInput(taskId));
      await runStore.createRun(makeRunInput(taskId, 1));
      await runStore.createRun(makeRunInput(taskId, 2));
      const results = await runStore.listRunsByTask(taskId);
      expect(results.length).toBe(2);
      expect(results[0]!.attemptNumber).toBe(1);
      expect(results[1]!.attemptNumber).toBe(2);
    });

    it('returns empty array for task with no runs', async () => {
      const taskId = 'task-no-runs';
      await taskStore.createTask(makeTaskInput(taskId));
      const results = await runStore.listRunsByTask(taskId);
      expect(results).toEqual([]);
    });
  });

  describe('updateRun', () => {
    it('updates run endedAt and reason', async () => {
      const taskId = 'task-run-update';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = await runStore.createRun(makeRunInput(taskId, 1));
      const endedAt = new Date().toISOString();
      const result = await runStore.updateRun(run.runId, {
        endedAt,
        reason: 'completed successfully',
      });
      expect(result.endedAt).toBe(endedAt);
      expect(result.reason).toBe('completed successfully');
    });

    it('throws for non-existent run', async () => {
      await expect(
        runStore.updateRun('non-existent', { reason: 'test' }),
      ).rejects.toThrow();
    });

    it('can set errorCategory', async () => {
      const taskId = 'task-run-reason';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = await runStore.createRun(makeRunInput(taskId, 1));
      const result = await runStore.updateRun(run.runId, {
        reason: 'Agent stalled',
        errorCategory: 'timeout',
      });
      expect(result.reason).toBe('Agent stalled');
      expect(result.errorCategory).toBe('timeout');
    });
  });

  describe('deleteRun', () => {
    it('deletes existing run and returns true', async () => {
      const taskId = 'task-run-delete';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = await runStore.createRun(makeRunInput(taskId, 1));
      const deleted = await runStore.deleteRun(run.runId);
      expect(deleted).toBe(true);
      expect(await runStore.getRun(run.runId)).toBeNull();
    });

    it('returns false for non-existent run', async () => {
      const deleted = await runStore.deleteRun('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('schema validation and degradation resilience', () => {
    it('createRun blocks invalid runtimeKind config', async () => {
      const taskId = 'task-invalid-kind';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = makeRunInput(taskId, 1) as unknown as Record<string, unknown>;
      // force invalid runtimeKind
      run.runtimeKind = 'config';
      await expect(runStore.createRun(run as unknown as Omit<RunRecord, 'createdAt' | 'updatedAt'>)).rejects.toThrow('Invalid runtime kind: config');
    });

    it('getRun throws MalformedRunError for a malformed run row in DB', async () => {
      const taskId = 'task-malformed';
      await taskStore.createTask(makeTaskInput(taskId));
      conn.getDb().prepare(
        `INSERT INTO runs (run_id, task_id, runtime_kind, started_at, attempt_number, execution_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run_malformed_1', taskId, 'config', new Date().toISOString(), 1, 'failed', new Date().toISOString(), new Date().toISOString());

      await expect(runStore.getRun('run_malformed_1')).rejects.toThrowError('Run run_malformed_1 has invalid schema');
    });

    it('listRunsByTask throws MalformedRunError grouping valid and degraded runs', async () => {
      const taskId = 'task-mixed';
      await taskStore.createTask(makeTaskInput(taskId));

      // insert valid run
      await runStore.createRun(makeRunInput(taskId, 1));

      // insert malformed run using raw SQL
      conn.getDb().prepare(
        `INSERT INTO runs (run_id, task_id, runtime_kind, started_at, attempt_number, execution_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run_malformed_2', taskId, 'config', new Date().toISOString(), 2, 'failed', new Date().toISOString(), new Date().toISOString());

      let caughtError: unknown = null;
      try {
        await runStore.listRunsByTask(taskId);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const malformedErr = caughtError as MalformedRunError;
      expect(malformedErr.name).toBe('MalformedRunError');
      expect(malformedErr.validRuns.length).toBe(1);
      expect(malformedErr.degradedRuns.length).toBe(1);
      expect(malformedErr.degradedRuns[0]).toBeDefined();
      expect(malformedErr.degradedRuns[0]?.runId).toBe('run_malformed_2');
      expect(malformedErr.degradedRuns[0]?.error).toContain('runtimeKind');
    });

    it('listValidRunsByTaskTolerant returns valid + degraded runs WITHOUT throwing when a malformed row is present', async () => {
      const taskId = 'task-tolerant-mixed';
      await taskStore.createTask(makeTaskInput(taskId));

      // valid run (attempt 1)
      await runStore.createRun(makeRunInput(taskId, 1));

      // malformed run via raw SQL (invalid runtime_kind 'config')
      conn.getDb().prepare(
        `INSERT INTO runs (run_id, task_id, runtime_kind, started_at, attempt_number, execution_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run_tol_malformed', taskId, 'config', new Date().toISOString(), 2, 'failed', new Date().toISOString(), new Date().toISOString());

      const result = await runStore.listValidRunsByTaskTolerant(taskId);

      // Must NOT throw — the whole point of the tolerant accessor.
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]!.runId).toBe(`run_${taskId}_1`);
      expect(result.degradedRuns).toHaveLength(1);
      expect(result.degradedRuns[0]!.runId).toBe('run_tol_malformed');
      expect(result.degradedRuns[0]!.error).toContain('runtimeKind');
      // rawRow is preserved for diagnostics (ERR-002: observable, not silent)
      expect(result.degradedRuns[0]!.rawRow).toBeDefined();
    });

    it('listValidRunsByTaskTolerant returns empty runs + empty degradedRuns for a task with only valid runs', async () => {
      const taskId = 'task-tolerant-clean';
      await taskStore.createTask(makeTaskInput(taskId));
      await runStore.createRun(makeRunInput(taskId, 1));

      const result = await runStore.listValidRunsByTaskTolerant(taskId);
      expect(result.runs).toHaveLength(1);
      expect(result.degradedRuns).toEqual([]);
    });

    it('listValidRunsByTaskTolerant returns empty runs + only degradedRuns when ALL rows are malformed', async () => {
      // This is the worst case: no valid run exists. The tolerant accessor
      // still must NOT throw — callers (resolveStoreRunId) decide to fail
      // loud when runs.length === 0.
      const taskId = 'task-tolerant-all-malformed';
      await taskStore.createTask(makeTaskInput(taskId));
      conn.getDb().prepare(
        `INSERT INTO runs (run_id, task_id, runtime_kind, started_at, attempt_number, execution_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run_all_bad', taskId, 'config', new Date().toISOString(), 1, 'failed', new Date().toISOString(), new Date().toISOString());

      const result = await runStore.listValidRunsByTaskTolerant(taskId);
      expect(result.runs).toEqual([]);
      expect(result.degradedRuns).toHaveLength(1);
      expect(result.degradedRuns[0]!.runId).toBe('run_all_bad');
    });

    // ── P1: missing/wrong-typed required fields must fail loud via rowToRecord ──
    // The DB enforces NOT NULL on these columns, so a NULL never reaches the reader
    // in a healthy DB. But schema drift (a migration that drops/renames a column,
    // or a manual ALTER) can make row.xxx undefined. String()/Number() coercion
    // would wash undefined into "undefined"/NaN and PASS schema validation, hiding
    // the malformed row. These tests prove the field-level readers reject that.
    // We test rowToRecord directly with hand-built rows (the trust boundary).
    function validRowBase(): Record<string, unknown> {
      const now = new Date().toISOString();
      return {
        run_id: 'run-direct-1',
        task_id: 'task-direct',
        runtime_kind: 'openclaw',
        execution_status: 'running',
        started_at: now,
        attempt_number: 1,
        created_at: now,
        updated_at: now,
      };
    }

    it('rowToRecord accepts a fully-valid row', () => {
      expect(() => SqliteRunStore.rowToRecord(validRowBase())).not.toThrow();
    });

    it('rowToRecord throws when started_at is undefined (not coerced to "undefined")', () => {
      const row = validRowBase();
      delete row.started_at;
      expect(() => SqliteRunStore.rowToRecord(row)).toThrow(/started_at: expected string, got undefined/);
    });

    it('rowToRecord throws when created_at is undefined', () => {
      const row = validRowBase();
      delete row.created_at;
      expect(() => SqliteRunStore.rowToRecord(row)).toThrow(/created_at: expected string, got undefined/);
    });

    it('rowToRecord throws when updated_at is undefined', () => {
      const row = validRowBase();
      delete row.updated_at;
      expect(() => SqliteRunStore.rowToRecord(row)).toThrow(/updated_at: expected string, got undefined/);
    });

    it('rowToRecord throws when task_id is undefined (not coerced to "undefined")', () => {
      const row = validRowBase();
      delete row.task_id;
      expect(() => SqliteRunStore.rowToRecord(row)).toThrow(/task_id: expected string, got undefined/);
    });

    it('rowToRecord throws when run_id is undefined', () => {
      const row = validRowBase();
      delete row.run_id;
      expect(() => SqliteRunStore.rowToRecord(row)).toThrow(/run_id: expected string, got undefined/);
    });

    it('rowToRecord throws when attempt_number is undefined (not coerced to NaN→0)', () => {
      const row = validRowBase();
      delete row.attempt_number;
      expect(() => SqliteRunStore.rowToRecord(row)).toThrow(/attempt_number: expected integer, got undefined/);
    });

    it('rowToRecord throws when attempt_number is a non-integer number', () => {
      const row = validRowBase();
      row.attempt_number = 1.5;
      expect(() => SqliteRunStore.rowToRecord(row)).toThrow(/attempt_number: expected integer/);
    });

    it('rowToRecord accepts null for optional string fields (ended_at, reason, output_ref)', () => {
      const row = validRowBase();
      row.ended_at = null;
      row.reason = null;
      row.output_ref = null;
      const rec = SqliteRunStore.rowToRecord(row);
      expect(rec.endedAt).toBeUndefined();
      expect(rec.reason).toBeUndefined();
      expect(rec.outputRef).toBeUndefined();
    });

    it('rowToRecord throws when an optional string field is a non-string non-null type (e.g. number)', () => {
      const row = validRowBase();
      row.output_ref = 12345;
      expect(() => SqliteRunStore.rowToRecord(row)).toThrow(/output_ref: expected string\|null, got number/);
    });

    it('rowToRecord error message never contains the literal "undefined" string for a missing field', () => {
      // Regression guard: the old String() coercion produced "undefined" which
      // would pass Type.String(). The reader must reject, and the message must
      // name the field + type, not silently coerce.
      const row = validRowBase();
      delete row.started_at;
      let msg = '';
      try {
        SqliteRunStore.rowToRecord(row);
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      expect(msg).toContain('started_at');
      expect(msg).not.toMatch(/^$/); // must not be empty
      // The value must be reported as "undefined" type, but the FIELD must not
      // have been coerced into the string "undefined" that would pass validation.
      expect(msg).toContain('got undefined');
    });
  });
});
