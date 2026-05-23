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
  lines.push(`  failedCount: ${summary.failedCount}`);
  lines.push(`  candidateCount: ${summary.candidateCount}`);
  lines.push(`  taskCount: ${summary.taskCount}`);
  lines.push(`  maxEvidencePreviewLength: ${summary.maxEvidencePreviewLength}`);
  lines.push(`  contextBudgetSummary: ${summary.contextBudgetSummary}`);
  lines.push('');

  for (const stage of summary.stages) {
    const stageIcon = stage.status === 'passed' ? '✓' : stage.status === 'skipped' ? '○' : '✗';
    lines.push(`  ${stageIcon} ${stage.scenarioName}: ${stage.status}`);
    lines.push(`      input=${stage.inputCount} accepted=${stage.acceptedCount} skipped=${stage.skippedCount} failed=${stage.failedCount} tasks=${stage.taskCount} candidates=${stage.candidateCount}`);
    if (stage.reason) {
      lines.push(`      reason: ${stage.reason}`);
    }
  }

  if (summary.recommendedNextIssue) {
    lines.push('');
    lines.push(`Recommended next issue: ${summary.recommendedNextIssue}`);
  }

  if (summary.reason) {
    lines.push(`reason: ${summary.reason}`);
  }

  if (summary.nextAction) {
    lines.push(`nextAction: ${summary.nextAction}`);
  }

  return lines.join('\n');
}

export async function handleRuntimePainFlood(opts: CliPainFloodOptions): Promise<void> {
  if (opts.workspace) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', reason: 'Explicit workspace is not allowed for pain flood simulation — this command mutates state and must run in an auto-created temp workspace only.', nextAction: 'Remove --workspace flag and re-run to use a temp workspace.' }));
    } else {
      console.error('Error: --workspace is not allowed for pain flood simulation. This command mutates state and must run in an auto-created temp workspace only.');
    }
    process.exitCode = 1;
    return;
  }

  const countFields: { name: 'identicalCount' | 'similarCount' | 'stressCount'; value: number | undefined; min: number }[] = [
    { name: 'identicalCount', value: opts.identicalCount, min: 1 },
    { name: 'similarCount', value: opts.similarCount, min: 1 },
    { name: 'stressCount', value: opts.stressCount, min: 1 },
  ];

  for (const field of countFields) {
    if (field.value !== undefined) {
      if (!Number.isFinite(field.value) || !Number.isInteger(field.value) || field.value < field.min) {
        const reason = `--${field.name === 'identicalCount' ? 'identical-count' : field.name === 'similarCount' ? 'similar-count' : 'stress-count'} must be a finite integer >= ${field.min}, got ${field.value}`;
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', reason, nextAction: `Provide a valid --${field.name === 'identicalCount' ? 'identical-count' : field.name === 'similarCount' ? 'similar-count' : 'stress-count'} value` }));
        } else {
          console.error(`Error: ${reason}`);
        }
        process.exitCode = 1;
        return;
      }
    }
  }

  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-flood-'));
  const workspaceMode = 'temp' as const;

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
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  }
}