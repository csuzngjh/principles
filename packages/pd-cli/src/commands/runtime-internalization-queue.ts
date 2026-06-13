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
import { createInternalizationQueueReadModel } from '@principles/core/runtime-v2';
import type { InternalizationQueueSnapshot } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadEffectiveFeatureFlags } from '../services/feature-flag-loader.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';

interface QueueOptions {
  workspace?: string;
  json?: boolean;
}

function formatTextOutput(snap: InternalizationQueueSnapshot, workspaceDir: string): string {
  const lines: string[] = [];
  lines.push(`Internalization Queue Snapshot`);
  lines.push(`  pending: ${snap.pendingCount}  retry_wait: ${snap.retryWaitCount}`);

  if (snap.invalidMetadataCount > 0) {
    lines.push(`  invalid_metadata: ${snap.invalidMetadataCount}  (${snap.sampleInvalidTaskIds.join(', ')})`);
  }

  lines.push(`  ready: ${snap.readyTasks.length}`);

  const taskKinds = Object.entries(snap.countsByTaskKind);
  if (taskKinds.length > 0) {
    lines.push(`  by_kind: ${taskKinds.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  const channels = Object.entries(snap.countsByChannel);
  if (channels.length > 0) {
    lines.push(`  by_channel: ${channels.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

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

  if (snap.leaseConflictSummary.count > 0) {
    lines.push(`  lease_conflict: ${snap.leaseConflictSummary.count}`);
    for (const s of snap.leaseConflictSummary.samples.slice(0, 3)) {
      lines.push(`    ${s.taskId} (${s.taskKind}) owner: ${s.leaseOwner}, expires: ${s.leaseExpiresAt}`);
    }
  }

  if (snap.retryWaitPendingSummary.count > 0) {
    lines.push(`  retry_wait_pending: ${snap.retryWaitPendingSummary.count}`);
    for (const s of snap.retryWaitPendingSummary.samples.slice(0, 3)) {
      lines.push(`    ${s.taskId} (${s.taskKind}) retry_after: ${s.retryAfter}`);
    }
  }

  if (snap.noReadyTasks) {
    lines.push(`  no_ready_tasks: ${snap.noReadyTasks.reason} (inspected: ${snap.noReadyTasks.inspectedCount})`);
  }

  if (snap.suppressedTasks.length > 0) {
    lines.push(`  suppressed (${snap.suppressedTasks.length}):`);
    for (const s of snap.suppressedTasks.slice(0, 5)) {
      lines.push(`    ${s.taskId} (${s.taskKind}, ${s.channel}) reason: ${s.reason}`);
    }
  }

  if (snap.readyTasks.length > 0) {
    const nextAction = `pd runtime internalization run-once --workspace "${workspaceDir}" --runner dreamer --runtime config --json`;
    lines.push(`  nextAction: ${nextAction}`);
  }

  return lines.join('\n');
}

export async function handleRuntimeInternalizationQueue(opts: QueueOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();

  const featureFlags = loadEffectiveFeatureFlags(workspaceDir);
  const enabledChannels = new Set(
    Object.values(featureFlags.flags)
      .filter(f => f.enabled)
      .map(f => f.id),
  );
  const { readModel, close } = await createInternalizationQueueReadModel({ workspaceDir, enabledChannels });

  try {
    const snapshot = await readModel.getSnapshot();

    const pdConfigResult = loadPdConfig(workspaceDir);
    const pdFlags = computeFlagsFromLoadResult(pdConfigResult);
    const autoConsumerEnabled = pdFlags.flags.internalization_auto_consumer?.enabled ?? false;

    if (opts.json) {
      const output: Record<string, unknown> = { ...snapshot };

      if (snapshot.readyTasks.length > 0) {
        if (autoConsumerEnabled) {
          output.consumerStatus = 'auto_consumer_enabled';
        } else {
          output.nextAction = `pd runtime internalization run-once --workspace "${workspaceDir}" --runner dreamer --runtime config --json`;
          output.consumerStatus = 'manual_action_required';
        }
      }

      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(formatTextOutput(snapshot, workspaceDir));
    }
  } finally {
    await close();
  }
}
