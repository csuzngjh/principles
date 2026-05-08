import { describe, it, expect } from 'vitest';
import {
  applyFriction,
  applyDecay,
  applyRelief,
  classifyGfiStage,
  createGfiSnapshot,
  DEFAULT_GFI_POLICY,
} from '../gfi-kernel.js';
import type { GfiState, GfiEvent, GfiPolicy } from '../gfi-types.js';

function makeState(overrides: Partial<GfiState> = {}): GfiState {
  return {
    currentGfi: 0,
    gfiBySource: {},
    consecutiveErrors: 0,
    ...overrides,
  };
}

function makePolicy(overrides: Partial<GfiPolicy> = {}): GfiPolicy {
  return { ...DEFAULT_GFI_POLICY, ...overrides };
}

// Fixed timestamp injected into applyDecay/applyRelief (architecture requirement: no Date.now() in core kernel)
const FIXED_NOW = 1700000000000;

describe('applyFriction', () => {
  it('single event increments currentGfi + source ledger', () => {
    const state = makeState({ currentGfi: 0, gfiBySource: {} });
    const event: GfiEvent = { source: 'tool_failure', baseScore: 20 };
    const next = applyFriction(state, event, DEFAULT_GFI_POLICY);

    expect(next.currentGfi).toBe(20);
    expect(next.gfiBySource.tool_failure).toBe(20);
    expect(next.consecutiveErrors).toBe(1);
  });

  it('repeated same-hash -> consecutiveErrors++', () => {
    const state = makeState({
      currentGfi: 15,
      gfiBySource: { tool_failure: 15 },
      consecutiveErrors: 1,
      lastErrorHash: 'abc123',
    });
    const event: GfiEvent = { source: 'tool_failure', baseScore: 20, hash: 'abc123' };
    const next = applyFriction(state, event, DEFAULT_GFI_POLICY);

    expect(next.consecutiveErrors).toBe(2);
    // baseScore * multiplier (base=1.5, so 1.5^1 = 1.5, capped at 3.0)
    expect(next.currentGfi).toBe(15 + 20 * 1.5);
    expect(next.gfiBySource.tool_failure).toBe(15 + 20 * 1.5);
  });

  it('different hash -> resets consecutiveErrors', () => {
    const state = makeState({
      currentGfi: 15,
      gfiBySource: { tool_failure: 15 },
      consecutiveErrors: 3,
      lastErrorHash: 'abc123',
      lastErrorSource: 'tool_failure',
    });
    const event: GfiEvent = { source: 'tool_failure', baseScore: 20, hash: 'different' };
    const next = applyFriction(state, event, DEFAULT_GFI_POLICY);

    expect(next.consecutiveErrors).toBe(1);
    expect(next.lastErrorHash).toBe('different');
    expect(next.lastErrorSource).toBe('tool_failure');
    expect(next.currentGfi).toBe(15 + 20); // multiplier = 1.0 for first failure
  });

  it('multiplier capped at policy max (D1 fix)', () => {
    // Consecutive errors high enough that multiplier would exceed 3.0
    const state = makeState({
      currentGfi: 100,
      gfiBySource: { tool_failure: 100 },
      consecutiveErrors: 5, // multiplier would be 1.5^4 = 5.0625, capped at 3.0
      lastErrorHash: 'abc123',
    });
    const event: GfiEvent = { source: 'tool_failure', baseScore: 20, hash: 'abc123' };
    const policy = makePolicy({ repeatedFailureMultiplier: { base: 1.5, max: 3.0 } });
    const next = applyFriction(state, event, policy);

    // multiplier = min(1.5^4, 3.0) = 3.0, not 5.0625
    expect(next.currentGfi).toBe(100 + 20 * 3.0);
    expect(next.consecutiveErrors).toBe(6);
  });

  it('never mutates input state', () => {
    const state = makeState({ currentGfi: 10, consecutiveErrors: 2 });
    const originalCurrentGfi = state.currentGfi;
    const originalConsecutiveErrors = state.consecutiveErrors;
    const event: GfiEvent = { source: 'tool_failure', baseScore: 20 };
    applyFriction(state, event, DEFAULT_GFI_POLICY);

    expect(state.currentGfi).toBe(originalCurrentGfi);
    expect(state.consecutiveErrors).toBe(originalConsecutiveErrors);
  });

  it('source attribution tracks per-source', () => {
    const state = makeState({ gfiBySource: {} });
    const event1: GfiEvent = { source: 'tool_failure', baseScore: 15 };
    const event2: GfiEvent = { source: 'dispatch_error', baseScore: 10 };

    const next1 = applyFriction(state, event1, DEFAULT_GFI_POLICY);
    const next2 = applyFriction(next1, event2, DEFAULT_GFI_POLICY);

    expect(next2.gfiBySource.tool_failure).toBe(15);
    expect(next2.gfiBySource.dispatch_error).toBe(10);
    expect(next2.currentGfi).toBe(25);
  });
});

