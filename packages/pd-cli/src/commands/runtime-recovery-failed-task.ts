import * as path from 'path';
import type { Command } from 'commander';
import {
  createRuntimeStateHandle,
  appendRecoveryAction,
  inspectFailedTaskRecovery,
  recoverSingleFailedTask,
} from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface RecoveryFailedTaskOptions {
  workspace?: string;
  taskId?: string;
  dryRun?: boolean;
  confirm?: boolean;
  resetBudget?: boolean;
  decidedBy?: string;
  json?: boolean;
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
 * Parse the authoritative channel out of the task's raw diagnostic payload
 * for the channel-aware nextAction. Deliberately lenient (plain
 * pi_metadata.channel lookup, not full hydration): a recovered task whose
 * metadata fails full hydration must still get a correct Code Rule warning —
 * those tasks exist in production (PRI-989).
 */
function readAuthoredChannel(diagnosticJson: string | null): string | null {
  if (diagnosticJson === null || diagnosticJson.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(diagnosticJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Object.hasOwn(parsed, 'pi_metadata')) return null;
    const meta = (parsed as Record<string, unknown>).pi_metadata;
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
    if (!Object.hasOwn(meta, 'channel')) return null;
    const { channel } = meta as Record<string, unknown>;
    return typeof channel === 'string' ? channel : null;
  } catch {
    return null;
  }
}

/**
 * PRI-674 review P2 convention, scoped to the code channel: a recovered
 * code_tool_hook task is NOT executed by run-once (it refuses Code Rule
 * tasks), and the next auto-consumer cycle runs the IAER evidence preflight
 * on it — without Owner evidence it is parked in needs_human_review at zero
 * model cost. The nextAction must say that, never point at a command that
 * would fail or bypass the gate.
 */
function buildRecoveryNextAction(taskKind: string, diagnosticJson: string | null): string {
  if (taskKind === 'artificer' && readAuthoredChannel(diagnosticJson) === 'code_tool_hook') {
    return 'Task recovered to pending. The next auto-consumer cycle runs the evidence preflight on it: without Owner evidence it is parked in needs_human_review (zero model cost), then attach/resume via: pd runtime internalization evidence attach --confirm → pd runtime internalization evidence resume --confirm';
  }
  return 'Task recovered to pending. The auto-consumer advances it by stage; manual alternative: pd runtime internalization run-once --runner ' + taskKind + ' (Code Rule tasks are refused there by design)';
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
  const isConfirm = opts.confirm ?? false;
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

  let closeHandle: (() => Promise<void>) | null = null;
  try {
    const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    closeHandle = handle.close;
    const { stateManager } = handle;

    if (!isConfirm) {
      // Dry-run (default): pure read — no task mutation, no audit append.
      const inspection = await inspectFailedTaskRecovery(stateManager, taskId);
      const plannedChange = inspection.eligible && inspection.isExhausted === true
        ? {
            status: 'failed → pending',
            attemptBudget: `${inspection.attemptCount}/${inspection.maxAttempts} → 0/${(inspection.maxAttempts ?? 0) + 3} (with --reset-budget)`,
          }
        : inspection.eligible
          ? {
              status: 'failed → pending',
              attemptBudget: `${inspection.attemptCount}/${inspection.maxAttempts} → 0/${inspection.maxAttempts}`,
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
    // refusal), then the strict single-task mutation (CAS).
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
      // Lost a race against a concurrent writer, or the state moved between
      // the precheck and the CAS — structured refusal, zero writes.
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

    const audit = appendRecoveryAction(workspaceDir, {
      taskId,
      previousStatus: 'failed',
      result: 'recovered',
      operator: opts.decidedBy,
      forceApplied: outcome.budgetResetApplied,
      previousAttemptCount: outcome.previousAttemptCount,
    });

    // The recovery never touches the metadata payload (CAS-proven
    // byte-identity), so the precheck's read is still the authoritative
    // channel source for the nextAction.
    const current = await stateManager.getTask(taskId);
    const nextAction = buildRecoveryNextAction(outcome.taskKind, typeof current?.diagnosticJson === 'string' ? current.diagnosticJson : null);

    emit({
      ok: true,
      mode: 'confirm',
      taskId,
      taskKind: outcome.taskKind,
      previousStatus: outcome.previousStatus,
      newStatus: 'pending',
      previousAttemptCount: outcome.previousAttemptCount,
      previousMaxAttempts: outcome.previousMaxAttempts,
      newMaxAttempts: outcome.newMaxAttempts,
      budgetResetApplied: outcome.budgetResetApplied,
      auditActionId: audit.actionId,
      historyPreserved: 'runs, artifacts and the diagnostic metadata payload are untouched',
      nextAction,
      workspace: workspaceDir,
    }, opts.json);
  } catch (err: unknown) {
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
 * Register `failed-task` (singular) under `pd runtime recovery` (PRI-990).
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
    .option('--dry-run', 'Read-only precheck: shows the exact planned change without writing anything (default)')
    .option('--confirm', 'Actually recover this one task (CAS-guarded; appends one audit record)')
    .option('--reset-budget', 'Explicitly reset an exhausted attempt budget (required when attempts are exhausted; records previousAttemptCount in the audit)')
    .option('--decidedBy <label>', 'Operator label recorded in the recovery audit log (e.g. owner/console)')
    .option('--json', 'Output raw JSON')
    .action(async (opts: RecoveryFailedTaskOptions) => {
      await handler(opts);
    });
}
