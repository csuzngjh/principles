import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type Database from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './task/sqlite-task-store.js';
import { SqliteRunStore } from './run/sqlite-run-store.js';
import { TaskRecordSchema, type PDTaskStatus } from '../task-status.js';
import { RunRecordSchema, type RunExecutionStatus } from '../runtime-protocol.js';
import { SqliteCandidateStore } from './candidate/sqlite-candidate-store.js';

describe('SchemaConformance', () => {
   
  let tmpdir: string;
   
  let connection: SqliteConnection;
   
  let taskStore: SqliteTaskStore;
   
  let runStore: SqliteRunStore;

  beforeEach(() => {
    tmpdir = path.join(os.tmpdir(), `pd-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpdir, { recursive: true });
    connection = new SqliteConnection(tmpdir);
    taskStore = new SqliteTaskStore(connection);
    runStore = new SqliteRunStore(connection);
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(tmpdir, { force: true, recursive: true });
  });

  it('TaskRecordSchema validates a valid task record', () => {
    const valid = {
      taskId: 'task-1',
      taskKind: 'diagnostician',
      status: 'pending' as PDTaskStatus,
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(Value.Check(TaskRecordSchema, valid)).toBe(true);
  });

  it('TaskRecordSchema rejects invalid status', () => {
    const invalid = {
      taskId: 'task-1',
      taskKind: 'diagnostician',
      status: 'invalid_status' as PDTaskStatus,
      attemptCount: 0,
      maxAttempts: 3,
    };
    expect(Value.Check(TaskRecordSchema, invalid)).toBe(false);
  });

  it('TaskRecordSchema rejects negative attemptCount', () => {
    const invalid = {
      taskId: 'task-1',
      taskKind: 'diagnostician',
      status: 'pending' as PDTaskStatus,
      attemptCount: -1,
      maxAttempts: 3,
    };
    expect(Value.Check(TaskRecordSchema, invalid)).toBe(false);
  });

  it('RunRecordSchema validates a valid run record', () => {
    const valid = {
      runId: 'run-task-1-1',
      taskId: 'task-1',
      runtimeKind: 'openclaw',
      executionStatus: 'running' as RunExecutionStatus,
      startedAt: new Date().toISOString(),
      attemptNumber: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(Value.Check(RunRecordSchema, valid)).toBe(true);
  });

  it('RunRecordSchema rejects invalid executionStatus', () => {
    const invalid = {
      runId: 'run-task-1-1',
      taskId: 'task-1',
      runtimeKind: 'openclaw',
      executionStatus: 'invalid_status' as RunExecutionStatus,
      startedAt: new Date().toISOString(),
      attemptNumber: 1,
    };
    expect(Value.Check(RunRecordSchema, invalid)).toBe(false);
  });

  it('sqlite-task-store returns records that pass schema validation', async () => {
    await taskStore.createTask({
      taskId: 'task-schema-1',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    const record = await taskStore.getTask('task-schema-1');
    expect(record).not.toBeNull();
    expect(Value.Check(TaskRecordSchema, record)).toBe(true);
  });

  it('sqlite-task-store updateTask returns records that pass schema validation', async () => {
    await taskStore.createTask({
      taskId: 'task-schema-2',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    const updated = await taskStore.updateTask('task-schema-2', { status: 'leased' });
    expect(Value.Check(TaskRecordSchema, updated)).toBe(true);
  });

  it('sqlite-run-store returns records that pass schema validation', async () => {
    await taskStore.createTask({
      taskId: 'task-schema-3',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    await runStore.createRun({
      runId: 'run-task-schema-3-1',
      taskId: 'task-schema-3',
      runtimeKind: 'openclaw',
      executionStatus: 'running',
      startedAt: new Date().toISOString(),
      attemptNumber: 1,
    });

    const record = await runStore.getRun('run-task-schema-3-1');
    expect(record).not.toBeNull();
    expect(Value.Check(RunRecordSchema, record)).toBe(true);
  });

  it('sqlite-run-store updateRun returns records that pass schema validation', async () => {
    await taskStore.createTask({
      taskId: 'task-schema-4',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    await runStore.createRun({
      runId: 'run-task-schema-4-1',
      taskId: 'task-schema-4',
      runtimeKind: 'openclaw',
      executionStatus: 'running',
      startedAt: new Date().toISOString(),
      attemptNumber: 1,
    });

    const updated = await runStore.updateRun('run-task-schema-4-1', {
      endedAt: new Date().toISOString(),
    });
    expect(Value.Check(RunRecordSchema, updated)).toBe(true);
  });

  it('listTasks returns all records that pass schema validation', async () => {
    for (let i = 0; i < 5; i++) {
      await taskStore.createTask({
        taskId: `task-list-${i}`,
        taskKind: 'test',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
      });
    }

    const tasks = await taskStore.listTasks();
    expect(tasks).toHaveLength(5);
    for (const task of tasks) {
      expect(Value.Check(TaskRecordSchema, task)).toBe(true);
    }
  });

  it('listRunsByTask returns all records that pass schema validation', async () => {
    await taskStore.createTask({
      taskId: 'task-list-runs',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    for (let i = 0; i < 3; i++) {
      await runStore.createRun({
        runId: `run-task-list-runs-${i + 1}`,
        taskId: 'task-list-runs',
        runtimeKind: 'openclaw',
        executionStatus: 'running',
        startedAt: new Date().toISOString(),
        attemptNumber: i + 1,
      });
    }

    const runs = await runStore.listRunsByTask('task-list-runs');
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(Value.Check(RunRecordSchema, run)).toBe(true);
    }
  });
});

describe('ArtifactRegistrySchema', () => {
   
  let tmpdir: string;
   
  let connection: SqliteConnection;
   
  let taskStore: SqliteTaskStore;
   
  let runStore: SqliteRunStore;

  beforeEach(() => {
    tmpdir = path.join(os.tmpdir(), `pd-test-artf-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpdir, { recursive: true });
    connection = new SqliteConnection(tmpdir);
    taskStore = new SqliteTaskStore(connection);
    runStore = new SqliteRunStore(connection);
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(tmpdir, { force: true, recursive: true });
  });

  /** Helper: create task + run + artifact chain for cascade tests */
  async function insertTestChain(db: Database.Database, suffix: string): Promise<void> {
    await taskStore.createTask({
      taskId: `t-${suffix}`,
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });
    await runStore.createRun({
      runId: `r-${suffix}`,
      taskId: `t-${suffix}`,
      runtimeKind: 'test-double',
      executionStatus: 'succeeded',
      startedAt: new Date().toISOString(),
      attemptNumber: 1,
    });
    db.prepare(
      "INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(`a-${suffix}`, `r-${suffix}`, `t-${suffix}`, 'diagnostician_output', '{}', new Date().toISOString());
  }

  it('artifacts table created with correct columns', () => {
    const db = connection.getDb();
    const columns = db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain('artifact_id');
    expect(names).toContain('run_id');
    expect(names).toContain('task_id');
    expect(names).toContain('artifact_kind');
    expect(names).toContain('content_json');
    expect(names).toContain('created_at');
    expect(columns).toHaveLength(6);
  });

  it('commits table created with correct columns', () => {
    const db = connection.getDb();
    const columns = db.prepare('PRAGMA table_info(commits)').all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain('commit_id');
    expect(names).toContain('task_id');
    expect(names).toContain('run_id');
    expect(names).toContain('artifact_id');
    expect(names).toContain('idempotency_key');
    expect(names).toContain('status');
    expect(names).toContain('created_at');
    expect(columns).toHaveLength(7);
  });

  it('principle_candidates table created with correct columns', () => {
    const db = connection.getDb();
    const columns = db
      .prepare('PRAGMA table_info(principle_candidates)')
      .all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain('candidate_id');
    expect(names).toContain('artifact_id');
    expect(names).toContain('task_id');
    expect(names).toContain('source_run_id');
    expect(names).toContain('title');
    expect(names).toContain('description');
    expect(names).toContain('confidence');
    expect(names).toContain('source_recommendation_json');
    expect(names).toContain('idempotency_key');
    expect(names).toContain('status');
    expect(names).toContain('created_at');
    expect(names).toContain('consumed_at');
    expect(names).toContain('recommendation_kind');
    expect(names).toContain('trigger_pattern');
    expect(names).toContain('action');
    expect(names).toContain('abstracted_principle');
    expect(columns).toHaveLength(16);
  });

  // PRI-442 F13: schema CHECK constraint enforces consumed_at IS NOT NULL
  // when status = 'consumed'. Defense in depth for Bug-J (consumed_at never
  // filled). The application layer (ensureConsumedAt + updateCandidateStatus)
  // is the primary fix; this CHECK is the DB-level backstop.
  it('F13: CHECK constraint rejects status=consumed with NULL consumed_at', () => {
    const db = connection.getDb();
    // Insert a valid task + run + artifact first to satisfy FK constraints
    const now = new Date().toISOString();
    db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-f13', 'diagnostician', 'pending', now, now);
    db.prepare('INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('run-f13', 'task-f13', 'test-double', 'queued', now, now, now);
    db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('art-f13', 'run-f13', 'task-f13', 'principle', '{}', now);

    // Attempt to insert status='consumed' with NULL consumed_at — must throw
    expect(() => {
      db.prepare(
        `INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at, recommendation_kind)
         VALUES ('cand-f13-bad', 'art-f13', 'task-f13', 'run-f13', 't', 'd', 'idem-f13-bad', 'consumed', ?, 'principle')`,
      ).run(now);
    }).toThrow(/CHECK constraint failed/);

    // Insert with status='consumed' AND consumed_at — must succeed
    expect(() => {
      db.prepare(
        `INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at, consumed_at, recommendation_kind)
         VALUES ('cand-f13-ok', 'art-f13', 'task-f13', 'run-f13', 't', 'd', 'idem-f13-ok', 'consumed', ?, ?, 'principle')`,
      ).run(now, now);
    }).not.toThrow();

    // Insert with status='pending' and NULL consumed_at — must succeed
    expect(() => {
      db.prepare(
        `INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at, recommendation_kind)
         VALUES ('cand-f13-pending', 'art-f13', 'task-f13', 'run-f13', 't', 'd', 'idem-f13-pending', 'pending', ?, 'principle')`,
      ).run(now);
    }).not.toThrow();
  });

  it('all three tables created idempotently on re-open', () => {
    const db = connection.getDb();
    // Verify all three tables exist on first open
    const artifactsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'")
      .get();
    const commitsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='commits'")
      .get();
    const candidatesExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='principle_candidates'")
      .get();
    expect(artifactsExists).toBeTruthy();
    expect(commitsExists).toBeTruthy();
    expect(candidatesExists).toBeTruthy();

    // Re-open the connection — must be idempotent
    connection.close();
    const conn2 = new SqliteConnection(tmpdir);
    const db2 = conn2.getDb();
    const artifactsExists2 = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'")
      .get();
    const commitsExists2 = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='commits'")
      .get();
    const candidatesExists2 = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='principle_candidates'")
      .get();
    expect(artifactsExists2).toBeTruthy();
    expect(commitsExists2).toBeTruthy();
    expect(candidatesExists2).toBeTruthy();
    conn2.close();
  });

  it('all 8 indexes exist', () => {
    const db = connection.getDb();
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' AND tbl_name IN ('artifacts','commits','principle_candidates')"
      )
      .all() as { name: string }[];
    expect(indexes).toHaveLength(9);
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_artifacts_task_id');
    expect(indexNames).toContain('idx_artifacts_run_id');
    expect(indexNames).toContain('idx_artifacts_artifact_kind');
    expect(indexNames).toContain('idx_commits_task_id');
    expect(indexNames).toContain('idx_commits_artifact_id');
    expect(indexNames).toContain('idx_candidates_status');
    expect(indexNames).toContain('idx_candidates_source_run_id');
    expect(indexNames).toContain('idx_candidates_task_id');
    expect(indexNames).toContain('idx_candidates_recommendation_kind');
  });

  it('deleting run cascades to artifacts, commits, and candidates', async () => {
    const db = connection.getDb();
    await insertTestChain(db, 'cascade-run');

    // Insert commit and candidate linked to artifact a-cascade-run
    db.prepare(
      "INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      'c-cascade-run',
      't-cascade-run',
      'r-cascade-run',
      'a-cascade-run',
      'ik-cr-1',
      'committed',
      new Date().toISOString()
    );
    db.prepare(
      "INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      'pc-cascade-run',
      'a-cascade-run',
      't-cascade-run',
      'r-cascade-run',
      'Test Principle',
      'Test description',
      'ik-pc-cr-1',
      'pending',
      new Date().toISOString()
    );

    // Verify all rows exist
    expect(db.prepare('SELECT 1 FROM artifacts WHERE artifact_id=?').get('a-cascade-run')).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM commits WHERE commit_id=?').get('c-cascade-run')).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM principle_candidates WHERE candidate_id=?').get('pc-cascade-run')).toBeTruthy();

    // Delete the run — should cascade
    db.exec("DELETE FROM runs WHERE run_id='r-cascade-run'");

    expect(db.prepare('SELECT 1 FROM artifacts WHERE artifact_id=?').get('a-cascade-run')).toBeFalsy();
    expect(db.prepare('SELECT 1 FROM commits WHERE commit_id=?').get('c-cascade-run')).toBeFalsy();
    expect(db.prepare('SELECT 1 FROM principle_candidates WHERE candidate_id=?').get('pc-cascade-run')).toBeFalsy();
  });

  it('deleting task cascades to commits and candidates', async () => {
    const db = connection.getDb();
    await insertTestChain(db, 'cascade-task');

    db.prepare(
      "INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      'c-cascade-task',
      't-cascade-task',
      'r-cascade-task',
      'a-cascade-task',
      'ik-ct-1',
      'committed',
      new Date().toISOString()
    );
    db.prepare(
      "INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      'pc-cascade-task',
      'a-cascade-task',
      't-cascade-task',
      'r-cascade-task',
      'Test Principle',
      'Test description',
      'ik-pc-ct-1',
      'pending',
      new Date().toISOString()
    );

    // Verify all rows exist
    expect(db.prepare('SELECT 1 FROM artifacts WHERE artifact_id=?').get('a-cascade-task')).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM commits WHERE commit_id=?').get('c-cascade-task')).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM principle_candidates WHERE candidate_id=?').get('pc-cascade-task')).toBeTruthy();

    // Delete the task — should cascade through run -> artifacts -> commits -> candidates
    db.exec("DELETE FROM tasks WHERE task_id='t-cascade-task'");

    expect(db.prepare('SELECT 1 FROM commits WHERE commit_id=?').get('c-cascade-task')).toBeFalsy();
    expect(db.prepare('SELECT 1 FROM principle_candidates WHERE candidate_id=?').get('pc-cascade-task')).toBeFalsy();
    expect(db.prepare('SELECT 1 FROM artifacts WHERE artifact_id=?').get('a-cascade-task')).toBeFalsy();
  });

  it('deleting artifact cascades to commits and candidates', async () => {
    const db = connection.getDb();
    await insertTestChain(db, 'cascade-artifact');

    db.prepare(
      "INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      'c-cascade-art',
      't-cascade-artifact',
      'r-cascade-artifact',
      'a-cascade-artifact',
      'ik-ca-1',
      'committed',
      new Date().toISOString()
    );
    db.prepare(
      "INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      'pc-cascade-art',
      'a-cascade-artifact',
      't-cascade-artifact',
      'r-cascade-artifact',
      'Test Principle',
      'Test description',
      'ik-pc-ca-1',
      'pending',
      new Date().toISOString()
    );

    // Verify all rows exist
    expect(db.prepare('SELECT 1 FROM commits WHERE commit_id=?').get('c-cascade-art')).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM principle_candidates WHERE candidate_id=?').get('pc-cascade-art')).toBeTruthy();

    // Delete the artifact — should cascade to commits and candidates
    db.exec("DELETE FROM artifacts WHERE artifact_id='a-cascade-artifact'");

    expect(db.prepare('SELECT 1 FROM commits WHERE commit_id=?').get('c-cascade-art')).toBeFalsy();
    expect(db.prepare('SELECT 1 FROM principle_candidates WHERE candidate_id=?').get('pc-cascade-art')).toBeFalsy();
  });

  it('commits.run_id UNIQUE constraint prevents duplicate', async () => {
    const db = connection.getDb();
    await insertTestChain(db, 'unique-run');
    db.prepare(
      "INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      'c-unique-run-1',
      't-unique-run',
      'r-unique-run',
      'a-unique-run',
      'ik-ur-1',
      'committed',
      new Date().toISOString()
    );

    expect(() =>
      db.prepare(
        "INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        'c-unique-run-2',
        't-unique-run',
        'r-unique-run', // same run_id — violates UNIQUE
        'a-unique-run',
        'ik-ur-2',
        'committed',
        new Date().toISOString()
      )
    ).toThrow(/UNIQUE constraint failed.*commits\.run_id/);
  });

  it('commits.idempotency_key UNIQUE constraint prevents duplicate', async () => {
    const db = connection.getDb();
    await insertTestChain(db, 'unique-ik');
    db.prepare(
      "INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      'c-unique-ik-1',
      't-unique-ik',
      'r-unique-ik',
      'a-unique-ik',
      'ik-unique-ik-1',
      'committed',
      new Date().toISOString()
    );

    expect(() =>
      db.prepare(
        "INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        'c-unique-ik-2',
        't-unique-ik',
        'r-unique-ik', // same run_id — violates UNIQUE
        'a-unique-ik',
        'ik-unique-ik-1', // same idempotency_key — violates UNIQUE
        'committed',
        new Date().toISOString()
      )
    ).toThrow(/UNIQUE constraint failed.*commits\.idempotency_key/);
  });

  it('principle_candidates.idempotency_key UNIQUE constraint prevents duplicate', async () => {
    const db = connection.getDb();
    await insertTestChain(db, 'unique-pc-ik');
    db.prepare(
      "INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      'pc-unique-ik-1',
      'a-unique-pc-ik',
      't-unique-pc-ik',
      'r-unique-pc-ik',
      'Test Principle',
      'Test description',
      'ik-pc-unique-1',
      'pending',
      new Date().toISOString()
    );

    expect(() =>
      db.prepare(
        "INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        'pc-unique-ik-2',
        'a-unique-pc-ik',
        't-unique-pc-ik',
        'r-unique-pc-ik',
        'Test Principle 2',
        'Test description 2',
        'ik-pc-unique-1', // same idempotency_key — violates UNIQUE
        'pending',
        new Date().toISOString()
      )
    ).toThrow(/UNIQUE constraint failed.*principle_candidates\.idempotency_key/);
  });

  it('existing tasks and runs tables unaffected', async () => {
    // Create task and run, then re-open connection
    await taskStore.createTask({
      taskId: 't-backward-compat',
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });
    await runStore.createRun({
      runId: 'r-backward-compat',
      taskId: 't-backward-compat',
      runtimeKind: 'openclaw',
      executionStatus: 'succeeded',
      startedAt: new Date().toISOString(),
      attemptNumber: 1,
    });

    // Re-open
    connection.close();
    const conn2 = new SqliteConnection(tmpdir);
    const taskStore2 = new SqliteTaskStore(conn2);
    const runStore2 = new SqliteRunStore(conn2);

    const task = await taskStore2.getTask('t-backward-compat');
    expect(task).not.toBeNull();
    expect(task?.taskId).toBe('t-backward-compat');

    const run = await runStore2.getRun('r-backward-compat');
    expect(run).not.toBeNull();
    expect(run?.runId).toBe('r-backward-compat');
    conn2.close();
  });
});