describe('applyDecay', () => {
  it('correct rate per stage (stable)', () => {
    const state = makeState({ currentGfi: 30, gfiBySource: { tool_failure: 30 } });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'stable', FIXED_NOW);

    // stable decay = 0.5 per minute, so 30 - 0.5 = 29.5
    expect(next.currentGfi).toBeCloseTo(29.5);
  });

  it('correct rate per stage (elevated)', () => {
    const state = makeState({ currentGfi: 50, gfiBySource: { tool_failure: 50 } });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'elevated', FIXED_NOW);

    // elevated decay = 1.0 per minute
    expect(next.currentGfi).toBeCloseTo(49.0);
  });

  it('correct rate per stage (critical)', () => {
    const state = makeState({ currentGfi: 80, gfiBySource: { tool_failure: 80 } });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'critical', FIXED_NOW);

    // critical decay = 2.0 per minute
    expect(next.currentGfi).toBeCloseTo(78.0);
  });

  it('correct rate per stage (saturated)', () => {
    const state = makeState({ currentGfi: 95, gfiBySource: { tool_failure: 95 } });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'saturated', FIXED_NOW);

    // saturated decay = 4.0 per minute
    expect(next.currentGfi).toBeCloseTo(91.0);
  });

  it('prunes sources below minPruneBelow', () => {
    const state = makeState({
      currentGfi: 30,
      gfiBySource: {
        tool_failure: 25,
        dispatch_error: 5, // below minPruneBelow=8
      },
    });
    const policy = makePolicy({ relief: { toolSuccessRatio: 0.5, minPruneBelow: 8 } });
    const nextState = applyDecay(state, 1, policy, 'stable', FIXED_NOW);

    expect(nextState.gfiBySource.tool_failure).toBeDefined();
    expect(nextState.gfiBySource.dispatch_error).toBeUndefined();
  });

  // PRI-82: Decay invariant — currentGfi must equal sum of remaining source slices
  it('multi-source decay: currentGfi equals sum of remaining gfiBySource', () => {
    const state = makeState({
      currentGfi: 50,
      gfiBySource: {
        tool_failure: 30,
        dispatch_error: 20,
      },
    });
    // stable decay = 0.5/min, 1 min → each source loses 0.5
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'stable', FIXED_NOW);

    expect(next.gfiBySource.tool_failure).toBe(29.5);
    expect(next.gfiBySource.dispatch_error).toBe(19.5);
    expect(next.currentGfi).toBe(49.0); // 29.5 + 19.5
  });

  it('source prune causes currentGfi to drop by exact pruned amount', () => {
    // tool_failure: 8.3 → after 1min decay: 7.8 (< minPruneBelow=8 → pruned)
    // dispatch_error: 20 → after 1min decay: 19.5 (kept)
    const state = makeState({
      currentGfi: 28.3,
      gfiBySource: {
        tool_failure: 8.3,
        dispatch_error: 20,
      },
    });
    const policy = makePolicy({ relief: { toolSuccessRatio: 0.25, minPruneBelow: 8 } });
    const next = applyDecay(state, 1, policy, 'stable', FIXED_NOW);

    expect(next.gfiBySource.tool_failure).toBeUndefined(); // pruned
    expect(next.gfiBySource.dispatch_error).toBe(19.5);
    expect(next.currentGfi).toBe(19.5); // only dispatch_error remains
  });

  it('single source decay preserves original semantic (currentGfi derived from source)', () => {
    const state = makeState({
      currentGfi: 30,
      gfiBySource: { tool_failure: 30 },
    });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'stable', FIXED_NOW);

    // 30 - 0.5 = 29.5
    expect(next.gfiBySource.tool_failure).toBe(29.5);
    expect(next.currentGfi).toBe(29.5);
  });

  it('nowMs is injected by caller (time independence)', () => {
    const state = makeState({ currentGfi: 30, gfiBySource: { tool_failure: 30 } });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'stable', FIXED_NOW);

    expect(next.lastGfiDecayAt).toBe(FIXED_NOW);
  });

  it('rounds to 1 decimal', () => {
    const state = makeState({ currentGfi: 33.33, gfiBySource: { tool_failure: 33.33 } });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'stable', FIXED_NOW);

    // 33.33 - 0.5 = 32.83, rounds to 32.8
    expect(next.currentGfi).toBe(32.8);
  });

  it('prunes based on post-decay value, not pre-decay value', () => {
    // Source: 9, minPruneBelow=8, stable decay=0.5/min for 1 min → 8.5 after decay
    // BUG-FIX: pre-decay check (>=8) would keep it; post-decay check (>=8) correctly keeps it
    const state1 = makeState({ currentGfi: 9, gfiBySource: { tool_failure: 9 } });
    const next1 = applyDecay(state1, 1, makePolicy({ relief: { toolSuccessRatio: 0.25, minPruneBelow: 8 } }), 'stable', FIXED_NOW);
    expect(next1.gfiBySource.tool_failure).toBe(8.5);

    // Source: 8, minPruneBelow=8, stable decay=0.5/min → 7.5 after decay
    // BUG-FIX: pre-decay check (8 >= 8) would incorrectly keep it; post-decay check (7.5 < 8) correctly prunes it
    const state2 = makeState({ currentGfi: 8, gfiBySource: { tool_failure: 8 } });
    const next2 = applyDecay(state2, 1, makePolicy({ relief: { toolSuccessRatio: 0.25, minPruneBelow: 8 } }), 'stable', FIXED_NOW);
    expect(next2.gfiBySource.tool_failure).toBeUndefined();
  });

  it('immutable', () => {
    const state = makeState({ currentGfi: 30, gfiBySource: { tool_failure: 30 } });
    applyDecay(state, 1, DEFAULT_GFI_POLICY, 'stable', FIXED_NOW);

    expect(state.currentGfi).toBe(30);
  });

  // PRI-82: Empty source ledger + stable stage → direct decay on currentGfi
  it('empty source ledger decays currentGfi directly (fresh session restart case)', () => {
    const state = makeState({ currentGfi: 30, gfiBySource: {} });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'stable', FIXED_NOW);

    // stable decay = 0.5/min → 30 - 0.5 = 29.5
    expect(next.currentGfi).toBeCloseTo(29.5);
    expect(next.gfiBySource).toEqual({});
  });

  it('empty source ledger + elevated stage -> decay at 1.0/min', () => {
    const state = makeState({ currentGfi: 30, gfiBySource: {} });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'elevated', FIXED_NOW);

    // elevated decay = 1.0/min → 30 - 1.0 = 29.0
    expect(next.currentGfi).toBeCloseTo(29.0);
    expect(next.gfiBySource).toEqual({});
  });

  it('empty source ledger + critical stage -> decay at 2.0/min', () => {
    const state = makeState({ currentGfi: 30, gfiBySource: {} });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'critical', FIXED_NOW);

    // critical decay = 2.0/min → 30 - 2.0 = 28.0
    expect(next.currentGfi).toBeCloseTo(28.0);
    expect(next.gfiBySource).toEqual({});
  });

  it('empty source ledger + saturated stage -> decay at 4.0/min', () => {
    const state = makeState({ currentGfi: 30, gfiBySource: {} });
    const next = applyDecay(state, 1, DEFAULT_GFI_POLICY, 'saturated', FIXED_NOW);

    // saturated decay = 4.0/min → 30 - 4.0 = 26.0
    expect(next.currentGfi).toBeCloseTo(26.0);
    expect(next.gfiBySource).toEqual({});
  });

  it('source ledger all pruned -> currentGfi=0', () => {
    // Source at minPruneBelow=8, stable decay=0.5/min → 7.5 after 1 min → pruned
    const state = makeState({
      currentGfi: 8,
      gfiBySource: { tool_failure: 8 },
    });
    const policy = makePolicy({ relief: { toolSuccessRatio: 0.25, minPruneBelow: 8 } });
    const next = applyDecay(state, 1, policy, 'stable', FIXED_NOW);

    expect(next.gfiBySource.tool_failure).toBeUndefined();
    expect(next.currentGfi).toBe(0); // Invariant: when all sources pruned, currentGfi must be 0
  });

  it('all sources pruned -> currentGfi=0 (multi-source)', () => {
    const state = makeState({
      currentGfi: 16.5,
      gfiBySource: {
        tool_failure: 8.3,  // → 7.8 after decay → pruned (< 8)
        dispatch_error: 8.2, // → 7.7 after decay → pruned (< 8)
      },
    });
    const policy = makePolicy({ relief: { toolSuccessRatio: 0.25, minPruneBelow: 8 } });
    const next = applyDecay(state, 1, policy, 'stable', FIXED_NOW);

    expect(next.gfiBySource.tool_failure).toBeUndefined();
    expect(next.gfiBySource.dispatch_error).toBeUndefined();
    expect(next.currentGfi).toBe(0); // Invariant preserved
  });
});

