/**
 * lastProgressAt evidence (task §6, FR-10 / AC-12, TD §7.2).
 *
 * `lastProgressAt` must reflect ACTUAL persisted business progress — never
 * process start, PID liveness, worker "ready", or a bare cycle completion
 * over an empty backlog. The primary evidence source is the Workspace's own
 * task table in `.pd/state.db` (the single task authority, SPEC §9): the
 * adapter snapshots (taskId → status) read-only BEFORE and AFTER the cycle,
 * and progress is a NEW task or a STATUS transition. A pure `updatedAt`
 * bump (lease renewal without a state change) is deliberately NOT progress.
 *
 * Read semantics (rc-9 + PRI-991 discipline):
 *  - a workspace with NO state.db yet is an EMPTY task set (`storePresent:
 *    false`), never an error — nothing is persisted, so nothing progressed;
 *    the file is never created by this reader;
 *  - an existing store is opened read-only (pure readonly first; a
 *    query_only recovery open as fallback for WAL/shm corner states);
 *  - a store that exists but cannot be read (corrupt, locked) is a
 *    STRUCTURED failure — the adapter degrades rather than guessing.
 *
 * Secondary (corroborating) evidence comes from the Worker cycle's own
 * structured report (diagnostician succeeded, downstream ran, post-
 * processing resumed, catch-up ingested) — extracted separately by each
 * adapter because the two report shapes differ.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

/** Bounded snapshot: the most recently updated tasks are the diff surface. */
const SNAPSHOT_LIMIT = 500;
const TASK_SNAPSHOT_SQL =
  'SELECT task_id AS taskId, status, updated_at AS updatedAt FROM tasks ORDER BY updated_at DESC LIMIT ?';

export interface TaskProgressSnapshot {
  /** taskId → status (the durable state machine position). */
  readonly tasks: ReadonlyMap<string, string>;
  readonly maxUpdatedAt: string | null;
  /** False when no state.db exists yet (empty task set, not an error). */
  readonly storePresent: boolean;
}

export interface TaskProgressEvidence {
  /** At least one new task or status transition between the two snapshots. */
  readonly taskStateChanged: boolean;
  readonly changedCount: number;
  /** Max updatedAt among changed/new tasks — the progress timestamp, or null. */
  readonly changedAt: string | null;
}

export type TaskProgressRead =
  | { readonly ok: true; readonly snapshot: TaskProgressSnapshot }
  | { readonly ok: false; readonly reason: string };

interface TaskRow {
  taskId: string;
  status: string;
  updatedAt: string;
}

function isTaskRow(value: unknown): value is TaskRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.taskId === 'string'
    && typeof row.status === 'string'
    && typeof row.updatedAt === 'string';
}

/** Open the existing store for reading without creating or logically writing it. */
function openReadonly(dbPath: string): Database.Database {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  } catch {
    // WAL corner states (checkpointed clean, no -shm) can defeat a pure
    // readonly open; a write-CAPABLE open performs the WAL/shm recovery with
    // `query_only` pinning the logical database against any write.
    const db = new Database(dbPath, { fileMustExist: true, timeout: 5_000 });
    db.pragma('query_only = ON');
    return db;
  }
}

/**
 * Read the (taskId → status) task snapshot. Side-effect free: a missing
 * state.db is an empty snapshot; the reader never creates the store.
 */
export function readTaskProgressSnapshot(workspaceDir: string): TaskProgressRead {
  const dbPath = path.join(path.resolve(workspaceDir), '.pd', 'state.db');
  try {
    if (!fs.statSync(dbPath).isFile()) {
      return {
        ok: true,
        snapshot: { tasks: new Map(), maxUpdatedAt: null, storePresent: false },
      };
    }
  } catch {
    return {
      ok: true,
      snapshot: { tasks: new Map(), maxUpdatedAt: null, storePresent: false },
    };
  }
  let db: Database.Database;
  try {
    db = openReadonly(dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `progress_snapshot_open_failed:${message.slice(0, 160)}` };
  }
  try {
    const rows: unknown[] = db.prepare(TASK_SNAPSHOT_SQL).all(SNAPSHOT_LIMIT);
    const tasks = new Map<string, string>();
    let maxUpdatedAt: string | null = null;
    for (const row of rows) {
      if (!isTaskRow(row)) continue;
      tasks.set(row.taskId, row.status);
      if (maxUpdatedAt === null || row.updatedAt > maxUpdatedAt) maxUpdatedAt = row.updatedAt;
    }
    return { ok: true, snapshot: { tasks, maxUpdatedAt, storePresent: true } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `progress_snapshot_read_failed:${message.slice(0, 160)}` };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort close of our own reader
    }
  }
}

/**
 * Diff two snapshots into progress evidence. A change is a NEW taskId or a
 * STATUS transition; updatedAt-only movement (lease renewal) does not count.
 *
 * `changedAt` is the AFTER snapshot's `maxUpdatedAt`: snapshots are ordered
 * updated_at DESC, and any new/transitioned task write either re-bumps the
 * max task or inserts above the previous max — so when anything changed, the
 * newest task-write timestamp IS the progress timestamp. When nothing
 * changed it is null (a completed-but-empty cycle keeps the prior value at
 * the status layer, task §6).
 */
export function diffTaskProgress(before: TaskProgressSnapshot, after: TaskProgressSnapshot): TaskProgressEvidence {
  let changedCount = 0;
  for (const [taskId, status] of after.tasks) {
    const previous = before.tasks.get(taskId);
    if (previous === undefined || previous !== status) changedCount += 1;
  }
  // A task REMOVED between snapshots (e.g. cleanup) is not business progress
  // for this contract — only new/transitioned tasks count.
  const taskStateChanged = changedCount > 0;
  return {
    taskStateChanged,
    changedCount,
    changedAt: taskStateChanged ? after.maxUpdatedAt : null,
  };
}
