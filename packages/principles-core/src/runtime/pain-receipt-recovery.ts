/**
 * Pain submit receipt recovery — PRI-1274 B1 fallback path
 * (SPEC-PD-FEEDBACK-RESILIENCE-001 v0.7 §G2, TD §1.3 "兜底路径").
 *
 * When a `pd_submit_pain` MCP request carried NO trusted host `_meta`, the
 * original Pain/Task is legally persisted unbound. The host's formal
 * tool-completion event (Codex PostToolUse) then carries PD's own structured
 * receipt (`pd.pain-submit-receipt.v1`) plus host-authoritative identity
 * (session/turn/tool-use ids from the EVENT, never from model parameters).
 * This module validates that receipt strictly and restores the submission
 * identity on the SAME original task via the existing expected-value CAS
 * (`updateTaskIfDiagnosticJsonUnchanged` with full status/lease
 * preconditions) — never a second Pain/Task, queue, lease or evidence store.
 *
 * Match rules (SPEC TD §1.3.3): exact workspace + hostKind + tool name
 * (caller-enforced) + receipt schema/capability/status + exact
 * painId/taskId + the deterministic taskId↔painId mapping + original task
 * `input_ref` + the original task's own hostKind/workspace + the receipt's
 * `sessionAssociation` reason. Idempotent replay of the SAME physical call
 * folds; a receipt with a DIFFERENT toolCallId against an already-bound task
 * is ambiguous. `submit_unconfirmed` must be confirmed by an exact-ID
 * read-back before it may recover identity. Nothing here reads transcripts,
 * prompts, reasons or anchor text — the persisted metadata is exactly the
 * receipt identity fields plus the recovery disposition.
 *
 * Security boundary (P1-2, review round 2): the fallback may ONLY repair a
 * submission the main path left unbound because trusted metadata was absent
 * (`codex_host_metadata_missing`). A receipt whose `sessionAssociation`
 * records a SAFETY REFUSAL — `host_context_conflict`,
 * `host_context_invalid:*`, `blocked_by_consent`,
 * `codex_target_turn_invalid` — is rejected: the PostToolUse fallback must
 * never overturn a fail-closed decision the MCP path already made.
 */

import { RuntimeStateManager } from './store/runtime-state-manager.js';
import type { TaskRecord } from './task-status.js';
import { createDiagnosticianTaskId } from './pain-signal-bridge.js';
import { isSentinelSessionId } from './pain-ingress-payload.js';
import {
  SUBMIT_PAIN_CAPABILITY_ID,
  SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION,
} from './pain-submit-capability.js';
import { PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION } from './pain-admission-disposition.js';
import type { PainRecoveryDisposition, PainRecoveryReceiptRef } from './pain-admission-disposition.js';

// Re-exported for the existing consumers of this module's surface (the
// canonical definitions live in the leaf `pain-admission-disposition.ts`).
export type {
  PainRecoveryState,
  PainRecoveryDisposition,
  PainRecoveryReceiptRef,
} from './pain-admission-disposition.js';
export { PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION } from './pain-admission-disposition.js';

/** The association outcome of the ORIGINAL submit, as carried on the receipt
 * (P1-2: retained through validation — the fallback's security boundary). */
export type ReceiptSessionAssociation =
  | { readonly status: 'verified'; readonly sessionId: string; readonly submissionTurnId?: string; readonly targetTurnId?: string }
  | { readonly status: 'unverified'; readonly detail: string }
  | { readonly status: 'absent' };

/** The strict receipt surface this recovery accepts. */
export interface ValidatedPainSubmitReceipt {
  readonly status: 'submitted' | 'submit_unconfirmed';
  readonly painId: string;
  readonly taskId: string;
  readonly workspaceDir: string;
  readonly sessionAssociation: ReceiptSessionAssociation;
}

export type PainSubmitReceiptValidation =
  | { readonly ok: true; readonly receipt: ValidatedPainSubmitReceipt }
  | { readonly ok: false; readonly reasonCode: string };

