/**
 * PRI-1274 (B1 / P1-3): bounded worker-cycle reconcile for tasks waiting on
 * their target turn's text.
 *
 * A submission that bound a session and named a target turn whose text was
 * not yet collectable is created `waiting_for_target_evidence` (the same
 * `recovery` block the PostToolUse receipt fallback writes). The candidate
 * picker excludes those tasks in SQL; THIS reconcile is the only exit from
 * that state: once the host's authorized evidence store holds readable text
 * for the exact (session, target turn), the disposition flips to
 * `ready_for_diagnosis` on the SAME task via the existing expected-value CAS
 * with full status/lease preconditions.
 *
 * Bounded by design: at most `limit` (default 5) waiting tasks per cycle, no
 * new Task, no queue, no scheduler, no transcript scanning — the only input
 * beyond the task rows is the caller-injected `targetTurnTextAvailable`
 * probe (the host adapter reads its own authorized governance store).
 */
import type { RuntimeStateManager } from './store/runtime-state-manager.js';
import type { TaskRecord } from './task-status.js';
import { PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION, type PainRecoveryDisposition } from './pain-admission-disposition.js';

/** Bounded per-cycle work: waiting tasks examined per reconcile run. */
export const TARGET_EVIDENCE_RECONCILE_LIMIT = 5;

/**
 * r2b (devin finding 0002): rotation cursor scope. A fixed oldest-first
 * window would let permanently-textless tasks (e.g. submitted while
 * ingestion was off) starve every later waiting task. The scan resumes
 * AFTER the last task of the previous full page and wraps to the start
 * whenever a page comes back short — the same reconciliation-cursor
 * authority the fair-share picker uses, with `lastUpdatedAt`/`lastTaskId`
 * holding the (updatedAt, taskId) tuple of the last task examined.
 */
export const TARGET_EVIDENCE_RECONCILE_SCOPE = 'target-evidence-reconcile';

export interface TargetEvidenceReconcileReport {
  /** Waiting tasks examined this run (bounded by `limit`). */
  readonly checked: number;
  /** Dispositions flipped to `ready_for_diagnosis`. */
  readonly flipped: number;
  /** Still waiting (text not yet available) or CAS-lost to a concurrent writer. */
  readonly stillWaiting: number;
  /** Per-task structured failures (malformed payload, store error) — rc-9. */
  readonly errors: readonly string[];
}

export interface ReconcileWaitingTargetEvidenceInput {
  readonly stateManager: Pick<RuntimeStateManager, 'listTasks' | 'updateTaskIfDiagnosticJsonUnchanged' | 'getDiagnosticianServiceCursor' | 'setDiagnosticianServiceCursor'>;
  /** Host-adapter probe: does the authorized store hold readable text for
   * the exact (session, target turn)? Owns host/workspace semantics. */
  readonly targetTurnTextAvailable: (sessionId: string, targetTurnId: string) => boolean;
  readonly nowIso: string;
  readonly limit?: number;
}

