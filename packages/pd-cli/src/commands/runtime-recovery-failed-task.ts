import * as path from 'path';
import * as fs from 'fs';
import type { Command } from 'commander';
import {
  createRuntimeStateHandle,
  appendRecoveryAction,
  inspectFailedTaskRecovery,
  recoverSingleFailedTask,
  listRecoveryActions,
  hydratePITaskRecord,
} from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { buildExecutionNextAction } from './runtime-recovery-failed-tasks.js';

interface RecoveryFailedTaskOptions {
  workspace?: string;
  taskId?: string;
  dryRun?: boolean;
  confirm?: boolean;
  resetBudget?: boolean;
  decidedBy?: string;
  repairAudit?: boolean;
  json?: boolean;
}

/** ERR-001-safe record narrowing for untrusted parsed JSON (rc-1/rc-2). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emit(payload: Record<string, unknown>, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined) continue;
      console.log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    }
  }
}

function refusal(payload: Record<string, unknown>, json: boolean | undefined): void {
  emit({ ok: false, ...payload }, json);
  process.exitCode = 1;
}

/**
 * PRI-991 (P1-01): both modes refuse a workspace whose state.db does not
 * exist BEFORE opening any connection — dry-run must not create it and
 * confirm must not bootstrap a wrong-typed path. The open itself re-validates
 * (no TOCTOU reliance): the check only picks the refusal path.
 */
function stateDbPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', 'state.db');
}

/**
 * PRI-991 (P1-01): classify storage-level open/query failures (missing file,
 * not-a-database, missing tables) as structured `storage_unavailable`
 * instead of the generic recovery_error — dry-run's read-only connection
 * cannot migrate or bootstrap, so these are terminal for the invocation.
 */
function isSqliteUnavailable(err: unknown): boolean {
  if (!isRecord(err)) return false;
  return typeof err.code === 'string' && err.code.startsWith('SQLITE_');
}

/**
 * PRI-991 (P2-B): channel-aware recovery nextAction. A recovered
 * code_tool_hook Artificer task is NOT executable via run-once (it refuses
 * Code Rule tasks) — the next auto-consumer cycle runs the IAER evidence
 * preflight and, without Owner evidence, parks the task in
 * needs_human_review at zero model cost. Every OTHER kind reuses the shared
 * per-kind guidance authority (buildExecutionNextAction) so both recovery
 * surfaces stay identical.
 */
function buildRecoveryNextAction(task: { taskId: string; taskKind: string; inputRef: string | null; diagnosticJson: string | null }): string {
  const { diagnosticJson } = task;
  if (diagnosticJson !== null && diagnosticJson.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(diagnosticJson);
      if (isRecord(parsed) && Object.hasOwn(parsed, 'pi_metadata')) {
        const meta = parsed.pi_metadata;
        if (isRecord(meta) && Object.hasOwn(meta, 'channel') && typeof meta.channel === 'string' && meta.channel === 'code_tool_hook') {
          return 'Task recovered to pending. The next auto-consumer cycle runs the evidence preflight on it: without Owner evidence it is parked in needs_human_review (zero model cost), then attach/resume via: pd runtime internalization evidence attach --confirm → pd runtime internalization evidence resume --confirm';
        }
      }
    } catch {
      // Unparseable payload — fall through to the per-kind guidance below.
    }
  }
  return buildExecutionNextAction(task);
}

