import type { GfiState, GfiEvent, GfiPolicy, GfiStage, GfiSource, GfiSnapshot } from './gfi-types';
import { DEFAULT_GFI_POLICY } from './gfi-policy';

export { DEFAULT_GFI_POLICY };

export function applyFriction(
  state: GfiState,
  event: GfiEvent,
  policy: GfiPolicy,
): GfiState {
  const isRepeated = state.lastErrorHash !== undefined && state.lastErrorHash === event.hash;

  const consecutiveErrors = isRepeated
    ? state.consecutiveErrors + 1
    : 1;

  const exponent = Math.max(0, consecutiveErrors - 1);
  const multiplier = Math.min(
    Math.pow(policy.repeatedFailureMultiplier.base, exponent),
    policy.repeatedFailureMultiplier.max,
  );

  const score = event.baseScore * multiplier;
  const newCurrentGfi = state.currentGfi + score;

  const newGfiBySource: Partial<Record<GfiSource, number>> = { ...state.gfiBySource };
  newGfiBySource[event.source] = (newGfiBySource[event.source] ?? 0) + score;

  return {
    ...state,
    currentGfi: newCurrentGfi,
    gfiBySource: newGfiBySource,
    consecutiveErrors,
    lastErrorHash: event.hash,
    lastErrorSource: event.source,
    dailyGfiPeak: Math.max(state.dailyGfiPeak ?? 0, newCurrentGfi),
  };
}

// eslint-disable-next-line @typescript-eslint/max-params
export function applyDecay(
  state: GfiState,
  elapsedMinutes: number,
  policy: GfiPolicy,
  stage: GfiStage,
): GfiState {
  const rate = policy.decayRatesPerMinute[stage];
  const decayed = state.currentGfi - rate * elapsedMinutes;
  const nextGfi = Math.max(0, Math.round(decayed * 10) / 10);

  const nextSources: Partial<Record<GfiSource, number>> = {};
  for (const [src, value] of Object.entries(state.gfiBySource)) {
    const sourceDecayed = value - rate * elapsedMinutes;
    const sourceAfterDecay = Math.max(0, Math.round(sourceDecayed * 10) / 10);
    if (sourceAfterDecay >= policy.relief.minPruneBelow) {
      nextSources[src as GfiSource] = sourceAfterDecay;
    }
  }

  return {
    ...state,
    currentGfi: nextGfi,
    gfiBySource: nextSources,
    lastGfiDecayAt: Date.now(),
  };
}

export function applyRelief(
  state: GfiState,
  opts: { source: string; amount?: number },
  policy: GfiPolicy = DEFAULT_GFI_POLICY,
): GfiState {
  const { source, amount = 0 } = opts;

  if (source === 'all' && amount >= 100) {
    return {
      currentGfi: 0,
      gfiBySource: {},
      consecutiveErrors: 0,
      lastErrorHash: undefined,
      lastErrorSource: undefined,
      dailyGfiPeak: state.dailyGfiPeak,
    };
  }

  const newSources: Partial<Record<GfiSource, number>> = { ...state.gfiBySource };

  if (amount > 0) {
    // source-specific partial relief
    const key = source as GfiSource;
    if (newSources[key] !== undefined) {
      newSources[key] = Math.max(0, (newSources[key] ?? 0) - amount);
      if (newSources[key] === 0) {
        delete newSources[key];
      }
    }
  } else {
    // ratio-based relief (toolSuccessRatio)
    const ratio = policy.relief.toolSuccessRatio;
    for (const src of Object.keys(newSources)) {
      const key = src as GfiSource;
      newSources[key] = Math.max(0, Math.round(((newSources[key] ?? 0) * (1 - ratio)) * 10) / 10);
      if (newSources[key] === 0) {
        delete newSources[key];
      }
    }
  }

  const totalSources = Object.values(newSources).reduce((a, b) => a + b, 0);

  const isLastErrorSource = source === state.lastErrorSource && source !== 'all';
  const newConsecutiveErrors = isLastErrorSource ? 0 : state.consecutiveErrors;

  return {
    ...state,
    currentGfi: totalSources,
    gfiBySource: newSources,
    consecutiveErrors: newConsecutiveErrors,
    lastErrorHash: newConsecutiveErrors === 0 ? undefined : state.lastErrorHash,
    lastErrorSource: newConsecutiveErrors === 0 ? undefined : state.lastErrorSource,
  };
}

export function classifyGfiStage(gfi: number, policy: GfiPolicy): GfiStage {
  if (gfi >= policy.stageThresholds.saturated) return 'saturated';
  if (gfi >= policy.stageThresholds.critical) return 'critical';
  if (gfi >= policy.stageThresholds.elevated) return 'elevated';
  return 'stable';
}

export function createGfiSnapshot(state: GfiState, policy: GfiPolicy): GfiSnapshot {
  const stage = classifyGfiStage(state.currentGfi, policy);

  const sources: Partial<Record<GfiSource, number>> = { ...state.gfiBySource };

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