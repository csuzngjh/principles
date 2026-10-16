import { createRuntimeStateHandle } from './runtime-state-handle.js';
import type { RuntimeStateHandle } from './runtime-state-handle.js';
import type { RecoveryResult } from './store/lifecycle/recovery-sweep.js';
import type { TaskRecord } from './task-status.js';
import type { TaskStoreUpdatePatch } from './store/task/task-store.js';
import { PDRuntimeError } from './error-categories.js';
import { isRunnerKind } from './internalization/peer-runner-contracts.js';
import { hydratePITaskRecord, mergePITaskMetadata, createPITaskDiagnosticJson, FAILED_TASK_RECOVERY_RETENTION } from './internalization/pitask-metadata.js';
import { ownerRetryNeedsHumanReviewTask } from './internalization/owner-retry.js';
import type { OwnerRetryOutcome } from './internalization/owner-retry.js';
import * as crypto from 'crypto';

export interface FailedTaskRecoveryInfo {
  taskId: string;
  taskKind: string;
  attemptCount: number;
  maxAttempts: number;
  isExhausted: boolean;
  status: string;
  /**
   * Persisted inputRef of the task record. For diag_* stage tasks this is
   * the parent diagnostician task ID (linkage written by
   * SplitDiagnosticianRunner.ensureSubTask); for diagnostician parent tasks
   * it is the source painId. null when absent — consumers that need the
   * stage→parent linkage must fall back to the diag_<stage>-<parentTaskId>
   * ID convention and report unresolved linkage honestly.
   */
  inputRef: string | null;
}

export interface FailedTaskRecoveryResult {
  taskId: string;
  previousStatus: string;
  newStatus: string;
  attemptCount: number;
  maxAttempts: number;
  forceApplied: boolean;
  /** Attempt budget before the recovery reset (PRI-991; additive, optional). */
  previousAttemptCount?: number;
  previousMaxAttempts?: number;
}

/**
 * PRI-991 — read-only precheck for recovering ONE failed task. Pure read:
 * no mutation, no audit, no telemetry. Consumed by the CLI dry-run AND as
 * the confirm path's pre-mutation guard.
 */
export interface FailedTaskRecoveryInspection {
  taskId: string;
  found: boolean;
  taskKind?: string;
  status?: string;
  attemptCount?: number;
  maxAttempts?: number;
  isExhausted?: boolean;
  /** `isExhausted` — recovering requires the explicit `resetBudget` opt-in. */
  budgetResetRequired?: boolean;
  /** Active (unexpired) lease on the task row. */
  leaseConflict?: boolean;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  /** Parsed pi_metadata carries a completionIntent with status 'pending'. */
  completionIntentPending?: boolean;
  /** Kind is in the recoverable set (runner kinds + diagnostician). */
  kindRecoverable?: boolean;
  /** All guards pass — a confirm with the right budget flag would recover. */
  eligible: boolean;
  /** Stable refusal/eligibility code (FR-06). */
  reasonCode: string;
  nextAction?: string;
}

/**
 * PRI-991 — structured outcome of the strict single-task recovery. Every
 * non-recovered variant leaves the task row untouched (single CAS write).
 */
export type SingleTaskRecoveryOutcome =
  | { status: 'not_found' }
  | { status: 'kind_not_recoverable'; taskKind: string }
  | { status: 'not_failed'; taskKind: string; previousStatus: string }
  | { status: 'invalid_task_metadata'; taskKind: string }
  | { status: 'lease_conflict'; taskKind: string; leaseOwner: string; leaseExpiresAt: string }
  | { status: 'completion_intent_pending'; taskKind: string }
  | { status: 'budget_exhausted'; taskKind: string; attemptCount: number; maxAttempts: number; nextAction: string }
  | { status: 'conflict'; taskKind: string; previousStatus: string }
  | {
      status: 'recovered';
      taskKind: string;
      previousStatus: string;
      previousAttemptCount: number;
      previousMaxAttempts: number;
      newMaxAttempts: number;
      budgetResetApplied: boolean;
      /**
       * PRI-991 (P1-03): id of the durable audit fact embedded in the task's
       * own metadata by the SAME conditional UPDATE that moved the task to
       * pending. The recovery_actions.jsonl line must carry the same id; the
       * CLI's --repair-audit mode re-projects from this fact.
       */
      actionId: string;
    };

