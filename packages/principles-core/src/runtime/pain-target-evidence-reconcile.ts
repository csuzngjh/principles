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
 * PRI-1273 (A2): the flip and the evidence backfill are ONE CAS write. When
 * the caller-injected reader returns the target turn's entries, the SAME
 * original task's top-level `evidence` array and its versioned
 * `painIngress.evidenceClass` (available/entryCount) are persisted together
 * with the disposition flip — real array and count stay consistent, exactly
 * like a submission whose target text existed up front (SPEC-PD-FEEDBACK-
 * RESILIENCE-001 TD §3 step 6). A source-material consent denial is NOT a
 * wait: it reclassifies the task to `blocked_by_source_material_consent`
 * (the picker already excludes that state; only a newly authorized target
 * turn may unblock it).
 *
 * SPEC TD §2.2 ruling 4: the evidence write is preceded by ONE more live
 * authorization read through the existing PRI-1283 R2 port (wired by the
 * host adapter). A consent revocation that lands between the reader's
 * read-time gate and the write therefore persists nothing — the task is
 * reclassified instead. The ledger is a file and the task a SQLite row, so
 * no single transaction spans both: the remaining window is the statement
 * sequence between that last read and the CAS, and the downstream R2
 * assembly/model-boundary filters plus the R3 sweep remain the backstop.
 *
 * Bounded by design: at most `limit` (default 5) waiting tasks per cycle, no
 * new Task, no queue, no scheduler, no transcript scanning — the only input
 * beyond the task rows is the caller-injected `readTargetTurnEvidence`
 * probe (the host adapter reads its own authorized governance store).
 */
import type { RuntimeStateManager } from './store/runtime-state-manager.js';
import type { TaskRecord } from './task-status.js';
import { PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION, type PainRecoveryDisposition } from './pain-admission-disposition.js';
import type {
  SourceMaterialAuthorizationPort,
  SourceMaterialDenialReason,
  SourceMaterialHostKind,
} from './source-material-authorization.js';
import type { PainEvidenceEntry } from './pain-signal-bridge.js';

/** Bounded per-cycle work: waiting tasks examined per reconcile run. */
export const TARGET_EVIDENCE_RECONCILE_LIMIT = 5;

/**
 * PRI-1273 (A2): the structured target-turn evidence read the reconcile (and
 * any host adapter probing on its behalf) consumes. The SAME vocabulary the
 * submit path's opportunistic enrichment uses (`pd-mcp-server`
 * submit-assembly imports this type): only `available` carries entries; a
 * consent denial is distinct from "text not yet there"; a store failure is
 * distinct from both.
 */
export type TargetTurnEvidenceRead =
  | { readonly status: 'available'; readonly entries: PainEvidenceEntry[] }
  | { readonly status: 'not_found' }
  | { readonly status: 'blocked_by_consent'; readonly reason: SourceMaterialDenialReason }
  | { readonly status: 'read_failed'; readonly reason: string };

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
  /** Flips whose CAS also backfilled the target-turn evidence entries. */
  readonly backfilled: number;
  /** Dispositions reclassified to `blocked_by_source_material_consent`. */
  readonly blocked: number;
  /** Still waiting (text not yet available) or CAS-lost to a concurrent writer. */
  readonly stillWaiting: number;
  /** Per-task structured failures (malformed payload, store error) — rc-9. */
  readonly errors: readonly string[];
}

