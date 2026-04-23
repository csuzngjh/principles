import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
      status: 'pending' as PDTaskStatus,
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
      status: 'pending' as PDTaskStatus,
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
      status: 'pending' as PDTaskStatus,
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
      status: 'pending' as PDTaskStatus,
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
        status: 'pending' as PDTaskStatus,
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
      status: 'pending' as PDTaskStatus,
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