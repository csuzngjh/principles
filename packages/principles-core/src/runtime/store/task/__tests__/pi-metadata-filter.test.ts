import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SqliteConnection } from '../../sqlite-connection.js';
import { SqliteTaskStore } from '../sqlite-task-store.js';
import { MemoryTaskStore } from '../memory-task-store.js';
import type { TaskStore } from '../task-store.js';
import { PD_TASK_STATUSES, type PDTaskStatus, type TaskRecord } from '../../../task-status.js';

function diagnosticJson(piMetadata: Record<string, unknown>): string {
  return JSON.stringify({ pi_metadata: piMetadata });
}

function taskInput(
  taskId: string,
  overrides: Partial<Omit<TaskRecord, 'createdAt' | 'updatedAt'>> = {},
): Omit<TaskRecord, 'createdAt' | 'updatedAt'> {
  return {
    taskId,
    taskKind: 'evaluator',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

function piFields(fields: { parentTaskId?: unknown; channel?: unknown }): Record<string, unknown> {
  return {
    dependencyTaskIds: [],
    channel: 'prompt',
    timeoutMs: 300000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    ...fields,
  };
}

async function seedSuccessorFilterFixture(store: TaskStore): Promise<void> {
  await store.createTask(taskInput('target', {
    diagnosticJson: diagnosticJson(piFields({ parentTaskId: 'parent-a', channel: 'prompt' })),
  }));
  await store.createTask(taskInput('other-parent', {
    diagnosticJson: diagnosticJson(piFields({ parentTaskId: 'parent-b', channel: 'prompt' })),
  }));
  await store.createTask(taskInput('other-channel', {
    diagnosticJson: diagnosticJson(piFields({ parentTaskId: 'parent-a', channel: 'code_tool_hook' })),
  }));
  await store.createTask(taskInput('other-kind', {
    taskKind: 'scribe',
    diagnosticJson: diagnosticJson(piFields({ parentTaskId: 'parent-a', channel: 'prompt' })),
  }));
  await store.createTask(taskInput('missing-parent', {
    diagnosticJson: diagnosticJson(piFields({ channel: 'prompt' })),
  }));
}

async function expectSameIds(store: TaskStore, filter: Parameters<TaskStore['listTasks']>[0], expected: string[]): Promise<void> {
  const rows = await store.listTasks(filter);
  expect(rows.map((row) => row.taskId).sort()).toEqual([...expected].sort());
}

interface StoreFixture {
  readonly store: TaskStore;
  readonly close: () => void;
}

function makeSqliteStore(): StoreFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pi-filter-sqlite-'));
  const connection = new SqliteConnection(dir);
  return {
    store: new SqliteTaskStore(connection),
    close: () => {
      connection.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows temp cleanup */ }
    },
  };
}

function makeMemoryStore(): StoreFixture {
  return { store: new MemoryTaskStore(), close: () => undefined };
}

describe.each([
  ['sqlite', makeSqliteStore],
  ['memory', makeMemoryStore],
] as const)('TaskStore pi metadata filter parity (%s)', (_name, makeStore) => {
  let cleanup: () => void = () => undefined;

  afterEach(() => cleanup());

  async function withStore(run: (store: TaskStore) => Promise<void>): Promise<void> {
    const made = makeStore();
    cleanup = made.close;
    try {
      await run(made.store);
    } finally {
      made.close();
      cleanup = () => undefined;
    }
  }

  it('filters exact parentTaskId + channel + taskKind across all statuses', async () => {
    await withStore(async (store) => {
      await seedSuccessorFilterFixture(store);
      await expectSameIds(store, {
        statuses: [...PD_TASK_STATUSES],
        taskKind: 'evaluator',
        piParentTaskId: 'parent-a',
        piChannel: 'prompt',
      }, ['target']);
    });
  });

  it.each([...PD_TASK_STATUSES])('finds exact metadata rows in status %s', async (status: PDTaskStatus) => {
    await withStore(async (store) => {
      const taskId = 'target-' + status;
      await store.createTask(taskInput(taskId, {
        status,
        diagnosticJson: diagnosticJson(piFields({ parentTaskId: 'parent-a', channel: 'prompt' })),
      }));
      await expectSameIds(store, {
        statuses: [...PD_TASK_STATUSES],
        taskKind: 'evaluator',
        piParentTaskId: 'parent-a',
        piChannel: 'prompt',
      }, [taskId]);
    });
  });

  it('distinguishes missing/null metadata from empty-string values strictly', async () => {
    await withStore(async (store) => {
      await store.createTask(taskInput('missing-parent', {
        diagnosticJson: diagnosticJson(piFields({ channel: 'prompt' })),
      }));
      await store.createTask(taskInput('empty-parent', {
        diagnosticJson: diagnosticJson(piFields({ parentTaskId: '', channel: 'prompt' })),
      }));
      await store.createTask(taskInput('empty-channel', {
        diagnosticJson: diagnosticJson(piFields({ parentTaskId: 'parent-a', channel: '' })),
      }));
      await store.createTask(taskInput('null-parent', {
        diagnosticJson: diagnosticJson(piFields({ parentTaskId: null, channel: 'prompt' })),
      }));
      await store.createTask(taskInput('null-channel', {
        diagnosticJson: diagnosticJson(piFields({ parentTaskId: 'parent-a', channel: null })),
      }));
      await store.createTask(taskInput('null-envelope', {
        diagnosticJson: JSON.stringify({ pi_metadata: null }),
      }));
      await store.createTask(taskInput('non-object-envelope', {
        diagnosticJson: JSON.stringify({ pi_metadata: 'corrupt' }),
      }));
      await store.createTask(taskInput('missing-envelope', {
        diagnosticJson: JSON.stringify({ other: { parentTaskId: '', channel: '' } }),
      }));

      await expectSameIds(store, { piParentTaskId: '' }, ['empty-parent']);
      await expectSameIds(store, { piChannel: '' }, ['empty-channel']);
      await expectSameIds(store, { piParentTaskId: 'parent-a' }, ['empty-channel', 'null-channel']);
    });
  });

  it('does not match array/object metadata through SQLite JSON text coercion', async () => {
    await withStore(async (store) => {
      await store.createTask(taskInput('array-parent', {
        diagnosticJson: diagnosticJson(piFields({ parentTaskId: [], channel: 'prompt' })),
      }));
      await store.createTask(taskInput('array-channel', {
        diagnosticJson: diagnosticJson(piFields({ parentTaskId: 'parent-a', channel: [] })),
      }));

      await expectSameIds(store, { piParentTaskId: '[]' }, []);
      await expectSameIds(store, { piChannel: '[]' }, []);
    });
  });
});
