/**
 * PD Config Module — PRI-304
 *
 * Public API for the PD-owned config contract.
 */

// Types
export type {
  PdConfigVersion,
  FeatureCategory,
  FeatureFlagEntry,
  RuntimeProfileType,
  OpenClawRuntimeProfile,
  PdLocalRuntimeProfile,
  RuntimeProfile,
  InternalAgentName,
  InternalAgentBinding,
  InternalAgentsConfig,
  DiagnosticsMode,
  UiConfig,
  PrinciplesConfig,
  PdConfig,
  PdConfigValidationError,
  PdConfigValidationResultOk,
  PdConfigValidationResultErr,
  PdConfigValidationResult,
  EffectivePdConfig,
  RedactedRuntimeProfileSummary,
  RedactedAgentSummary,
  RedactedFeatureSummary,
  RedactedPdConfigSummary,
} from './pd-config-types.js';

export {
  PD_CONFIG_VERSION,
  VALID_FEATURE_CATEGORIES,
  VALID_PROFILE_TYPES,
  INTERNAL_AGENT_NAMES,
  VALID_DIAGNOSTICS_MODES,
  DANGEROUS_KEYS,
} from './pd-config-types.js';

// Validation
export {
  validatePdConfig,
} from './pd-config-validate.js';

// Defaults
export {
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_RUNTIME_PROFILE_ID,
  DEFAULT_RUNTIME_PROFILE,
  DEFAULT_UI,
  getDefaultInternalAgents,
  getDefaultPdConfig,
} from './pd-config-defaults.js';

// Effective config
export {
  computeEffectivePdConfig,
} from './pd-config-effective.js';

// Redaction
export {
  redactPdConfig,
  redactConfigValue,
} from './pd-config-redaction.js';

// Feature flags
export type {
  EffectiveFeatureFlag,
  FeatureFlagsResult,
} from './pd-config-feature-flags.js';

export {
  MVP_CHANNEL_IDS,
  computeFeatureFlagsFromConfig,
  isFeatureEnabled,
  getEnabledFlagIds,
} from './pd-config-feature-flags.js';

// Agent runtime binding — PRI-306
export type {
  AgentRuntimeBindingOk,
  AgentRuntimeBindingErr,
  AgentRuntimeBindingResult,
  AgentRuntimeReadinessResult,
  PiAiAdapterConfigResult,
  OpenClawAdapterConfigResult,
  AdapterConfigResult,
} from './pd-config-agent-binding.js';

export {
  resolveAgentRuntimeBinding,
  checkAgentRuntimeReadiness,
  createAdapterConfigFromProfile,
} from './pd-config-agent-binding.js';
