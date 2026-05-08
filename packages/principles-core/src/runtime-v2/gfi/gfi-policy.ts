import type { GfiPolicy } from './gfi-types';

export const DEFAULT_GFI_POLICY: GfiPolicy = {
  stageThresholds: {
    elevated: 40,
    critical: 70,
    saturated: 100,
  },
  repeatedFailureMultiplier: {
    base: 1.5,
    max: 3.0,
  },
  decayRatesPerMinute: {
    stable: 0.5,
    elevated: 1.0,
    critical: 2.0,
    saturated: 4.0,
  },
  relief: {
    toolSuccessRatio: 0.25,
    minPruneBelow: 8,
  },
  sourceWeights: {},
};