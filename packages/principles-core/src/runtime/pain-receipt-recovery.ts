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
 * (`updateTaskIfDiagnosticJsonUnchanged`) — never a second Pain/Task, queue,
 * lease or evidence store.
 *
 * Match rules (SPEC TD §1.3.3): exact workspace + hostKind + tool name
 * (caller-enforced) + receipt schema/capability/status + exact
 * painId/taskId + the deterministic taskId↔painId mapping + original task
 * `input_ref`. Idempotent replay of the SAME physical call folds; a receipt
 * with a DIFFERENT toolCallId against an already-bound task is ambiguous.
 * `submit_unconfirmed` must be confirmed by an exact-ID read-back before it
 * may recover identity. Nothing here reads transcripts, prompts, reasons or
 * anchor text — the persisted metadata is exactly the receipt identity
 * fields plus the recovery disposition.
 */

import { RuntimeStateManager } from './store/runtime-state-manager.js';
import type { TaskRecord } from './task-status.js';
import { createDiagnosticianTaskId } from './pain-signal-bridge.js';
import {
  SUBMIT_PAIN_CAPABILITY_ID,
  SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION,
} from './pain-submit-capability.js';

/** Recovery disposition states (SPEC TD §1.3 "Recovery disposition"). */
export type PainRecoveryState =
  | 'waiting_for_receipt'
  | 'waiting_for_target_evidence'
  | 'ready_for_diagnosis'
  | 'blocked_by_consent'
  | 'ambiguous_receipt'
  | 'recovery_exhausted'
  | 'unrecoverable';

export const PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION = 1 as const;

/** Minimal reference to the receipt that drove (or was rejected for) this
 * task — identity fields only, never tool input/output text. */
export interface PainRecoveryReceiptRef {
  readonly schemaVersion: string;
  readonly capability: string;
  readonly status: string;
  readonly toolCallId: string;
  readonly receivedAt: string;
}

/** Versioned recovery object persisted inside the original task's
 * `diagnostic_json` (no new TaskStatus; SPEC TD §3 step 9). */
export interface PainRecoveryDisposition {
  readonly schemaVersion: typeof PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION;
  readonly state: PainRecoveryState;
  readonly reasonCode: string;
  readonly attemptCount: number;
  readonly lastCheckedAt: string;
  readonly nextCheckAt?: string;
  readonly receiptRef?: PainRecoveryReceiptRef;
  readonly resolvedAt?: string;
}

/** The strict receipt surface this recovery accepts. */
export interface ValidatedPainSubmitReceipt {
  readonly status: 'submitted' | 'submit_unconfirmed';
  readonly painId: string;
  readonly taskId: string;
  readonly workspaceDir: string;
}

export type PainSubmitReceiptValidation =
  | { readonly ok: true; readonly receipt: ValidatedPainSubmitReceipt }
  | { readonly ok: false; readonly reasonCode: string };

const RECEIPT_ALLOWED_KEYS = [
  'schemaVersion', 'capability', 'status', 'painId', 'taskId', 'workspaceDir',
  'diagnosis', 'anchor', 'provenance', 'warnings', 'error', 'nextAction', 'sessionAssociation',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length === value.length && value.length <= 200;
}

/**
 * Strict validation of a parsed `pd.pain-submit-receipt.v1` document
 * (rc-1/rc-2/rc-3: guards, no `as`, unknown/malformed fields fail loud).
 *
 * Rejected on purpose: degraded transport forms (the minimal receipt lost
 * `schemaVersion`/`capability`; the plain-text statement), `refused` /
 * `failed` statuses (nothing recoverable was written), and any
 * painId/taskId pair that breaks the deterministic mapping.
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
  if (value.status !== 'submitted' && value.status !== 'submit_unconfirmed') {
    return { ok: false, reasonCode: `receipt_status_not_recoverable:${String(value.status)}` };
  }
  if (!isNonEmptyId(value.painId)) return { ok: false, reasonCode: 'receipt_pain_id_invalid' };
  if (!isNonEmptyId(value.taskId)) return { ok: false, reasonCode: 'receipt_task_id_invalid' };
  if (value.taskId !== createDiagnosticianTaskId(value.painId)) {
    return { ok: false, reasonCode: 'receipt_task_id_mapping_mismatch' };
  }
  if (typeof value.workspaceDir !== 'string' || value.workspaceDir.length === 0) {
    return { ok: false, reasonCode: 'receipt_workspace_invalid' };
  }
  // Exact-string workspace equality; the HOST adapter additionally compares
  // path-normalized forms before invoking the recovery (platform path
  // knowledge belongs to the host layer, and Core stays path-free).
  if (value.workspaceDir !== options.workspaceDir) {
    return { ok: false, reasonCode: 'receipt_workspace_mismatch' };
  }
  return {
    ok: true,
    receipt: { status: value.status, painId: value.painId, taskId: value.taskId, workspaceDir: value.workspaceDir },
  };
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
  | { readonly status: 'rejected'; readonly reasonCode: string; readonly painId?: string; readonly taskId?: string };

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

/**
 * One evaluation pass against a freshly-read task row. Pure decision +
 * patch construction; the caller owns the read-CAS loop.
 */
