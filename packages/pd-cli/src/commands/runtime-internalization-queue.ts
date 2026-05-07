/**
 * pd runtime internalization queue command handler.
 *
 * Usage:
 *   pd runtime internalization queue --workspace <path> --json
 *
 * Provides a read-only snapshot of the PI task queue health.
 * Never acquires leases or mutates any task/run/artifact/ledger state.
 */
import * as path from 'path';
import { RuntimeStateManager, InternalizationQueueReadModel } from '@principles/core/runtime-v2';
import type { InternalizationQueueSnapshot } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface QueueOptions {
  workspace?: string;
  json?: boolean;
}

function formatTextOutput(snap: InternalizationQueueSnapshot): string {
  const lines: string[] = [];
  lines.push(`Internalization Queue Snapshot`);
  lines.push(`  pending: ${snap.pendingCount}  retry_wait: ${snap.retryWaitCount}`);

  if (snap.invalidMetadataCount > 0) {
    lines.push(`  invalid_metadata: ${snap.invalidMetadataCount}  (${snap.sampleInvalidTaskIds.join(', ')})`);
  }

  lines.push(`  ready: ${snap.readyTasks.length}`);

  if (snap.blockedSummary.count > 0) {
    lines.push(`  blocked: ${snap.blockedSummary.count}`);
    for (const s of snap.blockedSummary.samples.slice(0, 3)) {
      lines.push(`    ${s.taskId} (${s.taskKind}) blocked by: ${s.blockedBy.join(', ')}`);
    }
  }

  if (snap.dependencyFailedSummary.count > 0) {
    lines.push(`  dependency_failed: ${snap.dependencyFailedSummary.count}`);
    for (const s of snap.dependencyFailedSummary.samples.slice(0, 3)) {
      lines.push(`    ${s.taskId} (${s.taskKind}) failed deps: ${s.failedDependencies.join(', ')}`);
    }
  }

  if (snap.noReadyTasks) {
    lines.push(`  no_ready_tasks: ${snap.noReadyTasks.reason} (inspected: ${snap.noReadyTasks.inspectedCount})`);
  }

  return lines.join('\n');
}

export async function handleRuntimeInternalizationQueue(opts: QueueOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();

  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    const readModel = new InternalizationQueueReadModel(stateManager);
    const snapshot = await readModel.getSnapshot();

    if (opts.json) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      console.log(formatTextOutput(snapshot));
    }
  } finally {
    await stateManager.close();
  }
}