export interface ReconcileWaitingTargetEvidenceInput {
  readonly stateManager: Pick<RuntimeStateManager, 'listTasks' | 'updateTaskIfDiagnosticJsonUnchanged' | 'getDiagnosticianServiceCursor' | 'setDiagnosticianServiceCursor'>;
  /**
   * PRI-1273: host-adapter probe — read the authorized store for the EXACT
   * (session, target turn). Owns host/workspace semantics AND the
   * source-material consent gate: a denied read returns `blocked_by_consent`,
   * never a fake not-found. The backfill persists exactly what this returns.
   *
   * Optional at the TYPE level for one reason: published-package mixing
   * (devin BUG_0001). An older adapter compiled against the PRI-1274
   * contract still passes only `targetTurnTextAvailable`; against this newer
   * Core that call must not throw at the first waiting task. PRI-1296 then
   * tightens the admission rule: a legacy boolean can keep the task waiting,
   * but it can never by itself prove evidence completeness or flip it ready.
   */
  readonly readTargetTurnEvidence?: (sessionId: string, targetTurnId: string) => TargetTurnEvidenceRead;
  /**
   * PRI-1274 boolean probe (LEGACY compatibility only). Used only when
   * `readTargetTurnEvidence` is absent. Since PRI-1296 its `true` result is
   * NOT evidence completeness: a task with no persisted evidence stays
   * waiting; only a task that already carries evidence may flip without a
   * backfill write. Consent denials cannot be classified through a boolean
   * and stay waiting under this mode.
   */
  readonly targetTurnTextAvailable?: (sessionId: string, targetTurnId: string) => boolean;
  /**
   * SPEC-PD-FEEDBACK-RESILIENCE-001 TD §2.2 ruling 4 (devin SEC_0001): the
   * LAST source-material authorization check, taken immediately before the
   * evidence CAS. The reader gated on the ledger when it READ; a revocation
   * landing between that read and this write means NO write — the `available`
   * read is turned into a denial and the task is reclassified instead. This
   * is the existing PRI-1283 R2 port (a live ledger read per call), not a new
   * mechanism. PRI-1296: unwired ⇒ no source-material evidence write at all;
   * the task stays waiting with a bounded configuration error.
   */
  readonly sourceMaterialAuthorization?: SourceMaterialAuthorizationPort;
  /** Host worker scope: when set, waiting tasks belonging to another governed
   * host are left for that host's worker. This prevents one host's reader or
   * consent state from reclassifying a foreign host's task in a shared workspace. */
  readonly hostKind?: SourceMaterialHostKind;
  readonly nowIso: string;
  readonly limit?: number;
}

interface WaitingTaskFacts {
  readonly task: TaskRecord;
  readonly diagnosticText: string;
  readonly sessionId: string;
  readonly targetTurnId: string;
  /** The task's own persisted `hostKind` (untrusted diagnostic_json) — the
   * host whose consent governs the evidence this task may receive. */
  readonly hostKind: unknown;
  readonly existingDisposition: PainRecoveryDisposition;
}

/** Every consent-governed host, exhaustively (a `Record` over the union, so
 * adding a host without listing it here fails the typecheck). Keyed lookup
 * goes through `Object.hasOwn` — `'constructor'` / `'__proto__'` are not
 * hosts (rc-5). */
const SOURCE_MATERIAL_HOST_KINDS: Readonly<Record<SourceMaterialHostKind, true>> = {
  codex: true, workbuddy: true, openclaw: true,
};

function isSourceMaterialHostKind(value: unknown): value is SourceMaterialHostKind {
  return typeof value === 'string' && Object.hasOwn(SOURCE_MATERIAL_HOST_KINDS, value);
}

type PreWriteAuthorizationGate =
  | { readonly outcome: 'authorized' }
  | { readonly outcome: 'denied'; readonly reason: SourceMaterialDenialReason }
  | { readonly outcome: 'host_invalid' };

/**
 * Ruling 4: one live authorization read for the task's governing host, taken
 * right before the evidence write. A persisted `hostKind` that is missing or
 * foreign cannot be authorization-checked — such a write fails closed
 * (`host_invalid`), it never skips the check.
 */
