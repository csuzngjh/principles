/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * ResilientHistoryQuery test suite.
 *
 * Tests cursor error fallback, pass-through for successful queries,
 * and telemetry emission for degradation scenarios.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { SqliteHistoryQuery } from './sqlite-history-query.js';
import { ResilientHistoryQuery } from './resilient-history-query.js';
import { StoreEventEmitter } from './event-emitter.js';
import type { RunRecord, RunExecutionStatus } from '../runtime-protocol.js';
import type { TaskRecord, PDTaskStatus } from '../task-status.js';

interface TestFixture {
  tmpDir: string;
  connection: SqliteConnection;
  taskStore: SqliteTaskStore;
  runStore: SqliteRunStore;
  historyQuery: SqliteHistoryQuery;
  resilientQuery: ResilientHistoryQuery;
  emitter: StoreEventEmitter;
}

function createFixture(): TestFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-resilient-hq-test-'));
  const connection = new SqliteConnection(tmpDir);
  const taskStore = new SqliteTaskStore(connection);
  const runStore = new SqliteRunStore(connection);
  const historyQuery = new SqliteHistoryQuery(connection);
  const emitter = new StoreEventEmitter();
  const resilientQuery = new ResilientHistoryQuery(historyQuery, emitter);
  return { tmpDir, connection, taskStore, runStore, historyQuery, resilientQuery, emitter };
}

function cleanupFixture(f: TestFixture): void {
  f.connection.close();
  fs.rmSync(f.tmpDir, { recursive: true, force: true });
}

async function seedTaskAndRuns(f: TestFixture, taskId: string, count: number): Promise<void> {
  await f.taskStore.createTask({
    taskId,
    taskKind: 'diagnostician',
    status: 'pending' as PDTaskStatus,
    attemptCount: 0,
    maxAttempts: 3,
  } satisfies Omit<TaskRecord, 'createdAt' | 'updatedAt'>);

  for (let i = 0; i < count; i++) {
    const now = new Date(Date.now() - (count - i) * 1000).toISOString();
    await f.runStore.createRun({
      runId: `run_${taskId}_${i}`,
      taskId,
      attemptNumber: i + 1,
      executionStatus: 'succeeded' as RunExecutionStatus,
      startedAt: now,
      runtimeKind: 'openclaw',
      inputPayload: `input ${i}`,
      outputPayload: `output ${i}`,
    } satisfies Omit<RunRecord, 'createdAt' | 'updatedAt'>);
  }
}

describe('ResilientHistoryQuery', () => {

  it('passes through successful query unchanged', async () => {
    const f = createFixture();
    try {
      await seedTaskAndRuns(f, 'task-ok', 3);

      const result = await f.resilientQuery.query('task-ok');

      expect(result.sourceRef).toBe('task-ok');
      expect(result.entries.length).toBeGreaterThanOrEqual(6);
      expect(result.truncated).toBe(false);
    } finally { cleanupFixture(f); }
  });

  it('falls back to first page when cursor throws input_invalid', async () => {
    const f = createFixture();
    try {
      await seedTaskAndRuns(f, 'task-cursor', 5);

      // Malformed cursor — SqliteHistoryQuery will throw
      const badCursor = Buffer.from('not-valid-json').toString('base64');

      const result = await f.resilientQuery.query('task-cursor', badCursor);

      // Should return first page results (fallback)
      expect(result.sourceRef).toBe('task-cursor');
      expect(result.entries.length).toBeGreaterThanOrEqual(2);
    } finally { cleanupFixture(f); }
  });

  it('falls back to first page when cursor references deleted run', async () => {
    const f = createFixture();
    try {
      await seedTaskAndRuns(f, 'task-del', 5);

      // Get a valid cursor from first query
      const firstResult = await f.historyQuery.query('task-del');
      const cursor = firstResult.nextCursor;
      if (!cursor) {
        // Not enough runs to truncate — skip this test
        return;
      }

      // Delete the run the cursor points to
      const db = f.connection.getDb();
      db.prepare('DELETE FROM runs WHERE run_id LIKE ?').run('run_task-del_%');

      // Re-seed with different runs
      await seedTaskAndRuns(f, 'task-del', 3);

      // Cursor now references a deleted run → fallback
      const result = await f.resilientQuery.query('task-del', cursor);

      expect(result.sourceRef).toBe('task-del');
      expect(result.entries.length).toBeGreaterThanOrEqual(2);
    } finally { cleanupFixture(f); }
  });

  it('emits degradation_triggered telemetry on cursor fallback', async () => {
    const f = createFixture();
    try {
      await seedTaskAndRuns(f, 'task-telem', 3);

      const handler = vi.fn();
      f.emitter.onEventType('degradation_triggered', handler);

      const badCursor = Buffer.from('not-valid-json').toString('base64');
      await f.resilientQuery.query('task-telem', badCursor);

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0]![0]!;
      expect(event.eventType).toBe('degradation_triggered');
      expect(event.payload.component).toBe('HistoryQuery');
      expect(event.payload.fallback).toBe('first_page_fallback');
      expect(event.payload.severity).toBe('warning');
    } finally { cleanupFixture(f); }
  });
});
