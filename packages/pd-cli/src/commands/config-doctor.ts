/**
 * pd config doctor — Discover and explain PD / OpenClaw configuration state.
 *
 * PRI-305: Cutover to .pd/config.yaml.
 *   - Feature flags and internal agent runtime bindings come from .pd/config.yaml
 *   - .pd/feature-flags.yaml and .state/workflows.yaml are no longer production inputs
 *
 * Usage:
 *   pd config doctor [--workspace <path>] [--json]
 */

import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { buildDoctorOutput, type DoctorOutput } from '../services/config-doctor.js';
import { discoverWorkspaceDefault } from '../services/pd-config-loader.js';

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

  // Workspace discovery info
  const discovery = discoverWorkspaceDefault();
  if (discovery) {
    lines.push(`workspace.default: ${discovery.workspaceDefault} (source: ${discovery.source})`);
    const normalizedResolved = output.workspaceDir.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedDefault = discovery.workspaceDefault.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalizedResolved !== normalizedDefault) {
      lines.push(`  ⚠ RESOLVED path differs from workspace.default!`);
    } else {
      lines.push(`  ✓ resolved path matches workspace.default`);
    }
  } else {
    lines.push('workspace.default: (not configured — add workspace.default to .pd/config.yaml)');
  }
  lines.push('');

  lines.push('PD config paths:');
  for (const [k, v] of Object.entries(output.pdConfigPaths)) {
    const exists = v.exists ? '[exists]' : '[missing]';
    const parseable = v.parseable === false ? ' [unparseable]' : '';
    lines.push(`  ${k.padEnd(16)} ${exists.padEnd(10)}${parseable} ${v.path}`);
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

  lines.push('Internal agents:');
  if (output.internalAgents.length === 0) {
    lines.push('  (no internal agents diagnosed)');
  } else {
    for (const agent of output.internalAgents) {
      const readiness = agent.readiness.toUpperCase();
      const enabledLabel = agent.enabled ? 'enabled' : 'disabled';
      lines.push(`  ${agent.name}: [${readiness}] (${enabledLabel})`);
      lines.push(`    profile:      ${agent.runtimeProfileLabel} (${agent.runtimeProfileId})`);
      if (agent.apiKeyEnv) {
        const apiKeyState = agent.apiKeyPresent ? 'present' : 'absent';
        lines.push(`    apiKeyEnv:    ${agent.apiKeyEnv} (${apiKeyState})`);
      }
      lines.push(`    reason:       ${agent.reason}`);
      lines.push(`    nextAction:   ${agent.nextAction}`);
    }
  }
  lines.push('');

  lines.push('Provider health:');
  if (output.providerHealth.length === 0) {
    lines.push('  (no providers discovered)');
  } else {
    for (const p of output.providerHealth) {
      const cls = p.classification.toUpperCase();
      const apiKeyEnv = p.apiKeyEnv ?? '(unset)';
      const apiKeyState = p.apiKeyPresent ? 'present' : 'absent';
      lines.push(`  [${cls}]`);
      lines.push(`    apiKeyEnv:   ${apiKeyEnv} (${apiKeyState})`);
      lines.push(`    source:      ${p.source}`);
      lines.push(`    reason:      ${p.reason}`);
      lines.push(`    nextAction:  ${p.nextAction}`);
    }
  }
  lines.push('');

  if (output.legacyFilesDetected.length > 0) {
    lines.push('Legacy files detected (not used for resolution):');
    for (const f of output.legacyFilesDetected) {
      lines.push(`  [!] ${f}`);
    }
    lines.push('');
  }

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