describe('applyRelief', () => {
  it('source-specific partial relief', () => {
    const state = makeState({
      currentGfi: 50,
      gfiBySource: { tool_failure: 30, dispatch_error: 20 },
      consecutiveErrors: 2,
    });
    const next = applyRelief(state, { source: 'tool_failure', amount: 10 }, FIXED_NOW, DEFAULT_GFI_POLICY);

    expect(next.currentGfi).toBe(40);
    expect(next.gfiBySource.tool_failure).toBe(20);
    expect(next.gfiBySource.dispatch_error).toBe(20);
    expect(next.consecutiveErrors).toBe(2);
    expect(next.lastGfiDecayAt).toBe(FIXED_NOW);
  });

  it('ratio-based relief (toolSuccessRatio)', () => {
    const state = makeState({
      currentGfi: 60,
      gfiBySource: { tool_failure: 40, dispatch_error: 20 },
      consecutiveErrors: 0,
    });
    const policy = makePolicy({ relief: { toolSuccessRatio: 0.25, minPruneBelow: 5 } });
    // amount=0 triggers ratio-based relief applied to ALL sources
    const next = applyRelief(state, { source: 'tool_failure', amount: 0 }, FIXED_NOW, policy);

    // 25% ratio applied to each source: tool_failure 40→30, dispatch_error 20→15
    expect(next.gfiBySource.tool_failure).toBe(30);
    expect(next.gfiBySource.dispatch_error).toBe(15);
    expect(next.currentGfi).toBe(45);
    expect(next.lastGfiDecayAt).toBe(FIXED_NOW);
  });

  it('full reset zeroes everything', () => {
    const state = makeState({
      currentGfi: 80,
      gfiBySource: { tool_failure: 50, dispatch_error: 30 },
      consecutiveErrors: 5,
      lastErrorHash: 'abc',
      lastErrorSource: 'tool_failure',
      dailyGfiPeak: 90,
    });
    const next = applyRelief(state, { source: 'all', amount: 100 }, FIXED_NOW, DEFAULT_GFI_POLICY);

    expect(next.currentGfi).toBe(0);
    expect(next.gfiBySource).toEqual({});
    expect(next.consecutiveErrors).toBe(0);
    expect(next.lastErrorHash).toBeUndefined();
    expect(next.lastErrorSource).toBeUndefined();
    expect(next.lastGfiDecayAt).toBe(FIXED_NOW);
  });

  it('source=all with amount < 100 falls through to ratio-based relief', () => {
    const state = makeState({
      currentGfi: 60,
      gfiBySource: { tool_failure: 40, dispatch_error: 20 },
      consecutiveErrors: 2,
    });
    const policy = makePolicy({ relief: { toolSuccessRatio: 0.5, minPruneBelow: 5 } });
    // amount=50 is not >= 100, so it falls through: amount > 0 but 'all' not in gfiBySource → no-op
    const next = applyRelief(state, { source: 'all', amount: 50 }, FIXED_NOW, policy);

    // 'all' not a real source, so no source-specific partial relief applies
    // consecutiveErrors unchanged (source='all' is not lastErrorSource)
    expect(next.gfiBySource.tool_failure).toBe(40);
    expect(next.gfiBySource.dispatch_error).toBe(20);
    expect(next.currentGfi).toBe(60);
    expect(next.consecutiveErrors).toBe(2);
  });

  it('resets consecutiveErrors when relieving last error source', () => {
    const state = makeState({
      currentGfi: 50,
      gfiBySource: { tool_failure: 50 },
      consecutiveErrors: 3,
      lastErrorHash: 'abc123',
      lastErrorSource: 'tool_failure',
    });
    const next = applyRelief(state, { source: 'tool_failure', amount: 50 }, FIXED_NOW, DEFAULT_GFI_POLICY);

    expect(next.consecutiveErrors).toBe(0);
    expect(next.lastErrorHash).toBeUndefined();
    expect(next.lastErrorSource).toBeUndefined();
    expect(next.lastGfiDecayAt).toBe(FIXED_NOW);
  });

  it('never mutates input state', () => {
    const state = makeState({ currentGfi: 50, gfiBySource: { tool_failure: 30 }, consecutiveErrors: 2 });
    const originalCurrentGfi = state.currentGfi;
    const originalConsecutiveErrors = state.consecutiveErrors;
    applyRelief(state, { source: 'tool_failure', amount: 10 }, FIXED_NOW, DEFAULT_GFI_POLICY);

    expect(state.currentGfi).toBe(originalCurrentGfi);
    expect(state.consecutiveErrors).toBe(originalConsecutiveErrors);
  });
});