const RECEIPT_ALLOWED_KEYS = [
  'schemaVersion', 'capability', 'status', 'painId', 'taskId', 'workspaceDir',
  'diagnosis', 'anchor', 'provenance', 'warnings', 'error', 'nextAction', 'sessionAssociation',
] as const;

/**
 * The ONLY unbound causes the PostToolUse fallback is allowed to repair
 * (P1-2). `codex_host_metadata_missing` is the designated fallback
 * territory: the host attached no trusted `_meta`, so the completion event's
 * own host identity is the designated repair source. Every other cause —
 * a conflict the main path detected, malformed metadata, a consent refusal,
 * an invalid target turn — stays refused here.
 */
const RECOVERABLE_UNVERIFIED_DETAILS: ReadonlySet<string> = new Set(['codex_host_metadata_missing']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length === value.length && value.length <= 200;
}

/** Bounded diagnostic text by CODE POINTS — never splits a surrogate pair
 * (a CJK store message must not render U+FFFD at the cut; EP-11). */
function boundedDetail(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join('');
}

/** Host identity value: non-empty, bounded, and never a sentinel spelling. */
function isUsableHostId(value: unknown): value is string {
  return isNonEmptyId(value) && !isSentinelSessionId(value);
}

function validateSessionAssociation(value: unknown): ReceiptSessionAssociation | null {
  if (!isRecord(value)) return null;
  if (value.status === 'verified') {
    const allowed = ['status', 'sessionId', 'submissionTurnId', 'targetTurnId'] as const;
    for (const key of Object.keys(value)) {
      if (!(allowed as readonly string[]).includes(key)) return null;
    }
    if (!isUsableHostId(value.sessionId)) return null;
    const optionalTurn = (candidate: unknown): candidate is string => candidate === undefined || isUsableHostId(candidate);
    if (!optionalTurn(value.submissionTurnId) || !optionalTurn(value.targetTurnId)) return null;
    return {
      status: 'verified',
      sessionId: value.sessionId,
      ...(value.submissionTurnId === undefined ? {} : { submissionTurnId: value.submissionTurnId }),
      ...(value.targetTurnId === undefined ? {} : { targetTurnId: value.targetTurnId }),
    };
  }
  if (value.status === 'unverified') {
    const allowed = ['status', 'detail'] as const;
    for (const key of Object.keys(value)) {
      if (!(allowed as readonly string[]).includes(key)) return null;
    }
    if (typeof value.detail !== 'string' || value.detail.length === 0 || value.detail.length > 200) return null;
    return { status: 'unverified', detail: value.detail };
  }
  if (value.status === 'absent') {
    return Object.keys(value).length === 1 ? { status: 'absent' } : null;
  }
  return null;
}

/**
 * Strict validation of a parsed `pd.pain-submit-receipt.v1` document
 * (rc-1/rc-2/rc-3: guards, no `as`, unknown/malformed fields fail loud).
 *
 * Rejected on purpose: degraded transport forms (the minimal receipt lost
 * `schemaVersion`/`capability`; the plain-text statement), `refused` /
 * `failed` statuses (nothing recoverable was written), and any
 * painId/taskId pair that breaks the deterministic mapping. A present
 * `sessionAssociation` must match the receipt contract exactly — it is the
 * P1-2 security boundary, so a malformed value is invalid rather than
 * dropped.
 */
