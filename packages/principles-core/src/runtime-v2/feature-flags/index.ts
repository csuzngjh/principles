export {
  VALID_CATEGORIES,
  validateFeatureFlagRaw,
  computeEffectiveFlags,
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_ALIASES,
  normalizeFeatureFlagOverrides,
} from './feature-flag-contract.js';

export type {
  FeatureFlagCategory,
  FeatureFlagDefinition,
  EffectiveFeatureFlags,
  ValidationResult,
  ValidationResultOk,
  ValidationResultErr,
  FeatureFlagOverrideNormalization,
} from './feature-flag-contract.js';

export {
  VALID_SURFACE_KINDS,
  VALID_MVP_CATEGORIES,
  PLUGIN_SURFACE_REGISTRY,
  validateSurfaceRegistry,
  getEnabledSurfaces,
  getSurfacesByCategory,
  getSurfacesByKind,
  findUnclassifiedSurfaces,
} from './plugin-surface-registry.js';

export type {
  SurfaceKind,
  MvpCategory,
  PluginSurfaceEntry,
  SurfaceRegistryValidationResult,
} from './plugin-surface-registry.js';

// Surface guard — pure logic migrated from plugin (Stage 3)
export {
  checkSurfaceGuard,
  getSurfaceIdForHook,
  getSurfaceIdForService,
  isSurfaceEnabled,
  guardHook,
  guardService,
  __resetSurfaceGuardSkipLogStateForTests,
} from './surface-guard-policy.js';

export type {
  SurfaceGuardResult,
  HookHandler,
} from './surface-guard-policy.js';
