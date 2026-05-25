import * as path from 'path';
import { loadEffectiveFeatureFlags } from '../services/feature-flag-loader.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

export interface FeatureFlagsStatusOutput {
  status: 'ok' | 'degraded';
  source: string;
  configPath: string;
  flags: {
    id: string;
    category: string;
    enabled: boolean;
    since: string;
    description?: string;
  }[];
  warnings: string[];
  totalFlags: number;
  enabledCount: number;
  disabledCount: number;
  reason?: string;
  nextAction?: string;
}

interface FeaturesOptions {
  workspace?: string;
  json?: boolean;
}

export function buildFeatureFlagsStatus(workspaceDir: string): FeatureFlagsStatusOutput {
  const effective = loadEffectiveFeatureFlags(workspaceDir);
  const flags = Object.values(effective.flags);
  const enabledCount = flags.filter(f => f.enabled).length;
  const hasWarnings = effective.warnings.length > 0;

  return {
    status: hasWarnings ? 'degraded' : 'ok',
    source: effective.source,
    configPath: effective.configPath,
    flags: flags.map(f => ({
      id: f.id,
      category: f.category,
      enabled: f.enabled,
      since: f.since,
      ...(f.description ? { description: f.description } : {}),
    })),
    warnings: effective.warnings,
    totalFlags: flags.length,
    enabledCount,
    disabledCount: flags.length - enabledCount,
    ...(hasWarnings ? {
      reason: `Config warnings: ${effective.warnings.join('; ')}`,
      nextAction: 'Review feature-flags.yaml for malformed overrides or unknown flags',
    } : {}),
  };
}

function formatTextOutput(output: FeatureFlagsStatusOutput): string {
  const lines: string[] = [];

  lines.push('PD Feature Flags Status');
  lines.push(`source: ${output.source}`);
  lines.push(`config: ${output.configPath}`);
  lines.push('');

  const categoryOrder = ['core', 'quiet', 'gone', 'legacy_retire'] as const;
  for (const category of categoryOrder) {
    const categoryFlags = output.flags.filter(f => f.category === category);
    if (categoryFlags.length === 0) continue;

    lines.push(`  ${category.toUpperCase()} (${categoryFlags.length})`);
    for (const flag of categoryFlags) {
      const icon = flag.enabled ? '+' : '-';
      lines.push(`    [${icon}] ${flag.id} (since ${flag.since})${flag.description ? ` — ${flag.description}` : ''}`);
    }
    lines.push('');
  }

  lines.push(`Total: ${output.totalFlags} flags, ${output.enabledCount} enabled, ${output.disabledCount} disabled`);

  if (output.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of output.warnings) {
      lines.push(`  [!] ${warning}`);
    }
  }

  return lines.join('\n');
}

export async function handleRuntimeFeaturesStatus(opts: FeaturesOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const output = buildFeatureFlagsStatus(workspaceDir);

  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatTextOutput(output));
  }
}