async function repairAuditProjection(opts: RecoveryFailedTaskOptions, workspaceDir: string): Promise<void> {
  // Read-only DB handle (no bootstrap, no writes); the ONLY write this mode
  // performs is the idempotent JSONL projection append.
  let handle: Awaited<ReturnType<typeof createRuntimeStateHandle>> | null = null;
  try {
    handle = await createRuntimeStateHandle({ workspaceDir, readonly: true, bootstrapIfMissing: false });
    const rawTask = await handle.stateManager.getTask(String(opts.taskId));
    if (!rawTask) {
      refusal({ reason: 'Task not found in this workspace', reasonCode: 'task_not_found', taskId: opts.taskId, nextAction: 'Verify the exact taskId (pd runtime internalization queue --json)' }, opts.json);
      return;
    }
    const piTask = hydratePITaskRecord(rawTask);
    const record = piTask?.lastFailedTaskRecovery;
    if (!record) {
      refusal({
        reason: 'No durable recovery fact in the task metadata — nothing to project',
        reasonCode: 'no_durable_recovery_record',
        taskId: opts.taskId,
        nextAction: 'recovery_actions.jsonl has no row-fact fallback for this task (legacy absent-metadata recovery); the recovery itself stands as reported by its confirm output',
      }, opts.json);
      return;
    }
    const alreadyProjected = listRecoveryActions(workspaceDir, { taskId: String(opts.taskId) })
      .some((a) => a.actionId === record.actionId);
    if (alreadyProjected) {
      emit({
        ok: true,
        mode: 'repair_audit',
        taskId: opts.taskId,
        auditActionId: record.actionId,
        auditStatus: 'already_projected',
        nextAction: 'Nothing to do — the JSONL projection already carries this actionId',
      }, opts.json);
      return;
    }
    appendRecoveryAction(workspaceDir, {
      actionId: record.actionId,
      taskId: String(opts.taskId),
      previousStatus: record.previousStatus,
      result: 'recovered',
      operator: record.operator ?? undefined,
      forceApplied: record.budgetResetApplied,
      previousAttemptCount: record.previousAttemptCount,
    });
    emit({
      ok: true,
      mode: 'repair_audit',
      taskId: opts.taskId,
      auditActionId: record.actionId,
      auditStatus: 'repaired',
      previousAttemptCount: record.previousAttemptCount,
      newMaxAttempts: record.newMaxAttempts,
      nextAction: 'Audit projection restored. Verify: pd runtime internalization queue --json (task state untouched by this mode)',
    }, opts.json);
  } catch (err: unknown) {
    if (isSqliteUnavailable(err)) {
      refusal({ reason: err instanceof Error ? err.message : String(err), reasonCode: 'storage_unavailable', nextAction: 'Check the workspace path — repair-audit opens the database read-only and never creates it' }, opts.json);
      return;
    }
    refusal({ reason: err instanceof Error ? err.message : String(err), reasonCode: 'repair_failed', nextAction: 'Fix the audit sink (workspace/.state/recovery_actions.jsonl) and re-run; the durable row fact is untouched' }, opts.json);
  } finally {
    if (handle) await handle.close();
  }
}

