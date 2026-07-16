import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import {
  listEvolutionTasks,
  getEvolutionTask,
  type EvolutionTaskRecord,
} from './evolution-store.js';

describe('evolution-store', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = join(process.cwd(), 'tmp-test-evolution-store-' + Date.now());
    stateDir = join(tmpDir, '.state');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore errors on tmp teardown.
    }
  });

  function setupTestDb(dbPath: string) {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE evolution_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT UNIQUE NOT NULL,
        trace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT,
        score INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        enqueued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        resolution TEXT,
        task_kind TEXT,
        priority TEXT,
        retry_count INTEGER,
        max_retries INTEGER,
        last_error TEXT,
        result_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const now = '2026-06-01T00:00:00.000Z';

    db.prepare(`
      INSERT INTO evolution_tasks (
        task_id, trace_id, source, reason, score, status,
        enqueued_at, started_at, completed_at, resolution,
        task_kind, priority, retry_count, max_retries, last_error, result_ref,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'task-001',
      'trace-001',
      'pain_signal',
      'High pain detected',
      85,
      'completed',
      '2026-06-01T00:01:00.000Z',
      '2026-06-01T00:02:00.000Z',
      '2026-06-01T00:05:00.000Z',
      'resolved',
      'debugging',
      'high',
      0,
      3,
      null,
      'result-001',
      now,
      now,
    );

    db.prepare(`
      INSERT INTO evolution_tasks (
        task_id, trace_id, source, reason, score, status,
        enqueued_at, started_at, completed_at, resolution,
        task_kind, priority, retry_count, max_retries, last_error, result_ref,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'task-002',
      'trace-002',
      'code_review',
      null,
      42,
      'pending',
      null,
      null,
      null,
      null,
      'coding',
      'low',
      1,
      5,
      'timeout',
      null,
      '2026-06-02T00:00:00.000Z',
      '2026-06-02T00:00:00.000Z',
    );

    db.prepare(`
      INSERT INTO evolution_tasks (
        task_id, trace_id, source, reason, score, status,
        enqueued_at, started_at, completed_at, resolution,
        task_kind, priority, retry_count, max_retries, last_error, result_ref,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'task-003',
      'trace-003',
      'manual',
      'User reported issue',
      0,
      'failed',
      '2026-06-03T00:01:00.000Z',
      '2026-06-03T00:02:00.000Z',
      '2026-06-03T00:03:00.000Z',
      'failed',
      'reasoning',
      'critical',
      2,
      2,
      'max retries exceeded',
      null,
      '2026-06-03T00:00:00.000Z',
      '2026-06-03T00:00:00.000Z',
    );

    db.close();
  }

  describe('listEvolutionTasks', () => {
    it('returns empty array when DB does not exist', () => {
      const result = listEvolutionTasks(tmpDir);
      expect(result).toEqual([]);
    });

    it('returns all tasks when no filters provided', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir);
      expect(result).toHaveLength(3);
      expect(result[0]?.taskId).toBe('task-003');
      expect(result[1]?.taskId).toBe('task-002');
      expect(result[2]?.taskId).toBe('task-001');
    });

    it('filters by status', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const completed = listEvolutionTasks(tmpDir, { status: 'completed' });
      expect(completed).toHaveLength(1);
      expect(completed[0]?.taskId).toBe('task-001');

      const pending = listEvolutionTasks(tmpDir, { status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.taskId).toBe('task-002');
    });

    it('filters by dateFrom', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir, { dateFrom: '2026-06-02T00:00:00.000Z' });
      expect(result).toHaveLength(2);
      expect(result[0]?.taskId).toBe('task-003');
      expect(result[1]?.taskId).toBe('task-002');
    });

    it('filters by dateTo', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir, { dateTo: '2026-06-02T00:00:00.000Z' });
      expect(result).toHaveLength(2);
      expect(result[0]?.taskId).toBe('task-002');
      expect(result[1]?.taskId).toBe('task-001');
    });

    it('filters by date range', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir, {
        dateFrom: '2026-06-01T12:00:00.000Z',
        dateTo: '2026-06-02T12:00:00.000Z',
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.taskId).toBe('task-002');
    });

    it('respects limit', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir, { limit: 2 });
      expect(result).toHaveLength(2);
      expect(result[0]?.taskId).toBe('task-003');
      expect(result[1]?.taskId).toBe('task-002');
    });

    it('respects offset', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir, { offset: 1 });
      expect(result).toHaveLength(2);
      expect(result[0]?.taskId).toBe('task-002');
      expect(result[1]?.taskId).toBe('task-001');
    });

    it('combines limit and offset for pagination', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const page1 = listEvolutionTasks(tmpDir, { limit: 2, offset: 0 });
      const page2 = listEvolutionTasks(tmpDir, { limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      expect(page1[0]?.taskId).toBe('task-003');
      expect(page2[0]?.taskId).toBe('task-001');
    });

    it('applies status filter with limit and offset', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir, {
        status: 'completed',
        limit: 1,
        offset: 0,
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.status).toBe('completed');
    });

    it('returns empty array when status matches nothing', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir, { status: 'nonexistent' });
      expect(result).toEqual([]);
    });

    it('maps all fields correctly from DB rows', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir, { status: 'completed' });
      expect(result).toHaveLength(1);
      const task = result[0] as EvolutionTaskRecord;

      expect(task.id).toBe(1);
      expect(task.taskId).toBe('task-001');
      expect(task.traceId).toBe('trace-001');
      expect(task.source).toBe('pain_signal');
      expect(task.reason).toBe('High pain detected');
      expect(task.score).toBe(85);
      expect(task.status).toBe('completed');
      expect(task.enqueuedAt).toBe('2026-06-01T00:01:00.000Z');
      expect(task.startedAt).toBe('2026-06-01T00:02:00.000Z');
      expect(task.completedAt).toBe('2026-06-01T00:05:00.000Z');
      expect(task.resolution).toBe('resolved');
      expect(task.taskKind).toBe('debugging');
      expect(task.priority).toBe('high');
      expect(task.retryCount).toBe(0);
      expect(task.maxRetries).toBe(3);
      expect(task.lastError).toBeNull();
      expect(task.resultRef).toBe('result-001');
      expect(task.createdAt).toBe('2026-06-01T00:00:00.000Z');
      expect(task.updatedAt).toBe('2026-06-01T00:00:00.000Z');
    });

    it('handles NULL fields correctly', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir, { status: 'pending' });
      expect(result).toHaveLength(1);
      const task = result[0] as EvolutionTaskRecord;

      expect(task.reason).toBeNull();
      expect(task.enqueuedAt).toBeNull();
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
      expect(task.resolution).toBeNull();
      expect(task.resultRef).toBeNull();
      expect(task.lastError).toBe('timeout');
    });

    it('orders by created_at DESC by default', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = listEvolutionTasks(tmpDir);
      expect(result).toHaveLength(3);
      const dates = result.map(r => r.createdAt);
      expect(dates[0]! > dates[1]!).toBe(true);
      expect(dates[1]! > dates[2]!).toBe(true);
    });

    it('throws when table does not exist in DB', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE some_other_table (id INTEGER PRIMARY KEY)');
      db.close();

      expect(() => listEvolutionTasks(tmpDir)).toThrow(/no such table/);
    });
  });

  describe('getEvolutionTask', () => {
    it('returns null when DB does not exist', () => {
      const result = getEvolutionTask(tmpDir, 'task-001');
      expect(result).toBeNull();
    });

    it('returns task by numeric id', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = getEvolutionTask(tmpDir, 1);
      expect(result).not.toBeNull();
      expect(result?.taskId).toBe('task-001');
    });

    it('returns task by string taskId', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = getEvolutionTask(tmpDir, 'task-002');
      expect(result).not.toBeNull();
      expect(result?.taskId).toBe('task-002');
      expect(result?.source).toBe('code_review');
    });

    it('returns null when task not found by taskId', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = getEvolutionTask(tmpDir, 'nonexistent-task');
      expect(result).toBeNull();
    });

    it('returns null when numeric id not found', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = getEvolutionTask(tmpDir, 999);
      expect(result).toBeNull();
    });

    it('maps all fields correctly when getting by taskId', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const task = getEvolutionTask(tmpDir, 'task-003');
      expect(task).not.toBeNull();
      if (!task) return;

      expect(task.id).toBe(3);
      expect(task.taskId).toBe('task-003');
      expect(task.traceId).toBe('trace-003');
      expect(task.source).toBe('manual');
      expect(task.reason).toBe('User reported issue');
      expect(task.score).toBe(0);
      expect(task.status).toBe('failed');
      expect(task.taskKind).toBe('reasoning');
      expect(task.priority).toBe('critical');
      expect(task.retryCount).toBe(2);
      expect(task.maxRetries).toBe(2);
      expect(task.lastError).toBe('max retries exceeded');
    });

    it('throws when table does not exist in DB', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE some_other_table (id INTEGER PRIMARY KEY)');
      db.close();

      expect(() => getEvolutionTask(tmpDir, 'task-001')).toThrow(/no such table/);
    });

    it('handles empty string taskId', () => {
      const dbPath = join(stateDir, '.trajectory.db');
      setupTestDb(dbPath);

      const result = getEvolutionTask(tmpDir, '');
      expect(result).toBeNull();
    });
  });
});
