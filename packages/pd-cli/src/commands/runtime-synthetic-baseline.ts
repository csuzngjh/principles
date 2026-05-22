import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { runSyntheticBaseline } from '../services/synthetic-baseline-runner.js';
import type { SyntheticBaselineSummary } from '@principles/core/runtime-v2';

interface CliSyntheticBaselineOptions {
  workspace?: string;
  json?: boolean;
}

function formatTextOutput(summary: SyntheticBaselineSummary): string {
  const lines: string[] = [];
  const icon = summary.status === 'passed' ? '✓' : summary.status === 'degraded' ? '⚠' : '✗';

  lines.push('PD Synthetic Workload Baseline');
  lines.push(`generatedAt: ${summary.generatedAt}`);
  lines.push(`workspaceMode: ${summary.workspaceMode}`);
  lines.push(`OVERALL: ${icon} ${summary.status.toUpperCase()}`);
  lines.push('');

  for (const stage of summary.stages) {
    const stageIcon = stage.status === 'passed' ? '✓' : stage.status === 'skipped' ? '○' : '✗';
    lines.push(`  ${stageIcon} ${stage.name}: ${stage.status}`);
    if (stage.reason) {
      lines.push(`    reason: ${stage.reason}`);
    }
  }

  if (summary.recommendedNextIssue) {
    lines.push('');
    lines.push(`Recommended next issue: ${summary.recommendedNextIssue}`);
  }

  return lines.join('\n');
}

export async function handleRuntimeSyntheticBaseline(opts: CliSyntheticBaselineOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'pd-synth-baseline-'));
  const workspaceMode: 'temp' | 'explicit_workspace' = opts.workspace ? 'explicit_workspace' : 'temp';

  try {
    const summary = await runSyntheticBaseline({
      workspaceDir,
      workspaceMode,
    });

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(formatTextOutput(summary));
    }

    if (summary.status !== 'passed') {
      console.error('');
      console.error(`FAIL: status=${summary.status}`);
      process.exitCode = 1;
    }
  } finally {
    if (workspaceMode === 'temp') {
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors on Windows
      }
    }
  }
}