export async function handleRuntimeRecoveryFailedTask(opts: RecoveryFailedTaskOptions): Promise<void> {
  if (opts.dryRun && opts.confirm) {
    refusal({
      reason: 'Error: --dry-run and --confirm are mutually exclusive',
      reasonCode: 'flag_conflict',
      nextAction: 'Specify only one of --dry-run or --confirm (dry-run is the default)',
    }, opts.json);
    return;
  }
  if (opts.repairAudit && opts.confirm) {
    refusal({
      reason: 'Error: --repair-audit and --confirm are mutually exclusive',
      reasonCode: 'flag_conflict',
      nextAction: '--repair-audit only re-projects the JSONL audit from the durable row fact; it never mutates task state',
    }, opts.json);
    return;
  }
  const rawTaskId = opts.taskId ?? '';
  const taskId = rawTaskId.trim();
  if (taskId === '' || taskId !== rawTaskId) {
    refusal({
      reason: 'Error: --task-id requires the exact task id (no surrounding whitespace)',
      reasonCode: 'invalid_task_id',
      nextAction: 'Copy the full taskId from: pd runtime internalization queue --json (or the audit-artificer-evidence output)',
    }, opts.json);
    return;
  }

  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();

  // PRI-991 (P1-01): refuse before opening ANY connection when the database
  // does not exist — dry-run must not create it, confirm must not bootstrap.
  if (!fs.existsSync(stateDbPath(workspaceDir))) {
    refusal({
      reason: `No state database at ${stateDbPath(workspaceDir)}`,
      reasonCode: 'storage_unavailable',
      nextAction: 'This workspace has no .pd/state.db — verify the --workspace path; recovery never creates databases',
    }, opts.json);
    return;
  }

  if (opts.repairAudit) {
    await repairAuditProjection(opts, workspaceDir);
    return;
  }

  const isConfirm = opts.confirm ?? false;

  // PRI-991 (P1-01): dry-run opens a STRICTLY read-only connection with
  // bootstrap disabled — no mkdir, no WAL journal, no schema init/migration
  // can happen from the file open onward. Confirm uses the controlled write
  // connection (bootstrap likewise disabled: the DB is known to exist).
  let closeHandle: (() => Promise<void>) | null = null;
  try {
    const handle = await createRuntimeStateHandle({
      workspaceDir,
      readonly: !isConfirm,
      bootstrapIfMissing: false,
    });
    closeHandle = handle.close;
    const { stateManager } = handle;

    if (!isConfirm) {
      // Dry-run (default): pure read — no task mutation, no audit append.
      const inspection = await inspectFailedTaskRecovery(stateManager, taskId);
      const plannedChange = inspection.eligible && inspection.isExhausted === true
        ? {
            status: 'failed → pending',
            attemptBudget: `${inspection.attemptCount}/${inspection.maxAttempts} → 0/${(inspection.maxAttempts ?? 0) + 3} (with --reset-budget)`,
            audit: 'a durable recovery fact is written into the task metadata in the same transaction, then projected to .state/recovery_actions.jsonl',
          }
        : inspection.eligible
          ? {
              status: 'failed → pending',
              attemptBudget: `${inspection.attemptCount}/${inspection.maxAttempts} → 0/${inspection.maxAttempts}`,
              audit: 'a durable recovery fact is written into the task metadata in the same transaction, then projected to .state/recovery_actions.jsonl',
            }
          : undefined;
      const payload: Record<string, unknown> = {
        ok: inspection.eligible,
        mode: 'dry_run',
        ...inspection,
        plannedChange,
        wouldWriteAudit: false,
        workspace: workspaceDir,
        ...(inspection.eligible
          ? { nextAction: inspection.isExhausted === true
            ? 'Recover with: pd runtime recovery failed-task --task-id <exact-task-id> --confirm --reset-budget'
            : 'Recover with: pd runtime recovery failed-task --task-id <exact-task-id> --confirm' }
          : {}),
      };
      if (!inspection.eligible) {
        payload.reasonCode = inspection.reasonCode;
      }
      emit(payload, opts.json);
      if (!inspection.eligible) {
        process.exitCode = 1;
      }
      return;
    }

    // Confirm: precheck for precise structured refusals (and zero writes on
    // refusal), then the strict single-task mutation (full-snapshot CAS).
    const inspection = await inspectFailedTaskRecovery(stateManager, taskId);
    if (!inspection.eligible) {
      refusal({
        reason: 'Task is not recoverable in its current state',
        reasonCode: inspection.reasonCode,
        taskId,
        taskKind: inspection.taskKind,
        status: inspection.status,
        attemptCount: inspection.attemptCount,
        maxAttempts: inspection.maxAttempts,
        nextAction: inspection.nextAction,
      }, opts.json);
      return;
    }

    const outcome = await recoverSingleFailedTask(stateManager, taskId, { resetBudget: opts.resetBudget ?? false });
    if (outcome.status !== 'recovered') {
      // Lost a race against a concurrent writer, or a guard fired at mutation
      // time — structured refusal, zero writes.
      refusal({
        reason: 'Task recovery refused (guard fired or state changed between precheck and mutation)',
        reasonCode: outcome.status === 'not_found' ? 'task_not_found' : outcome.status,
        taskId,
        ...(outcome.status === 'not_failed' ? { currentStatus: outcome.previousStatus } : {}),
        ...(outcome.status === 'budget_exhausted'
          ? { nextAction: outcome.nextAction }
          : { nextAction: 'Re-run the dry-run to inspect the current state' }),
      }, opts.json);
      return;
    }

    // PRI-991 (P1-03): the durable audit fact is ALREADY committed inside the
    // recovery CAS (task metadata `lastFailedTaskRecovery`, actionId shared).
    // The JSONL line is a projection; a projection failure must never misreport
    // the recovery as failed — and never asks the Owner to re-confirm.
    const current = await stateManager.getTask(taskId);
    let auditStatus: 'projected' | 'recovered_but_audit_failed' = 'projected';
    let auditFailureReason: string | undefined;
    try {
      appendRecoveryAction(workspaceDir, {
        actionId: outcome.actionId,
        taskId,
        previousStatus: 'failed',
        result: 'recovered',
        operator: opts.decidedBy,
        forceApplied: outcome.budgetResetApplied,
        previousAttemptCount: outcome.previousAttemptCount,
      });
    } catch (auditErr: unknown) {
      auditStatus = 'recovered_but_audit_failed';
      auditFailureReason = auditErr instanceof Error ? auditErr.message : String(auditErr);
    }

    const nextAction = buildRecoveryNextAction({
      taskId,
      taskKind: outcome.taskKind,
      inputRef: current?.inputRef ?? null,
      diagnosticJson: typeof current?.diagnosticJson === 'string' ? current.diagnosticJson : null,
    });

    emit({
      ok: true,
      mode: 'confirm',
      taskId,
      taskKind: outcome.taskKind,
      previousStatus: outcome.previousStatus,
      newStatus: current?.status ?? 'pending',
      attemptCount: current?.attemptCount ?? 0,
      maxAttempts: current?.maxAttempts ?? outcome.newMaxAttempts,
      previousAttemptCount: outcome.previousAttemptCount,
      previousMaxAttempts: outcome.previousMaxAttempts,
      newMaxAttempts: outcome.newMaxAttempts,
      budgetResetApplied: outcome.budgetResetApplied,
      auditStatus,
      ...(auditStatus === 'recovered_but_audit_failed'
        ? {
            auditFailureReason,
            auditActionId: outcome.actionId,
            decidedByLabel: opts.decidedBy ?? null,
            nextAction: `Recovery IS committed (durable fact in the task metadata, actionId ${outcome.actionId}); the JSONL projection failed (${auditFailureReason ?? 'unknown'}). Do NOT re-run --confirm. Repair with: pd runtime recovery failed-task --task-id <exact-task-id> --repair-audit`,
          }
        : {
            auditActionId: outcome.actionId,
            nextAction,
          }),
      workspace: workspaceDir,
    }, opts.json);
  } catch (err: unknown) {
    if (isSqliteUnavailable(err)) {
      refusal({
        reason: err instanceof Error ? err.message : String(err),
        reasonCode: 'storage_unavailable',
        nextAction: 'The database could not be opened in its requested mode (readonly for --dry-run); recovery never migrates or bootstraps schemas',
      }, opts.json);
      return;
    }
    refusal({
      reason: err instanceof Error ? err.message : String(err),
      reasonCode: 'recovery_error',
      nextAction: 'Check the workspace path and DB connectivity, then re-run the dry-run',
    }, opts.json);
  } finally {
    if (closeHandle) {
      await closeHandle();
    }
  }
}

