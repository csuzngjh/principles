import { DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime-v2';
import * as yaml from 'js-yaml';
import * as path from 'path';

export const MVP_CHANNELS = ['prompt', 'code_tool_hook', 'defer_archive'] as const;
export type MvpChannel = (typeof MVP_CHANNELS)[number];

export const MVP_QUIET_FLAGS = ['gfi'] as const;
export const MVP_GONE_FLAGS = ['nocturnal', 'idle_trigger', 'model_training', 'trainer'] as const;

export function generateFeatureFlagsYamlContent(): string {
  const flags: Record<string, { enabled: boolean; category: string; since: string; description?: string }> = {};

  for (const flag of DEFAULT_FEATURE_FLAGS) {
    flags[flag.id] = {
      enabled: flag.enabled,
      category: flag.category,
      since: flag.since,
    };
    if (flag.description) {
      flags[flag.id].description = flag.description;
    }
  }

  return yaml.dump(flags, { lineWidth: -1, quotingType: '"' });
}

export function validateMvpChannels(channels: unknown): {
  valid: MvpChannel[];
  unknowns: string[];
} {
  if (!Array.isArray(channels)) {
    return { valid: [], unknowns: [] };
  }

  const mvpSet = new Set<string>(MVP_CHANNELS);
  const valid: MvpChannel[] = [];
  const unknowns: string[] = [];

  for (const ch of channels) {
    if (typeof ch !== 'string') continue;
    if (mvpSet.has(ch)) {
      valid.push(ch as MvpChannel);
    } else {
      unknowns.push(ch);
    }
  }

  return { valid, unknowns };
}

export function buildNextAction(): string {
  return 'Run "pd demo story-a" to verify MVP channels, or "pd runtime features --json" to inspect feature flags';
}

export function buildFailureReason(errorMsg: string): string {
  return `install_error: ${errorMsg}`;
}

export function buildFailureNextAction(): string {
  return 'Check the error message above. If the issue persists, file a bug report.';
}

export function getFeatureFlagsPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', 'feature-flags.yaml');
}

export function isMvpChannel(value: string): value is MvpChannel {
  return (MVP_CHANNELS as readonly string[]).includes(value);
}