export interface RecoverySweepService {
  detectExpiredLeases(): Promise<string[]>;
  recoverTask(taskId: string): Promise<RecoveryResult | null>;
  detectFailedTasks(): Promise<FailedTaskRecoveryInfo[]>;
  recoverFailedTask(taskId: string, force?: boolean): Promise<FailedTaskRecoveryResult | null>;
  /** PRI-991: read-only single-task recovery precheck. */
  inspectFailedTaskRecovery(taskId: string): Promise<FailedTaskRecoveryInspection>;
  /** PRI-991: strict single-task recovery (guards + CAS + opt-in budget reset). */
  recoverSingleFailedTask(taskId: string, opts?: { resetBudget?: boolean; operator?: string }): Promise<SingleTaskRecoveryOutcome>;
  /**
   * Governance Recovery Actions v1: Owner authority reset for a
   * needs_human_review task (→ pending, clears runnerDecision +
   * completionIntent atomically). Same sequence as
   * `pd runtime internalization retry --confirm` (shared implementation).
   */
  recoverNeedsHumanReviewTask(taskId: string): Promise<OwnerRetryOutcome>;
  close(): Promise<void>;
}

export interface RecoverySweepServiceHandle {
  service: RecoverySweepService;
  close: () => Promise<void>;
}

/** TaskRecord.diagnosticJson is optional — normalize to the store's null contract. */
function readRawDiagnosticJson(task: TaskRecord): string | null {
  return typeof task.diagnosticJson === 'string' ? task.diagnosticJson : null;
}

/**
 * PRI-991 (P1-02): recovery metadata guard — the recovery qualification
 * contract over the task's diagnostic payload. This is a STRUCTURAL check
 * only; the governance judgment itself stays with the ONE hydration
 * authority (hydratePITaskRecord) — no second parser, no second truth.
 *
 *   'absent'  — no payload or valid JSON without the `pi_metadata` key:
 *               legal legacy shape (production: failed diagnostician tasks).
 *               A completion intent cannot exist where there is no PI
 *               metadata, so recovery may proceed (batch parity, T02-F).
 *   'valid'   — `pi_metadata` present and hydrates through the single
 *               authority; the completionIntent guard is meaningful.
 *   'invalid' — unparseable JSON, or `pi_metadata` present but failing
 *               hydration: a corrupted governance record must fail CLOSED
 *               (`invalid_task_metadata`), never read as "no intent" (T02-A/B/C).
 */
type RecoveryMetadataGuard =
  | { state: 'absent' }
  | { state: 'valid'; piTask: NonNullable<ReturnType<typeof hydratePITaskRecord>> }
  | { state: 'invalid' };

function assessRecoveryMetadataGuard(task: TaskRecord): RecoveryMetadataGuard {
  const raw = readRawDiagnosticJson(task);
  if (raw === null || raw.trim() === '') return { state: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'invalid' };
  }
  const hasPiMetadata = typeof parsed === 'object'
    && parsed !== null
    && !Array.isArray(parsed)
    && Object.hasOwn(parsed, 'pi_metadata');
  if (!hasPiMetadata) return { state: 'absent' };
  const piTask = hydratePITaskRecord(task);
  if (piTask === null) return { state: 'invalid' };
  return { state: 'valid', piTask };
}

