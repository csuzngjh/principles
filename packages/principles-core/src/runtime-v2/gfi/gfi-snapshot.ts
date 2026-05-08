import type { GfiState, GfiPolicy, GfiSnapshot } from './gfi-types';
import { classifyGfiStage } from './gfi-kernel';

export function createGfiSnapshot(state: GfiState, policy: GfiPolicy): GfiSnapshot {
  const stage = classifyGfiStage(state.currentGfi, policy);

  const sources: Record<string, number> = { ...state.gfiBySource };

  let dominantSource: string | null = null;
  let maxSourceValue = 0;
  for (const [src, val] of Object.entries(state.gfiBySource)) {
    if (val > maxSourceValue) {
      maxSourceValue = val;
      dominantSource = src;
    }
  }

  const attitudeMode: 'efficient' | 'conciliatory' | 'humble_recovery' =
    state.currentGfi < policy.stageThresholds.elevated
      ? 'efficient'
      : state.currentGfi < policy.stageThresholds.critical
        ? 'conciliatory'
        : 'humble_recovery';

  const painDiagnosticReason: 'none' | 'high_gfi' =
    state.currentGfi >= policy.stageThresholds.elevated ? 'high_gfi' : 'none';
  const consumers = { attitudeMode, painDiagnosticReason };

  return {
    currentGfi: state.currentGfi,
    stage,
    sources,
    dominantSource,
    consecutiveErrors: state.consecutiveErrors,
    lastErrorSource: state.lastErrorSource,
    lastDecayAt: state.lastGfiDecayAt ? new Date(state.lastGfiDecayAt).toISOString() : undefined,
    dailyGfiPeak: state.dailyGfiPeak,
    policy: {
      elevatedThreshold: policy.stageThresholds.elevated,
      criticalThreshold: policy.stageThresholds.critical,
      saturatedThreshold: policy.stageThresholds.saturated,
      repeatedFailureMultiplierMax: policy.repeatedFailureMultiplier.max,
    },
    consumers,
  };
}