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
import { Value } from '@sinclair/typebox/value';
import { RuntimeKindSchema } from '../../runtime-protocol.js';
import { PDRuntimeError } from '../../error-categories.js';
import type { TaskRecord } from '../../task-status.js';
import type { TaskStore } from '../task/task-store.js';
import type { RunStore } from '../run/run-store.js';
import type { SqliteConnection } from '../sqlite-connection.js';
import { storeEmitter, type StoreEventEmitter } from '../event-emitter.js';
import { assertLeaseFenceShape, leaseFenceValues, type LeaseFence } from './lease-fence.js';

// ── Options ──────────────────────────────────────────────────────────────────

export interface AcquireLeaseOptions {
  taskId: string;
  owner: string;
  durationMs?: number;
  runtimeKind: string;
}

/**
 * Everything an execution needs from an acquisition.
 *
 * `runId` and `leaseGeneration` are the identity the caller must carry into
 * EVERY subsequent write (terminal state, diagnostic JSON, artifacts). They
 * are returned here precisely so call sites never have to guess ("the latest
 * run") or re-derive the token from a label.
 */
export interface LeaseAcquisition {
  readonly task: TaskRecord;
  readonly runId: string;
  readonly leaseGeneration: number;
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
   *   - lease_generation incremented (the fencing token for THIS acquisition)
   *   - A new Run record is created with execution_status = 'running'
   *
   * @returns The updated TaskRecord
   * @throws PDRuntimeError with category 'storage_unavailable' if task not found
   * @throws PDRuntimeError with category 'lease_conflict' if task not in acquireable state
   */
  acquireLease(options: AcquireLeaseOptions): Promise<TaskRecord>;

  /**
   * Same acquisition, returning the runId and fencing token the caller must
   * use for every subsequent write. Production execution paths use this.
   */
  acquireLeaseDetailed(options: AcquireLeaseOptions): Promise<LeaseAcquisition>;

  /**
   * Release a lease, returning the task to pending state.
   *
   * Only the exact acquisition that holds the fence may release: owner AND
   * generation must match, and the lease must not have expired.
   */
  releaseLease(fence: LeaseFence): Promise<TaskRecord>;

  /**
   * Renew (extend) the lease duration for a currently leased task.
   *
   * CAS: `status = leased AND owner AND generation AND not expired`. A lease
   * that already expired can NEVER be revived by a renewal — it must be
   * reclaimed by recovery and re-acquired (which mints a new generation).
   */
  renewLease(fence: LeaseFence, durationMs?: number): Promise<TaskRecord>;

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

interface LeaseManagerOptions {
  taskStore: TaskStore;
  runStore: RunStore;
  connection: SqliteConnection;
  emitter?: StoreEventEmitter;
}

export class DefaultLeaseManager implements LeaseManager {
  private readonly emitter: StoreEventEmitter;

  // eslint-disable-next-line @typescript-eslint/max-params
  constructor(
    private readonly taskStore: TaskStore,
    private readonly runStore: RunStore,
    private readonly connection: SqliteConnection,
    options?: LeaseManagerOptions,
  ) {
    this.emitter = options?.emitter ?? storeEmitter;
  }

  async acquireLease(options: AcquireLeaseOptions): Promise<TaskRecord> {
    return (await this.acquireLeaseDetailed(options)).task;
  }