export function validatePainSubmitReceipt(
  value: unknown,
  options: { readonly workspaceDir: string },
): PainSubmitReceiptValidation {
  if (!isRecord(value)) return { ok: false, reasonCode: 'receipt_not_an_object' };
  for (const key of Object.keys(value)) {
    if (!(RECEIPT_ALLOWED_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reasonCode: 'receipt_unknown_field' };
    }
  }
  if (value.schemaVersion !== SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION) {
    return { ok: false, reasonCode: 'receipt_schema_version_mismatch' };
  }
  if (value.capability !== SUBMIT_PAIN_CAPABILITY_ID) {
    return { ok: false, reasonCode: 'receipt_capability_mismatch' };
  }
  if (typeof value.status !== 'string' || (value.status !== 'submitted' && value.status !== 'submit_unconfirmed')) {
    // Fixed code only — the raw status value is untrusted JSON and never
    // stringified into a reason code (it could be any JSON value).
    return { ok: false, reasonCode: 'receipt_status_not_recoverable' };
  }
  if (!isNonEmptyId(value.painId)) return { ok: false, reasonCode: 'receipt_pain_id_invalid' };
  if (!isNonEmptyId(value.taskId)) return { ok: false, reasonCode: 'receipt_task_id_invalid' };
  if (value.taskId !== createDiagnosticianTaskId(value.painId)) {
    return { ok: false, reasonCode: 'receipt_task_id_mapping_mismatch' };
  }
  if (typeof value.workspaceDir !== 'string' || value.workspaceDir.length === 0) {
    return { ok: false, reasonCode: 'receipt_workspace_invalid' };
  }
  // Exact-string workspace equality; the HOST adapter normalizes both sides
  // (path.resolve) BEFORE this check — platform path knowledge belongs to
  // the host layer, and Core stays path-free.
  if (value.workspaceDir !== options.workspaceDir) {
    return { ok: false, reasonCode: 'receipt_workspace_mismatch' };
  }
  const sessionAssociation = value.sessionAssociation === undefined
    ? { status: 'absent' } as const
    : validateSessionAssociation(value.sessionAssociation);
  if (sessionAssociation === null) {
    return { ok: false, reasonCode: 'receipt_session_association_invalid' };
  }
  return {
    ok: true,
    receipt: { status: value.status, painId: value.painId, taskId: value.taskId, workspaceDir: value.workspaceDir, sessionAssociation },
  };
}

/**
 * P1-2 gate: may THIS receipt's original unbound cause be repaired by the
 * PostToolUse fallback at all? Only `unverified` with an explicitly
 * recoverable detail passes; a `verified` original flows on to the normal
 * idempotent/conflict handling (never a fresh bind decision made here).
 */
export function isReceiptSessionAssociationRecoverable(
  association: ReceiptSessionAssociation,
): { readonly ok: true } | { readonly ok: false; readonly reasonCode: string; readonly detail?: string } {
  if (association.status === 'verified') return { ok: true };
  if (association.status === 'absent') {
    // No association record means the producer never said WHY the submission
    // was unbound — not a designated fallback cause. Fail closed.
    return { ok: false, reasonCode: 'session_association_not_recoverable', detail: 'absent' };
  }
  if (!RECOVERABLE_UNVERIFIED_DETAILS.has(association.detail)) {
    // `host_context_conflict`, `host_context_invalid:*`, `blocked_by_consent`,
    // `codex_target_turn_invalid`, … — safety refusals the main path already
    // made; the fallback must never overturn them (P1-2).
    return { ok: false, reasonCode: 'session_association_not_recoverable', detail: association.detail };
  }
  return { ok: true };
}

/** Host-authoritative identity taken from the completion EVENT context. */
export interface ReceiptEventIdentity {
  /** Host session id (`session_id` on the Codex PostToolUse payload). */
  readonly sessionId: string;
  /** Optional submission turn (`turn_id`). Absence never blocks recovery. */
  readonly submissionTurnId?: string;
  /** The physical tool call id (`tool_use_id`) — the ambiguity key. */
  readonly toolCallId: string;
}

export type PainReceiptRecoveryOutcome =
  | { readonly status: 'recovered'; readonly painId: string; readonly taskId: string; readonly disposition: PainRecoveryDisposition }
  | { readonly status: 'already_bound'; readonly painId: string; readonly taskId: string }
  | { readonly status: 'rejected'; readonly reasonCode: string; readonly detail?: string; readonly painId?: string; readonly taskId?: string };

/** Caller-resolved authorization (the quiet flag verdict — Core stays
 * flag-agnostic; both MCP prebind and this fallback share the same scope). */