/**
 * Register `failed-task` (singular) under `pd runtime recovery` (PRI-991).
 * The exact single-task counterpart of the batch `failed-tasks` command:
 * the two coexist and the batch command is unchanged.
 */
export function registerRuntimeRecoveryFailedTaskCommand(
  recoveryCmd: Command,
  handlers: { failedTask?: typeof handleRuntimeRecoveryFailedTask } = {},
): void {
  const handler = handlers.failedTask ?? handleRuntimeRecoveryFailedTask;
  recoveryCmd
    .command('failed-task')
    .description('Recover ONE failed task by exact taskId (dry-run default; exhausted tasks additionally require --reset-budget)')
    .requiredOption('--task-id <taskId>', 'Exact task id — no prefix, no wildcard, no fallback to batch recovery')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--dry-run', 'Strictly read-only precheck: opens the DB read-only (never creates/migrates), shows the exact planned change (default)')
    .option('--confirm', 'Actually recover this one task (full-snapshot CAS; durable audit fact + JSONL projection)')
    .option('--reset-budget', 'Explicitly reset an exhausted attempt budget (required when attempts are exhausted; records previousAttemptCount in the audit)')
    .option('--repair-audit', 'Idempotently re-project the JSONL audit line from the durable recovery fact in the task metadata (never mutates task state)')
    .option('--decidedBy <label>', 'Operator-provided label recorded in the audit log (a label, NOT an authenticated identity)')
    .option('--json', 'Output raw JSON')
    .action(async (opts: RecoveryFailedTaskOptions) => {
      await handler(opts);
    });
}
