import * as path from 'path';
import { InternalizationIntegrityRemediation } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import type { RemediationResult } from './remediation-output.js';

interface InternalizationIntegrityRepairOptions {
  workspace?: string;
  dryRun?: boolean;
  confirm?: boolean;
  json?: boolean;
}

function formatTextOutput(result: RemediationResult): string {
  const lines: string[] = [];

  lines.push('Internalization Integrity Repair Report');
  lines.push(`generatedAt: ${result.generatedAt}`);
  lines.push(`mode: ${result.mode === 'dry_run' ? 'DRY-RUN' : 'CONFIRM'}`);
  lines.push(`status: ${result.status}`);
  lines.push(`safeToConfirm: ${result.safeToConfirm}`);
  lines.push(`repairedCount: ${result.repairedCount}`);
  lines.push(`skippedCount: ${result.skippedCount}`);
  lines.push('');

  if (result.actions.length === 0) {
    lines.push('No broken links found. Nothing to repair.');
  } else {
    lines.push(`Actions (${result.actions.length}):`);
    for (const action of result.actions) {
      const icon = action.severity === 'error' ? '✗' : '⚠';
      lines.push(`  ${icon} [${action.type ?? action.action}] ${action.taskId ?? action.targetId}`);
      lines.push(`    ${action.previousState ?? action.previousStatus ?? '(unknown)'} → ${action.nextState ?? action.newStatus ?? '(unknown)'}`);
      lines.push(`    action: ${action.action}`);
      lines.push(`    reason: ${action.reason}`);
      if (action.successorTaskId) {
        lines.push(`    successorTaskId: ${action.successorTaskId}`);
      }
    }
  }

  return lines.join('\n');
}

export async function handleRuntimeInternalizationIntegrityRepair(opts: InternalizationIntegrityRepairOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  if (opts.dryRun && opts.confirm) {
    console.error('Error: --dry-run and --confirm are mutually exclusive. Specify one or the other.');
    process.exit(1);
  }

  const isDryRun = !opts.confirm;

  const remediation = new InternalizationIntegrityRemediation({ workspaceDir });
  const result = remediation.repair({ dryRun: isDryRun });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTextOutput(result));
  }

  if (!isDryRun && result.repairedCount === 0 && result.actions.length > 0) {
    console.error('');
    console.error('NOTE: No repairs were made. All issues were already resolved or skipped.');
  }
}
