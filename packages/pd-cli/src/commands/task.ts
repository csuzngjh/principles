/**
 * pd task list/show commands — Runtime v2 task inspection.
 *
 * Usage:
 *   pd task list [--status <status>] [--kind <kind>] [--limit <n>]
 *   pd task show <taskId>
 */
import * as path from 'path';
import { RuntimeStateManager, MalformedRunError, type RunRecord } from '@principles/core';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface TaskListOptions {
  status?: string;
  kind?: string;
  limit?: number;
}

export async function handleTaskList(opts: TaskListOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir();
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    const filter: Record<string, string | number> = {};
    if (opts.status) filter.status = opts.status;
    if (opts.kind) filter.taskKind = opts.kind;
    if (opts.limit) filter.limit = opts.limit;

     
    const tasks = await stateManager.listTasks(Object.keys(filter).length > 0 ? filter : undefined);

    if (tasks.length === 0) {
      console.log('No tasks found.');
      return;
    }

    console.log(`\nTasks (${tasks.length}):\n`);
    console.log(
      '%-22s %-12s %-10s %-4s/%-4s %-15s %s',
      'TASK_ID', 'KIND', 'STATUS', 'ATT', 'MAX', 'LEASE_OWNER', 'LEASE_EXPIRES',
    );
    console.log('-'.repeat(90));

    for (const task of tasks) {
      const expiresAt = task.leaseExpiresAt
        ? new Date(task.leaseExpiresAt).toLocaleString()
        : '-';
      console.log(
        '%-22s %-12s %-10s %-4s %-4s %-15s %s',
        task.taskId.substring(0, 22),
        task.taskKind.substring(0, 12),
        task.status,
        task.attemptCount,
        task.maxAttempts,
        task.leaseOwner ?? '-',
        expiresAt.substring(0, 19),
      );
    }
    console.log('');
  } finally {
    await stateManager.close();
  }
}

interface TaskShowOptions {
  id: string;
  json?: boolean;
  workspace?: string;
}

export async function handleTaskShow(opts: TaskShowOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    const task = await stateManager.getTask(opts.id);

    if (!task) {
      console.error(`Task not found: ${opts.id}`);
      process.exit(1);
    }

    let runs: RunRecord[] = [];
    let degradedRuns: { runId: string; error: string; rawRow: Record<string, unknown> }[] = [];
    let isDegraded = false;
    let malformedError: MalformedRunError | null = null;

    try {
      runs = await stateManager.getRunsByTask(opts.id);
    } catch (err: unknown) {
      if (err instanceof MalformedRunError) {
        const { validRuns, degradedRuns: malformedRuns } = err;
        runs = validRuns;
        degradedRuns = malformedRuns;
        isDegraded = true;
        malformedError = err;
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({
            ok: false,
            reason: errorMsg,
            nextAction: 'Check state.db connection and schema integrity',
          }, null, 2));
        } else {
          console.error(`Error: ${errorMsg}`);
        }
        process.exit(1);
      }
    }

    if (opts.json) {
      if (isDegraded) {
        console.log(JSON.stringify({
          ok: false,
          task,
          runs,
          degradedRuns: degradedRuns.map(dr => ({
            runId: dr.runId,
            error: dr.error,
          })),
          reason: malformedError?.message ?? 'Unknown malformed run schema',
          nextAction: 'Use integrity-repair to clean up or recover malformed runs, or fix runs in DB',
        }, null, 2));
      } else {
        console.log(JSON.stringify({ task, runs }, null, 2));
      }
      return;
    }

    console.log(`\nTask: ${task.taskId}\n`);
    console.log(`  Kind:          ${task.taskKind}`);
    console.log(`  Status:        ${task.status}`);
    console.log(`  Attempts:      ${task.attemptCount} / ${task.maxAttempts}`);
    if (task.leaseOwner) {
      console.log(`  Lease Owner:   ${task.leaseOwner}`);
      console.log(`  Lease Expires: ${task.leaseExpiresAt ? new Date(task.leaseExpiresAt).toLocaleString() : '-'}`);
    }
    if (task.lastError) {
      console.log(`  Last Error:    ${task.lastError}`);
    }
    if (task.inputRef) {
      console.log(`  Input Ref:     ${task.inputRef}`);
    }
    if (task.resultRef) {
      console.log(`  Result Ref:    ${task.resultRef}`);
    }
    console.log(`  Created:       ${new Date(task.createdAt).toLocaleString()}`);
    console.log(`  Updated:       ${new Date(task.updatedAt).toLocaleString()}`);
    console.log('');

    if (runs.length > 0) {
      console.log(`Runs (${runs.length}):`);
      console.log('  %-22s %-12s %-6s %s', 'RUN_ID', 'STATUS', 'ATT', 'STARTED');
      console.log('  ' + '-'.repeat(65));
      for (const run of runs) {
        console.log(
          '  %-22s %-12s %-6s %s',
          run.runId.substring(0, 22),
          run.executionStatus,
          run.attemptNumber,
          new Date(run.startedAt).toLocaleString(),
        );
      }
      console.log('');
    }

    if (isDegraded && degradedRuns.length > 0) {
      console.warn(`WARNING: Task has ${degradedRuns.length} malformed run(s) in database!`);
      console.warn(`Reason: ${malformedError?.message ?? 'Unknown malformed run schema'}`);
      console.warn(`nextAction: Use integrity-repair to clean up or recover malformed runs, or fix runs in DB\n`);
      console.log('Degraded Runs:');
      for (const dr of degradedRuns) {
        console.log(`  - Run: ${dr.runId}`);
        console.log(`    Error: ${dr.error}`);
      }
      console.log('');
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        nextAction: 'Check workspace path and task ID',
      }, null, 2));
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  } finally {
    await stateManager.close();
  }
}
