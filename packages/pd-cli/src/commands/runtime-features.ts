/**
 * pd runtime features — Show effective feature flags from .pd/config.yaml.
 *
 * PRI-305: Cutover from .pd/feature-flags.yaml to .pd/config.yaml.
 * Uses core computeFeatureFlagsFromConfig for flag computation.
 * --json outputs a single parseable JSON object.
 * Missing config uses core defaults with nextAction.
 * Malformed config fails loud with reason and nextAction.
 * No secret output.
 */

import * as path from 'path';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

// ── Output types ─────────────────────────────────────────────────────────────

export interface RuntimeFeaturesOutput {
  status: 'ok' | 'degraded' | 'failed';
  source: 'defaults' | 'user_config' | 'malformed';
  configPath: string;
  features: {
    id: string;
    category: string;
    enabled: boolean;
  }[];
  enabledMvpChannels: string[];
  totalFlags: number;
  enabledCount: number;
  disabledCount: number;
  warnings: string[];
  reason?: string;
  nextAction?: string;
  /** Malformed config errors (only present when source=malformed) */
  errors?: { path: string; reason: string; nextAction: string }[];
}

// ── Build output ─────────────────────────────────────────────────────────────

export function buildRuntimeFeaturesStatus(workspaceDir: string): RuntimeFeaturesOutput {
  const loadResult = loadPdConfig(workspaceDir);
  const flags = computeFlagsFromLoadResult(loadResult);

  const allFlags = Object.values(flags.flags);
  const enabledCount = allFlags.filter(f => f.enabled).length;
  const features = allFlags.map(f => ({
    id: f.id,
    category: f.category,
    enabled: f.enabled,
  }));

  // Determine status
  let status: RuntimeFeaturesOutput['status'] = 'ok';
  const warnings = [...loadResult.warnings, ...flags.warnings];

  if (!loadResult.ok) {
    status = 'failed';
  } else if (warnings.length > 0) {
    status = 'degraded';
  }

  const output: RuntimeFeaturesOutput = {
    status,
    source: loadResult.ok ? loadResult.source : 'malformed',
    configPath: loadResult.configPath,
    features,
    enabledMvpChannels: [...flags.enabledChannels],
    totalFlags: allFlags.length,
    enabledCount,
    disabledCount: allFlags.length - enabledCount,
    warnings,
  };

  // Add reason and nextAction for non-ok states
  if (!loadResult.ok) {
    output.reason = `Config validation failed: ${loadResult.errors.map(e => e.reason).join('; ')}`;
    output.nextAction = loadResult.errors[0]?.nextAction ?? 'Fix .pd/config.yaml and retry';
    output.errors = loadResult.errors;
  } else if (warnings.length > 0) {
    output.reason = `Config warnings: ${warnings.slice(0, 3).join('; ')}`;
    output.nextAction = 'Review .pd/config.yaml for warnings';
  }

  return output;
}

// ── Text formatting ──────────────────────────────────────────────────────────

function formatTextOutput(output: RuntimeFeaturesOutput): string {
  const lines: string[] = [];

  lines.push('PD Runtime Features');
  lines.push(`source: ${output.source}`);
  lines.push(`config: ${output.configPath}`);
  lines.push('');

  const categoryOrder = ['core', 'quiet', 'gone'] as const;
  for (const category of categoryOrder) {
    const categoryFlags = output.features.filter(f => f.category === category);
    if (categoryFlags.length === 0) continue;

    lines.push(`  ${category.toUpperCase()} (${categoryFlags.length})`);
    for (const flag of categoryFlags) {
      const icon = flag.enabled ? '+' : '-';
      lines.push(`    [${icon}] ${flag.id}`);
    }
    lines.push('');
  }

  lines.push(`Total: ${output.totalFlags} flags, ${output.enabledCount} enabled, ${output.disabledCount} disabled`);
  lines.push(`MVP channels: ${output.enabledMvpChannels.length > 0 ? output.enabledMvpChannels.join(', ') : '(none)'}`);

  if (output.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of output.warnings) {
      lines.push(`  [!] ${w}`);
    }
  }

  if (output.errors && output.errors.length > 0) {
    lines.push('');
    lines.push('Errors:');
    for (const e of output.errors) {
      lines.push(`  [x] ${e.path}: ${e.reason}`);
      lines.push(`      → ${e.nextAction}`);
    }
  }

  return lines.join('\n');
}

// ── CLI handler ──────────────────────────────────────────────────────────────

interface FeaturesOptions {
  workspace?: string;
  json?: boolean;
}

export async function handleRuntimeFeaturesStatus(opts: FeaturesOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const output = buildRuntimeFeaturesStatus(workspaceDir);

  if (opts.json) {
    // JSON mode: single parseable object on stdout
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatTextOutput(output));
  }

  if (output.status === 'failed') {
    process.exitCode = 1;
  }
}
