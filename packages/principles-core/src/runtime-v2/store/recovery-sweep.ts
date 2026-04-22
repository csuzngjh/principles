/**
 * Recovery Sweep — expired lease recovery for PD Runtime v2 tasks.
 *
 * Detects tasks whose lease has expired (worker died or stalled) and:
 *   - Transitions to retry_wait if attempts remain (with backoff)
 *   - Transitions to failed if maxAttempts exceeded
 *   - Emits a telemetry event for each recovery
 *
 * Idempotent: safe to run multiple times. A task that was already recovered
 * will have its leaseOwner/leaseExpiresAt cleared, so isLeaseExpired returns false,
 * and recoverTask returns null immediately.
 *
 * Source: PD Runtime Protocol SPEC v1, Section 12 (Task lease recovery)
 * Source: Diagnostician v2 Detailed Design, Section 8 (Stale task detection)
 */
import type { TaskStore } from './task-store.js';
import type { LeaseManager } from './lease-manager.js';
import type { RetryPolicy } from './retry-policy.js';
import type { PDTaskStatus, TaskRecord } from '../task-status.js';
import type { SqliteConnection } from './sqlite-connection.js';
import { storeEmitter, type StoreEventEmitter } from './event-emitter.js';
 
import type { Database } from 'better-sqlite3';

export interface RecoveryResult {
  taskId: string;
  recoveredAt: string;
  previousStatus: PDTaskStatus;
  newStatus: PDTaskStatus;
  wasLeaseExpired: boolean;
}

export interface RecoverySweep {
  detectExpiredLeases(): Promise<string[]>;
  recoverTask(taskId: string): Promise<RecoveryResult | null>;
  recoverAll(): Promise<{ recovered: number; errors: string[] }>;
}

export class DefaultRecoverySweep implements RecoverySweep {
  private readonly emitter: StoreEventEmitter;

  // eslint-disable-next-line @typescript-eslint/max-params
  constructor(
    private readonly taskStore: TaskStore,
    private readonly leaseManager: LeaseManager,
    private readonly retryPolicy: RetryPolicy,
    private readonly connection: SqliteConnection,
    emitter?: StoreEventEmitter,
  ) {
    this.emitter = emitter ?? storeEmitter;
  }

  /**
   * Detect all leased tasks whose lease has expired.
   *
   * Uses the leaseExpiresAtBefore filter to push predicate to SQL
   * (leverages idx_tasks_lease_expires_at index), avoiding an in-memory filter.
   */
  async detectExpiredLeases(): Promise<string[]> {
    const now = new Date().toISOString();
    const tasks = await this.taskStore.listTasks({
      status: 'leased',
      leaseExpiresAtBefore: now,
    });
    return tasks.map(task => task.taskId);
  }

  /**
   * Atomic read-check-write inside a db transaction.
   * Returns null if nothing to recover; otherwise returns RecoveryResult plus
   * internal telemetry fields.
   */
  private atomicRecover(
    db: Database,
    taskId: string,
    now: string,
  ): (RecoveryResult & { attemptCount: number; backoffMs?: number }) | null {
    const row = db.prepare(
      'SELECT task_id, status, attempt_count, max_attempts, lease_expires_at FROM tasks WHERE task_id = ?',
    ).get(taskId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const attemptCount = Number(row.attempt_count ?? 0);
    const maxAttempts = Number(row.max_attempts ?? 3);
    const leaseExpiresAt = row.lease_expires_at ? String(row.lease_expires_at) : undefined;
    const status = String(row.status) as PDTaskStatus;

    // Idempotency: not leased or not expired → nothing to do
    if (status !== 'leased' || !leaseExpiresAt) return null;
    if (new Date(leaseExpiresAt) >= new Date()) return null;

    const previousStatus = status;

    if (this.retryPolicy.shouldRetry({ taskId, status, attemptCount, maxAttempts } as TaskRecord)) {
      const backoffMs = this.retryPolicy.calculateBackoff(attemptCount + 1);
      const retryExpiresAt = new Date(Date.now() + backoffMs).toISOString();
      db.prepare(`
        UPDATE tasks
        SET status = 'retry_wait', lease_owner = NULL, lease_expires_at = ?, last_error = ?, updated_at = ?
        WHERE task_id = ?
      `).run(retryExpiresAt, 'lease_expired', now, taskId);

      return { taskId, recoveredAt: now, previousStatus, newStatus: 'retry_wait', wasLeaseExpired: true, attemptCount, backoffMs };
    } else {
      db.prepare(`
        UPDATE tasks
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
        WHERE task_id = ?
      `).run('max_attempts_exceeded', now, taskId);

      return { taskId, recoveredAt: now, previousStatus, newStatus: 'failed', wasLeaseExpired: true, attemptCount };
    }
  }

  /**
   * Recover a single task from an expired lease.
   *
   * Idempotent: returns null if the task is not leased or its lease has not expired.
   *
   * Transitions:
   *   - retry_wait (if attempts remain per shouldRetry check)
   *   - failed (if maxAttempts exceeded)
   *
   * Uses a db.transaction() to atomically read the task, verify lease expiry,
   * and apply the status update — avoiding TOCTOU race conditions when multiple
   * recovery scans run concurrently.
   */
  async recoverTask(taskId: string): Promise<RecoveryResult | null> {
    const db = this.connection.getDb();
    const now = new Date().toISOString();

    // Atomic read-check-write inside a transaction
    const result = db.transaction(() => this.atomicRecover(db, taskId, now))();

    if (!result) return null;

    // Emit telemetry after successful atomic update
    if (result.newStatus === 'retry_wait') {
      this.emitter.emitTelemetry({
        eventType: 'task_retried',
        traceId: result.taskId,
        timestamp: result.recoveredAt,
        sessionId: 'system',
        payload: { taskId: result.taskId, newStatus: 'retry_wait', attemptCount: result.attemptCount, backoffMs: result.backoffMs ?? 0, previousLeaseExpired: true },
      });
    } else {
      this.emitter.emitTelemetry({
        eventType: 'task_failed',
        traceId: result.taskId,
        timestamp: result.recoveredAt,
        sessionId: 'system',
        payload: { taskId: result.taskId, lastError: 'max_attempts_exceeded', attemptCount: result.attemptCount },
      });
    }

    return result;
  }

  /**
   * Recover all expired leases.
   *
   * Processes all expired leases sequentially, collecting errors without
   * stopping recovery of other tasks.
   */
  async recoverAll(): Promise<{ recovered: number; errors: string[] }> {
    const expiredIds = await this.detectExpiredLeases();
    let recovered = 0;
    const errors: string[] = [];

    for (const taskId of expiredIds) {
      try {
        const result = await this.recoverTask(taskId);
        if (result) recovered++;
      } catch (err) {
        errors.push(`${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { recovered, errors };
  }
}