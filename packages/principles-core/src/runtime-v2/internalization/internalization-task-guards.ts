/**
 * Internalization Task Guards (PRI-62)
 *
 * Pure Boolean guard functions that validate individual conditions
 * for the Internalization Engine state machine.
 *
 * Key constraints (ADR-0003 Section 3.9):
 *   - Terminal task states: succeeded and failed only
 *   - resultRef is immutable only after status transitions to succeeded
 *   - lastError can be updated during retry_wait and failed transitions
 *   - dependencyTaskIds gating must fail closed
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

import type { PDTaskStatus, TaskRecord } from '../task-status.js';
import type { PITaskRecord, PIArtifact } from './peer-runner-contracts.js';

// ── Lease Acquisition Guards ─────────────────────────────────────────────────

/**
 * Returns true if a retry_wait task's backoff period has expired and it can
 * be re-leased now.
 *
 * When a task enters retry_wait, recovery-sweep sets leaseExpiresAt to
 * now + backoffMs (the "retry-after" deadline). The task should NOT be
 * re-leased until that deadline has passed.
 *
 * For non-retry_wait tasks, always returns true (no backoff gating needed).
 *
 * @param task - The task record to evaluate
 * @param nowMs - Current time in milliseconds (default: Date.now())
 */
export function canRetryNow(task: PITaskRecord, nowMs: number = Date.now()): boolean {
  if (task.status !== 'retry_wait') return true;
  if (!task.leaseExpiresAt) return true;
  const retryAfterMs = new Date(task.leaseExpiresAt).getTime();
  if (Number.isNaN(retryAfterMs)) return true;
  return retryAfterMs <= nowMs;
}

/**
 * Returns true if the task status allows acquiring a lease.
 *
 * Only `pending` and `retry_wait` can be leased:
 *   - pending: task is waiting for a runner to pick it up
 *   - retry_wait: task is recovering after a transient failure
 *
 * Terminal states (succeeded/failed) are not leaseable.
 * `leased` tasks already have an active lease and cannot be re-leased.
 *
 * Note: This does NOT check backoff timing. Use canRetryNow() to gate
 * retry_wait tasks whose backoff period has not yet expired.
 */
export function canAcquireLease(task: PITaskRecord): boolean {
  return task.status === 'pending' || task.status === 'retry_wait';
}

// ── Dependency Gate ───────────────────────────────────────────────────────────

/**
 * Returns true if ALL dependency tasks have reached succeeded state.
 *
 * Fail-closed: if ANY dependency is not found in the dependencies array,
 * or is not in succeeded state, returns false.
 *
 * Empty dependencyTaskIds means no gating — returns true.
 */
export function areDependenciesMet(
  task: PITaskRecord,
  dependencies: readonly TaskRecord[],
): boolean {
  if (task.dependencyTaskIds.length === 0) {
    return true;
  }

  const depMap = new Map(dependencies.map(d => [d.taskId, d]));

  for (const depId of task.dependencyTaskIds) {
    const dep = depMap.get(depId);
    if (!dep || dep.status !== 'succeeded') {
      return false;
    }
  }

  return true;
}

// ── Status Transition Guards ─────────────────────────────────────────────────

/**
 * Returns true if a PDTaskStatus transition is valid per ADR-0003 Section 3.8.
 *
 * Valid transitions:
 *   pending     → leased
 *   leased      → succeeded
 *   leased      → retry_wait
 *   leased      → failed
 *   leased      → pending   (lease release / force-expire — e.g. LeaseManager.releaseLease)
 *   retry_wait  → pending   (recovery sweep resets)
 *
 * Terminal states (succeeded, failed) cannot transition to any other state.
 */
