import { createRuntimeStateHandle } from './runtime-state-handle.js';
import type { RuntimeStateHandle } from './runtime-state-handle.js';
import type { RecoveryResult } from './store/lifecycle/recovery-sweep.js';
import type { TaskRecord } from './task-status.js';
import { PDRuntimeError } from './error-categories.js';
import { isRunnerKind } from './internalization/peer-runner-contracts.js';
import { hydratePITaskRecord } from './internalization/pitask-metadata.js';
import { ownerRetryNeedsHumanReviewTask } from './internalization/owner-retry.js';
import type { OwnerRetryOutcome } from './internalization/owner-retry.js';

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
  /** Attempt budget before the recovery reset (PRI-990; additive, optional). */
  previousAttemptCount?: number;
  previousMaxAttempts?: number;
}

/**
 * PRI-990 — read-only precheck for recovering ONE failed task. Pure read:
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
 * PRI-990 — structured outcome of the strict single-task recovery. Every
 * non-recovered variant leaves the task row untouched (single CAS write).
 */
export type SingleTaskRecoveryOutcome =
  | { status: 'not_found' }
  | { status: 'kind_not_recoverable'; taskKind: string }
  | { status: 'not_failed'; taskKind: string; previousStatus: string }
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
    };

export interface RecoverySweepService {
  detectExpiredLeases(): Promise<string[]>;
  recoverTask(taskId: string): Promise<RecoveryResult | null>;
  detectFailedTasks(): Promise<FailedTaskRecoveryInfo[]>;
  recoverFailedTask(taskId: string, force?: boolean): Promise<FailedTaskRecoveryResult | null>;
  /** PRI-990: read-only single-task recovery precheck. */
  inspectFailedTaskRecovery(taskId: string): Promise<FailedTaskRecoveryInspection>;
  /** PRI-990: strict single-task recovery (guards + CAS + opt-in budget reset). */
  recoverSingleFailedTask(taskId: string, opts?: { resetBudget?: boolean }): Promise<SingleTaskRecoveryOutcome>;
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
 * ONE patch builder for the failed→pending reset — the legacy batch path and
 * the strict single-task path share this so the mutation content has exactly
 * one authority (P4). Budget semantics: exhausted + reset → maxAttempts =
 * max(maxAttempts, attemptCount) + 3, attemptCount 0; otherwise maxAttempts
 * unchanged, attemptCount 0. lastError / lease / resultRef cleared; runs,
 * artifacts and the diagnostic metadata payload are NEVER touched.
 */
function buildFailedRecoveryPatch(
  task: TaskRecord,
  resetBudget: boolean,
): { isExhausted: boolean; newMaxAttempts: number; patch: { status: 'pending'; attemptCount: number; maxAttempts: number; lastError: null; leaseOwner: null; leaseExpiresAt: null; resultRef: null } } {
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
 * PRI-990: the mutation is now a CAS
 * (`updateTaskIfDiagnosticJsonUnchanged` with `expectedStatus: 'failed'`)
 * over the caller's read snapshot — a concurrent writer that moved the task
 * out of `failed` (or mutated its metadata) between this read and write
 * loses the race and yields null instead of a double recovery. Observable
 * batch behavior is unchanged (null already meant "skipped").
 */
export async function recoverFailedTask(
  stateManager: RuntimeStateHandle['stateManager'],
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

  const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
    taskId,
    readRawDiagnosticJson(task),
    patch,
    { expectedStatus: 'failed' },
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
 * PRI-990 — read-only inspection of ONE task for single-task recovery.
 * Guards, in refusal-priority order: existence → kind legality → status
 * (`failed` only) → active lease → pending completion intent → budget.
 * Malformed metadata never blocks the inspection (it only makes the intent
 * guard unprovable — the CAS still protects the mutation).
 */
export async function inspectFailedTaskRecovery(
  stateManager: RuntimeStateHandle['stateManager'],
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
  const leaseOwner = task.leaseOwner ?? null;
  const leaseExpiresAt = task.leaseExpiresAt ?? null;
  const leaseConflict = leaseOwner !== null
    && leaseExpiresAt !== null
    && !Number.isNaN(new Date(leaseExpiresAt).getTime())
    && new Date(leaseExpiresAt).getTime() > Date.now();
  const piTask = hydratePITaskRecord(task);
  const completionIntentPending = piTask?.completionIntent?.status === 'pending';
  const isExhausted = task.attemptCount >= task.maxAttempts;
  const isFailed = task.status === 'failed';

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
    leaseOwner,
    leaseExpiresAt,
    completionIntentPending,
    kindRecoverable,
  };

  if (!kindRecoverable) {
    return { ...base, eligible: false, reasonCode: 'kind_not_recoverable', nextAction: `Task kind '${task.taskKind}' has no failed-task recovery entry` };
  }
  if (!isFailed) {
    return { ...base, eligible: false, reasonCode: 'not_failed', nextAction: `Task is '${task.status}', not 'failed' — nothing to recover` };
  }
  if (leaseConflict) {
    return { ...base, eligible: false, reasonCode: 'lease_conflict', nextAction: 'Wait for the lease to expire (the per-cycle recovery sweep will reclaim it), then retry' };
  }
  if (completionIntentPending) {
    return { ...base, eligible: false, reasonCode: 'completion_intent_pending', nextAction: 'A runner verdict completion intent is still pending — let the runner resume it, or resolve it via the governance focus before recovering' };
  }
  if (isExhausted) {
    return { ...base, eligible: true, reasonCode: 'eligible_budget_reset_required', nextAction: 'Recoverable with an explicit budget reset: rerun with --confirm --reset-budget' };
  }
  return { ...base, eligible: true, reasonCode: 'eligible', nextAction: 'Recoverable: rerun with --confirm' };
}

/**
 * PRI-990 — strict single-task recovery. Same mutation authority as
 * `recoverFailedTask` (shared patch builder + CAS), plus the guards the
 * batch path deliberately does not enforce: exact-task kind legality, active
 * lease refusal, pending completion intent refusal, and the budget reset as
 * an explicit `resetBudget` opt-in (structured refusal instead of a throw).
 */
export async function recoverSingleFailedTask(
  stateManager: RuntimeStateHandle['stateManager'],
  taskId: string,
  opts: { resetBudget?: boolean } = {},
): Promise<SingleTaskRecoveryOutcome> {
  const task = await stateManager.getTask(taskId);
  if (!task) return { status: 'not_found' };
  if (!isRunnerKind(task.taskKind) && task.taskKind !== 'diagnostician') {
    return { status: 'kind_not_recoverable', taskKind: task.taskKind };
  }
  if (task.status !== 'failed') {
    return { status: 'not_failed', taskKind: task.taskKind, previousStatus: task.status };
  }
  const leaseOwner = task.leaseOwner ?? null;
  const leaseExpiresAt = task.leaseExpiresAt ?? null;
  if (leaseOwner !== null && leaseExpiresAt !== null
    && !Number.isNaN(new Date(leaseExpiresAt).getTime())
    && new Date(leaseExpiresAt).getTime() > Date.now()) {
    return { status: 'lease_conflict', taskKind: task.taskKind, leaseOwner, leaseExpiresAt };
  }
  const piTask = hydratePITaskRecord(task);
  if (piTask?.completionIntent?.status === 'pending') {
    return { status: 'completion_intent_pending', taskKind: task.taskKind };
  }

  const { isExhausted, patch } = buildFailedRecoveryPatch(task, opts.resetBudget === true);
  if (isExhausted && opts.resetBudget !== true) {
    return {
      status: 'budget_exhausted',
      taskKind: task.taskKind,
      attemptCount: task.attemptCount,
      maxAttempts: task.maxAttempts,
      nextAction: 'Rerun with --reset-budget to explicitly reset the attempt budget (run history and failure reasons are preserved)',
    };
  }

  const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
    taskId,
    readRawDiagnosticJson(task),
    patch,
    { expectedStatus: 'failed' },
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

  async recoverSingleFailedTask(taskId: string, opts: { resetBudget?: boolean } = {}): Promise<SingleTaskRecoveryOutcome> {
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
