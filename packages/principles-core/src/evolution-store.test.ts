import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { listEvolutionTasks, getEvolutionTask } from './evolution-store.js';

describe('evolution-store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'principles-core-evolution-store-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
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
        task_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT,
        score REAL DEFAULT 0,
        status TEXT NOT NULL,
        enqueued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        task_kind TEXT,
        priority TEXT,
        retry_count INTEGER,
        max_retries INTEGER,
        last_error TEXT,
        result_ref TEXT
      );
    `);

    const now = '2026-06-15T12:00:00.000Z';
    const earlier = '2026-06-10T08:00:00.000Z';
    const later = '2026-06-20T16:00:00.000Z';

    db.prepare(`
      INSERT INTO evolution_tasks (task_id, trace_id, source, reason, score, status,
        enqueued_at, started_at, completed_at, resolution, created_at, updated_at,
        task_kind, priority, retry_count, max_retries, last_error, result_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'task-001', 'trace-001', 'auto', 'low score', 0.3, 'queued',
      earlier, null, null, null, earlier, earlier,
      'coding', 'high', 0, 3, null, null,
    );

    db.prepare(`
      INSERT INTO evolution_tasks (task_id, trace_id, source, reason, score, status,
        enqueued_at, started_at, completed_at, resolution, created_at, updated_at,
        task_kind, priority, retry_count, max_retries, last_error, result_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'task-002', 'trace-002', 'manual', null, 0.8, 'completed',
      now, now, now, 'applied', now, now,
      'debugging', 'normal', 1, 3, null, 'ref://result/2',
    );

    db.prepare(`
      INSERT INTO evolution_tasks (task_id, trace_id, source, reason, score, status,
        enqueued_at, started_at, completed_at, resolution, created_at, updated_at,
        task_kind, priority, retry_count, max_retries, last_error, result_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'task-003', 'trace-003', 'auto', 'error detected', 0.1, 'failed',
      later, later, later, 'max_retries_exceeded', later, later,
      null, 'critical', 3, 3, 'timeout error', null,
    );

    db.close();
  }

  function seedTestDb() {
    mkdirSync(join(tmpDir, '.state'), { recursive: true });
    setupTestDb(join(tmpDir, '.state', '.trajectory.db'));
  }

  describe('listEvolutionTasks', () => {
    it('returns empty array when DB does not exist', () => {
      const result = listEvolutionTasks(tmpDir);
      expect(result).toEqual([]);
    });

    it('returns all tasks when no filters applied', () => {
      seedTestDb();

      const result = listEvolutionTasks(tmpDir);
      expect(result).toHaveLength(3);
    });

    it('filters by status', () => {
      seedTestDb();

      const result = listEvolutionTasks(tmpDir, { status: 'completed' });
      expect(result).toHaveLength(1);
      const [task] = result;
      if (!task) throw new Error('Expected non-null task');
      expect(task.taskId).toBe('task-002');
      expect(task.status).toBe('completed');
    });

    it('filters by dateFrom', () => {
      seedTestDb();

      const result = listEvolutionTasks(tmpDir, { dateFrom: '2026-06-18T00:00:00.000Z' });
      expect(result).toHaveLength(1);
      const [task] = result;
      if (!task) throw new Error('Expected non-null task');
      expect(task.taskId).toBe('task-003');
    });

    it('filters by dateTo', () => {
      seedTestDb();

      const result = listEvolutionTasks(tmpDir, { dateTo: '2026-06-12T00:00:00.000Z' });
      expect(result).toHaveLength(1);
      const [task] = result;
      if (!task) throw new Error('Expected non-null task');
      expect(task.taskId).toBe('task-001');
    });

    it('filters by both dateFrom and dateTo', () => {
      seedTestDb();

      const result = listEvolutionTasks(tmpDir, {
        dateFrom: '2026-06-12T00:00:00.000Z',
        dateTo: '2026-06-18T00:00:00.000Z',
      });
      expect(result).toHaveLength(1);
      const [task] = result;
      if (!task) throw new Error('Expected non-null task');
      expect(task.taskId).toBe('task-002');
    });

    it('applies limit and offset', () => {
      seedTestDb();

      // Default limit is 50, so all 3 rows are returned
      const all = listEvolutionTasks(tmpDir);
      expect(all).toHaveLength(3);

      // Limit to 2
      const limited = listEvolutionTasks(tmpDir, { limit: 2 });
      expect(limited).toHaveLength(2);

      // Offset 1
      const offset = listEvolutionTasks(tmpDir, { offset: 1 });
      expect(offset).toHaveLength(2);

      // Limit 1, offset 1
      const page = listEvolutionTasks(tmpDir, { limit: 1, offset: 1 });
      expect(page).toHaveLength(1);
    });

    it('orders by created_at DESC', () => {
      seedTestDb();

      const result = listEvolutionTasks(tmpDir);
      expect(result[0]?.taskId).toBe('task-003');
      expect(result[1]?.taskId).toBe('task-002');
      expect(result[2]?.taskId).toBe('task-001');
    });

    it('maps snake_case columns to camelCase fields', () => {
      seedTestDb();

      const result = listEvolutionTasks(tmpDir, { status: 'failed' });
      expect(result).toHaveLength(1);

      const [task] = result;
      if (!task) throw new Error('Expected non-null task');
      expect(task.taskId).toBe('task-003');
      expect(task.traceId).toBe('trace-003');
      expect(task.enqueuedAt).toBe('2026-06-20T16:00:00.000Z');
      expect(task.startedAt).toBe('2026-06-20T16:00:00.000Z');
      expect(task.completedAt).toBe('2026-06-20T16:00:00.000Z');
      expect(task.taskKind).toBeNull();
      expect(task.priority).toBe('critical');
      expect(task.retryCount).toBe(3);
      expect(task.maxRetries).toBe(3);
      expect(task.lastError).toBe('timeout error');
      expect(task.resultRef).toBeNull();
    });

    it('handles NULL optional fields as null', () => {
      seedTestDb();

      // task-001 has nulls for started_at, completed_at, resolution, last_error, result_ref
      const result = listEvolutionTasks(tmpDir, { status: 'queued' });
      expect(result).toHaveLength(1);

      const [task] = result;
      if (!task) throw new Error('Expected non-null task');
      expect(task.reason).toBe('low score');
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
      expect(task.resolution).toBeNull();
      expect(task.lastError).toBeNull();
      expect(task.resultRef).toBeNull();
    });
  });

  describe('getEvolutionTask', () => {
    it('returns null when DB does not exist', () => {
      const result = getEvolutionTask(tmpDir, 1);
      expect(result).toBeNull();
    });

    it('returns null when task not found', () => {
      seedTestDb();

      expect(getEvolutionTask(tmpDir, 999)).toBeNull();
      expect(getEvolutionTask(tmpDir, 'nonexistent-task')).toBeNull();
    });

    it('returns task by numeric id', () => {
      seedTestDb();

      const task = getEvolutionTask(tmpDir, 1);
      expect(task).not.toBeNull();
      if (!task) throw new Error('Expected non-null task');
      expect(task.id).toBe(1);
      expect(task.taskId).toBe('task-001');
    });

    it('returns task by string taskId', () => {
      seedTestDb();

      const task = getEvolutionTask(tmpDir, 'task-002');
      expect(task).not.toBeNull();
      if (!task) throw new Error('Expected non-null task');
      expect(task.taskId).toBe('task-002');
      expect(task.status).toBe('completed');
      expect(task.resolution).toBe('applied');
    });

    it('maps all fields correctly for a completed task', () => {
      seedTestDb();

      const task = getEvolutionTask(tmpDir, 'task-002');
      expect(task).not.toBeNull();
      if (!task) throw new Error('Expected non-null task');
      expect(task.id).toBe(2);
      expect(task.taskId).toBe('task-002');
      expect(task.traceId).toBe('trace-002');
      expect(task.source).toBe('manual');
      expect(task.reason).toBeNull();
      expect(task.score).toBe(0.8);
      expect(task.status).toBe('completed');
      expect(task.enqueuedAt).toBe('2026-06-15T12:00:00.000Z');
      expect(task.startedAt).toBe('2026-06-15T12:00:00.000Z');
      expect(task.completedAt).toBe('2026-06-15T12:00:00.000Z');
      expect(task.resolution).toBe('applied');
      expect(task.createdAt).toBe('2026-06-15T12:00:00.000Z');
      expect(task.updatedAt).toBe('2026-06-15T12:00:00.000Z');
      expect(task.taskKind).toBe('debugging');
      expect(task.priority).toBe('normal');
      expect(task.retryCount).toBe(1);
      expect(task.maxRetries).toBe(3);
      expect(task.lastError).toBeNull();
      expect(task.resultRef).toBe('ref://result/2');
    });
  });
});
