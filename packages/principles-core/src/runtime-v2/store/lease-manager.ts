/**
 * Lease Manager — atomic lease lifecycle for PD Runtime v2 tasks.
 *
 * Manages the full lease lifecycle:
 *   - acquire: atomically claim a pending/retry_wait task and create a Run record
 *   - release: release a lease back to pending (caller cancelled)
 *   - renew: extend the lease duration for a currently leased task
 *   - isLeaseExpired: check if a task's lease has expired
 *   - forceExpire: recovery mechanism to clear a stale lease (no owner check)
 *
 * Source: PD Runtime Protocol SPEC v1, Section 12 (Task lease protocol)
 * Source: Diagnostician v2 Detailed Design, Section 7-8 (Task queue, lease)
 */
import { PDRuntimeError } from '../error-categories.js';
import type { TaskRecord } from '../task-status.js';
import type { TaskStore } from './task-store.js';
import type { RunStore } from './run-store.js';
import type { SqliteConnection } from './sqlite-connection.js';

// ── Options ──────────────────────────────────────────────────────────────────

export interface AcquireLeaseOptions {
  taskId: string;
  owner: string;
  durationMs?: number;
  runtimeKind: string;
}

// ── LeaseManager interface ───────────────────────────────────────────────────

export interface LeaseManager {
  /**
   * Atomically acquire a lease on a task.
   *
   * Preconditions:
   *   - Task must exist
   *   - Task status must be 'pending' or 'retry_wait'
   *
   * Side effects (same transaction):
   *   - Task status → 'leased'
   *   - lease_owner, lease_expires_at set
   *   - A new Run record is created with execution_status = 'running'
   *
   * @returns The updated TaskRecord
   * @throws PDRuntimeError with category 'storage_unavailable' if task not found
   * @throws PDRuntimeError with category 'lease_conflict' if task not in acquireable state
   */
  acquireLease(options: AcquireLeaseOptions): Promise<TaskRecord>;

  /**
   * Release a lease, returning the task to pending state.
   *
   * Preconditions:
   *   - Task must exist
   *   - The calling owner must match the current lease_owner
   *
   * @returns The updated TaskRecord (status = 'pending')
   * @throws PDRuntimeError with category 'storage_unavailable' if task not found
   * @throws PDRuntimeError with category 'lease_conflict' if owner does not match
   */
  releaseLease(taskId: string, owner: string): Promise<TaskRecord>;

  /**
   * Renew (extend) the lease duration for a currently leased task.
   *
   * Preconditions:
   *   - Task must exist
   *   - Task must be in 'leased' state
   *   - The calling owner must match the current lease_owner
   *
   * @param durationMs - New lease duration from now (default: 300_000 ms / 5 minutes)
   * @returns The updated TaskRecord with new lease_expires_at
   * @throws PDRuntimeError with category 'storage_unavailable' if task not found
   * @throws PDRuntimeError with category 'lease_conflict' if owner/state check fails
   */
  renewLease(taskId: string, owner: string, durationMs?: number): Promise<TaskRecord>;

  /**
   * Check whether a task's lease has expired.
   *
   * Returns false if the task is not in 'leased' state or has no lease_expires_at.
   *
   * @returns true if the lease has expired, false otherwise
   */
  isLeaseExpired(task: TaskRecord): boolean;

  /**
   * Force-expire a lease without owner check (recovery use only).
   *
   * Used by the recovery sweep to reclaim tasks whose lease owner died.
   *
   * @returns The updated TaskRecord (status = 'pending')
   */
  forceExpire(taskId: string): Promise<TaskRecord>;
}

// ── DefaultLeaseManager implementation ───────────────────────────────────────

export class DefaultLeaseManager implements LeaseManager {
  constructor(
    private taskStore: TaskStore,
    private runStore: RunStore,
    private connection: SqliteConnection,
  ) {}

