import * as path from 'path';
import { InternalizationChainIntegrityReadModel } from '@principles/core/runtime-v2';
import type { ChainIntegrityResult } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { assembleMainlineSnapshot } from '../services/mainline-snapshot-assembler.js';

interface InternalizationIntegrityOptions {
  workspace?: string;
  json?: boolean;
}

function formatTextOutput(result: ChainIntegrityResult): string {
  const lines: string[] = [];
  const icon = result.overallStatus === 'ok' ? '✓' : result.overallStatus === 'degraded' ? '⚠' : '✗';

  lines.push('Internalization Chain Integrity Report');
  lines.push(`generatedAt: ${result.generatedAt}`);
  lines.push(`OVERALL: ${icon} ${result.overallStatus.toUpperCase()}`);
  lines.push('');

  lines.push('Chain Summaries:');
  lines.push(`  totalCandidates: ${result.chainSummaries.totalCandidates}`);
  lines.push(`  totalDreamerTasks: ${result.chainSummaries.totalDreamerTasks}`);
  lines.push(`  totalPhilosopherTasks: ${result.chainSummaries.totalPhilosopherTasks}`);
  lines.push(`  totalPIArtifacts: ${result.chainSummaries.totalPIArtifacts}`);
  lines.push(`  chainsWithBrokenLinks: ${result.chainSummaries.chainsWithBrokenLinks}`);
  lines.push('');

  if (result.brokenLinks.length === 0) {
    lines.push('No broken links found. Chain integrity is OK.');
  } else {
    lines.push(`Broken Links (${result.brokenLinks.length}):`);
    for (const link of result.brokenLinks) {
      const sevIcon = link.severity === 'error' ? '✗' : '⚠';
      lines.push(`  ${sevIcon} [${link.severity}] ${link.type}: ${link.reason}`);
      if (link.taskId) lines.push(`    taskId: ${link.taskId}`);
      if (link.runId) lines.push(`    runId: ${link.runId}`);
      if (link.candidateId) lines.push(`    candidateId: ${link.candidateId}`);
      lines.push(`    action: ${link.recommendedAction}`);
    }
  }

  return lines.join('\n');
}

export async function handleRuntimeInternalizationIntegrity(opts: InternalizationIntegrityOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  let warnings: string[];
  let snapshot;
  try {
    ({ snapshot, warnings } = await assembleMainlineSnapshot({ workspaceDir }));
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    const failure: ChainIntegrityResult = {
      overallStatus: 'error',
      brokenLinks: [{
        type: 'mainline_snapshot_assembly_failed',
        severity: 'error',
        reason: `Failed to assemble mainline snapshot: ${reason}`,
        recommendedAction: 'Verify workspace state.db/config and rerun `pd runtime internalization integrity`.',
      }],
      chainSummaries: {
        totalCandidates: 0,
        totalDreamerTasks: 0,
        totalPhilosopherTasks: 0,
        totalPIArtifacts: 0,
        chainsWithBrokenLinks: 0,
      },
      generatedAt: new Date().toISOString(),
    };
    if (opts.json) {
      console.log(JSON.stringify(failure, null, 2));
    } else {
      const [firstBrokenLink] = failure.brokenLinks;
      const failReason = firstBrokenLink ? firstBrokenLink.reason : 'unknown failure';
      console.error(`FAIL: ${failReason}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!opts.json && warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }
  }

  const model = new InternalizationChainIntegrityReadModel({ workspaceDir, mainlineSnapshot: snapshot });
  const result = model.check();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTextOutput(result));
  }

  if (result.overallStatus !== 'ok') {
    if (!opts.json) {
      console.error('');
      console.error(`FAIL: overallStatus=${result.overallStatus}`);
    }
    process.exitCode = 1;
  }
}