export function canTransitionTo(currentStatus: PDTaskStatus, newStatus: PDTaskStatus): boolean {
  switch (currentStatus) {
    case 'pending':
      return newStatus === 'leased';
    case 'leased':
      return (
        newStatus === 'succeeded' ||
        newStatus === 'retry_wait' ||
        newStatus === 'failed' ||
        newStatus === 'pending'
      );
    case 'retry_wait':
      return newStatus === 'pending';
    case 'succeeded':
    case 'failed':
      return false;
    default:
      return false;
  }
}

// ── Immutability Guards ─────────────────────────────────────────────────────

/**
 * Returns true if resultRef is now immutable (task reached succeeded).
 *
 * Per ADR-0003: resultRef becomes immutable after task enters succeeded state.
 * Before succeeded, resultRef may still be set or updated.
 */
export function isResultRefImmutable(task: PITaskRecord): boolean {
  return task.status === 'succeeded';
}

/**
 * Returns true if lastError can be updated for this task.
 *
 * lastError can be updated during retry_wait and failed transitions.
 * It is NOT updated during pending (no error yet) or succeeded (terminal).
 */
export function canUpdateLastError(task: PITaskRecord): boolean {
  return task.status === 'retry_wait' || task.status === 'failed';
}

// ── Artifact Guards ──────────────────────────────────────────────────────────

/**
 * Returns true if the artifact has been rejected by the evaluator.
 *
 * Per ADR-0003 Section 3.7: rejected artifacts trigger a corrective feedback
 * loop but do NOT directly set the source task to failed.
 */
export function isArtifactRejected(artifact: PIArtifact): boolean {
  return artifact.validationStatus === 'rejected';
}

// ── Three Strikes Out Guards (PRI-141) ──────────────────────────────────────

export const DEFAULT_UNRESOLVABLE_THRESHOLD = 3;

export function isUnresolvable(task: PITaskRecord, threshold: number = DEFAULT_UNRESOLVABLE_THRESHOLD): boolean {
  const count = task.rejectionCount ?? 0;
  return count >= threshold;
}

export function recordRejection(task: PITaskRecord): PITaskRecord {
  const currentCount = task.rejectionCount ?? 0;
  return {
    ...task,
    rejectionCount: currentCount + 1,
    updatedAt: new Date().toISOString(),
  };
}

// ── Retry Wait Staleness (F7-6, PRI-442) ────────────────────────────────────

/**
 * Default maximum time a task may remain in `retry_wait` before being
 * considered stale. 24 hours — conservative threshold; if a task has been
 * in retry_wait this long without recovery, something is likely wrong
 * (e.g. recovery sweep not running, persistent transient failure).
 */
export const DEFAULT_RETRY_WAIT_STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Returns true if a `retry_wait` task has been stale longer than the TTL.
 *
 * F7-6 (PRI-442): previously a task could cycle retry_wait → pending → leased
 * → retry_wait indefinitely without ever reaching `failed`. The integrity
 * read model already detects `retry_wait_exceeded` (attempt_count >=
 * max_attempts) but NOT time-based staleness. This function closes that
 * observability gap (rc-9: no silent degradation).
 *
 * Uses `updatedAt` as the entry-time proxy: when a task transitions to
 * retry_wait, `updatedAt` is set to the transition timestamp. If
 * `updatedAt` is missing or unparseable, returns false (fail-safe — do not
 * false-positive on malformed data).
 *
 * @param task - The task record to evaluate
 * @param nowMs - Current time in milliseconds (default: Date.now())
 * @param maxWaitMs - Maximum allowed wait in ms (default: 24h)
 */
export function isRetryWaitStale(
  task: PITaskRecord,
  nowMs: number = Date.now(),
  maxWaitMs: number = DEFAULT_RETRY_WAIT_STALE_TTL_MS,
): boolean {
  if (task.status !== 'retry_wait') return false;
  if (!task.updatedAt) return false;
  const updatedAtMs = new Date(task.updatedAt).getTime();
  if (Number.isNaN(updatedAtMs)) return false;
  return (nowMs - updatedAtMs) >= maxWaitMs;
}