/** PRI-991 (P1-04): the FULL decision snapshot joins the conditional UPDATE. */
function failedRecoveryPreconditions(task: TaskRecord, expectedStatus: string): {
  expectedStatus: string;
  expectedAttemptCount: number;
  expectedMaxAttempts: number;
  expectedLeaseOwner: string | null;
  expectedLeaseExpiresAt: string | null;
} {
  return {
    expectedStatus,
    expectedAttemptCount: task.attemptCount,
    expectedMaxAttempts: task.maxAttempts,
    expectedLeaseOwner: task.leaseOwner ?? null,
    expectedLeaseExpiresAt: task.leaseExpiresAt ?? null,
  };
}

/** PRI-991 (P1-03): active (unexpired) lease check shared by inspect + recover. */
function hasActiveLease(task: TaskRecord): { active: true; owner: string; expiresAt: string } | { active: false } {
  const owner = task.leaseOwner ?? null;
  const expiresAt = task.leaseExpiresAt ?? null;
  if (owner === null || expiresAt === null) return { active: false };
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs) || expiryMs <= Date.now()) return { active: false };
  return { active: true, owner, expiresAt };
}

/**
 * ONE patch builder for the failed→pending reset — the legacy batch path and
 * the strict single-task path share this so the mutation content has exactly
 * one authority (P4). Budget semantics: exhausted + reset → maxAttempts =
 * max(maxAttempts, attemptCount) + 3, attemptCount 0; otherwise maxAttempts
 * unchanged, attemptCount 0. lastError / lease / resultRef cleared; runs,
 * artifacts are NEVER touched. The strict path additionally injects the
 * durable audit fact via `diagnosticJson` (P1-03) — the batch path keeps the
 * metadata payload untouched.
 */
function buildFailedRecoveryPatch(
  task: TaskRecord,
  resetBudget: boolean,
): { isExhausted: boolean; newMaxAttempts: number; patch: TaskStoreUpdatePatch } {
  const isExhausted = task.attemptCount >= task.maxAttempts;
  const newMaxAttempts = isExhausted && resetBudget
    ? Math.max(task.maxAttempts, task.attemptCount) + 3
    : task.maxAttempts;
  return {
    isExhausted,
    newMaxAttempts,
    patch: {
      status: 'pending',
      attemptCount: 0,
      maxAttempts: newMaxAttempts,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      resultRef: null,
    },
  };
}

/**
 * Recover a failed task to `pending` — the single recovery authority for the
 * failed→pending reset semantics (PRI-674), shared by the recovery sweep
 * service and `pd pain retry` (PRI-934). Callers must not re-implement this
 * transition: attempt-budget handling (exhausted + force → +3) and lease/
 * result clearing live here only.
 *
 * Returns null (no mutation) when the task is absent or not in `failed`
 * status; throws `input_invalid` when the budget is exhausted and force is
 * not supplied.
 *
 * PRI-991: the mutation is now a CAS
 * (`updateTaskIfDiagnosticJsonUnchanged` with `expectedStatus: 'failed'`)
 * over the caller's read snapshot — a concurrent writer that moved the task
 * out of `failed` (or mutated its metadata) between this read and write
 * loses the race and yields null instead of a double recovery. Observable
 * batch behavior is unchanged (null already meant "skipped").
 */
export async function recoverFailedTask(
  stateManager: Pick<RuntimeStateHandle['stateManager'], 'getTask' | 'updateTaskIfDiagnosticJsonUnchanged'>,
  taskId: string,
  force = false,
): Promise<FailedTaskRecoveryResult | null> {
  const task = await stateManager.getTask(taskId);
  if (!task) return null;
  if (task.status !== 'failed') return null;

  const { isExhausted, patch } = buildFailedRecoveryPatch(task, force);
  if (isExhausted && !force) {
    throw new PDRuntimeError(
      'input_invalid',
      `Task ${taskId} has exhausted max attempts (${task.attemptCount}/${task.maxAttempts}). Use force to recover.`,
    );
  }

  // PRI-991 (P1-04): the batch path joins the same full decision snapshot —
  // a concurrent budget/lease writer defeats the recovery instead of being
  // silently overwritten. Observable behavior unchanged (null → "skipped").
  const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
    taskId,
    readRawDiagnosticJson(task),
    patch,
    failedRecoveryPreconditions(task, 'failed'),
  );
  if (!updated) return null;

  return {
    taskId: updated.taskId,
    previousStatus: 'failed',
    newStatus: updated.status,
    attemptCount: updated.attemptCount,
    maxAttempts: updated.maxAttempts,
    forceApplied: isExhausted && force,
    previousAttemptCount: task.attemptCount,
    previousMaxAttempts: task.maxAttempts,
  };
}

