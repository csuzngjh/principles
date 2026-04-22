/**
 * pd run list/show commands — Runtime v2 run inspection.
 *
 * Usage:
 *   pd run list <taskId>
 *   pd run show <runId>
 */
import { RuntimeStateManager } from '@principles/core';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface RunListOptions {
  taskId: string;
}

export async function handleRunList(opts: RunListOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir();
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    const runs = await stateManager.getRunsByTask(opts.taskId);

    if (runs.length === 0) {
      console.log(`No runs found for task: ${opts.taskId}`);
      return;
    }

    console.log(`\nRuns for ${opts.taskId} (${runs.length}):\n`);
    console.log('  %-22s %-12s %-20s %-6s %s', 'RUN_ID', 'STATUS', 'STARTED', 'ATT', 'ENDED');
    console.log('  ' + '-'.repeat(80));

    for (const run of runs) {
      console.log(
        '  %-22s %-12s %-20s %-6s %s',
        run.runId.substring(0, 22),
        run.executionStatus,
        new Date(run.startedAt).toLocaleString(),
        run.attemptNumber,
        run.endedAt ? new Date(run.endedAt).toLocaleString() : '-',
      );
    }
    console.log('');
  } finally {
    await stateManager.close();
  }
}

interface RunShowOptions {
  id: string;
}

export async function handleRunShow(opts: RunShowOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir();
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    const run = await stateManager.getRun(opts.id);

    if (!run) {
      console.error(`Run not found: ${opts.id}`);
      process.exit(1);
    }

    console.log(`\nRun: ${run.runId}\n`);
    console.log(`  Task ID:       ${run.taskId}`);
    console.log(`  Runtime Kind:  ${run.runtimeKind}`);
    console.log(`  Status:        ${run.executionStatus}`);
    console.log(`  Attempt:       ${run.attemptNumber}`);
    console.log(`  Started:       ${new Date(run.startedAt).toLocaleString()}`);
    if (run.endedAt) {
      console.log(`  Ended:         ${new Date(run.endedAt).toLocaleString()}`);
      const duration = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
      console.log(`  Duration:      ${(duration / 1000).toFixed(1)}s`);
    }
    if (run.reason) {
      console.log(`  Reason:        ${run.reason}`);
    }
    if (run.errorCategory) {
      console.log(`  Error Category:${run.errorCategory}`);
    }
    if (run.outputRef) {
      console.log(`  Output Ref:    ${run.outputRef}`);
    }
    console.log('');
  } finally {
    await stateManager.close();
  }
}