  async acquireLease(options: AcquireLeaseOptions): Promise<TaskRecord> {
    const { taskId, owner, durationMs = 300_000, runtimeKind } = options;
    const db = this.connection.getDb();

    const tx = db.transaction(() => {
      const row = db.prepare(
        'SELECT task_id, status, attempt_count FROM tasks WHERE task_id = ?',
      ).get(taskId) as Record<string, unknown> | undefined;

      if (!row) {
        throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);
      }

      const currentStatus = String(row.status);
      if (currentStatus !== 'pending' && currentStatus !== 'retry_wait') {
        throw new PDRuntimeError(
          'lease_conflict',
          `Task ${taskId} is ${currentStatus}, expected pending/retry_wait`,
        );
      }

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + durationMs).toISOString();

      // Determine next attempt number from existing runs (most reliable)
      const lastRun = db.prepare(
        'SELECT attempt_number FROM runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1',
      ).get(taskId) as { attempt_number: number } | undefined;
      const lastAttemptNumber = lastRun?.attempt_number ?? 0;
      const attemptNumber = lastAttemptNumber + 1;

      db.prepare(`
        UPDATE tasks
        SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE task_id = ?
      `).run(owner, expiresAt, nowIso, taskId);

      const runId = `run_${taskId}_${attemptNumber}`;
      db.prepare(`
        INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
      `).run(runId, taskId, runtimeKind, nowIso, attemptNumber, nowIso, nowIso);

      return attemptNumber;
    });

    tx();
    const updated = await this.taskStore.getTask(taskId);
    if (!updated) throw new PDRuntimeError('storage_unavailable', `Task not found after lease: ${taskId}`);
    return updated;
  }

  async releaseLease(taskId: string, owner: string): Promise<TaskRecord> {
    const db = this.connection.getDb();

    db.transaction(() => {
      const row = db.prepare(
        'SELECT task_id, status, lease_owner FROM tasks WHERE task_id = ?',
      ).get(taskId) as Record<string, unknown> | undefined;

      if (!row) {
        throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);
      }
      if (String(row.lease_owner) !== owner) {
        throw new PDRuntimeError(
          'lease_conflict',
          `Task ${taskId} is not owned by ${owner}`,
        );
      }

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE tasks
        SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE task_id = ?
      `).run(nowIso, taskId);
    })();

    const updated = await this.taskStore.getTask(taskId);
    if (!updated) throw new PDRuntimeError('storage_unavailable', `Task not found after release: ${taskId}`);
    return updated;
  }

  async renewLease(taskId: string, owner: string, durationMs = 300_000): Promise<TaskRecord> {
    const db = this.connection.getDb();

    db.transaction(() => {
      const row = db.prepare(
        'SELECT task_id, status, lease_owner FROM tasks WHERE task_id = ?',
      ).get(taskId) as Record<string, unknown> | undefined;

      if (!row) {
        throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);
      }
      if (String(row.lease_owner) !== owner) {
        throw new PDRuntimeError(
          'lease_conflict',
          `Task ${taskId} is not owned by ${owner}`,
        );
      }
      if (String(row.status) !== 'leased') {
        throw new PDRuntimeError(
          'lease_conflict',
          `Task ${taskId} is not leased`,
        );
      }

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + durationMs).toISOString();
      db.prepare(`
        UPDATE tasks SET lease_expires_at = ?, updated_at = ?
        WHERE task_id = ?
      `).run(expiresAt, nowIso, taskId);
    })();

    const updated = await this.taskStore.getTask(taskId);
    if (!updated) throw new PDRuntimeError('storage_unavailable', `Task not found after renew: ${taskId}`);
    return updated;
  }

  isLeaseExpired(task: TaskRecord): boolean {
    if (task.status !== 'leased' || !task.leaseExpiresAt) return false;
    return new Date(task.leaseExpiresAt) < new Date();
  }

  async forceExpire(taskId: string): Promise<TaskRecord> {
    return this.taskStore.updateTask(taskId, {
      status: 'pending',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }
}
