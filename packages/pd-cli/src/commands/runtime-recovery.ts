import * as path from 'path';
import { RuntimeStateManager } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { createRemediationResult, remediationAction } from './remediation-output.js';
import type { RemediationResult } from './remediation-output.js';

interface RecoverySweepOptions {
  workspace?: string;
  dryRun?: boolean;
  confirm?: boolean;
  json?: boolean;
}

function formatTextOutput(output: RemediationResult): string {
  const lines: string[] = [];

  lines.push(`Recovery Sweep (${output.mode})`);
  lines.push(`  status: ${output.status}`);
  lines.push(`  safeToConfirm: ${output.safeToConfirm}`);
  lines.push(`  repairedCount: ${output.repairedCount}`);
  lines.push(`  skippedCount: ${output.skippedCount}`);

  if (output.warnings.length > 0) {
    lines.push(`  warnings:`);
    for (const warning of output.warnings) lines.push(`    - ${warning}`);
  }
  for (const action of output.actions.slice(0, 5)) {
    lines.push(`  ${action.targetId}: ${action.previousState ?? '(unknown)'} → ${action.nextState ?? '(unknown)'}`);
    lines.push(`    action: ${action.action}`);
    lines.push(`    reason: ${action.reason}`);
  }
  if (output.mode === 'dry_run' && output.actions.length > 0) {
    lines.push(`  (use --confirm to recover expired leases)`);
  } else if (output.actions.length === 0) {
    lines.push(`  no expired leases found`);
  }

  return lines.join('\n');
}

export async function handleRuntimeRecoverySweep(opts: RecoverySweepOptions): Promise<void> {
  if (opts.dryRun && opts.confirm) {
    console.error('Error: --dry-run and --confirm are mutually exclusive');
    process.exitCode = 1;
    return;
  }
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const isConfirm = opts.confirm ?? false;
  const isDryRun = !isConfirm;

  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    const expiredLeaseTaskIds = await stateManager.detectExpiredLeases();

    const actions = expiredLeaseTaskIds.map((taskId) => remediationAction({
      action: 'recover_expired_lease',
      targetId: taskId,
      previousState: 'leased',
      nextState: 'retry_wait',
      reason: 'Task lease is expired and can be recovered by the operator sweep.',
    }));
    const warnings: string[] = [];
    let repairedCount = 0;
    let failedCount = 0;

    if (isConfirm && expiredLeaseTaskIds.length > 0) {
      for (const taskId of expiredLeaseTaskIds) {
        try {
          const result = await stateManager.recoverTask(taskId);
          if (result) {
            repairedCount++;
            const action = actions.find((a) => a.targetId === taskId);
            if (action) {
              action.previousState = result.previousStatus;
              action.nextState = result.newStatus;
            }
          }
        } catch (err) {
          failedCount++;
          warnings.push(`${taskId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const output = createRemediationResult({
      mode: isDryRun ? 'dry_run' : 'confirm',
      repairedCount,
      skippedCount: failedCount,
      actions,
      warnings,
      status: failedCount > 0 && repairedCount === 0 ? 'error' : undefined,
      safeToConfirm: isDryRun && expiredLeaseTaskIds.length > 0,
    });

    if (opts.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(formatTextOutput(output));
    }

    if (expiredLeaseTaskIds.length > 0 && isDryRun) {
      process.exitCode = 1;
    }
  } finally {
    await stateManager.close();
  }
}
