import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type Database from 'better-sqlite3';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { TaskRecordSchema, type PDTaskStatus } from '../task-status.js';
import { RunRecordSchema, type RunExecutionStatus } from '../runtime-protocol.js';

describe('SchemaConformance', () => {
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let tmpdir: string;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let connection: SqliteConnection;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let taskStore: SqliteTaskStore;
  // eslint-disable-next-line @typescript-eslint/init-declarations
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
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let tmpdir: string;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let connection: SqliteConnection;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let taskStore: SqliteTaskStore;
  // eslint-disable-next-line @typescript-eslint/init-declarations
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
    expect(columns).toHaveLength(12);
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
    expect(indexes).toHaveLength(8);
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_artifacts_task_id');
    expect(indexNames).toContain('idx_artifacts_run_id');
    expect(indexNames).toContain('idx_artifacts_artifact_kind');
    expect(indexNames).toContain('idx_commits_task_id');
    expect(indexNames).toContain('idx_commits_artifact_id');
    expect(indexNames).toContain('idx_candidates_status');
    expect(indexNames).toContain('idx_candidates_source_run_id');
    expect(indexNames).toContain('idx_candidates_task_id');
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