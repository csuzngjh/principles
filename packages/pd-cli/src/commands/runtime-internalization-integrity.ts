import * as path from 'path';
import { InternalizationChainIntegrityReadModel } from '@principles/core/runtime-v2';
import type { ChainIntegrityResult } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

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

  const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
  const result = model.check();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTextOutput(result));
  }

  if (result.overallStatus !== 'ok') {
    console.error('');
    console.error(`FAIL: overallStatus=${result.overallStatus}`);
    process.exitCode = 1;
  }
}
