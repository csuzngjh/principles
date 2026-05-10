import * as path from 'path';
import { RuntimeStateManager } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface RecoverySweepOptions {
  workspace?: string;
  dryRun?: boolean;
  confirm?: boolean;
  json?: boolean;
}

interface RecoverySweepOutput {
  mode: 'dry-run' | 'confirm';
  expiredLeaseCount: number;
  expiredLeaseTaskIds: string[];
  recoveredCount: number;
  failedCount: number;
  errors: string[];
  samples: {
    taskId: string;
    previousStatus: string;
    newStatus: string;
    wasLeaseExpired: boolean;
  }[];
}

function formatTextOutput(output: RecoverySweepOutput): string {
  const lines: string[] = [];

  lines.push(`Recovery Sweep (${output.mode})`);
  lines.push(`  expired_leases: ${output.expiredLeaseCount}`);

  if (output.expiredLeaseCount > 0) {
    lines.push(`  task_ids: ${output.expiredLeaseTaskIds.join(', ')}`);
  }

  if (output.mode === 'confirm') {
    lines.push(`  recovered: ${output.recoveredCount}`);
    lines.push(`  failed: ${output.failedCount}`);
    if (output.errors.length > 0) {
      lines.push(`  errors:`);
      for (const err of output.errors) {
        lines.push(`    - ${err}`);
      }
    }
    for (const sample of output.samples.slice(0, 5)) {
      lines.push(`  ${sample.taskId}: ${sample.previousStatus} → ${sample.newStatus}`);
    }
  } else {
    lines.push(`  (use --confirm to recover expired leases)`);
  }

  return lines.join('\n');
}

export async function handleRuntimeRecoverySweep(opts: RecoverySweepOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const isConfirm = opts.confirm ?? false;
  const isDryRun = !isConfirm;

  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    const expiredLeaseTaskIds = await stateManager.detectExpiredLeases();

    const output: RecoverySweepOutput = {
      mode: isDryRun ? 'dry-run' : 'confirm',
      expiredLeaseCount: expiredLeaseTaskIds.length,
      expiredLeaseTaskIds,
      recoveredCount: 0,
      failedCount: 0,
      errors: [],
      samples: [],
    };

    if (isConfirm && expiredLeaseTaskIds.length > 0) {
      const result = await stateManager.runRecoverySweep();
      output.recoveredCount = result.recovered;
      output.errors = result.errors;
      output.failedCount = result.errors.length;
    }

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