export interface ReceiptRecoveryAuthorization {
  readonly minimalMetadataGranted: boolean;
}

export interface RecoverTaskIdentityFromReceiptOptions {
  readonly workspaceDir: string;
  readonly hostKind: 'codex';
  readonly receipt: ValidatedPainSubmitReceipt;
  readonly identity: ReceiptEventIdentity;
  readonly authorization: ReceiptRecoveryAuthorization;
  /**
   * P1-3: host-layer probe — does the authorized governance store already
   * hold readable text for (session, target turn)? The fallback uses it to
   * decide `waiting_for_target_evidence` vs `ready_for_diagnosis` when the
   * task carries no submitted evidence. Absent → the text is treated as
   * missing whenever a target turn is known.
   */
  readonly targetTurnTextAvailable?: (sessionId: string, targetTurnId: string) => boolean;
  readonly now?: () => Date;
  /** Test seam; production uses the real manager. */
  readonly managerFactory?: (workspaceDir: string) => Promise<RuntimeStateManager>;
}

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'needs_human_review']);

function leaseActive(task: TaskRecord, nowMs: number): boolean {
  if (task.status !== 'leased') return false;
  const expiresAt = task.leaseExpiresAt === null || task.leaseExpiresAt === undefined
    ? null
    : Date.parse(task.leaseExpiresAt);
  return expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt > nowMs;
}

interface ParsedDiagnosticJson {
  readonly record: Record<string, unknown>;
  readonly text: string;
}