describe('classifyGfiStage', () => {
  it('stable: GFI < elevated threshold', () => {
    expect(classifyGfiStage(0, DEFAULT_GFI_POLICY)).toBe('stable');
    expect(classifyGfiStage(29, DEFAULT_GFI_POLICY)).toBe('stable');
    expect(classifyGfiStage(39, DEFAULT_GFI_POLICY)).toBe('stable');
  });

  it('elevated: GFI >= elevated, < critical', () => {
    expect(classifyGfiStage(40, DEFAULT_GFI_POLICY)).toBe('elevated');
    expect(classifyGfiStage(59, DEFAULT_GFI_POLICY)).toBe('elevated');
    expect(classifyGfiStage(69, DEFAULT_GFI_POLICY)).toBe('elevated');
  });

  it('critical: GFI >= critical, < saturated', () => {
    expect(classifyGfiStage(70, DEFAULT_GFI_POLICY)).toBe('critical');
    expect(classifyGfiStage(89, DEFAULT_GFI_POLICY)).toBe('critical');
    expect(classifyGfiStage(99, DEFAULT_GFI_POLICY)).toBe('critical');
  });

  it('saturated: GFI >= saturated threshold', () => {
    expect(classifyGfiStage(100, DEFAULT_GFI_POLICY)).toBe('saturated');
    expect(classifyGfiStage(150, DEFAULT_GFI_POLICY)).toBe('saturated');
  });
});