interface WaitingTaskFacts {
  readonly task: TaskRecord;
  readonly diagnosticText: string;
  readonly sessionId: string;
  readonly targetTurnId: string;
  readonly existingDisposition: PainRecoveryDisposition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a waiting task's persisted facts; null when the payload does not
 * carry the verified session + target turn the waiting state promises. */
function parseWaitingTaskFacts(task: TaskRecord): WaitingTaskFacts | null {
  if (task.diagnosticJson === null || task.diagnosticJson === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(task.diagnosticJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const {painIngress} = parsed;
  const verified = isRecord(painIngress) ? painIngress.verifiedHostSession : undefined;
  if (!isRecord(verified) || verified.status !== 'verified') return null;
  const {sessionId} = verified;
  const {targetTurnId} = verified;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof targetTurnId !== 'string' || targetTurnId.length === 0) return null;
  const {recovery} = parsed;
  if (!isRecord(recovery) || recovery.state !== 'waiting_for_target_evidence') return null;
  const attemptCount = typeof recovery.attemptCount === 'number' && Number.isInteger(recovery.attemptCount) && recovery.attemptCount >= 1
    ? recovery.attemptCount
    : 1;
  // The receiptRef identity fields are re-validated field-by-field — a
  // malformed ref is dropped (the flip does not depend on it), never cast.
  const rawRef = isRecord(recovery.receiptRef) ? recovery.receiptRef : undefined;
  const receiptRef = rawRef !== undefined
    && typeof rawRef.schemaVersion === 'string'
    && typeof rawRef.capability === 'string'
    && typeof rawRef.status === 'string'
    && typeof rawRef.toolCallId === 'string'
    && typeof rawRef.receivedAt === 'string'
    ? {
      schemaVersion: rawRef.schemaVersion,
      capability: rawRef.capability,
      status: rawRef.status,
      toolCallId: rawRef.toolCallId,
      receivedAt: rawRef.receivedAt,
    }
    : undefined;
  return {
    task,
    diagnosticText: task.diagnosticJson,
    sessionId,
    targetTurnId,
    existingDisposition: {
      schemaVersion: PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION,
      state: 'waiting_for_target_evidence',
      reasonCode: typeof recovery.reasonCode === 'string' ? recovery.reasonCode : 'target_turn_text_pending',
      attemptCount,
      lastCheckedAt: typeof recovery.lastCheckedAt === 'string' ? recovery.lastCheckedAt : new Date(0).toISOString(),
      ...(receiptRef !== undefined ? { receiptRef } : {}),
    },
  };
}

/**
 * One bounded reconcile pass. Never throws: every failure lands in the
 * report's `errors` (bounded, ids + codes only).
 */
export async function reconcileWaitingTargetEvidenceTasks(
  input: ReconcileWaitingTargetEvidenceInput,
): Promise<TargetEvidenceReconcileReport> {
  const limit = Math.max(1, Math.min(input.limit ?? TARGET_EVIDENCE_RECONCILE_LIMIT, 25));
  let checked = 0;
  let flipped = 0;
  let stillWaiting = 0;
  const errors: string[] = [];

  // r2b (devin finding 0002): rotate through the waiting set — resume after
  // the last examined task of the previous FULL page; a short page means the
  // set's tail was reached, so the cursor resets and the next pass wraps to
  // the oldest again. No waiting task can permanently occupy the window.
  const cursor = await input.stateManager.getDiagnosticianServiceCursor(TARGET_EVIDENCE_RECONCILE_SCOPE);
  const resumeAfter = cursor !== null && cursor.lastUpdatedAt.length > 0
    ? { updatedAt: cursor.lastUpdatedAt, taskId: cursor.lastTaskId }
    : undefined;
  const waiting = await input.stateManager.listTasks({
    taskKind: 'diagnostician',
    status: 'pending',
    recoveryState: 'waiting_for_target_evidence',
    orderBy: 'updated_at_asc',
    ...(resumeAfter !== undefined ? { afterCursor: resumeAfter } : {}),
    limit,
  });
  if (waiting.length > 0) {
    const last = waiting[waiting.length - 1];
    if (last === undefined) throw new Error('unreachable: non-empty page has a last element');
    // Full page → continue after it next cycle; short page → wrap to start.
    const nextCursor = waiting.length === limit
      ? { lastUpdatedAt: last.updatedAt, lastTaskId: last.taskId }
      : { lastUpdatedAt: '', lastTaskId: '' };
    await input.stateManager.setDiagnosticianServiceCursor(TARGET_EVIDENCE_RECONCILE_SCOPE, nextCursor);
  }

  for (const task of waiting) {
    checked += 1;
    const facts = parseWaitingTaskFacts(task);
    if (facts === null) {
      // A waiting task without its promised verified session + target turn
      // is a malformed payload — reported, never silently dropped (rc-9).
      errors.push(`target_evidence_reconcile_payload_invalid:taskId=${task.taskId}`);
      continue;
    }
    if (!input.targetTurnTextAvailable(facts.sessionId, facts.targetTurnId)) {
      stillWaiting += 1;
      continue;
    }
    const disposition: PainRecoveryDisposition = {
      ...facts.existingDisposition,
      state: 'ready_for_diagnosis',
      reasonCode: 'target_evidence_arrived',
      attemptCount: facts.existingDisposition.attemptCount + 1,
      lastCheckedAt: input.nowIso,
      resolvedAt: input.nowIso,
    };
    try {
      let parsedRecord: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(facts.diagnosticText);
        parsedRecord = isRecord(parsed) ? parsed : {};
      } catch {
        errors.push(`target_evidence_reconcile_payload_invalid:taskId=${task.taskId}`);
        continue;
      }
      // Status/lease preconditions (P1-4 parity): a worker that leased or
      // finished the task in the read→write window defeats the flip in the
      // same statement as the diagnostic_json comparison.
      const updated = await input.stateManager.updateTaskIfDiagnosticJsonUnchanged(
        task.taskId,
        facts.diagnosticText,
        { diagnosticJson: JSON.stringify({ ...parsedRecord, recovery: disposition }) },
        { expectedStatus: task.status, expectedLeaseOwner: task.leaseOwner ?? null, expectedLeaseExpiresAt: task.leaseExpiresAt ?? null },
      );
      if (updated !== null) {
        flipped += 1;
      } else {
        // Lost a race — the concurrent writer's state wins; re-checked next cycle.
        stillWaiting += 1;
      }
    } catch (error: unknown) {
      errors.push(`target_evidence_reconcile_failed:taskId=${task.taskId}:${error instanceof Error ? Array.from(error.message).slice(0, 80).join('') : 'unknown'}`);
    }
  }

  return { checked, flipped, stillWaiting, errors };
}
