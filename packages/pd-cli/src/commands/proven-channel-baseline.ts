import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { runProvenChannelBaseline } from '../services/proven-channel-baseline-runner.js';
import type { ProvenChannelBaselineSummary, MvpChannel } from '@principles/core/runtime-v2';
import { isMvpChannel } from '@principles/core/runtime-v2';

interface ProvenChannelBaselineCliOptions {
  workspace?: string;
  json?: boolean;
  channels?: string;
}

function formatChannelResult(ch: { channel: string; status: string; failureReason?: string; nextAction?: string; evidence: Record<string, unknown> }): string {
  const icon = ch.status === 'passed' ? '✓' : ch.status === 'degraded' ? '⚠' : '✗';
  const lines: string[] = [];
  lines.push(`  ${icon} ${ch.channel}: ${ch.status}`);
  if (ch.failureReason) {
    lines.push(`    reason: ${ch.failureReason}`);
  }
  if (ch.nextAction) {
    lines.push(`    nextAction: ${ch.nextAction}`);
  }
  return lines.join('\n');
}

function formatTextOutput(summary: ProvenChannelBaselineSummary): string {
  const lines: string[] = [];
  const icon = summary.status === 'passed' ? '✓' : summary.status === 'degraded' ? '⚠' : '✗';

  lines.push('PD Proven Channel Baseline (PRI-240)');
  lines.push(`generatedAt: ${summary.generatedAt}`);
  lines.push(`workspaceMode: ${summary.workspaceMode}`);
  lines.push(`OVERALL: ${icon} ${summary.status.toUpperCase()}`);
  lines.push('');

  lines.push('Channel Results:');
  for (const ch of summary.channels) {
    lines.push(formatChannelResult(ch));
  }

  lines.push('');
  lines.push('Continuity Matrix:');
  for (const entry of summary.continuityMatrix) {
    lines.push(`  ${entry.channel}:`);
    lines.push(`    entryPoint: ${entry.entryPoint}`);
    lines.push(`    expected: ${entry.expectedObservable}`);
    lines.push(`    dependsOnNocturnal: ${entry.dependsOnNocturnal}`);
    lines.push(`    dependsOnIdleTrigger: ${entry.dependsOnIdleTrigger}`);
    lines.push(`    dependsOnPluginDiscovery: ${entry.dependsOnPluginDiscovery}`);
  }

  if (summary.recommendedNextIssue) {
    lines.push('');
    lines.push(`Recommended next issue: ${summary.recommendedNextIssue}`);
  }

  return lines.join('\n');
}

function parseChannels(raw: string | undefined): MvpChannel[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map(p => p.trim()).filter(p => p.length > 0);
  const valid: MvpChannel[] = [];
  for (const part of parts) {
    if (isMvpChannel(part)) {
      valid.push(part);
    }
  }
  if (valid.length === 0) return undefined;
  return valid;
}

export async function handleProvenChannelBaseline(opts: ProvenChannelBaselineCliOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'pd-proven-channel-'));
  const workspaceMode: 'temp' | 'explicit_workspace' = opts.workspace ? 'explicit_workspace' : 'temp';
  const channels = parseChannels(opts.channels);

  try {
    const summary = await runProvenChannelBaseline({
      workspaceDir,
      workspaceMode,
      channels,
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
        void 0;
      }
    }
  }
}
