/**
 * Shared Diagnostician candidate selection (SPEC-PD-AGENT-PAIN-INGRESS-001
 * §8.4.3 / TECHNICAL-DESIGN §8.4.3).
 *
 * Extracted verbatim from the Codex worker so the Codex worker and OpenClaw's
 * L3 automatic execution pick from ONE implementation instead of two copies.
 * The fair-share cursor keeps living in the existing `reconciliation_cursor`
 * authority — no new table, no new column, no new parameter. Only the scope KEY
 * became host-neutral (`diagnostician-fair-share`), which changes one rotation
 * starting point and no task data (rollback = restore the old key).
 */
import { isRetryWaitBackoffElapsed } from './internalization/internalization-task-guards.js';
import type { TaskRecord } from './task-status.js';
import type { RuntimeStateManager } from './store/runtime-state-manager.js';

/** Host-neutral fair-share cursor scope. */
export const DIAGNOSTICIAN_FAIR_SHARE_SCOPE = 'diagnostician-fair-share';

export interface DiagnosticianCandidateStatePort {
  listTasks: RuntimeStateManager['listTasks'];
  getDiagnosticianServiceCursor: RuntimeStateManager['getDiagnosticianServiceCursor'];
  setDiagnosticianServiceCursor: RuntimeStateManager['setDiagnosticianServiceCursor'];
}

/**
 * Oldest pending diagnostician first; retry_wait candidates are filtered to
 * those whose backoff window has ELAPSED, so an old-but-still-waiting task
 * cannot starve a younger eligible one (review P1). The candidate set stays
 * bounded (`limit`), and executePendingDiagnosis re-enforces the backoff
 * window on the chosen task — no double bookkeeping.
 *
 * Fair-share (SPEC §9.1): pending and due-retry are both continuously-eligible
 * classes; neither may starve the other while new pending signals keep
 * arriving. A persistent round-robin cursor alternates service between the two
 * classes — each eligible class is served at least every other cycle, well
 * inside the 3-full-cycle bound. Single-eligible work is always served.
 */
export async function pickDiagnosticianCandidate(
  stateManager: DiagnosticianCandidateStatePort,
  limit: number,
  nowIso: string,
): Promise<TaskRecord | null> {
  const pending = await stateManager.listTasks({ taskKind: 'diagnostician', status: 'pending', orderBy: 'updated_at_asc', limit });
  const [pendingTask] = pending;
  let retryTask: TaskRecord | null = null;
  const retrying = await stateManager.listTasks({ taskKind: 'diagnostician', status: 'retry_wait', orderBy: 'updated_at_asc', limit });
  for (const candidate of retrying) {
    if (isRetryWaitBackoffElapsed(candidate.status, candidate.leaseExpiresAt)) {
      retryTask = candidate;
      break;
    }
  }
  if (pendingTask === undefined && retryTask === null) return null;
  if (retryTask === null) {
    await stateManager.setDiagnosticianServiceCursor(DIAGNOSTICIAN_FAIR_SHARE_SCOPE, { lastUpdatedAt: nowIso, lastTaskId: 'pending' });
    return pendingTask ?? null;
  }
  if (pendingTask === undefined) {
    await stateManager.setDiagnosticianServiceCursor(DIAGNOSTICIAN_FAIR_SHARE_SCOPE, { lastUpdatedAt: nowIso, lastTaskId: 'retry_wait' });
    return retryTask;
  }
  const cursor = await stateManager.getDiagnosticianServiceCursor(DIAGNOSTICIAN_FAIR_SHARE_SCOPE);
  const serveRetryFirst = cursor?.lastTaskId !== 'retry_wait';
  const servedClass = serveRetryFirst ? 'retry_wait' : 'pending';
  await stateManager.setDiagnosticianServiceCursor(DIAGNOSTICIAN_FAIR_SHARE_SCOPE, { lastUpdatedAt: nowIso, lastTaskId: servedClass });
  return serveRetryFirst ? retryTask : pendingTask;
}
