/**
 * pd runtime internalization wake-once command handler.
 *
 * Usage:
 *   pd runtime internalization wake-once --workspace <path> --dry-run --json
 *
 * This command ONLY supports --dry-run mode. Non-dry-run invocations are rejected
 * before any state interaction (no lease acquisition, no mutation).
 *
 * PRI-73 scope: dry-run inspection only; real lease acquisition is future scope.
 */
import * as path from 'path';
import { RuntimeStateManager, InternalizationOrchestrator } from '@principles/core/runtime-v2';
import type { WakeOnceResult } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface WakeOnceOptions {
  workspace?: string;
  dryRun?: boolean;
  json?: boolean;
}

const OWNER = 'pd-cli-internalization-wake-once';
const RUNTIME_KIND = 'local-worker';

function formatTextOutput(result: WakeOnceResult): string {
  switch (result.decision) {
    case 'would_lease':
      return `would_lease: ${result.taskId} (${result.taskKind})`;
    case 'no_ready_tasks':
      return `no_ready_tasks: ${result.reason} (inspected: ${result.inspectedCount})`;
    case 'blocked':
      return `blocked: ${result.taskId} (${result.taskKind}) by [${result.blockedBy.join(', ')}]`;
    case 'dependency_failed':
      return `dependency_failed: ${result.taskId} (${result.taskKind}) failed deps: [${result.failedDependencies.join(', ')}]`;
    case 'lease_conflict':
      return `lease_conflict: ${result.taskId} — ${result.conflictReason}`;
    case 'invalid_task_metadata':
      return `invalid_task_metadata: ${result.taskId} (${result.taskKind})`;
    case 'leased':
      return `leased: ${result.taskId} (${result.taskKind}) attempt ${result.attemptCount}`;
  }
}

export async function handleRuntimeInternalizationWakeOnce(opts: WakeOnceOptions): Promise<void> {
  // REJECT non-dry-run — only dry-run mode is implemented in this issue
  if (!opts.dryRun) {
    console.error('Error: wake-once without --dry-run is not implemented.');
    console.error('Only --dry-run mode is available for operator inspection.');
    process.exit(1);
    return;
  }

  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();

  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: true },
    );

    let result: WakeOnceResult = { decision: 'no_ready_tasks', reason: 'no_candidates', inspectedCount: 0 };
    try {
      result = await orchestrator.wakeOnce();
    } catch (err) {
      console.error('Error: wake-once failed:', err);
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTextOutput(result));
    }

    // Exit code 1 when no task could be leased (operator alert condition)
    if (result.decision === 'no_ready_tasks' || result.decision === 'lease_conflict') {
      process.exitCode = 1;
    }
  } finally {
    await stateManager.close();
  }
}