function parseDiagnosticJson(task: TaskRecord): ParsedDiagnosticJson | null {
  if (task.diagnosticJson === null || task.diagnosticJson === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(task.diagnosticJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return { record: parsed, text: task.diagnosticJson };
}

function countEvidence(diagnostic: ParsedDiagnosticJson): number {
  return Array.isArray(diagnostic.record.evidence) ? diagnostic.record.evidence.length : 0;
}

function buildReceiptRef(receipt: ValidatedPainSubmitReceipt, identity: ReceiptEventIdentity, nowIso: string): PainRecoveryReceiptRef {
  return {
    schemaVersion: SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION,
    capability: SUBMIT_PAIN_CAPABILITY_ID,
    status: receipt.status,
    toolCallId: identity.toolCallId,
    receivedAt: nowIso,
  };
}

/** Continuity for repeated checks: a fresh disposition increments the
 * persisted attempt count instead of resetting it (SPEC TD §3 step 9). */
function nextAttemptCount(existingRecovery: unknown): number {
  if (isRecord(existingRecovery) && typeof existingRecovery.attemptCount === 'number'
    && Number.isInteger(existingRecovery.attemptCount) && existingRecovery.attemptCount >= 1) {
    return existingRecovery.attemptCount + 1;
  }
  return 1;
}

function mergeDisposition(diagnostic: ParsedDiagnosticJson, disposition: PainRecoveryDisposition): string {
  return JSON.stringify({ ...diagnostic.record, recovery: disposition });
}

/** The read-time task snapshot the CAS write re-asserts atomically (P1-4):
 * a worker that acquires a lease or pushes the task to a terminal state in
 * the read→write window defeats the UPDATE in the SAME statement as the
 * diagnostic_json comparison — the check-then-write race is closed. */
interface TaskCasPreconditions {
  readonly expectedStatus: string;
  readonly expectedLeaseOwner: string | null;
  readonly expectedLeaseExpiresAt: string | null;
}

/**
 * One evaluation pass against a freshly-read task row. Pure decision +
 * patch construction; the caller owns the read-CAS loop.
 */
type Evaluation =
  | { action: 'cas'; expectedJson: string; newJson: string; preconditions: TaskCasPreconditions; outcome: PainReceiptRecoveryOutcome }
  | { action: 'report'; outcome: PainReceiptRecoveryOutcome }
  | { action: 'cas_disposition_only'; expectedJson: string; newJson: string; preconditions: TaskCasPreconditions; outcome: PainReceiptRecoveryOutcome };

function evaluateRecoveryPass(input: {
  task: TaskRecord;
  diagnostic: ParsedDiagnosticJson;
  receipt: ValidatedPainSubmitReceipt;
  identity: ReceiptEventIdentity;
  authorized: boolean;
  targetTurnTextAvailable: ((sessionId: string, targetTurnId: string) => boolean) | undefined;
  nowIso: string;
}): Evaluation {
  const { task, diagnostic, receipt, identity, authorized, targetTurnTextAvailable, nowIso } = input;
  const preconditions: TaskCasPreconditions = {
    expectedStatus: task.status,
    expectedLeaseOwner: task.leaseOwner ?? null,
    expectedLeaseExpiresAt: task.leaseExpiresAt ?? null,
  };

  if (task.inputRef !== receipt.painId) {
    return { action: 'report', outcome: { status: 'rejected', reasonCode: 'task_input_ref_mismatch', painId: receipt.painId, taskId: receipt.taskId } };
  }
  // P1-2.6/7: taskId/painId agreement alone proves nothing about WHO owns the
  // task — the original task must be a Codex submission for THIS workspace
  // before a Codex PostToolUse event may write identity onto it.
  if (diagnostic.record.hostKind !== 'codex') {
    return { action: 'report', outcome: { status: 'rejected', reasonCode: 'task_host_kind_mismatch', painId: receipt.painId, taskId: receipt.taskId } };
  }
  if (diagnostic.record.workspaceDir !== receipt.workspaceDir) {
    return { action: 'report', outcome: { status: 'rejected', reasonCode: 'task_workspace_mismatch', painId: receipt.painId, taskId: receipt.taskId } };
  }
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    // A terminal task is protected state — report only, never mutate (the
    // B1 contract: no reopening of historical terminal tasks).
    return { action: 'report', outcome: { status: 'rejected', reasonCode: 'task_terminal', painId: receipt.painId, taskId: receipt.taskId } };
  }
  if (leaseActive(task, Date.parse(nowIso))) {
    return { action: 'report', outcome: { status: 'rejected', reasonCode: 'task_leased', painId: receipt.painId, taskId: receipt.taskId } };
  }

  const existingHint = diagnostic.record.sessionIdHint;
  const hintPresent = typeof existingHint === 'string' && existingHint.length > 0;
  if (hintPresent && existingHint !== identity.sessionId) {
    // An already-verified, DIFFERENT identity is protected (never overwritten);
    // an event conflicting with a bound session is ambiguity, not truth.
    return { action: 'report', outcome: { status: 'rejected', reasonCode: 'identity_conflict', painId: receipt.painId, taskId: receipt.taskId } };
  }

  const existingRecovery = diagnostic.record.recovery;
  const existingRef = isRecord(existingRecovery) && isRecord(existingRecovery.receiptRef)
    ? existingRecovery.receiptRef
    : null;
  if (hintPresent && existingHint === identity.sessionId) {
    if (existingRef !== null && typeof existingRef.toolCallId === 'string' && existingRef.toolCallId !== identity.toolCallId) {
      // Same session but a DIFFERENT physical call claiming the same task:
      // multi-match ambiguity — never a second identity write.
      return { action: 'report', outcome: { status: 'rejected', reasonCode: 'ambiguous_receipt', painId: receipt.painId, taskId: receipt.taskId } };
    }
    // Same physical call replayed (or a prebound task whose _meta already
    // bound this session): idempotent — nothing to write.
    return { action: 'report', outcome: { status: 'already_bound', painId: receipt.painId, taskId: receipt.taskId } };
  }

  if (!authorized) {
    // Persist WHY the task stays unbound (rc-9) — a disposition-only write
    // touches no identity fields and respects every protection above. P2
    // review round: with the authorization OFF, NO receipt identity metadata
    // is persisted either — no receiptRef, no toolCallId.
    const disposition: PainRecoveryDisposition = {
      schemaVersion: PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION,
      state: 'blocked_by_consent',
      reasonCode: 'minimal_identity_metadata_not_granted',
      attemptCount: nextAttemptCount(existingRecovery),
      lastCheckedAt: nowIso,
    };
    return {
      action: 'cas_disposition_only',
      expectedJson: diagnostic.text,
      newJson: mergeDisposition(diagnostic, disposition),
      preconditions,
      outcome: { status: 'rejected', reasonCode: 'blocked_by_consent', painId: receipt.painId, taskId: receipt.taskId },
    };
  }

  // Unbound + authorized + original task: bind the submission identity.
  if (!isRecord(diagnostic.record.painIngress)) {
    // An original pd_submit_pain task always carries the versioned ingress
    // block; without it this is not that task — fail closed, no mutation.
    return { action: 'report', outcome: { status: 'rejected', reasonCode: 'diagnostic_payload_invalid:pain_ingress_missing', painId: receipt.painId, taskId: receipt.taskId } };
  }
  // P1-3: the host event's turn is the submission turn; without an explicit
  // target named on the original submission (not carried by the receipt),
  // the submission turn IS the target (the tool's documented semantics).
  // Never inferred further — no target turn means session-level policy.
  const targetTurnId = identity.submissionTurnId;
  const evidenceCount = countEvidence(diagnostic);
  const targetTextMissing = targetTurnId !== undefined
    && evidenceCount === 0
    && (targetTurnTextAvailable === undefined || !targetTurnTextAvailable(identity.sessionId, targetTurnId));
  const disposition: PainRecoveryDisposition = {
    schemaVersion: PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION,
    state: targetTextMissing ? 'waiting_for_target_evidence' : 'ready_for_diagnosis',
    reasonCode: targetTextMissing ? 'target_turn_text_pending' : 'receipt_recovered',
    attemptCount: nextAttemptCount(existingRecovery),
    lastCheckedAt: nowIso,
    receiptRef: buildReceiptRef(receipt, identity, nowIso),
    ...(targetTextMissing ? {} : { resolvedAt: nowIso }),
  };
  const painIngress: Record<string, unknown> = { ...diagnostic.record.painIngress };
  painIngress.verifiedHostSession = {
    status: 'verified',
    sessionId: identity.sessionId,
    ...(identity.submissionTurnId === undefined ? {} : { submissionTurnId: identity.submissionTurnId }),
    ...(targetTurnId === undefined ? {} : { targetTurnId }),
  };
  const newRecord = {
    ...diagnostic.record,
    sessionIdHint: identity.sessionId,
    painIngress,
    recovery: disposition,
  };
  return {
    action: 'cas',
    expectedJson: diagnostic.text,
    newJson: JSON.stringify(newRecord),
    preconditions,
    outcome: { status: 'recovered', painId: receipt.painId, taskId: receipt.taskId, disposition },
  };
}

/** Bounded CAS retry: re-read + re-evaluate on a lost race; a second loss is
 * a persistent concurrent writer and becomes an explicit degraded outcome
 * (never a blind retry and never a second Pain/Task). */
const MAX_CAS_ATTEMPTS = 2;

async function openManager(options: RecoverTaskIdentityFromReceiptOptions): Promise<RuntimeStateManager> {
  if (options.managerFactory !== undefined) return options.managerFactory(options.workspaceDir);
  const manager = new RuntimeStateManager({ workspaceDir: options.workspaceDir, bootstrapIfMissing: false });
  await manager.initialize();
  return manager;
}

/**
 * Attempt receipt-driven identity recovery on the original task. Never
 * throws: every failure is a structured outcome (rc-9).
 */
export async function recoverTaskIdentityFromReceipt(
  options: RecoverTaskIdentityFromReceiptOptions,
): Promise<PainReceiptRecoveryOutcome> {
  const now = options.now ?? (() => new Date());
  // P1-2 gate first — a receipt whose original submission was refused for a
  // safety reason is rejected BEFORE any store is opened or row read; the
  // fallback never re-litigates a fail-closed main-path decision.
  const associationGate = isReceiptSessionAssociationRecoverable(options.receipt.sessionAssociation);
  if (!associationGate.ok) {
    return {
      status: 'rejected',
      reasonCode: associationGate.reasonCode,
      ...(associationGate.detail === undefined ? {} : { detail: associationGate.detail }),
      painId: options.receipt.painId,
      taskId: options.receipt.taskId,
    };
  }
  // P2: event identity fields get the same unified format/sentinel check the
  // trusted `_meta` path applies — a sentinel or malformed id is a rejection,
  // never a bind.
  if (!isUsableHostId(options.identity.sessionId) || !isUsableHostId(options.identity.toolCallId)
    || (options.identity.submissionTurnId !== undefined && !isUsableHostId(options.identity.submissionTurnId))) {
    return { status: 'rejected', reasonCode: 'event_identity_invalid', painId: options.receipt.painId, taskId: options.receipt.taskId };
  }
  let manager: RuntimeStateManager | undefined;
  try {
    manager = await openManager(options);
    // submit_unconfirmed: the write outcome is unknown — identity recovery
    // is only allowed after the exact-ID read-back confirms the task exists.
    if (options.receipt.status === 'submit_unconfirmed') {
      const confirmed = await manager.getTask(options.receipt.taskId);
      if (confirmed === null || confirmed.inputRef !== options.receipt.painId) {
        return { status: 'rejected', reasonCode: 'submit_unconfirmed_task_not_found', painId: options.receipt.painId, taskId: options.receipt.taskId };
      }
    }
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const task = await manager.getTask(options.receipt.taskId);
      if (task === null) {
        return { status: 'rejected', reasonCode: 'task_not_found', painId: options.receipt.painId, taskId: options.receipt.taskId };
      }
      const diagnostic = parseDiagnosticJson(task);
      if (diagnostic === null) {
        return { status: 'rejected', reasonCode: 'diagnostic_payload_invalid', painId: options.receipt.painId, taskId: options.receipt.taskId };
      }
      const evaluation = evaluateRecoveryPass({
        task,
        diagnostic,
        receipt: options.receipt,
        identity: options.identity,
        authorized: options.authorization.minimalMetadataGranted,
        targetTurnTextAvailable: options.targetTurnTextAvailable,
        nowIso: now().toISOString(),
      });
      if (evaluation.action === 'report') return evaluation.outcome;
      // P1-4: diagnostic_json, task status AND lease columns are asserted in
      // ONE conditional UPDATE — a worker acquiring the lease or finishing
      // the task between read and write defeats this write atomically.
      const updated = await manager.updateTaskIfDiagnosticJsonUnchanged(
        options.receipt.taskId,
        evaluation.expectedJson,
        { diagnosticJson: evaluation.newJson },
        {
          expectedStatus: evaluation.preconditions.expectedStatus,
          expectedLeaseOwner: evaluation.preconditions.expectedLeaseOwner,
          expectedLeaseExpiresAt: evaluation.preconditions.expectedLeaseExpiresAt,
        },
      );
      if (updated !== null) return evaluation.outcome;
      // CAS lost a race: loop once with a fresh read. A second loss is a
      // persistent concurrent writer — explicit degraded outcome, never a
      // blind retry.
      if (attempt === MAX_CAS_ATTEMPTS) {
        return { status: 'rejected', reasonCode: 'cas_conflict', painId: options.receipt.painId, taskId: options.receipt.taskId };
      }
    }
    // Unreachable: the loop returns on every path.
    return { status: 'rejected', reasonCode: 'cas_conflict' };
  } catch (error: unknown) {
    // Fixed reason code; the raw exception text (untrusted, possibly carrying
    // paths) rides ONLY as a bounded diagnostic detail, never in the code.
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'rejected', reasonCode: 'recovery_store_error', detail: boundedDetail(message, 120), painId: options.receipt.painId, taskId: options.receipt.taskId };
  } finally {
    if (manager !== undefined) {
      try {
        await manager.close();
      } catch {
        // best-effort close; the outcome above is already authoritative
      }
    }
  }
}
