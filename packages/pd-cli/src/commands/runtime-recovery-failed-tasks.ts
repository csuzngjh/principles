import * as path from 'path';
import {
  createRecoverySweepService,
  isPeerRunnerKind,
  isDiagnosticianStageKind,
  type FailedTaskRecoveryInfo,
  type RecoverySweepServiceHandle,
} from '@principles/core/runtime';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface RecoveryFailedTasksOptions {
  workspace?: string;
  dryRun?: boolean;
  confirm?: boolean;
  force?: boolean;
  json?: boolean;
}

/**
 * PRI-1192 (Owner decision B): the batch recovery has no durable per-task
 * audit ledger — the pre-reset snapshot is emitted on stdout so the operator
 * can archive it (`--json > file`). No new table, no new event type, and
 * `tasks.diagnostic_json` is NOT repurposed as an audit column.
 *
 * The version below pins the machine-consumable schema of that snapshot; the
 * key order below is part of the contract (stable field order, cli-1).
 */
const SNAPSHOT_SCHEMA_VERSION = 'runtime_recovery_failed_tasks.v1';

type TaskAction = 'recovered' | 'would_recover' | 'skipped' | 'failed';

/**
 * One pre-reset observation, in fixed key order:
 * taskId → taskKind → action → previousStatus → previousAttemptCount →
 * previousMaxAttempts → (previousLastError, only when the task had one) →
 * reason → nextAction.
 */
interface TaskDetail {
  taskId: string;
  taskKind: string;
  action: TaskAction;
  previousStatus: string;
  previousAttemptCount: number;
  previousMaxAttempts: number;
  /** Persisted error category (not free text); omitted when the task had none. */
  previousLastError?: string;
  reason: string;
  nextAction: string;
}

/** Stage-task ID convention prefix → the remainder is the parent task ID. */
const DIAG_STAGE_ID_PREFIXES = ['diag_rootcause-', 'diag_distiller-', 'diag_router-'] as const;

/**
 * PRI-674 review P2: per-kind execution guidance must point at commands that
 * actually support the recovered task kind (cli-6-output-next-action).
 *
 * Verified against real command surfaces:
 * - `pd runtime internalization run-once` supports ONLY the 6 peer runner
 *   kinds (SUPPORTED_RUNNERS in runtime-internalization-run-once.ts).
 * - `pd diagnose run --task-id <id>` is the only diagnostician execution
 *   entry (SplitDiagnosticianRunner runs the full A→B→C pipeline from the
 *   PARENT task; running a diag_* stage as parent would create bogus nested
 *   stage tasks).
 * - diag_* stage linkage: persisted inputRef = parent task ID
 *   (SplitDiagnosticianRunner.ensureSubTask), with the
 *   diag_<stage>-<parentTaskId> ID convention as fallback. When the parent
 *   cannot be resolved we say so instead of printing a guessed command.
 * PRI-991 (P2-B): exported and reused by the single-task recovery command so
 * both recovery surfaces emit IDENTICAL per-kind execution guidance — no
 * second guidance authority.
 */
export function buildExecutionNextAction(t: { taskId: string; taskKind: string; inputRef: string | null }): string {
  // Branch on the authoritative taskKind, never on taskId shape.
  if (isDiagnosticianStageKind(t.taskKind)) {
    // Parent from persisted inputRef; fallback: diag_<stage>-<parentTaskId>
    // ID convention (plain prefix split — no regex needed for fixed literals).
    const matchedPrefix = DIAG_STAGE_ID_PREFIXES.find((p) => t.taskId.startsWith(p));
    const parentTaskId = t.inputRef && t.inputRef.trim() !== ''
      ? t.inputRef
      : matchedPrefix
        ? t.taskId.slice(matchedPrefix.length).trim() || undefined
        : undefined;
    if (parentTaskId) {
      return `Stage task of diagnostician parent "${parentTaskId}". Recover the parent, then run: pd diagnose run --task-id ${parentTaskId} (runs the full pipeline including this stage)`;
    }
    return `Stage task whose diagnostician parent could not be resolved (no inputRef linkage, task ID does not follow diag_<stage>-<parentTaskId>). Inspect: pd diagnose status --task-id ${t.taskId} — do not run a stage task directly as a parent`;
  }
  if (t.taskKind === 'diagnostician') {
    return `Run: pd diagnose run --task-id ${t.taskId} (executes the full diag_rootcause→diag_distiller→diag_router pipeline)`;
  }
  if (isPeerRunnerKind(t.taskKind)) {
    return `Run: pd runtime internalization run-once --runner ${t.taskKind} (executes the next ready ${t.taskKind} task)`;
  }
  return `Task kind ${t.taskKind} has no registered CLI execution entry. Inspect: pd diagnose status --task-id ${t.taskId}, or use the Console failed-tasks page`;
}

