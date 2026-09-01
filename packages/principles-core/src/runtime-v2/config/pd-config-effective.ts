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
  type ContextInjectionConfig,
  type PartialContextInjectionConfig,
  PD_CONFIG_VERSION,
  INTERNAL_AGENT_NAMES,
  DANGEROUS_KEYS,
} from './pd-config-types.js';
import {
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_RUNTIME_PROFILE_ID,
  DEFAULT_RUNTIME_PROFILE,
  DEFAULT_UI,
  DEFAULT_CONTEXT_INJECTION,
  getDefaultInternalAgents,
  getDefaultPdConfig,
} from './pd-config-defaults.js';
import { resolveProfile } from './pd-profile-constants.js';
import { normalizeFeatureFlagOverrides } from '../feature-flags/feature-flag-contract.js';

function resolveContextInjection(
  userPartial: PartialContextInjectionConfig | undefined,
): ContextInjectionConfig {
  if (!userPartial) return { ...DEFAULT_CONTEXT_INJECTION };
  return {
    thinkingOs: userPartial.thinkingOs ?? DEFAULT_CONTEXT_INJECTION.thinkingOs,
    projectFocus: userPartial.projectFocus ?? DEFAULT_CONTEXT_INJECTION.projectFocus,
    evolutionContext: {
      enabled: userPartial.evolutionContext?.enabled ?? DEFAULT_CONTEXT_INJECTION.evolutionContext.enabled,
      maxMessages: userPartial.evolutionContext?.maxMessages ?? DEFAULT_CONTEXT_INJECTION.evolutionContext.maxMessages,
      maxCharsPerMessage:
        userPartial.evolutionContext?.maxCharsPerMessage ?? DEFAULT_CONTEXT_INJECTION.evolutionContext.maxCharsPerMessage,
    },
  };
}

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
      resolvedProfile: resolveProfile({}),
      resolvedContextInjection: resolveContextInjection(undefined),
    };
  }

  const warnings: string[] = [];
  const featuresChangedFromDefault: string[] = [];

  // PRI-609: normalize alias IDs onto canonical IDs before merging so a
  // snake_case config key controls the runtime flag its camelCase production
  // consumer reads, and canonical/alias conflicts are reported (never silent).
  const { normalized: userFeatures, warnings: aliasWarnings } = normalizeFeatureFlagOverrides(
    userConfig.features,
  );
  warnings.push(...aliasWarnings);

  // Merge features: user overrides for known flags, defaults for missing
  const features: Record<string, FeatureFlagEntry> = {};
  for (const [flagId, defaultEntry] of Object.entries(DEFAULT_FEATURE_FLAGS)) {
    if (Object.hasOwn(userFeatures, flagId)) {
      const userEntry = userFeatures[flagId] as FeatureFlagEntry | undefined;
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
      // PRI-435: Core flags default ON and cannot be disabled by omission.
      // However, operators may explicitly set `enabled: false` for emergency disable
      // (e.g. `code_rule_capability.enabled: false` to halt the RuleHost pipeline).
      // This deliberate override is honored with a warning so the disable is observable
      // in logs/telemetry. Per-rule rollback remains `deactivate`.
      if (defaultEntry.category === 'core' && !userEntry.enabled) {
        features[flagId] = {
          category: userEntry.category,
          enabled: false,
          ...(userEntry.source ? { source: userEntry.source } : {}),
        };
        warnings.push(`feature '${flagId}': core flag explicitly disabled via config (emergency disable)`);
        featuresChangedFromDefault.push(flagId);
        continue;
      }
      if (userEntry.category !== defaultEntry.category || userEntry.enabled !== defaultEntry.enabled) {
        featuresChangedFromDefault.push(flagId);
      }
      features[flagId] = {
        category: userEntry.category,
        enabled: userEntry.enabled,
        ...(userEntry.source ? { source: userEntry.source } : {}),
      };
    } else {
      features[flagId] = { ...defaultEntry };
    }
  }

  // User-only features (not in defaults) are NOT effective capabilities.
  // PRI-609: an unknown key used to be inserted into the effective config
  // ("unknown flag accepted as-is"), letting a config key look valid while no
  // production consumer reads it. Unknown keys now produce a diagnostic only.
  for (const flagId of Object.keys(userFeatures)) {
    if (DANGEROUS_KEYS.has(flagId)) continue;
    if (!Object.hasOwn(features, flagId)) {
      warnings.push(`feature '${flagId}': unknown flag ignored (not a registered capability)`);
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

  // ── PRI-638 P1-B: legacy diagnostician_split_pipeline=false cutover ──────
  //
  // Pre-canonical workspaces may carry `diagnostician_split_pipeline.enabled:
  // false`, whose effective meaning back then was "Diagnostician disabled"
  // (it selected DisabledDiagnosticianRunner). After PRI-638 the split
  // pipeline is the only implementation and the flag must no longer silently
  // decide capability — BUT ignoring a legacy explicit `false` would silently
  // ACTIVATE a previously-disabled 3-stage LLM pipeline on upgrade.
  //
  // Policy (conservative, §9: silent false-negative is safer than silent
  // activation): fold a legacy explicit `false` into the canonical binding
  // (internalAgents.agents.diagnostician.enabled=false) at the effective
  // config layer, with a provenance-aware warning. The runtime keeps reading
  // exactly one authority (the agent binding); the legacy flag is consumed
  // here and never becomes a second runtime authority.
  //
  // Recovery for the Owner: remove the legacy flag (or set it enabled:true),
  // or set internalAgents.agents.diagnostician.enabled=true explicitly.
  const legacySplitEntry = userFeatures.diagnostician_split_pipeline as FeatureFlagEntry | undefined;
  if (
    legacySplitEntry !== undefined &&
    legacySplitEntry.enabled === false &&
    agents.diagnostician?.enabled === true
  ) {
    agents.diagnostician = {
      enabled: false,
      runtimeProfile: userConfig.internalAgents.defaultRuntime,
    };
    const provenance = legacySplitEntry.source ?? 'unknown';
    warnings.push(
      `PRI-638 cutover: legacy diagnostician_split_pipeline=false (source: ${provenance}) honored as ` +
      'internalAgents.agents.diagnostician.enabled=false to avoid silently enabling a previously-disabled ' +
      'LLM pipeline. To run diagnosis, remove the legacy flag or set it enabled:true, then ' +
      'set internalAgents.agents.diagnostician.enabled=true in .pd/config.yaml.',
    );
  }

  const internalAgents: InternalAgentsConfig = {
    defaultRuntime: userConfig.internalAgents.defaultRuntime,
    agents: agents,
  };

  // UI: use user config or default
  const ui = userConfig.ui ?? { ...DEFAULT_UI };

  // Principles: use user config or default (PRI-336)
  const principles = userConfig.principles ?? { outputLanguage: undefined };

  // Profile: resolve user partial over profile defaults (PRI-304/PRI-466)
  const resolvedProfile = resolveProfile(userConfig.profile ?? {});

  // Context injection: resolve user partial over defaults
  const resolvedContextInjection = resolveContextInjection(userConfig.contextInjection);

  const config: PdConfig = {
    version: PD_CONFIG_VERSION,
    ...(userConfig.workspace ? { workspace: userConfig.workspace } : {}),
    features,
    runtimeProfiles,
    internalAgents,
    ui,
    principles,
    ...(userConfig.profile ? { profile: userConfig.profile } : {}),
    ...(userConfig.contextInjection ? { contextInjection: userConfig.contextInjection } : {}),
  };

  return {
    config,
    source: 'user_config',
    warnings,
    featuresChangedFromDefault,
    resolvedProfile,
    resolvedContextInjection,
  };
}
