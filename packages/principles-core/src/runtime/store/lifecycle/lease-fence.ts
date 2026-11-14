/**
 * Lease Fence — the execution identity that guards every write a worker may
 * perform on a task it claims to own.
 *
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.3 (remediation).
 *
 * Why this exists: `lease_owner` is a *string* chosen by the caller, so two
 * workers can legitimately use the same owner label (`pain-signal-bridge`,
 * `split-diagnostician-orchestrator`). Before this module, ownership was
 * decided by comparing that label, which means worker A could be mistaken for
 * the legal owner after its lease expired and worker B re-acquired the task
 * with the same label.
 *
 * `lease_generation` is a monotonic integer minted by the ONE acquisition
 * statement in `DefaultLeaseManager`. A fence (`taskId + owner + generation`)
 * therefore identifies one acquisition, not one label:
 *
 *   worker A acquires  → generation 1
 *   lease expires      → recovery bumps generation to 2 (invalidation)
 *   worker B acquires  → generation 3
 *   worker A writes    → generation 1 ≠ 3 → refused
 *
 * Every guarded write embeds `leaseFencePredicate()` in the SAME SQL
 * statement that performs the mutation. A read-then-write (`assertOwned()`
 * followed by an unguarded UPDATE) is explicitly NOT sufficient: the lease can
 * be reclaimed in the interval, and that pattern is what this module replaces.
 */
import type { Database } from 'better-sqlite3';
import { PDRuntimeError } from '../../error-categories.js';
import type { TaskRecord } from '../../task-status.js';

/**
 * The identity of ONE lease acquisition.
 *
 * All three fields are required: there is no "owner-only" variant, and no
 * optional-token default that lets a caller bypass fencing.
 */
export interface LeaseFence {
  readonly taskId: string;
  readonly owner: string;
  readonly leaseGeneration: number;
}

/**
 * Values that pair with the fence predicate below.
 *
 * The predicate is written LITERALLY in every statement rather than shared as a
 * string constant: the architecture guard forbids interpolated DML, because a
 * predicate assembled at runtime can silently lose a clause.
 *
 *   status = 'leased'
 *   AND lease_owner = ?
 *   AND lease_generation = ?
 *   AND lease_expires_at IS NOT NULL
 *   AND lease_expires_at >= ?      -- an expired lease is NOT owned
 */
export function leaseFenceValues(fence: LeaseFence, nowIso: string): [string, number, string] {
  return [fence.owner, fence.leaseGeneration, nowIso];
}

/** Runtime guard: a fence with a non-integer generation proves nothing. */
export function isLeaseFence(value: unknown): value is LeaseFence {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.taskId === 'string'
    && typeof candidate.owner === 'string'
    && typeof candidate.leaseGeneration === 'number'
    && Number.isInteger(candidate.leaseGeneration)
    && candidate.leaseGeneration >= 0;
}

/** Fail loud on a malformed fence instead of degrading to an unfenced write. */
export function assertLeaseFenceShape(fence: LeaseFence): void {
  if (!isLeaseFence(fence)) {
    throw new PDRuntimeError('input_invalid', 'Invalid lease fence: taskId, owner and integer leaseGeneration are required', {
      taskId: (fence as { taskId?: unknown } | null | undefined)?.taskId ?? null,
    });
  }
}

/**
 * Build the fence for a task this process just acquired.
 *
 * Returns null when the record does not describe an acquirable lease (a test
 * double that does not model leases, or a synthetic record). Callers must treat
 * null as "no fence" — never as "fence passed".
 */
export function leaseFenceOf(task: TaskRecord): LeaseFence | null {
  if (task.status !== 'leased' || !task.leaseOwner) return null;
  const generation = task.leaseGeneration;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) return null;
  return { taskId: task.taskId, owner: task.leaseOwner, leaseGeneration: generation };
}

/**
 * Verify the fence against the persisted row INSIDE the caller's transaction
 * and abort the transaction when it no longer holds.
 *
 * This is the building block for multi-statement commit units
 * (artifacts / commits / candidates / pi_artifacts). It is deliberately a
 * throwing assertion: a caller that keeps writing after it fails would be
 * publishing a result the execution no longer owns.
 *
 * @throws PDRuntimeError{lease_conflict} when the row is missing, no longer
 *         leased, owned by another identity, or expired.
 */
export function assertLeaseFenceInTransaction(
  db: Database,
  fence: LeaseFence,
  nowIso: string,
): void {
  assertLeaseFenceShape(fence);
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM tasks
       WHERE task_id = ?
         AND status = 'leased'
         AND lease_owner = ?
         AND lease_generation = ?
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at >= ?`,
    )
    .get(fence.taskId, ...leaseFenceValues(fence, nowIso));
  if (row === undefined) {
    throw new PDRuntimeError(
      'lease_conflict',
      `Task ${fence.taskId} is no longer owned by lease generation ${fence.leaseGeneration} (owner ${fence.owner}); the execution has been superseded or has expired`,
      { taskId: fence.taskId, owner: fence.owner, leaseGeneration: fence.leaseGeneration },
    );
  }
}