/**
 * PRI-991 — read-only inspection of ONE task for single-task recovery.
 * Guards, in refusal-priority order: existence → kind legality → status
 * (`failed` only) → active lease → pending completion intent → budget.
 * Malformed metadata never blocks the inspection (it only makes the intent
 * guard unprovable — the CAS still protects the mutation).
 */
export async function inspectFailedTaskRecovery(
  stateManager: Pick<RuntimeStateHandle['stateManager'], 'getTask' | 'updateTaskIfDiagnosticJsonUnchanged'>,
  taskId: string,
): Promise<FailedTaskRecoveryInspection> {
  const task = await stateManager.getTask(taskId);
  if (!task) {
    return {
      taskId,
      found: false,
      eligible: false,
      reasonCode: 'task_not_found',
      nextAction: 'Verify the exact taskId in this workspace (pd runtime internalization queue --json); prefixes and wildcards are never matched',
    };
  }
  const kindRecoverable = isRunnerKind(task.taskKind) || task.taskKind === 'diagnostician';
  const leaseCheck = hasActiveLease(task);
  const leaseConflict = leaseCheck.active;
  const isExhausted = task.attemptCount >= task.maxAttempts;
  const isFailed = task.status === 'failed';
  const metadataGuard = assessRecoveryMetadataGuard(task);
  const completionIntentPending = metadataGuard.state === 'valid' && metadataGuard.piTask.completionIntent?.status === 'pending';

  const base = {
    taskId,
    found: true,
    taskKind: task.taskKind,
    status: task.status,
    attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts,
    isExhausted,
    budgetResetRequired: isExhausted,
    leaseConflict,
    leaseOwner: task.leaseOwner ?? null,
    leaseExpiresAt: task.leaseExpiresAt ?? null,
    completionIntentPending,
    kindRecoverable,
  };

  if (!kindRecoverable) {
    return { ...base, eligible: false, reasonCode: 'kind_not_recoverable', nextAction: `Task kind '${task.taskKind}' has no failed-task recovery entry` };
  }
  if (!isFailed) {
    return { ...base, eligible: false, reasonCode: 'not_failed', nextAction: `Task is '${task.status}', not 'failed' — nothing to recover` };
  }
  // PRI-991 (P1-02): corrupted governance payload fails closed BEFORE any
  // other guard can be interpreted — a corrupt record must never read as
  // "no pending intent" (the guard itself must not be bypassable). The
  // metadataGuard was computed above (single assessment, shared with the
  // completionIntentPending projection).
  if (metadataGuard.state === 'invalid') {
    return { ...base, eligible: false, reasonCode: 'invalid_task_metadata', nextAction: 'The task pi_metadata is present but fails validation (parsePITaskMetadata/hydratePITaskRecord) — inspect and repair the diagnostic payload before recovering' };
  }
  if (leaseConflict) {
    return { ...base, eligible: false, reasonCode: 'lease_conflict', nextAction: 'Wait for the lease to expire (the per-cycle recovery sweep will reclaim it), then retry' };
  }
  if (metadataGuard.state === 'valid' && metadataGuard.piTask.completionIntent?.status === 'pending') {
    return { ...base, eligible: false, reasonCode: 'completion_intent_pending', nextAction: 'A runner verdict completion intent is still pending — let the runner resume it, or resolve it via the governance focus before recovering' };
  }
  if (isExhausted) {
    return { ...base, eligible: true, reasonCode: 'eligible_budget_reset_required', nextAction: 'Recoverable with an explicit budget reset: rerun with --confirm --reset-budget' };
  }
  return { ...base, eligible: true, reasonCode: 'eligible', nextAction: 'Recoverable: rerun with --confirm' };
}