type Evaluation =
  | { action: 'cas'; expectedJson: string; newJson: string; outcome: PainReceiptRecoveryOutcome }
  | { action: 'report'; outcome: PainReceiptRecoveryOutcome }
  | { action: 'cas_disposition_only'; expectedJson: string; newJson: string; outcome: PainReceiptRecoveryOutcome };

function evaluateRecoveryPass(input: {
  task: TaskRecord;
  diagnostic: ParsedDiagnosticJson;
  receipt: ValidatedPainSubmitReceipt;
  identity: ReceiptEventIdentity;
  authorized: boolean;
  nowIso: string;
}): Evaluation {
  const { task, diagnostic, receipt, identity, authorized, nowIso } = input;

  if (task.inputRef !== receipt.painId) {
    return { action: 'report', outcome: { status: 'rejected', reasonCode: 'task_input_ref_mismatch', painId: receipt.painId, taskId: receipt.taskId } };
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
    // touches no identity fields and respects every protection above.
    const disposition: PainRecoveryDisposition = {
      schemaVersion: PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION,
      state: 'blocked_by_consent',
      reasonCode: 'minimal_identity_metadata_not_granted',
      attemptCount: nextAttemptCount(existingRecovery),
      lastCheckedAt: nowIso,
      receiptRef: buildReceiptRef(receipt, identity, nowIso),
    };
    return {
      action: 'cas_disposition_only',
      expectedJson: diagnostic.text,
      newJson: mergeDisposition(diagnostic, disposition),
      outcome: { status: 'rejected', reasonCode: 'blocked_by_consent', painId: receipt.painId, taskId: receipt.taskId },
    };
  }

  // Unbound + authorized + original task: bind the submission identity.
  if (!isRecord(diagnostic.record.painIngress)) {
    // An original pd_submit_pain task always carries the versioned ingress
    // block; without it this is not that task — fail closed, no mutation.
    return { action: 'report', outcome: { status: 'rejected', reasonCode: 'diagnostic_payload_invalid:pain_ingress_missing', painId: receipt.painId, taskId: receipt.taskId } };
  }
  const evidenceCount = countEvidence(diagnostic);
  const disposition: PainRecoveryDisposition = {
    schemaVersion: PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION,
    state: evidenceCount > 0 ? 'ready_for_diagnosis' : 'waiting_for_target_evidence',
    reasonCode: 'receipt_recovered',
    attemptCount: nextAttemptCount(existingRecovery),
    lastCheckedAt: nowIso,
    receiptRef: buildReceiptRef(receipt, identity, nowIso),
    ...(evidenceCount > 0 ? { resolvedAt: nowIso } : {}),
  };
  const painIngress: Record<string, unknown> = { ...diagnostic.record.painIngress };
  painIngress.verifiedHostSession = {
    status: 'verified',
    sessionId: identity.sessionId,
    ...(identity.submissionTurnId === undefined ? {} : { submissionTurnId: identity.submissionTurnId }),
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
    outcome: { status: 'recovered', painId: receipt.painId, taskId: receipt.taskId, disposition },
  };
}

/** Bounded CAS retry: one re-read + re-evaluate on a lost race. */
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
        nowIso: now().toISOString(),
      });
      if (evaluation.action === 'report') return evaluation.outcome;
      const updated = await manager.updateTaskIfDiagnosticJsonUnchanged(
        options.receipt.taskId,
        evaluation.expectedJson,
        { diagnosticJson: evaluation.newJson },
      );
      if (updated !== null) return evaluation.outcome;
      // CAS lost a race: loop once with a fresh read. A second loss is a
      // persistent concurrent writer — report, never blind-retry.
      if (attempt === MAX_CAS_ATTEMPTS) {
        return { status: 'rejected', reasonCode: 'cas_conflict', painId: options.receipt.painId, taskId: options.receipt.taskId };
      }
    }
    // Unreachable: the loop returns on every path.
    return { status: 'rejected', reasonCode: 'cas_conflict' };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'rejected', reasonCode: `recovery_store_error:${message.slice(0, 120)}` };
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
