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
  FeatureFlagSource,
  RuntimeProfileType,
  OpenClawRuntimeProfile,
  PdLocalRuntimeProfile,
  RuntimeProfile,
  InternalAgentName,
  InternalAgentBinding,
  InternalAgentsConfig,
  DiagnosticsMode,
  UiConfig,
  WorkspaceConfig,
  WorkspaceEnvironment,
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
  // PRI-304 Profile types
  ProfileAuditLevel,
  ProfileEvolutionMode,
  ProfileTestLevel,
  ProfileConfig,
  RedactedProfileSummary,
  // Context Injection types
  ProjectFocusMode,
  EvolutionContextConfig,
  ContextInjectionConfig,
  PartialContextInjectionConfig,
} from './pd-config-types.js';

export {
  PD_CONFIG_VERSION,
  VALID_FEATURE_CATEGORIES,
  VALID_PROFILE_TYPES,
  INTERNAL_AGENT_NAMES,
  VALID_DIAGNOSTICS_MODES,
  VALID_PROJECT_FOCUS_MODES,
  DANGEROUS_KEYS,
  // PRI-587 Workspace environment enum
  WORKSPACE_ENVIRONMENTS,
  // PRI-304 Enums
  PROFILE_AUDIT_LEVELS,
  PROFILE_EVOLUTION_MODES,
  PROFILE_TEST_LEVELS,
} from './pd-config-types.js';

// Validation
export {
  validatePdConfig,
} from './pd-config-validate.js';

// Profile validation — PRI-304
export {
  validateProfileConfig,
} from './pd-validate-profile.js';

// Profile defaults — PRI-304
export {
  PROFILE_DEFAULTS,
  resolveProfile,
} from './pd-profile-constants.js';

// Defaults
export {
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_RUNTIME_PROFILE_ID,
  DEFAULT_RUNTIME_PROFILE,
  DEFAULT_UI,
  DEFAULT_CONTEXT_INJECTION,
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
