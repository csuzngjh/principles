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