/**
 * PRI-991 — strict single-task recovery. Same mutation authority as
 * `recoverFailedTask` (shared patch builder + CAS), plus the guards the
 * batch path deliberately does not enforce: exact-task kind legality, active
 * lease refusal, pending completion intent refusal, and the budget reset as
 * an explicit `resetBudget` opt-in (structured refusal instead of a throw).
 */
export async function recoverSingleFailedTask(
  stateManager: Pick<RuntimeStateHandle['stateManager'], 'getTask' | 'updateTaskIfDiagnosticJsonUnchanged'>,
  taskId: string,
  opts: { resetBudget?: boolean; operator?: string } = {},
): Promise<SingleTaskRecoveryOutcome> {
  const task = await stateManager.getTask(taskId);
  if (!task) return { status: 'not_found' };
  if (!isRunnerKind(task.taskKind) && task.taskKind !== 'diagnostician') {
    return { status: 'kind_not_recoverable', taskKind: task.taskKind };
  }
  if (task.status !== 'failed') {
    return { status: 'not_failed', taskKind: task.taskKind, previousStatus: task.status };
  }
  // PRI-991 (P1-02): corrupted governance payload fails closed — identical
  // judgment to inspectFailedTaskRecovery (T02-G), evaluated at mutation time.
  const metadataGuard = assessRecoveryMetadataGuard(task);
  if (metadataGuard.state === 'invalid') {
    return { status: 'invalid_task_metadata', taskKind: task.taskKind };
  }
  const leaseCheck = hasActiveLease(task);
  if (leaseCheck.active) {
    return { status: 'lease_conflict', taskKind: task.taskKind, leaseOwner: leaseCheck.owner, leaseExpiresAt: leaseCheck.expiresAt };
  }
  if (metadataGuard.state === 'valid' && metadataGuard.piTask.completionIntent?.status === 'pending') {
    return { status: 'completion_intent_pending', taskKind: task.taskKind };
  }

  const { isExhausted, newMaxAttempts, patch } = buildFailedRecoveryPatch(task, opts.resetBudget === true);
  if (isExhausted && opts.resetBudget !== true) {
    return {
      status: 'budget_exhausted',
      taskKind: task.taskKind,
      attemptCount: task.attemptCount,
      maxAttempts: task.maxAttempts,
      nextAction: 'Rerun with --reset-budget to explicitly reset the attempt budget (run history and failure reasons are preserved)',
    };
  }

  // PRI-991 (P1-03): the audit fact rides the SAME conditional UPDATE as the
  // status change (crash-durable). The JSONL is a projection of this fact,
  // never its source of truth. Only hydratable payloads carry the record —
  // legacy absent-metadata payloads stay byte-identical (documented
  // reliability boundary: their JSONL projection has no row-fact fallback).
  // r2 P1-01: the operator-provided label is part of the durable fact (an
  // unprojected recovery must be repairable WITH its operator attribution);
  // it remains a label, never an authenticated identity.
  // r2 P1-02: the fact is APPENDED to the per-task array (bounded retention)
  // — a second recovery must never destroy an unprojected prior fact.
  const actionId = crypto.randomUUID();
  if (metadataGuard.state === 'valid') {
    const priorRecords = metadataGuard.piTask.failedTaskRecoveries ?? [];
    const merged = mergePITaskMetadata(metadataGuard.piTask, {
      failedTaskRecoveries: [
        ...priorRecords,
        {
          actionId,
          recoveredAt: new Date().toISOString(),
          operator: opts.operator?.trim() ? opts.operator.trim() : null,
          previousStatus: 'failed',
          previousAttemptCount: task.attemptCount,
          previousMaxAttempts: task.maxAttempts,
          newMaxAttempts,
          budgetResetApplied: isExhausted && opts.resetBudget === true,
        },
      ].slice(-FAILED_TASK_RECOVERY_RETENTION),
    });
    patch.diagnosticJson = createPITaskDiagnosticJson(merged);
  }

  // PRI-991 (P1-04): every field the decision depended on joins the WHERE
  // clause — a concurrent budget/lease/metadata writer defeats the recovery.
  const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
    taskId,
    readRawDiagnosticJson(task),
    patch,
    failedRecoveryPreconditions(task, 'failed'),
  );
  if (!updated) {
    return { status: 'conflict', taskKind: task.taskKind, previousStatus: task.status };
  }
  return {
    status: 'recovered',
    taskKind: task.taskKind,
    previousStatus: 'failed',
    previousAttemptCount: task.attemptCount,
    previousMaxAttempts: task.maxAttempts,
    newMaxAttempts: updated.maxAttempts,
    budgetResetApplied: isExhausted && opts.resetBudget === true,
    actionId,
  };
}