describe('SchemaMigration', () => {
   
  let tmpdir: string;
   
  let connection: SqliteConnection;

  beforeEach(() => {
    tmpdir = path.join(os.tmpdir(), `pd-migration-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpdir, { recursive: true });
  });

  afterEach(() => {
    try { connection.close(); } catch { /* best-effort */ }
    fs.rmSync(tmpdir, { force: true, recursive: true });
  });

  function createOldSchemaDb(): void {
    const dbPath = path.join(tmpdir, '.pd', 'state.db');
    fs.mkdirSync(path.join(tmpdir, '.pd'), { recursive: true });
    const rawDb = new BetterSqlite3(dbPath);
    rawDb.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        task_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        input_ref TEXT,
        result_ref TEXT
      );
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        execution_status TEXT NOT NULL DEFAULT 'queued',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        reason TEXT,
        output_ref TEXT,
        input_payload TEXT,
        output_payload TEXT,
        error_category TEXT,
        attempt_number INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
      );
      CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      CREATE TABLE commits (
        commit_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        artifact_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'committed',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
      );
      CREATE TABLE principle_candidates (
        candidate_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        confidence REAL,
        source_recommendation_json TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (source_run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_status ON principle_candidates(status);
      CREATE INDEX IF NOT EXISTS idx_candidates_source_run_id ON principle_candidates(source_run_id);
      CREATE INDEX IF NOT EXISTS idx_candidates_task_id ON principle_candidates(task_id);
    `);
    rawDb.close();
  }

  it('old schema principle_candidates gets 4 new columns after migration', () => {
    createOldSchemaDb();
    connection = new SqliteConnection(tmpdir);
    const db = connection.getDb();
    const columns = db.prepare('PRAGMA table_info(principle_candidates)').all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain('recommendation_kind');
    expect(names).toContain('trigger_pattern');
    expect(names).toContain('action');
    expect(names).toContain('abstracted_principle');
    expect(columns).toHaveLength(16);
  });

  it('old table with existing candidate row preserves data after migration', () => {
    createOldSchemaDb();
    const dbPath = path.join(tmpdir, '.pd', 'state.db');
    const rawDb = new BetterSqlite3(dbPath);
    rawDb.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at)
        VALUES ('t-mig', 'test', 'pending', '${new Date().toISOString()}', '${new Date().toISOString()}');
      INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at)
        VALUES ('r-mig', 't-mig', 'test', 'succeeded', '${new Date().toISOString()}', 1, '${new Date().toISOString()}', '${new Date().toISOString()}');
      INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
        VALUES ('a-mig', 'r-mig', 't-mig', 'test', '{}', '${new Date().toISOString()}');
      INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at)
        VALUES ('pc-mig', 'a-mig', 't-mig', 'r-mig', 'Test Title', 'Test Description', 'ik-mig-1', 'pending', '${new Date().toISOString()}');
    `);
    rawDb.close();

    connection = new SqliteConnection(tmpdir);
    const db = connection.getDb();
    const row = db.prepare('SELECT title, description, status FROM principle_candidates WHERE candidate_id = ?').get('pc-mig') as { title: string; description: string; status: string };
    expect(row.title).toBe('Test Title');
    expect(row.description).toBe('Test Description');
    expect(row.status).toBe('pending');

    const kindRow = db.prepare('SELECT recommendation_kind FROM principle_candidates WHERE candidate_id = ?').get('pc-mig') as { recommendation_kind: string };
    expect(kindRow.recommendation_kind).toBe('principle');
  });

  it('consecutive initialization does not error', () => {
    createOldSchemaDb();
    connection = new SqliteConnection(tmpdir);
    connection.getDb();
    connection.close();

    const conn2 = new SqliteConnection(tmpdir);
    expect(() => conn2.getDb()).not.toThrow();
    const columns = conn2.getDb().prepare('PRAGMA table_info(principle_candidates)').all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain('recommendation_kind');
    expect(names).toContain('trigger_pattern');
    expect(names).toContain('action');
    expect(names).toContain('abstracted_principle');
    conn2.close();
  });

  it('new DB initialization still has all columns', () => {
    connection = new SqliteConnection(tmpdir);
    const db = connection.getDb();
    const columns = db.prepare('PRAGMA table_info(principle_candidates)').all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain('candidate_id');
    expect(names).toContain('recommendation_kind');
    expect(names).toContain('trigger_pattern');
    expect(names).toContain('action');
    expect(names).toContain('abstracted_principle');
    expect(columns).toHaveLength(16);
  });

  it('readonly connection does not run migration', () => {
    createOldSchemaDb();
    connection = new SqliteConnection({ workspaceDir: tmpdir, readonly: true });
    const db = connection.getDb();
    const columns = db.prepare('PRAGMA table_info(principle_candidates)').all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).not.toContain('recommendation_kind');
    expect(names).not.toContain('trigger_pattern');
    expect(names).not.toContain('action');
    expect(names).not.toContain('abstracted_principle');
  });

  it('recommendation_kind index is created for old schema DB after migration', () => {
    createOldSchemaDb();
    connection = new SqliteConnection(tmpdir);
    const db = connection.getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_candidates_recommendation_kind'"
    ).all() as { name: string }[];
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.name).toBe('idx_candidates_recommendation_kind');
  });

  it('F13 store fallback: updateCandidateStatus sets consumed_at on old-schema db (no CHECK)', async () => {
    createOldSchemaDb();
    connection = new SqliteConnection(tmpdir); // triggers migrateSchema: adds 4 cols, no CHECK
    const db = connection.getDb();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('t-f13a', 'diagnostician', 'pending', now, now);
    db.prepare('INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('r-f13a', 't-f13a', 'test', 'queued', now, 1, now, now);
    db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?,?,?,?,?,?)').run('a-f13a', 'r-f13a', 't-f13a', 'principle', '{}', now);
    db.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at, recommendation_kind) VALUES (?,?,?,?,?,?,?, 'pending', ?, 'principle')`).run('c-f13a', 'a-f13a', 't-f13a', 'r-f13a', 't', 'd', 'idem-f13a', now);

    const store = new SqliteCandidateStore(connection);
    const ok = await store.updateCandidateStatus('c-f13a', { status: 'consumed' });
    expect(ok).toBe(true);

    // store path wrote consumed_at via COALESCE fallback
    const row = db.prepare('SELECT status, consumed_at FROM principle_candidates WHERE candidate_id = ?').get('c-f13a') as { status: string; consumed_at: string | null };
    expect(row.status).toBe('consumed');
    expect(row.consumed_at).not.toBeNull();

    // control: old-schema db has no CHECK, so direct UPDATE with NULL consumed_at does NOT throw
    expect(() => db.prepare("UPDATE principle_candidates SET status = 'consumed', consumed_at = NULL WHERE candidate_id = 'c-f13a'").run()).not.toThrow();
  });

  it('F13 store fallback: transitionCandidateStatus sets consumed_at on old-schema db', async () => {
    createOldSchemaDb();
    connection = new SqliteConnection(tmpdir);
    const db = connection.getDb();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('t-f13b', 'diagnostician', 'pending', now, now);
    db.prepare('INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('r-f13b', 't-f13b', 'test', 'queued', now, 1, now, now);
    db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?,?,?,?,?,?)').run('a-f13b', 'r-f13b', 't-f13b', 'principle', '{}', now);
    db.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at, recommendation_kind) VALUES (?,?,?,?,?,?,?, 'pending', ?, 'principle')`).run('c-f13b', 'a-f13b', 't-f13b', 'r-f13b', 't', 'd', 'idem-f13b', now);

    const store = new SqliteCandidateStore(connection);

    // wrong expected status → returns false (guard生效), row unchanged
    const okWrong = await store.transitionCandidateStatus('c-f13b', 'expired', 'consumed');
    expect(okWrong).toBe(false);
    const rowBefore = db.prepare('SELECT status, consumed_at FROM principle_candidates WHERE candidate_id = ?').get('c-f13b') as { status: string; consumed_at: string | null };
    expect(rowBefore.status).toBe('pending');
    expect(rowBefore.consumed_at).toBeNull();

    // correct expected status → success, consumed_at set via COALESCE fallback
    const ok = await store.transitionCandidateStatus('c-f13b', 'pending', 'consumed');
    expect(ok).toBe(true);
    const rowAfter = db.prepare('SELECT status, consumed_at FROM principle_candidates WHERE candidate_id = ?').get('c-f13b') as { status: string; consumed_at: string | null };
    expect(rowAfter.status).toBe('consumed');
    expect(rowAfter.consumed_at).not.toBeNull();
  });
});