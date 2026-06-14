import * as path from 'path';
import { createRecoverySweepService, type RecoverySweepServiceHandle } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface RecoveryFailedTasksOptions {
  workspace?: string;
  dryRun?: boolean;
  confirm?: boolean;
  force?: boolean;
  json?: boolean;
}

interface TaskDetail {
  taskId: string;
  taskKind: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  action: string;
  reason: string;
  nextAction: string;
}

export async function handleRuntimeRecoveryFailedTasks(opts: RecoveryFailedTasksOptions): Promise<void> {
  if (opts.dryRun && opts.confirm) {
    if (opts.json) {
      console.log(JSON.stringify({
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
    let recoveredCount = 0;
    let skippedCount = 0;

    for (const t of failedTasks) {
      if (t.isExhausted && !opts.force) {
        taskDetails.push({
          taskId: t.taskId,
          taskKind: t.taskKind,
          status: t.status,
          attemptCount: t.attemptCount,
          maxAttempts: t.maxAttempts,
          action: 'skipped',
          reason: `Task has exhausted max attempts (${t.attemptCount}/${t.maxAttempts})`,
          nextAction: 'Run with --force to recover this task',
        });
        skippedCount++;
      } else {
        if (isConfirm) {
          const result = await handle.service.recoverFailedTask(t.taskId, opts.force);
          if (result) {
            recoveredCount++;
            taskDetails.push({
              taskId: t.taskId,
              taskKind: t.taskKind,
              status: t.status,
              attemptCount: t.attemptCount,
              maxAttempts: t.maxAttempts,
              action: 'recovered',
              reason: t.isExhausted
                ? `Task exhausted max attempts (${t.attemptCount}/${t.maxAttempts}) but --force specified — reset to pending`
                : `Task failed and attempts remain (${t.attemptCount}/${t.maxAttempts}) — reset to pending`,
              nextAction: 'Task recovered to pending. Run pd runtime internalization run-once to execute.',
            });
          } else {
            skippedCount++;
            taskDetails.push({
              taskId: t.taskId,
              taskKind: t.taskKind,
              status: t.status,
              attemptCount: t.attemptCount,
              maxAttempts: t.maxAttempts,
              action: 'skipped',
              reason: 'Task recovery skipped (task no longer failed or concurrently modified)',
              nextAction: 'Verify task status using task list',
            });
          }
        } else {
          recoveredCount++;
          taskDetails.push({
            taskId: t.taskId,
            taskKind: t.taskKind,
            status: t.status,
            attemptCount: t.attemptCount,
            maxAttempts: t.maxAttempts,
            action: 'would_recover',
            reason: t.isExhausted
              ? `Task exhausted max attempts (${t.attemptCount}/${t.maxAttempts}) but --force specified — reset to pending`
              : `Task failed and attempts remain (${t.attemptCount}/${t.maxAttempts}) — reset to pending`,
            nextAction: 'Run with --confirm to recover this task',
          });
        }
      }
    }

    const mode = isDryRun ? 'dry_run' : 'confirm';
    let summaryReason = '';
    let summaryNextAction = '';

    if (isDryRun) {
      if (taskDetails.length === 0) {
        summaryReason = 'No failed internalization tasks found';
        summaryNextAction = 'Nothing to recover';
      } else {
        summaryReason = `Found ${recoveredCount} recoverable and ${skippedCount} exhausted failed tasks`;
        summaryNextAction = `Run with --confirm to recover tasks, and use --force to recover exhausted tasks`;
      }
    } else {
      summaryReason = `Successfully recovered ${recoveredCount} failed tasks, skipped ${skippedCount} tasks`;
      summaryNextAction = recoveredCount > 0
        ? 'Run pd runtime internalization run-once to execute recovered tasks'
        : 'No tasks recovered';
    }

    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        mode,
        recoveredCount,
        skippedCount,
        tasks: taskDetails,
        reason: summaryReason,
        nextAction: summaryNextAction,
      }, null, 2));
    } else {
      console.log(`Failed Tasks Recovery (${mode.toUpperCase()})`);
      console.log(`  reason:      ${summaryReason}`);
      console.log(`  nextAction:  ${summaryNextAction}`);
      console.log(`  recovered:   ${recoveredCount}`);
      console.log(`  skipped:     ${skippedCount}`);
      console.log('');
      if (taskDetails.length > 0) {
        console.log('Tasks:');
        for (const t of taskDetails) {
          console.log(`  - ${t.taskId} (${t.taskKind})`);
          console.log(`    action:     ${t.action}`);
          console.log(`    reason:     ${t.reason}`);
          console.log(`    nextAction: ${t.nextAction}`);
        }
        console.log('');
      }
    }

    if (recoveredCount > 0 && isDryRun) {
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    if (opts.json) {
      console.log(JSON.stringify({
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
