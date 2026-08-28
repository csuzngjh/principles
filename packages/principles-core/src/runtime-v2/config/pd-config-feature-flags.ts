/**
 * PD Config Feature Flags — PRI-304
 *
 * Compute effective feature flags from the new PD config contract.
 * Replaces the old `.pd/feature-flags.yaml` computation.
 * Feature flags now come from `.pd/config.yaml.features`.
 */

import {
  type EffectivePdConfig,
  type FeatureCategory,
  DANGEROUS_KEYS,
} from './pd-config-types.js';
import { DEFAULT_FEATURE_FLAGS } from './pd-config-defaults.js';

// ── Effective Feature Flag ──────────────────────────────────────────────────

export interface EffectiveFeatureFlag {
  id: string;
  category: FeatureCategory;
  enabled: boolean;
}

export interface FeatureFlagsResult {
  flags: Record<string, EffectiveFeatureFlag>;
  /** Which MVP channels are enabled */
  enabledChannels: string[];
  /** Warnings from flag computation */
  warnings: string[];
}

// ── MVP Channel IDs ─────────────────────────────────────────────────────────

export const MVP_CHANNEL_IDS = ['prompt', 'code_tool_hook', 'defer_archive'] as const;

// ── Compute Feature Flags ───────────────────────────────────────────────────

/**
 * Compute effective feature flags from the PD config.
 * This replaces the old `computeEffectiveFlags()` from feature-flag-contract.ts.
 */
export function computeFeatureFlagsFromConfig(effective: EffectivePdConfig): FeatureFlagsResult {
  const { config } = effective;
  const warnings: string[] = [];
  const flags: Record<string, EffectiveFeatureFlag> = {};

  // Start with defaults
  for (const [id, defaultEntry] of Object.entries(DEFAULT_FEATURE_FLAGS)) {
    flags[id] = {
      id,
      category: defaultEntry.category,
      enabled: defaultEntry.enabled,
    };
  }

  // Apply user config overrides
  for (const [id, userEntry] of Object.entries(config.features)) {
    if (DANGEROUS_KEYS.has(id)) continue;
    if (!userEntry) continue;

    if (Object.hasOwn(flags, id)) {
      const defaultFlag = flags[id];
      if (!defaultFlag) continue;

      // Gone flags can never be re-enabled
      if (defaultFlag.category === 'gone' && userEntry.enabled) {
        warnings.push(`feature '${id}': gone flag cannot be re-enabled`);
        continue;
      }

      // PRI-435: Core flags default ON and cannot be disabled by omission.
      // However, operators may explicitly set `enabled: false` for emergency disable
      // (e.g. `code_rule_capability.enabled: false` to halt the RuleHost pipeline).
      // This deliberate override is honored with a warning so the disable is observable
      // in logs/telemetry. Per-rule rollback remains `deactivate`.
      // F14-1 (PRI-442): category must be preserved as defaultFlag.category —
      // previously used userEntry.category, allowing operators to override a
      // core flag's category to 'gone' or 'quiet', which is a privilege
      // escalation. The old system (feature-flag-contract.ts) used
      // `{ ...def, enabled: false }` to preserve def.category.
      if (defaultFlag.category === 'core' && !userEntry.enabled) {
        warnings.push(`feature '${id}': core flag explicitly disabled via config (emergency disable)`);
        flags[id] = {
          id,
          category: defaultFlag.category,
          enabled: false,
        };
        continue;
      }

      flags[id] = {
        id,
        category: userEntry.category,
        enabled: userEntry.enabled,
      };
    } else {
      // PRI-609: unknown flags are NOT effective capabilities. A config key
      // that no production consumer reads must never appear enabled in the
      // effective flag map — diagnose it and move on.
      warnings.push(`feature '${id}': unknown flag ignored (not a registered capability)`);
    }
  }

  // Compute enabled channels
  const enabledChannels: string[] = [];
  for (const channelId of MVP_CHANNEL_IDS) {
    const flag = flags[channelId];
    if (flag && flag.enabled) {
      enabledChannels.push(channelId);
    }
  }

  return {
    flags,
    enabledChannels,
    warnings,
  };
}

/**
 * Check if a specific feature flag is enabled.
 */
export function isFeatureEnabled(result: FeatureFlagsResult, flagId: string): boolean {
  if (!Object.hasOwn(result.flags, flagId)) return false;
  return result.flags[flagId]?.enabled ?? false;
}

/**
 * Get all enabled feature flag IDs.
 */
export function getEnabledFlagIds(result: FeatureFlagsResult): string[] {
  return Object.values(result.flags)
    .filter((f): f is EffectiveFeatureFlag => f !== undefined && f.enabled)
    .map(f => f.id);
}
