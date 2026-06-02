export {
  VALID_CATEGORIES,
  validateFeatureFlagRaw,
  computeEffectiveFlags,
  DEFAULT_FEATURE_FLAGS,
} from './feature-flag-contract.js';

export type {
  FeatureFlagCategory,
  FeatureFlagDefinition,
  EffectiveFeatureFlags,
  ValidationResult,
  ValidationResultOk,
  ValidationResultErr,
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