export async function handleRuntimeRecoveryFailedTasks(opts: RecoveryFailedTasksOptions): Promise<void> {
  if (opts.dryRun && opts.confirm) {
    if (opts.json) {
      console.log(JSON.stringify({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        ok: false,
        reason: 'Error: --dry-run and --confirm are mutually exclusive',
        nextAction: 'Specify only one of --dry-run or --confirm',
      }, null, 2));
    } else {
      console.error('Error: --dry-run and --confirm are mutually exclusive');
    }
    process.exitCode = 1;
    return;
  }
  const isConfirm = opts.confirm ?? false;
  const isDryRun = !isConfirm;

  let serviceHandle: RecoverySweepServiceHandle | null = null;

  try {
    const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
    const handle = await createRecoverySweepService({ workspaceDir });
    serviceHandle = handle;

    const failedTasks = await handle.service.detectFailedTasks();
    const taskDetails: TaskDetail[] = [];
    const recoveredTaskIds: string[] = [];
    let recoveredCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    const describeBudgetReason = (t: FailedTaskRecoveryInfo): string => (t.isExhausted
      ? `Task exhausted max attempts (${t.attemptCount}/${t.maxAttempts}) but --force specified — reset to pending`
      : `Task failed and attempts remain (${t.attemptCount}/${t.maxAttempts}) — reset to pending`);

    const pushDetail = (
      t: FailedTaskRecoveryInfo,
      detail: { action: TaskAction; reason: string; nextAction: string },
    ): void => {
      taskDetails.push({
        taskId: t.taskId,
        taskKind: t.taskKind,
        action: detail.action,
        previousStatus: t.status,
        previousAttemptCount: t.attemptCount,
        previousMaxAttempts: t.maxAttempts,
        // Owner decision B: "有则给" — the key is absent when the task had no
        // persisted error category, so a null is never mistaken for a category.
        ...(t.lastError !== null ? { previousLastError: t.lastError } : {}),
        reason: detail.reason,
        nextAction: detail.nextAction,
      });
    };

    for (const t of failedTasks) {
      if (t.isExhausted && !opts.force) {
        pushDetail(t, {
          action: 'skipped',
          reason: `Task has exhausted max attempts (${t.attemptCount}/${t.maxAttempts})`,
          nextAction: 'Run with --force to recover this task',
        });
        skippedCount++;
        continue;
      }
      if (!isConfirm) {
        recoveredCount++;
        pushDetail(t, {
          action: 'would_recover',
          reason: describeBudgetReason(t),
          nextAction: 'Run with --confirm to recover this task',
        });
        continue;
      }
      // cli-5: one task's failure must not erase the tasks already reset in
      // this sweep — the successful resets stay in `recoveredTaskIds` and in
      // `tasks`, the run reports ok:false and a non-zero exit code.
      try {
        const result = await handle.service.recoverFailedTask(t.taskId, opts.force);
        if (result) {
          recoveredCount++;
          recoveredTaskIds.push(t.taskId);
          pushDetail(t, {
            action: 'recovered',
            reason: describeBudgetReason(t),
            nextAction: `Task recovered to pending. ${buildExecutionNextAction({ taskId: t.taskId, taskKind: t.taskKind, inputRef: t.inputRef })}`,
          });
        } else {
          skippedCount++;
          pushDetail(t, {
            action: 'skipped',
            reason: 'Task recovery skipped (task no longer failed or concurrently modified)',
            nextAction: 'Verify task status using task list',
          });
        }
      } catch (err: unknown) {
        failedCount++;
        pushDetail(t, {
          action: 'failed',
          reason: `Recovery failed: ${err instanceof Error ? err.message : String(err)}`,
          nextAction: `Inspect the task, then retry it alone: pd runtime recovery failed-task --task-id ${t.taskId} --confirm`,
        });
      }
    }

    const mode = isDryRun ? 'dry_run' : 'confirm';
    const ok = failedCount === 0;
    let summaryReason = '';
    let summaryNextAction = '';

    if (isDryRun) {
      if (taskDetails.length === 0) {
        summaryReason = 'No failed internalization or diagnostician tasks found';
        summaryNextAction = 'Nothing to recover';
      } else {
        summaryReason = `Found ${recoveredCount} recoverable and ${skippedCount} exhausted failed tasks`;
        summaryNextAction = `Run with --confirm to recover tasks, and use --force to recover exhausted tasks`;
      }
    } else {
      summaryReason = failedCount === 0
        ? `Successfully recovered ${recoveredCount} failed tasks, skipped ${skippedCount} tasks`
        : `Partially recovered: ${recoveredCount} reset to pending, ${failedCount} failed, ${skippedCount} skipped — recovered IDs are listed in recoveredTaskIds`;
      // PRI-674 review P2: mixed recoveries span different executors — split
      // the summary by actual command surface instead of one command for all.
      if (recoveredCount > 0) {
        const diagParents: string[] = [];
        const diagStages: string[] = [];
        const peerTasks: string[] = [];
        const otherTasks: string[] = [];
        for (const t of taskDetails) {
          if (t.action !== 'recovered') continue;
          if (t.taskKind === 'diagnostician') diagParents.push(t.taskId);
          else if (isDiagnosticianStageKind(t.taskKind)) diagStages.push(t.taskId);
          else if (isPeerRunnerKind(t.taskKind)) peerTasks.push(t.taskId);
          else otherTasks.push(t.taskId);
        }
        const lines: string[] = [];
        if (diagParents.length > 0) {
          lines.push(`For diagnostician parent task(s) (${diagParents.join(', ')}): pd diagnose run --task-id <taskId>`);
        }
        if (diagStages.length > 0) {
          lines.push(`For diag_* stage task(s) (${diagStages.join(', ')}): recover the parent diagnostician task, then pd diagnose run --task-id <parentTaskId> (each stage's parent is in its per-task nextAction)`);
        }
        if (peerTasks.length > 0) {
          lines.push(`For internalization task(s) (${peerTasks.join(', ')}): pd runtime internalization run-once --runner <kind>`);
        }
        if (otherTasks.length > 0) {
          lines.push(`For other task(s) (${otherTasks.join(', ')}): no registered CLI execution entry — see per-task nextAction`);
        }
        summaryNextAction = `Tasks recovered to pending. Execute by kind: ${lines.join('; ')}`;
      } else {
        summaryNextAction = 'No tasks recovered';
      }
      if (failedCount > 0) {
        // cli-6: a partial failure must name the recovery path for the
        // tasks that were NOT reset — "3 recovered then an error" is never
        // reported as a blanket success or a blanket failure.
        summaryNextAction += ` Retry the ${failedCount} failed task(s) individually: pd runtime recovery failed-task --task-id <taskId> --confirm`;
      }
    }

    const payload = {
      // Fixed key order — machine consumers may rely on it (PRI-1192).
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      ok,
      mode,
      recoveredCount,
      skippedCount,
      failedCount,
      recoveredTaskIds,
      tasks: taskDetails,
      reason: summaryReason,
      nextAction: summaryNextAction,
    };

    if (opts.json) {
      // cli-1: stdout carries the JSON document and nothing else. The human
      // summary lives in the non- --json mode (Owner decision B wording:
      // "stderr OR non-json mode"); emitting it on stderr here would also
      // break callers that capture both streams as "one JSON record per
      // invocation" (tests/commands/runtime-recovery-failed-task.test.ts T16).
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Failed Tasks Recovery (${mode.toUpperCase()})`);
      console.log(`  reason:      ${summaryReason}`);
      console.log(`  nextAction:  ${summaryNextAction}`);
      console.log(`  recovered:   ${recoveredCount}`);
      console.log(`  skipped:     ${skippedCount}`);
      console.log(`  failed:      ${failedCount}`);
      console.log(`  recoveredIds: ${recoveredTaskIds.length > 0 ? recoveredTaskIds.join(', ') : '(none)'}`);
      console.log('');
      if (taskDetails.length > 0) {
        console.log('Tasks:');
        for (const t of taskDetails) {
          console.log(`  - ${t.taskId} (${t.taskKind})`);
          console.log(`    action:      ${t.action}`);
          console.log(`    previous:    ${t.previousStatus} (${t.previousAttemptCount}/${t.previousMaxAttempts}${t.previousLastError !== undefined ? `, lastError=${t.previousLastError}` : ''})`);
          console.log(`    reason:      ${t.reason}`);
          console.log(`    nextAction:  ${t.nextAction}`);
        }
        console.log('');
      }
    }

    if (!ok) {
      process.exitCode = 1;
    } else if (recoveredCount > 0 && isDryRun) {
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    if (opts.json) {
      console.log(JSON.stringify({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        nextAction: 'Check workspace path and DB connectivity',
      }, null, 2));
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  } finally {
    if (serviceHandle) {
      await serviceHandle.close();
    }
  }
}