function preWriteAuthorizationGate(hostKind: unknown, port: SourceMaterialAuthorizationPort): PreWriteAuthorizationGate {
  if (!isSourceMaterialHostKind(hostKind)) return { outcome: 'host_invalid' };
  const decision = port.isHostSourceMaterialAuthorized(hostKind);
  return decision.authorized
    ? { outcome: 'authorized' }
    : { outcome: 'denied', reason: decision.reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * rc-4: the entries array from the host adapter is validated element-by-
 * element before anything is persisted — an entry is exactly
 * `{sourceRef, note}` with non-empty bounded strings, the same shape the
 * submit path's enrichment writes. Invalid input is a read failure, never a
 * partially-persisted evidence array.
 */
export function validateTargetTurnEvidenceEntries(entries: readonly unknown[]): PainEvidenceEntry[] | null {
  const validated: PainEvidenceEntry[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return null;
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes('sourceRef') || !keys.includes('note')) return null;
    const {sourceRef, note} = entry;
    if (typeof sourceRef !== 'string' || sourceRef.length === 0 || sourceRef.length > 500) return null;
    if (typeof note !== 'string' || note.length === 0) return null;
    validated.push({ sourceRef, note });
  }
  return validated;
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
    hostKind: parsed.hostKind,
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
 * PRI-1273 (A2): build the ONE CAS payload for a task whose target-turn
 * evidence has arrived. The disposition flip, the top-level `evidence`
 * array and `painIngress.evidenceClass` ride the SAME conditional UPDATE —
 * a concurrent writer cannot observe the flip without the evidence, or the
 * evidence without the count (SPEC TD §3 steps 6–7). An already non-empty
 * evidence array (not expected on a waiting task, but never assumed away)
 * is preserved untouched and only the disposition flips.
 */
function buildBackfillPatch(input: {
  readonly diagnostic: Record<string, unknown>;
  readonly facts: WaitingTaskFacts;
  readonly entries: PainEvidenceEntry[];
  readonly nowIso: string;
}): { readonly newRecord: Record<string, unknown>; readonly backfilled: boolean } {
  const {diagnostic, facts, entries, nowIso} = input;
  const disposition: PainRecoveryDisposition = {
    ...facts.existingDisposition,
    state: 'ready_for_diagnosis',
    reasonCode: 'target_evidence_arrived',
    attemptCount: facts.existingDisposition.attemptCount + 1,
    lastCheckedAt: nowIso,
    resolvedAt: nowIso,
  };
  const existingEvidence = Array.isArray(diagnostic.evidence) ? diagnostic.evidence : [];
  const painIngress = isRecord(diagnostic.painIngress) ? diagnostic.painIngress : {};
  if (existingEvidence.length === 0) {
    return {
      newRecord: {
        ...diagnostic,
        evidence: entries,
        painIngress: { ...painIngress, evidenceClass: { status: 'available' as const, entryCount: entries.length } },
        recovery: disposition,
      },
      backfilled: true,
    };
  }
  // Evidence already present (e.g. an owner statement arrived through another
  // path): preserve it and the class that already agrees with its count.
  return {
    newRecord: { ...diagnostic, recovery: disposition },
    backfilled: false,
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
  let backfilled = 0;
  let blocked = 0;
  let stillWaiting = 0;
  const errors: string[] = [];

  // Mode resolution (devin BUG_0001): the structured reader is the PRI-1273
  // contract; the legacy boolean probe keeps old published adapters working
  // at their old flip-only semantics. A caller wiring NEITHER gets a loud
  // per-task error, never a throw that would degrade the whole worker cycle.
  type ResolvedRead = TargetTurnEvidenceRead | { readonly status: 'legacy_available' } | { readonly status: 'misconfigured' };
  const structuredRead = input.readTargetTurnEvidence;
  const legacyProbe = input.targetTurnTextAvailable;
  const resolveRead = (sessionId: string, targetTurnId: string): ResolvedRead => {
    if (structuredRead !== undefined) return structuredRead(sessionId, targetTurnId);
    if (legacyProbe !== undefined) return legacyProbe(sessionId, targetTurnId) ? { status: 'legacy_available' } : { status: 'not_found' };
    return { status: 'misconfigured' };
  };

  // r2b (devin finding 0002): rotate through the waiting set — resume after
  // the last examined task of the previous FULL page; a short page means the
  // set's tail was reached, so the cursor resets and the next pass wraps to
  // the oldest again. No waiting task can permanently occupy the window.
  const cursor = await input.stateManager.getDiagnosticianServiceCursor(TARGET_EVIDENCE_RECONCILE_SCOPE);
  const resumeAfter = cursor !== null && cursor.lastUpdatedAt.length > 0
    ? { updatedAt: cursor.lastUpdatedAt, taskId: cursor.lastTaskId }
    : undefined;
  let waiting = await input.stateManager.listTasks({
    taskKind: 'diagnostician',
    status: 'pending',
    recoveryState: 'waiting_for_target_evidence',
    orderBy: 'updated_at_asc',
    ...(resumeAfter !== undefined ? { afterCursor: resumeAfter } : {}),
    limit,
  });
  if (resumeAfter !== undefined && waiting.length === 0) {
    // The persisted resume point sits at/past the waiting set's tail (the
    // previous page came back FULL — e.g. exactly `limit` waiting tasks —
    // so everything still waiting sorts at-or-before it). Resuming from it
    // returns an empty page on every pass and, because a stale cursor is
    // only ever rewritten when a page is non-empty, the set would stall
    // permanently. Wrap to the first page IN THE SAME PASS so the cycle's
    // bounded examination still happens instead of wasting a worker cycle.
    waiting = await input.stateManager.listTasks({
      taskKind: 'diagnostician',
      status: 'pending',
      recoveryState: 'waiting_for_target_evidence',
      orderBy: 'updated_at_asc',
      limit,
    });
  }
  if (waiting.length > 0) {
    const last = waiting[waiting.length - 1];
    if (last === undefined) throw new Error('unreachable: non-empty page has a last element');
    // Full page → continue after it next cycle; short page → wrap to start.
    const nextCursor = waiting.length === limit
      ? { lastUpdatedAt: last.updatedAt, lastTaskId: last.taskId }
      : { lastUpdatedAt: '', lastTaskId: '' };
    await input.stateManager.setDiagnosticianServiceCursor(TARGET_EVIDENCE_RECONCILE_SCOPE, nextCursor);
  } else if (resumeAfter !== undefined) {
    // The stale resume point yielded nothing even after the wrap — the
    // waiting set drained. Clear the cursor so the next pass scans cleanly
    // from the start rather than resuming past a dead position forever.
    await input.stateManager.setDiagnosticianServiceCursor(TARGET_EVIDENCE_RECONCILE_SCOPE, { lastUpdatedAt: '', lastTaskId: '' });
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
    if (input.hostKind !== undefined && facts.hostKind !== input.hostKind) {
      if (!isSourceMaterialHostKind(facts.hostKind)) {
        errors.push(`target_evidence_reconcile_host_invalid:taskId=${task.taskId}`);
      }
      continue;
    }
    let read = resolveRead(facts.sessionId, facts.targetTurnId);
    if (read.status === 'not_found') {
      stillWaiting += 1;
      continue;
    }
    if (read.status === 'misconfigured') {
      errors.push(`target_evidence_reconcile_unconfigured:taskId=${task.taskId}`);
      stillWaiting += 1;
      continue;
    }
    if (read.status === 'read_failed') {
      // Observable degradation, bounded code + reason (rc-9): the task keeps
      // waiting and is re-examined on a later cycle.
      errors.push(`target_evidence_read_failed:taskId=${task.taskId}:${read.reason.slice(0, 80)}`);
      stillWaiting += 1;
      continue;
    }
    // TD §2.2 ruling 4 (devin SEC_0001): the LAST authorization check before
    // any evidence is written. Only `available` reaches a write of source
    // material — the legacy flip-only mode persists nothing from the source,
    // so it is not gated here. A denial found at this point reclassifies the
    // task exactly like a read-time denial: nothing from the revoked source
    // is persisted.
    if (read.status === 'available') {
      if (input.sourceMaterialAuthorization === undefined) {
        // PRI-1296: no final authorization port means no source-material
        // write at all. This is a caller misconfiguration, not evidence absence.
        errors.push(`target_evidence_reconcile_authorization_unavailable:taskId=${task.taskId}`);
        stillWaiting += 1;
        continue;
      }
      const gate = preWriteAuthorizationGate(facts.hostKind, input.sourceMaterialAuthorization);
      if (gate.outcome === 'host_invalid') {
        // Fail closed: a write whose governing host cannot be determined
        // cannot be authorization-checked, so it does not happen (rc-9).
        errors.push(`target_evidence_reconcile_host_kind_invalid:taskId=${task.taskId}`);
        stillWaiting += 1;
        continue;
      }
      if (gate.outcome === 'denied') read = { status: 'blocked_by_consent', reason: gate.reason };
    }
    let parsedRecord: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(facts.diagnosticText);
      parsedRecord = isRecord(parsed) ? parsed : {};
    } catch {
      errors.push(`target_evidence_reconcile_payload_invalid:taskId=${task.taskId}`);
      continue;
    }
    if (read.status === 'blocked_by_consent') {
      // PRI-1273 / PRI-1283: a source-material denial is a DIFFERENT state
      // from waiting — persist the block with its reason code so the read
      // model shows why, and never mix it back into the waiting set.
      // CodeRabbit: this write is inside the per-task error boundary — a
      // transient store failure becomes one bounded error line and the loop
      // continues with the next task; it must never abort the whole pass
      // (the already-flipped tasks' report would be lost with it).
      try {
        const disposition: PainRecoveryDisposition = {
          ...facts.existingDisposition,
          state: 'blocked_by_source_material_consent',
          reasonCode: `target_turn_source_material_${read.reason}`,
          attemptCount: facts.existingDisposition.attemptCount + 1,
          lastCheckedAt: input.nowIso,
        };
        const updated = await input.stateManager.updateTaskIfDiagnosticJsonUnchanged(
          task.taskId,
          facts.diagnosticText,
          { diagnosticJson: JSON.stringify({ ...parsedRecord, recovery: disposition }) },
          {
            expectedStatus: task.status,
            expectedLeaseOwner: task.leaseOwner ?? null,
            expectedLeaseExpiresAt: task.leaseExpiresAt ?? null,
            expectedLeaseGeneration: task.leaseGeneration ?? 0,
            expectedAttemptCount: task.attemptCount,
          },
        );
        if (updated !== null) {
          blocked += 1;
        } else {
          // Lost a race — the concurrent writer's state wins; re-checked next cycle.
          stillWaiting += 1;
        }
      } catch (error: unknown) {
        errors.push(`target_evidence_reconcile_failed:taskId=${task.taskId}:${error instanceof Error ? Array.from(error.message).slice(0, 80).join('') : 'unknown'}`);
      }
      continue;
    }
    try {
      // `legacy_available` (old adapter probe) is not evidence. PRI-1296:
      // it may flip ONLY a task that already carries persisted evidence; an
      // empty-evidence task stays waiting until a structured reader can
      // backfill real entries in the same CAS.
      let patch: { readonly newRecord: Record<string, unknown>; readonly backfilled: boolean };
      if (read.status === 'legacy_available') {
        const existingEvidence = Array.isArray(parsedRecord.evidence) ? parsedRecord.evidence : [];
        if (existingEvidence.length === 0) {
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
        patch = { newRecord: { ...parsedRecord, recovery: disposition }, backfilled: false };
      } else {
        const entries = validateTargetTurnEvidenceEntries(read.entries);
        if (entries === null || entries.length === 0) {
          errors.push(`target_evidence_read_invalid_entries:taskId=${task.taskId}`);
          stillWaiting += 1;
          continue;
        }
        patch = buildBackfillPatch({ diagnostic: parsedRecord, facts, entries, nowIso: input.nowIso });
      }
      // Status/lease preconditions (P1-4 parity): a worker that leased or
      // finished the task in the read→write window defeats the flip in the
      // same statement as the diagnostic_json comparison.
      const updated = await input.stateManager.updateTaskIfDiagnosticJsonUnchanged(
        task.taskId,
        facts.diagnosticText,
        { diagnosticJson: JSON.stringify(patch.newRecord) },
        {
          expectedStatus: task.status,
          expectedLeaseOwner: task.leaseOwner ?? null,
          expectedLeaseExpiresAt: task.leaseExpiresAt ?? null,
          expectedLeaseGeneration: task.leaseGeneration ?? 0,
          expectedAttemptCount: task.attemptCount,
        },
      );
      if (updated !== null) {
        flipped += 1;
        if (patch.backfilled) backfilled += 1;
      } else {
        // Lost a race — the concurrent writer's state wins; re-checked next cycle.
        stillWaiting += 1;
      }
    } catch (error: unknown) {
      errors.push(`target_evidence_reconcile_failed:taskId=${task.taskId}:${error instanceof Error ? Array.from(error.message).slice(0, 80).join('') : 'unknown'}`);
    }
  }

  return { checked, flipped, backfilled, blocked, stillWaiting, errors };
}