class RecoverySweepServiceImpl implements RecoverySweepService {
  constructor(private readonly stateManager: RuntimeStateHandle['stateManager']) {}

  async detectExpiredLeases(): Promise<string[]> {
    return this.stateManager.detectExpiredLeases();
  }

  async recoverTask(taskId: string): Promise<RecoveryResult | null> {
    return this.stateManager.recoverTask(taskId);
  }

  async detectFailedTasks(): Promise<FailedTaskRecoveryInfo[]> {
    const failedTasks = await this.stateManager.listTasks({ status: 'failed' });
    return failedTasks
      // Discovery must cover everything recoverFailedTask() can recover: the
      // 6 peer runners, the diag_* split-pipeline stages (isRunnerKind), and
      // the parent 'diagnostician' task (a TaskRecord kind, not a RunnerKind).
      // Unrelated kinds (e.g. principle_candidate_intake) stay excluded.
      .filter(t => isRunnerKind(t.taskKind) || t.taskKind === 'diagnostician')
      .map(t => ({
        taskId: t.taskId,
        taskKind: t.taskKind,
        attemptCount: t.attemptCount,
        maxAttempts: t.maxAttempts,
        isExhausted: t.attemptCount >= t.maxAttempts,
        status: t.status,
        inputRef: t.inputRef ?? null,
      }));
  }

  async recoverFailedTask(taskId: string, force = false): Promise<FailedTaskRecoveryResult | null> {
    return recoverFailedTask(this.stateManager, taskId, force);
  }

  async inspectFailedTaskRecovery(taskId: string): Promise<FailedTaskRecoveryInspection> {
    return inspectFailedTaskRecovery(this.stateManager, taskId);
  }

  async recoverSingleFailedTask(taskId: string, opts: { resetBudget?: boolean; operator?: string } = {}): Promise<SingleTaskRecoveryOutcome> {
    return recoverSingleFailedTask(this.stateManager, taskId, opts);
  }

  async recoverNeedsHumanReviewTask(taskId: string): Promise<OwnerRetryOutcome> {
    return ownerRetryNeedsHumanReviewTask(this.stateManager, taskId);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async close(): Promise<void> {
    // No-op: RuntimeStateManager lifecycle managed by handle
  }
}

export async function createRecoverySweepService(
  opts: { workspaceDir: string },
): Promise<RecoverySweepServiceHandle> {
  const handle = await createRuntimeStateHandle({ workspaceDir: opts.workspaceDir });
  const service = new RecoverySweepServiceImpl(handle.stateManager);
  return {
    service,
    close: handle.close,
  };
}
