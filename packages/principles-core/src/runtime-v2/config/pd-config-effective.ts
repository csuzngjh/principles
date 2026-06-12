/**
 * PD Config Effective Config — PRI-304
 *
 * Merges validated user config with defaults.
 * Missing fields get deterministic defaults.
 * Per-agent override beats default runtime.
 */

import {
  type PdConfig,
  type EffectivePdConfig,
  type FeatureFlagEntry,
  type InternalAgentBinding,
  type InternalAgentsConfig,
  type RuntimeProfile,
  PD_CONFIG_VERSION,
  INTERNAL_AGENT_NAMES,
  DANGEROUS_KEYS,
} from './pd-config-types.js';
import {
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_RUNTIME_PROFILE_ID,
  DEFAULT_RUNTIME_PROFILE,
  DEFAULT_UI,
  getDefaultInternalAgents,
  getDefaultPdConfig,
} from './pd-config-defaults.js';

/**
 * Compute effective PD config by merging validated user config with defaults.
 * If userConfig is null/undefined, returns pure defaults.
 */
export function computeEffectivePdConfig(userConfig: PdConfig | null | undefined): EffectivePdConfig {
  if (userConfig === null || userConfig === undefined) {
    return {
      config: getDefaultPdConfig(),
      source: 'defaults',
      warnings: [],
      featuresChangedFromDefault: [],
    };
  }

  const warnings: string[] = [];
  const featuresChangedFromDefault: string[] = [];

  // Merge features: user overrides for known flags, defaults for missing
  const features: Record<string, FeatureFlagEntry> = {};
  for (const [flagId, defaultEntry] of Object.entries(DEFAULT_FEATURE_FLAGS)) {
    if (Object.hasOwn(userConfig.features, flagId)) {
      const userEntry = userConfig.features[flagId];
      if (!userEntry) {
        features[flagId] = { ...defaultEntry };
        continue;
      }
      // Gone flags can never be re-enabled
      if (defaultEntry.category === 'gone' && userEntry.enabled) {
        features[flagId] = { ...defaultEntry };
        warnings.push(`feature '${flagId}': gone flag cannot be re-enabled`);
        featuresChangedFromDefault.push(flagId);
        continue;
      }
      // Core flags can never be disabled
      if (defaultEntry.category === 'core' && !userEntry.enabled) {
        features[flagId] = { ...defaultEntry };
        warnings.push(`feature '${flagId}': core flag cannot be disabled`);
        featuresChangedFromDefault.push(flagId);
        continue;
      }
      if (userEntry.category !== defaultEntry.category || userEntry.enabled !== defaultEntry.enabled) {
        featuresChangedFromDefault.push(flagId);
      }
      features[flagId] = { category: userEntry.category, enabled: userEntry.enabled };
    } else {
      features[flagId] = { ...defaultEntry };
    }
  }

  // Add user-only features (not in defaults)
  for (const [flagId, userEntry] of Object.entries(userConfig.features)) {
    if (DANGEROUS_KEYS.has(flagId)) continue;
    if (!Object.hasOwn(features, flagId)) {
      featuresChangedFromDefault.push(flagId);
      features[flagId] = { ...userEntry };
      warnings.push(`feature '${flagId}': unknown flag accepted as-is`);
    }
  }

  // Runtime profiles: use user profiles directly
  const runtimeProfiles: Record<string, RuntimeProfile> = {};
  for (const [profileId, profile] of Object.entries(userConfig.runtimeProfiles)) {
    if (DANGEROUS_KEYS.has(profileId)) continue;
    runtimeProfiles[profileId] = { ...profile };
  }

  // Ensure default profile exists
  if (!Object.hasOwn(runtimeProfiles, DEFAULT_RUNTIME_PROFILE_ID)) {
    runtimeProfiles[DEFAULT_RUNTIME_PROFILE_ID] = { ...DEFAULT_RUNTIME_PROFILE };
    warnings.push(`runtime profile '${DEFAULT_RUNTIME_PROFILE_ID}' not found in config, using default`);
  }

  // Internal agents: merge user overrides with defaults
  const defaultAgents = getDefaultInternalAgents();
  const agents: Record<string, InternalAgentBinding> = {};

  for (const name of INTERNAL_AGENT_NAMES) {
    const userBinding = userConfig.internalAgents.agents[name];
    const defaultBinding = defaultAgents.agents[name];

    if (userBinding !== undefined) {
      // Per-agent override: use user's enabled + runtime profile
      agents[name] = {
        enabled: userBinding.enabled,
        runtimeProfile: userBinding.runtimeProfile ?? userConfig.internalAgents.defaultRuntime,
      };
    } else {
      // No override: use default enabled + user's defaultRuntime (not the hard-coded default)
      agents[name] = {
        enabled: defaultBinding.enabled,
        runtimeProfile: userConfig.internalAgents.defaultRuntime,
      };
    }
  }

  // Validate runtime profile references
  for (const name of INTERNAL_AGENT_NAMES) {
    const binding = agents[name];
    if (binding && binding.enabled && binding.runtimeProfile && !Object.hasOwn(runtimeProfiles, binding.runtimeProfile)) {
      warnings.push(`agent '${name}': runtime profile '${binding.runtimeProfile}' not found in runtimeProfiles`);
    }
  }

  const internalAgents: InternalAgentsConfig = {
    defaultRuntime: userConfig.internalAgents.defaultRuntime,
    agents: agents,
  };

  // UI: use user config or default
  const ui = userConfig.ui ?? { ...DEFAULT_UI };

  // Principles: use user config or default (PRI-336)
  const principles = userConfig.principles ?? { outputLanguage: undefined };

  const config: PdConfig = {
    version: PD_CONFIG_VERSION,
    ...(userConfig.workspace ? { workspace: userConfig.workspace } : {}),
    features,
    runtimeProfiles,
    internalAgents,
    ui,
    principles,
  };

  return {
    config,
    source: 'user_config',
    warnings,
    featuresChangedFromDefault,
  };
}
