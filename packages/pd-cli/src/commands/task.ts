/**
 * pd task list/show commands — Runtime v2 task inspection.
 *
 * Usage:
 *   pd task list [--status <status>] [--kind <kind>] [--limit <n>]
 *   pd task show <taskId>
 */
import * as path from 'path';
import type { Command } from 'commander';
import { RuntimeStateManager, MalformedRunError, type RunRecord } from '@principles/core';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { withWorkspaceAndJson } from './command-helpers.js';

interface TaskListOptions {
  status?: string;
  kind?: string;
  limit?: number;
  workspace?: string;
  json?: boolean;
}

export async function handleTaskList(opts: TaskListOptions): Promise<void> {
  // Pass through resolveWorkspaceDir to honor its consistency warning when
  // --workspace disagrees with workspace.default in .pd/config.yaml.
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const filter: Record<string, string | number> = {};
    if (opts.status) filter.status = opts.status;
    if (opts.kind) filter.taskKind = opts.kind;
    if (opts.limit) filter.limit = opts.limit;

    const tasks = await stateManager.listTasks(Object.keys(filter).length > 0 ? filter : undefined);

    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        count: tasks.length,
        workspace: workspaceDir,
        tasks: tasks.map((t) => ({
          taskId: t.taskId,
          taskKind: t.taskKind,
          status: t.status,
          attemptCount: t.attemptCount,
          maxAttempts: t.maxAttempts,
          leaseOwner: t.leaseOwner ?? null,
          leaseExpiresAt: t.leaseExpiresAt ?? null,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
      }, null, 2));
      return;
    }

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
  } catch (err: unknown) {
    // EP-04: failure paths emit a single parseable JSON object with
    // structured reason + nextAction (mirror handleTaskShow).
    if (opts.json) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({
        ok: false,
        count: 0,
        workspace: workspaceDir,
        reason,
        nextAction: 'Check workspace path and database accessibility. The workspace may need bootstrap (run "pd runtime internalization integrity-repair --confirm") or the workspace dir may be wrong.',
      }, null, 2));
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
    return;
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
      if (opts.json) {
        console.log(JSON.stringify({
          ok: false,
          reason: `Task not found: ${opts.id}`,
          nextAction: 'Specify a valid taskId',
        }, null, 2));
      } else {
        console.error(`Task not found: ${opts.id}`);
      }
      process.exit(1);
      return;
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
        return;
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
          nextAction: 'Malformed run rows are visible here but not auto-repaired. Runner execution tolerates them (uses the latest valid run). To quarantine malformed rows: pd runtime internalization integrity-repair --confirm --json',
        }, null, 2));
        process.exitCode = 1;
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
      console.warn(`nextAction: Malformed run rows are visible here but not auto-repaired. Runner execution tolerates them (uses the latest valid run). To quarantine malformed rows: pd runtime internalization integrity-repair --confirm --json\n`);
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

/**
 * Register the `pd task list` subcommand.
 *
 * Single source of truth for both production (`index.ts`) and parser tests
 * (mvp-smoke.test.ts). Reuses the `withWorkspaceAndJson` helper so adding a
 * new --workspace/--json pair elsewhere is one line, not five.
 */
export function registerTaskListCommand(taskCmd: Command): Command {
  const listCmd = taskCmd
    .command('list')
    .description('List runtime tasks')
    .option('-s, --status <status>', 'Filter by status (pending, leased, retry_wait, succeeded, failed)')
    .option('-k, --kind <kind>', 'Filter by task kind')
    .option('-l, --limit <number>', 'Limit number of results', parseInt, 50)
    .action(async (opts: { status?: string; kind?: string; limit?: number; workspace?: string; json?: boolean }) => {
      await handleTaskList({ status: opts.status, kind: opts.kind, limit: opts.limit, workspace: opts.workspace, json: opts.json });
    });

  withWorkspaceAndJson(listCmd);
  return listCmd;
}
