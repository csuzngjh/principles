/**
 * pd config doctor — Discover and explain PD / OpenClaw configuration state.
 *
 * PRI-299 MVP UX:
 *   - Reports workspace + OpenClaw config paths and existence
 *   - Lists effective feature flags and enabled MVP channels
 *   - Classifies provider/model/auth connectivity (healthy, auth_missing, rate_limit, etc.)
 *   - Emits `reason` + `nextActions` for failures
 *   - NEVER leaks tokens, env var values, or raw config bytes
 *
 * Usage:
 *   pd config doctor [--workspace <path>] [--json]
 */

import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { buildDoctorOutput, type DoctorOutput } from '../services/config-doctor.js';

interface DoctorOptions {
  workspace?: string;
  json?: boolean;
}

function formatTextOutput(output: DoctorOutput): string {
  const lines: string[] = [];
  const statusIcon = output.status === 'ok' ? '✓' : output.status === 'degraded' ? '⚠' : '✗';

  lines.push('PD Config Doctor');
  lines.push(`status: ${statusIcon} ${output.status.toUpperCase()}`);
  lines.push(`workspace: ${output.workspaceDir}`);
  lines.push('');

  lines.push('PD config paths:');
  for (const [k, v] of Object.entries(output.pdConfigPaths)) {
    const exists = v.exists ? '[exists]' : '[missing]';
    lines.push(`  ${k.padEnd(16)} ${exists.padEnd(10)} ${v.path}`);
  }
  lines.push('');

  lines.push('OpenClaw paths:');
  for (const [k, v] of Object.entries(output.openclawConfigPaths)) {
    const exists = v.exists ? '[exists]' : '[missing]';
    lines.push(`  ${k.padEnd(16)} ${exists.padEnd(10)} ${v.path}`);
  }
  lines.push('');

  lines.push(`Feature flags: source=${output.featureFlags.source}`);
  lines.push(`  enabled MVP channels: ${output.featureFlags.enabledMvpChannels.length === 0 ? '(none)' : output.featureFlags.enabledMvpChannels.join(', ')}`);
  if (output.featureFlags.disabledFlags.length > 0) {
    lines.push(`  disabled: ${output.featureFlags.disabledFlags.join(', ')}`);
  }
  if (output.featureFlags.warnings.length > 0) {
    lines.push(`  warnings: ${output.featureFlags.warnings.length}`);
  }
  lines.push('');

  lines.push('Provider health:');
  if (output.providerHealth.length === 0) {
    lines.push('  (no providers discovered)');
  } else {
    for (const p of output.providerHealth) {
      const cls = p.classification.toUpperCase();
      const provider = p.provider ?? '(unset)';
      const model = p.model ?? '(unset)';
      const apiKeyEnv = p.apiKeyEnv ?? '(unset)';
      const apiKeyState = p.apiKeyPresent ? 'present' : 'absent';
      lines.push(`  [${cls}] ${provider} / ${model}`);
      lines.push(`    apiKeyEnv:   ${apiKeyEnv} (${apiKeyState})`);
      lines.push(`    source:      ${p.source}`);
      lines.push(`    reason:      ${p.reason}`);
      lines.push(`    nextAction:  ${p.nextAction}`);
    }
  }
  lines.push('');

  if (output.warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of output.warnings) {
      lines.push(`  [!] ${w}`);
    }
    lines.push('');
  }

  if (output.reason) {
    lines.push(`Reason: ${output.reason}`);
    lines.push('');
  }

  if (output.nextActions.length > 0) {
    lines.push('Next actions:');
    for (const a of output.nextActions) {
      lines.push(`  → ${a}`);
    }
  }

  return lines.join('\n');
}

export async function handleConfigDoctor(opts: DoctorOptions): Promise<void> {
  let workspaceDir: string;
  try {
    workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = {
      status: 'failed' as const,
      reason: 'workspace_resolution_failed',
      message,
      nextActions: ['Pass --workspace <path> explicitly, or set PD_WORKSPACE_DIR environment variable'],
    };
    if (opts.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.error(`error: ${message}`);
    }
    process.exit(1);
    return;
  }

  const output = await buildDoctorOutput({ workspaceDir });

  if (opts.json) {
    // JSON mode: single parseable object on stdout.
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatTextOutput(output));
  }

  if (output.status === 'failed') {
    process.exitCode = 1;
  } else if (output.status === 'degraded') {
    // degraded: do not exit 1, but emit a hint to stderr for the operator.
    console.error(`\nNote: doctor status is degraded. Inspect warnings + nextActions.`);
  }
}
