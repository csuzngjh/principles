/**
 * Workspace isolation integration test.
 *
 * Verifies that two workspaces with separate SqliteConnection instances
 * cannot see each other's data through any store operation.
 *
 * Tests RET-11 (workspace ID required) and RET-12 (no cross-workspace leakage).
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { SqliteTrajectoryLocator } from './sqlite-trajectory-locator.js';
import { SqliteHistoryQuery } from './sqlite-history-query.js';
import { SqliteContextAssembler } from './sqlite-context-assembler.js';
import type { TaskRecord, PDTaskStatus, DiagnosticianTaskRecord } from '../task-status.js';
import type { RunRecord, RunExecutionStatus } from '../runtime-protocol.js';

interface WorkspaceFixture {
  tmpDir: string;
  connection: SqliteConnection;
  taskStore: SqliteTaskStore;
  runStore: SqliteRunStore;
  locator: SqliteTrajectoryLocator;
  historyQuery: SqliteHistoryQuery;
  assembler: SqliteContextAssembler;
}

function createWorkspace(prefix: string): WorkspaceFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pd-workspace-${prefix}-`));
  const connection = new SqliteConnection(tmpDir);
  const taskStore = new SqliteTaskStore(connection);
  const runStore = new SqliteRunStore(connection);
  const locator = new SqliteTrajectoryLocator(connection);
  const historyQuery = new SqliteHistoryQuery(connection);
  const assembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);
  return { tmpDir, connection, taskStore, runStore, locator, historyQuery, assembler };
}

function cleanupWorkspace(f: WorkspaceFixture): void {
  f.connection.close();
  fs.rmSync(f.tmpDir, { recursive: true, force: true });
}

async function seedTaskAndRun(f: WorkspaceFixture, taskId: string): Promise<void> {
  await f.taskStore.createTask({
    taskId,
    taskKind: 'diagnostician',
    status: 'pending' as PDTaskStatus,
    attemptCount: 0,
    maxAttempts: 3,
  } satisfies Omit<TaskRecord, 'createdAt' | 'updatedAt'>);

  const now = new Date().toISOString();
  await f.runStore.createRun({
    runId: `run_${taskId}_1`,
    taskId,
    attemptNumber: 1,
    executionStatus: 'succeeded' as RunExecutionStatus,
    startedAt: now,
    runtimeKind: 'openclaw',
    inputPayload: `input for ${taskId}`,
    outputPayload: `output for ${taskId}`,
  } satisfies Omit<RunRecord, 'createdAt' | 'updatedAt'>);
}

describe('Workspace Isolation', () => {
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let wsA: WorkspaceFixture;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let wsB: WorkspaceFixture;

  beforeEach(() => {
    wsA = createWorkspace('a');
    wsB = createWorkspace('b');
  });

  afterEach(() => {
    cleanupWorkspace(wsA);
    cleanupWorkspace(wsB);
  });

  it('tasks do not leak across workspaces', async () => {
    await seedTaskAndRun(wsA, 'task-alpha');

    const tasksA = await wsA.taskStore.listTasks();
    const tasksB = await wsB.taskStore.listTasks();

    expect(tasksA.length).toBe(1);
    expect(tasksA[0]!.taskId).toBe('task-alpha');
    expect(tasksB.length).toBe(0);
  });

  it('runs do not leak across workspaces', async () => {
    await seedTaskAndRun(wsA, 'task-alpha');

    const runsA = await wsA.runStore.listRunsByTask('task-alpha');
    const runsB = await wsB.runStore.listRunsByTask('task-alpha');

    expect(runsA.length).toBe(1);
    expect(runsB.length).toBe(0);
  });

  it('trajectory locator does not leak across workspaces', async () => {
    await seedTaskAndRun(wsA, 'task-alpha');

    const resultA = await wsA.locator.locate({ taskId: 'task-alpha' });
    const resultB = await wsB.locator.locate({ taskId: 'task-alpha' });

    expect(resultA.candidates.length).toBe(1);
    expect(resultB.candidates.length).toBe(0);
  });

  it('history query does not leak across workspaces', async () => {
    await seedTaskAndRun(wsA, 'task-alpha');

    const historyA = await wsA.historyQuery.query('task-alpha');
    const historyB = await wsB.historyQuery.query('task-alpha');

    expect(historyA.entries.length).toBeGreaterThanOrEqual(2);
    expect(historyB.entries.length).toBe(0);
  });

  it('context assembler fails on other workspace task', async () => {
    // Seed only in wsB
    await seedTaskAndRun(wsB, 'task-beta');

    // wsA assembler should throw (task not found in wsA's DB)
    await expect(wsA.assembler.assemble('task-beta')).rejects.toThrow('[storage_unavailable]');
  });

  it('context assembler succeeds in owning workspace', async () => {
    // Create a task with diagnostician-specific fields via mock TaskStore
    const diagTask: TaskRecord & Record<string, unknown> = {
      taskId: 'task-diag',
      taskKind: 'diagnostician',
      status: 'pending' as PDTaskStatus,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 0,
      maxAttempts: 3,
      workspaceDir: '/tmp/ws-test',
      reasonSummary: 'Test isolation',
    };

    const mockTaskStore = {
      createTask: async () => { throw new Error('not implemented'); },
      getTask: async (id: string) => id === 'task-diag' ? diagTask as DiagnosticianTaskRecord : null,
      updateTask: async () => { throw new Error('not implemented'); },
      listTasks: async () => [],
      deleteTask: async () => true,
    };

    await seedTaskAndRun(wsA, 'task-diag');
    const assembler = new SqliteContextAssembler(mockTaskStore, wsA.historyQuery, wsA.runStore);

    const payload = await assembler.assemble('task-diag');
    expect(payload.taskId).toBe('task-diag');
    expect(payload.workspaceDir).toBe('/tmp/ws-test');
  });

  it('separate DB files per workspace', async () => {
    // Trigger DB creation by performing an operation
    await wsA.taskStore.listTasks();
    await wsB.taskStore.listTasks();

    const dbPathA = path.join(wsA.tmpDir, '.pd', 'state.db');
    const dbPathB = path.join(wsB.tmpDir, '.pd', 'state.db');

    expect(fs.existsSync(dbPathA)).toBe(true);
    expect(fs.existsSync(dbPathB)).toBe(true);
    expect(dbPathA).not.toBe(dbPathB);
  });
});
