/**
 * Evolution Store — evolution task primitives for SDK use.
 *
 * Extracts listEvolutionTasks and getEvolutionTask from TrajectoryDatabase
 * as pure functions that can be used without openclaw-plugin dependency.
 *
 * @example
 * import { listEvolutionTasks, getEvolutionTask } from '@principles/core/evolution-store';
 */

import Database from 'better-sqlite3';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types (copied from trajectory-types.ts — do NOT import from openclaw-plugin)
// ---------------------------------------------------------------------------

export type TaskKind = 'coding' | 'debugging' | 'reasoning' | 'creative';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export interface EvolutionTaskRecord {
  id: number;
  taskId: string;
  traceId: string;
  source: string;
  reason: string | null;
  score: number;
  status: string;
  enqueuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  taskKind: TaskKind | null;
  priority: TaskPriority | null;
  retryCount: number | null;
  maxRetries: number | null;
  lastError: string | null;
  resultRef: string | null;
}

export interface EvolutionTaskFilters {
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDbPath(workspaceDir: string): string {
  return join(workspaceDir, '.state', '.trajectory.db');
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * List evolution tasks with optional filtering.
 *
 * @param workspaceDir - The workspace directory (DB path: {workspaceDir}/.state/.trajectory.db)
 * @param filters - Optional filters (status, dateFrom, dateTo, limit, offset)
 * @returns Array of EvolutionTaskRecord, or empty array if DB does not exist
 */
export function listEvolutionTasks(
  workspaceDir: string,
  filters: EvolutionTaskFilters = {},
): EvolutionTaskRecord[] {
  const dbPath = getDbPath(workspaceDir);

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    // Graceful fallback: DB does not exist yet
    return [];
  }

  try {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters.status) {
      conditions.push('status = ?');
      values.push(filters.status);
    }
    if (filters.dateFrom) {
      conditions.push('created_at >= ?');
      values.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push('created_at <= ?');
      values.push(filters.dateTo);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const rows = db.prepare(`
      SELECT id, task_id, trace_id, source, reason, score, status,
             enqueued_at, started_at, completed_at, resolution, created_at, updated_at,
             task_kind, priority, retry_count, max_retries, last_error, result_ref
      FROM evolution_tasks
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      traceId: String(row.trace_id),
      source: String(row.source),
      reason: row.reason ? String(row.reason) : null,
      score: Number(row.score ?? 0),
      status: String(row.status),
      enqueuedAt: row.enqueued_at ? String(row.enqueued_at) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      resolution: row.resolution ? String(row.resolution) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      taskKind: row.task_kind ? (row.task_kind as TaskKind) : null,
      priority: row.priority ? (row.priority as TaskPriority) : null,
      retryCount: row.retry_count != null ? Number(row.retry_count) : null,
      maxRetries: row.max_retries != null ? Number(row.max_retries) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      resultRef: row.result_ref ? String(row.result_ref) : null,
    }));
  } finally {
    db.close();
  }
}

/**
 * Get a single evolution task by numeric id or string taskId.
 *
 * @param workspaceDir - The workspace directory (DB path: {workspaceDir}/.state/.trajectory.db)
 * @param idOrTaskId - Numeric id or string taskId
 * @returns EvolutionTaskRecord or null if not found
 */
export function getEvolutionTask(
  workspaceDir: string,
  idOrTaskId: string | number,
): EvolutionTaskRecord | null {
  const dbPath = getDbPath(workspaceDir);

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    // Graceful fallback: DB does not exist yet
    return null;
  }

  try {
    const isNumeric = typeof idOrTaskId === 'number';
    const whereClause = isNumeric ? 'WHERE id = ?' : 'WHERE task_id = ?';
    const param = isNumeric ? idOrTaskId : String(idOrTaskId);

    const row = db.prepare(`
      SELECT id, task_id, trace_id, source, reason, score, status,
             enqueued_at, started_at, completed_at, resolution, created_at, updated_at,
             task_kind, priority, retry_count, max_retries, last_error, result_ref
      FROM evolution_tasks
      ${whereClause}
    `).get(param) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      id: Number(row.id),
      taskId: String(row.task_id),
      traceId: String(row.trace_id),
      source: String(row.source),
      reason: row.reason ? String(row.reason) : null,
      score: Number(row.score ?? 0),
      status: String(row.status),
      enqueuedAt: row.enqueued_at ? String(row.enqueued_at) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      resolution: row.resolution ? String(row.resolution) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      taskKind: row.task_kind ? (row.task_kind as TaskKind) : null,
      priority: row.priority ? (row.priority as TaskPriority) : null,
      retryCount: row.retry_count != null ? Number(row.retry_count) : null,
      maxRetries: row.max_retries != null ? Number(row.max_retries) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      resultRef: row.result_ref ? String(row.result_ref) : null,
    };
  } finally {
    db.close();
  }
}