  async acquireLeaseDetailed(options: AcquireLeaseOptions): Promise<LeaseAcquisition> {
    const { taskId, owner, durationMs = 300_000, runtimeKind } = options;
    if (!Value.Check(RuntimeKindSchema, runtimeKind)) {
      throw new PDRuntimeError('input_invalid', `Invalid runtime kind: ${runtimeKind}`);
    }
    const db = this.connection.getDb();

    // `.immediate()` takes the write lock up-front: the read (status /
    // generation) and the conditional UPDATE are one serialised unit, so two
    // connections racing for the same task cannot both observe 'pending'.
    const tx = db.transaction((): { attemptNumber: number; runId: string; leaseGeneration: number } => {
      const row = db.prepare(
        'SELECT task_id, status, attempt_count, lease_generation FROM tasks WHERE task_id = ?',
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

      // Determine next attempt number from existing runs (most reliable).
      // SPEC-PRI-1047: the RUN attempt_number stays globally sequential per task
      // (run-id uniqueness after crashes), but the TASK's attempt_count is now
      // EPOCH-LOCAL — incremented from the task's own counter instead of being
      // overwritten with the global run ordinal. The old overwrite made a
      // reopened epoch (attempt_count reset to 0, historical runs 1..N) start
      // at attempt_count = N+1, so shouldRetry (attempt_count < maxAttempts)
      // failed its FIRST validation loss against the original cap — the epoch
      // never actually received the maxAttempts retries it was reopened with.
      const lastRun = db.prepare(
        'SELECT attempt_number FROM runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1',
      ).get(taskId) as { attempt_number: number } | undefined;
      const lastAttemptNumber = lastRun?.attempt_number ?? 0;
      const attemptNumber = lastAttemptNumber + 1;
      const epochAttemptCount = Number(row.attempt_count ?? 0) + 1;

      // Fencing token: strictly greater than the previous one. The DB trigger
      // `tasks_lease_acquire_requires_generation` re-asserts this invariant for
      // writers that bypass this manager entirely.
      const leaseGeneration = Number(row.lease_generation ?? 0) + 1;

      const { changes } = db.prepare(`
        UPDATE tasks
        SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?,
            attempt_count = ?, lease_generation = ?
        WHERE task_id = ? AND status = ? AND COALESCE(lease_generation, 0) = ?
      `).run(
        owner,
        expiresAt,
        nowIso,
        epochAttemptCount,
        leaseGeneration,
        taskId,
        currentStatus,
        Number(row.lease_generation ?? 0),
      );

      if (changes === 0) {
        throw new PDRuntimeError(
          'lease_conflict',
          `Task ${taskId} was acquired concurrently; this acquisition lost the race`,
        );
      }

      const runId = `run_${taskId}_${attemptNumber}`;
      db.prepare(`
        INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
      `).run(runId, taskId, runtimeKind, nowIso, attemptNumber, nowIso, nowIso);

      return { attemptNumber, runId, leaseGeneration };
    });

    const { runId, leaseGeneration } = tx.immediate();
    const updated = await this.taskStore.getTask(taskId);
    if (!updated) throw new PDRuntimeError('storage_unavailable', `Task not found after lease: ${taskId}`);

    this.emitter.emitTelemetry({
      eventType: 'lease_acquired',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: owner,
      payload: {
        taskId,
        owner,
        durationMs,
        runtimeKind,
        attemptCount: updated.attemptCount,
        leaseGeneration,
        runId,
      },
    });

    return { task: updated, runId, leaseGeneration };
  }

  async releaseLease(fence: LeaseFence): Promise<TaskRecord> {
    assertLeaseFenceShape(fence);
    const db = this.connection.getDb();
    const nowIso = new Date().toISOString();

    db.transaction(() => {
      const { changes } = db.prepare(`
        UPDATE tasks
        SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE task_id = ?
          AND status = 'leased'
          AND lease_owner = ?
          AND lease_generation = ?
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at >= ?
      `).run(nowIso, fence.taskId, ...leaseFenceValues(fence, nowIso));

      if (changes === 0) {
        throw new PDRuntimeError(
          'lease_conflict',
          `Task ${fence.taskId} is not owned by lease generation ${fence.leaseGeneration} (owner ${fence.owner})`,
          { taskId: fence.taskId, owner: fence.owner, leaseGeneration: fence.leaseGeneration },
        );
      }
    }).immediate();

    const updated = await this.taskStore.getTask(fence.taskId);
    if (!updated) throw new PDRuntimeError('storage_unavailable', `Task not found after release: ${fence.taskId}`);

    this.emitter.emitTelemetry({
      eventType: 'lease_released',
      traceId: fence.taskId,
      timestamp: new Date().toISOString(),
      sessionId: fence.owner,
      payload: { taskId: fence.taskId, owner: fence.owner, leaseGeneration: fence.leaseGeneration, executionStatus: updated.status },
    });

    return updated;
  }

  async renewLease(fence: LeaseFence, durationMs = 300_000): Promise<TaskRecord> {
    assertLeaseFenceShape(fence);
    const db = this.connection.getDb();
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + durationMs).toISOString();

    // CAS. `lease_expires_at >= now` is part of the predicate: renewal extends
    // a LIVE lease, it never resurrects an expired one. A stale worker holding
    // generation N cannot renew after a takeover because the generation (and,
    // after expiry, the predicate itself) no longer matches.
    db.transaction(() => {
      const { changes } = db.prepare(`
        UPDATE tasks SET lease_expires_at = ?, updated_at = ?
        WHERE task_id = ?
          AND status = 'leased'
          AND lease_owner = ?
          AND lease_generation = ?
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at >= ?
      `).run(expiresAt, nowIso, fence.taskId, ...leaseFenceValues(fence, nowIso));

      if (changes === 0) {
        throw new PDRuntimeError(
          'lease_conflict',
          `Task ${fence.taskId} cannot be renewed by lease generation ${fence.leaseGeneration} (owner ${fence.owner}): the lease was superseded or has expired`,
          { taskId: fence.taskId, owner: fence.owner, leaseGeneration: fence.leaseGeneration },
        );
      }
    }).immediate();

    const updated = await this.taskStore.getTask(fence.taskId);
    if (!updated) throw new PDRuntimeError('storage_unavailable', `Task not found after renew: ${fence.taskId}`);

    this.emitter.emitTelemetry({
      eventType: 'lease_renewed',
      traceId: fence.taskId,
      timestamp: new Date().toISOString(),
      sessionId: fence.owner,
      payload: {
        taskId: fence.taskId,
        owner: fence.owner,
        leaseGeneration: fence.leaseGeneration,
        newExpiresAt: updated.leaseExpiresAt,
      },
    });

    return updated;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  isLeaseExpired(task: TaskRecord): boolean {
    if (task.status !== 'leased' || !task.leaseExpiresAt) return false;
    return new Date(task.leaseExpiresAt) < new Date();
  }

  async forceExpire(taskId: string): Promise<TaskRecord> {
    // Recovery-only. The lease is released without minting a token: the old
    // execution is invalidated by (a) the row no longer being `leased` and
    // (b) the next acquisition minting a strictly greater generation.
    const db = this.connection.getDb();
    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE tasks
      SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE task_id = ?
    `).run(nowIso, taskId);

    const updated = await this.taskStore.getTask(taskId);
    if (!updated) throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);

    this.emitter.emitTelemetry({
      eventType: 'lease_expired',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'system',
      payload: { taskId, reason: 'force_expire', leaseGeneration: updated.leaseGeneration },
    });

    return updated;
  }
}
