import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { runPainFloodSimulation } from '../services/pain-flood-simulation-runner.js';
import type { PainFloodSimulationSummary } from '@principles/core/runtime-v2';

interface CliPainFloodOptions {
  workspace?: string;
  json?: boolean;
  identicalCount?: number;
  similarCount?: number;
  stressCount?: number;
}

function formatTextOutput(summary: PainFloodSimulationSummary): string {
  const lines: string[] = [];
  const icon = summary.status === 'healthy' ? '✓' : summary.status === 'degraded' ? '⚠' : '✗';

  lines.push('PD Pain Flood Simulation');
  lines.push(`generatedAt: ${summary.generatedAt}`);
  lines.push(`workspaceMode: ${summary.workspaceMode}`);
  lines.push(`OVERALL: ${icon} ${summary.status.toUpperCase()}`);
  lines.push('');
  lines.push(`  inputPainCount: ${summary.inputPainCount}`);
  lines.push(`  acceptedPainCount: ${summary.acceptedPainCount}`);
  lines.push(`  skippedDuplicateCount: ${summary.skippedDuplicateCount}`);
  lines.push(`  candidateCount: ${summary.candidateCount}`);
  lines.push(`  taskCount: ${summary.taskCount}`);
  lines.push(`  maxEvidencePreviewLength: ${summary.maxEvidencePreviewLength}`);
  lines.push(`  contextBudgetSummary: ${summary.contextBudgetSummary}`);
  lines.push('');

  for (const stage of summary.stages) {
    const stageIcon = stage.status === 'passed' ? '✓' : stage.status === 'skipped' ? '○' : '✗';
    lines.push(`  ${stageIcon} ${stage.scenarioName}: ${stage.status}`);
    lines.push(`      input=${stage.inputCount} accepted=${stage.acceptedCount} skipped=${stage.skippedCount} tasks=${stage.taskCount} candidates=${stage.candidateCount}`);
    if (stage.reason) {
      lines.push(`      reason: ${stage.reason}`);
    }
  }

  if (summary.recommendedNextIssue) {
    lines.push('');
    lines.push(`Recommended next issue: ${summary.recommendedNextIssue}`);
  }

  return lines.join('\n');
}

export async function handleRuntimePainFlood(opts: CliPainFloodOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-flood-'));
  const workspaceMode: 'temp' | 'explicit_workspace' = opts.workspace ? 'explicit_workspace' : 'temp';

  try {
    const summary = await runPainFloodSimulation({
      workspaceDir,
      workspaceMode,
      identicalCount: opts.identicalCount,
      similarCount: opts.similarCount,
      stressCount: opts.stressCount,
    });

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(formatTextOutput(summary));
    }

    if (summary.status !== 'healthy') {
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