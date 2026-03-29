import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  loadThresholdState,
  updateThresholdState,
  resetThresholdState,
  getEffectiveThresholds,
  getDetailedThresholdState,
  DEFAULT_THRESHOLDS,
  MAX_ADJUSTMENT_PER_STEP,
  THRESHOLD_STATE_FILE,
} from '../../src/core/adaptive-thresholds.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createTempStateDir(): string {
  const tmpDir = path.join(__dirname, '..', '..', '.tmp', `threshold-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function cleanupStateDir(stateDir: string): void {
  if (fs.existsSync(stateDir)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests: loadThresholdState
// ---------------------------------------------------------------------------

describe('loadThresholdState', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    cleanupStateDir(stateDir);
  });

  it('returns default thresholds when no state file exists', () => {
    const result = loadThresholdState(stateDir);
    expect(result.success).toBe(true);
    expect(result.usedDefaults).toBe(true);
    expect(result.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it('loads persisted thresholds', () => {
    // Step constraint limits adjustment to MAX_ADJUSTMENT_PER_STEP per call
    // schemaCompletenessMin: 0.6 + 0.05 = 0.65 (one step)
    updateThresholdState(stateDir, 'schemaCompletenessMin', 0.65, 'test adjustment');

    // Then load it back
    const result = loadThresholdState(stateDir);
    expect(result.success).toBe(true);
    expect(result.usedDefaults).toBe(false);
    expect(result.thresholds.schemaCompletenessMin).toBe(0.65);
  });

  it('clamps values to bounds', () => {
    // Try to set above maximum
    updateThresholdState(stateDir, 'principleAlignmentMin', 1.5, 'test');
    const result = loadThresholdState(stateDir);
    expect(result.thresholds.principleAlignmentMin).toBeLessThanOrEqual(1.0);
  });

  it('returns defaults on corrupted state', () => {
    // Write corrupted JSON
    const statePath = path.join(stateDir, THRESHOLD_STATE_FILE);
    fs.writeFileSync(statePath, 'not valid json{', 'utf-8');

    const result = loadThresholdState(stateDir);
    expect(result.success).toBe(true);
    expect(result.usedDefaults).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: updateThresholdState
// ---------------------------------------------------------------------------

describe('updateThresholdState', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    cleanupStateDir(stateDir);
  });

  it('updates a threshold value', () => {
    // Step constraint limits adjustment per call
    // schemaCompletenessMin: 0.6 + 0.05 (max step) = 0.65
    const result = updateThresholdState(stateDir, 'schemaCompletenessMin', 0.65, 'test adjustment');
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.oldValue).toBe(DEFAULT_THRESHOLDS.schemaCompletenessMin);
    expect(result.newValue).toBe(0.65);
    expect(result.reason).toBe('test adjustment');
  });

  it('enforces max adjustment per step', () => {
    const largeDelta = DEFAULT_THRESHOLDS.schemaCompletenessMin + MAX_ADJUSTMENT_PER_STEP + 0.1;
    const result = updateThresholdState(stateDir, 'schemaCompletenessMin', largeDelta, 'large step');
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    // Should only move by MAX_ADJUSTMENT_PER_STEP
    expect(result.newValue).toBe(DEFAULT_THRESHOLDS.schemaCompletenessMin + MAX_ADJUSTMENT_PER_STEP);
  });

  it('ignores changes smaller than minimum', () => {
    const smallChange = DEFAULT_THRESHOLDS.schemaCompletenessMin + 0.001;
    const result = updateThresholdState(stateDir, 'schemaCompletenessMin', smallChange, 'tiny step');
    expect(result.success).toBe(true);
    expect(result.changed).toBe(false);
  });

  it('rejects unknown threshold names', () => {
    const result = updateThresholdState(stateDir, 'unknownThreshold' as any, 0.5, 'test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown threshold');
  });

  it('persists changes to disk', () => {
    // Step constraint limits adjustment to MAX_ADJUSTMENT_PER_STEP per call
    // executabilityMin: 0.65 + 0.05 (max step) = 0.70
    updateThresholdState(stateDir, 'executabilityMin', 0.70, 'persistence test');
    const loaded = loadThresholdState(stateDir);
    expect(loaded.thresholds.executabilityMin).toBe(0.70);
  });
});

// ---------------------------------------------------------------------------
// Tests: resetThresholdState
// ---------------------------------------------------------------------------

describe('resetThresholdState', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    cleanupStateDir(stateDir);
  });

  it('resets all thresholds to defaults', () => {
    // Change some values
    updateThresholdState(stateDir, 'schemaCompletenessMin', 0.9, 'change 1');
    updateThresholdState(stateDir, 'principleAlignmentMin', 0.95, 'change 2');

    // Reset
    resetThresholdState(stateDir);

    // Verify defaults
    const result = loadThresholdState(stateDir);
    expect(result.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

// ---------------------------------------------------------------------------
// Tests: getEffectiveThresholds
// ---------------------------------------------------------------------------

describe('getEffectiveThresholds', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    cleanupStateDir(stateDir);
  });

  it('returns default thresholds when no state file exists', () => {
    const thresholds = getEffectiveThresholds(stateDir);
    expect(thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it('returns persisted thresholds', () => {
    // Note: step constraint limits adjustment per call
    // Set to a value within one step: default (0.5) + MAX_ADJUSTMENT_PER_STEP (0.05) = 0.55
    updateThresholdState(stateDir, 'boundednessMin', 0.55, 'test');
    const thresholds = getEffectiveThresholds(stateDir);
    expect(thresholds.boundednessMin).toBe(0.55);
  });
});

// ---------------------------------------------------------------------------
// Tests: getDetailedThresholdState
// ---------------------------------------------------------------------------

describe('getDetailedThresholdState', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    cleanupStateDir(stateDir);
  });

  it('returns null when no state file exists', () => {
    const state = getDetailedThresholdState(stateDir);
    expect(state).toBeNull();
  });

  it('returns detailed state with metadata', () => {
    updateThresholdState(stateDir, 'confidenceMin', 0.75, 'test adjustment');
    const state = getDetailedThresholdState(stateDir);
    expect(state).not.toBeNull();
    expect(state!.thresholds.confidenceMin).toBeDefined();
    expect(state!.thresholds.confidenceMin!.lastUpdatedAt).toBeDefined();
    expect(state!.thresholds.confidenceMin!.adjustmentCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Default values integrity
// ---------------------------------------------------------------------------

describe('DEFAULT_THRESHOLDS', () => {
  it('has values in valid range (0-1)', () => {
    for (const value of Object.values(DEFAULT_THRESHOLDS)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('has aggregateMin higher than minimum possible weighted aggregate', () => {
    // aggregateMin (0.65) should be higher than the minimum possible
    // aggregate score given all thresholds at minimum values.
    // This ensures aggregateMin provides an additional quality gate.
    const weights = {
      schemaCompletenessMin: 0.15,
      principleAlignmentMin: 0.30,
      executabilityMin: 0.20,
      boundednessMin: 0.20,
      confidenceMin: 0.15,
    };
    const minPossibleAggregate =
      DEFAULT_THRESHOLDS.schemaCompletenessMin * weights.schemaCompletenessMin +
      DEFAULT_THRESHOLDS.principleAlignmentMin * weights.principleAlignmentMin +
      DEFAULT_THRESHOLDS.executabilityMin * weights.executabilityMin +
      DEFAULT_THRESHOLDS.boundednessMin * weights.boundednessMin +
      DEFAULT_THRESHOLDS.confidenceMin * weights.confidenceMin;
    
    // aggregateMin should be at or above the minimum possible aggregate
    expect(DEFAULT_THRESHOLDS.aggregateMin).toBeGreaterThanOrEqual(minPossibleAggregate);
  });
});