describe('createGfiSnapshot', () => {
  it('includes stage, dominant source, policy, consumers', () => {
    const state: GfiState = {
      currentGfi: 75,
      gfiBySource: { tool_failure: 50, dispatch_error: 25 },
      consecutiveErrors: 3,
      lastErrorHash: 'abc123',
      lastErrorSource: 'tool_failure',
      lastGfiDecayAt: Date.now() - 60000,
      dailyGfiPeak: 80,
    };
    const snapshot = createGfiSnapshot(state, DEFAULT_GFI_POLICY);

    expect(snapshot.currentGfi).toBe(75);
    expect(snapshot.stage).toBe('critical');
    expect(snapshot.dominantSource).toBe('tool_failure');
    expect(snapshot.consecutiveErrors).toBe(3);
    expect(snapshot.lastErrorSource).toBe('tool_failure');
    expect(snapshot.dailyGfiPeak).toBe(80);
    expect(snapshot.sources).toEqual({ tool_failure: 50, dispatch_error: 25 });

    // Policy thresholds
    expect(snapshot.policy.elevatedThreshold).toBe(40);
    expect(snapshot.policy.criticalThreshold).toBe(70);
    expect(snapshot.policy.saturatedThreshold).toBe(100);
    expect(snapshot.policy.repeatedFailureMultiplierMax).toBe(3.0);

    // Consumers: attitude + pain diagnostic
    expect(snapshot.consumers.attitudeMode).toBe('humble_recovery'); // GFI 75 >= 70
    expect(snapshot.consumers.painDiagnosticReason).toBe('high_gfi'); // GFI 75 >= elevated (40)
  });

  it('attitudeMode conciliatory when GFI 40-69', () => {
    const state = makeState({ currentGfi: 55, gfiBySource: { tool_failure: 55 } });
    const snapshot = createGfiSnapshot(state, DEFAULT_GFI_POLICY);

    expect(snapshot.consumers.attitudeMode).toBe('conciliatory');
    expect(snapshot.consumers.painDiagnosticReason).toBe('high_gfi');
  });

  it('attitudeMode efficient when GFI < 40', () => {
    const state = makeState({ currentGfi: 30, gfiBySource: { tool_failure: 30 } });
    const snapshot = createGfiSnapshot(state, DEFAULT_GFI_POLICY);

    expect(snapshot.consumers.attitudeMode).toBe('efficient');
    expect(snapshot.consumers.painDiagnosticReason).toBe('none'); // GFI < elevated
  });

  it('dominantSource null when gfiBySource empty', () => {
    const state = makeState({ currentGfi: 0, gfiBySource: {} });
    const snapshot = createGfiSnapshot(state, DEFAULT_GFI_POLICY);

    expect(snapshot.dominantSource).toBeNull();
  });
});

describe('DEFAULT_GFI_POLICY', () => {
  it('has expected stage thresholds', () => {
    expect(DEFAULT_GFI_POLICY.stageThresholds).toEqual({
      elevated: 40,
      critical: 70,
      saturated: 100,
    });
  });

  it('has expected repeated failure multiplier', () => {
    expect(DEFAULT_GFI_POLICY.repeatedFailureMultiplier).toEqual({
      base: 1.5,
      max: 3.0,
    });
  });

  it('has expected decay rates per minute', () => {
    expect(DEFAULT_GFI_POLICY.decayRatesPerMinute).toEqual({
      stable: 0.5,
      elevated: 1.0,
      critical: 2.0,
      saturated: 4.0,
    });
  });

  it('has expected relief settings', () => {
    expect(DEFAULT_GFI_POLICY.relief).toEqual({
      toolSuccessRatio: 0.25,
      minPruneBelow: 8,
    });
  });

  it('all stageThresholds values are numbers', () => {
    const { elevated, critical, saturated } = DEFAULT_GFI_POLICY.stageThresholds;
    expect(typeof elevated).toBe('number');
    expect(typeof critical).toBe('number');
    expect(typeof saturated).toBe('number');
  });
});