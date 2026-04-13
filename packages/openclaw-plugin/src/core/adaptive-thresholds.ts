/**
 * Adaptive Thresholds — Bounded Threshold State Management
 * ========================================================
 *
 * PURPOSE: Manage adaptive thresholds for Trinity candidate scoring with
 * bounded, observable, and reproducible threshold changes.
 *
 * DESIGN CONSTRAINTS:
 * - Thresholds only move within bounded ranges (min/max)
 * - Changes depend on explicit observable signals only
 * - No hidden learning loops
 * - Threshold state is persisted and can be rolled back
 * - Corruption or missing state falls back to safe defaults
 *
 * OBSERVABLE SIGNALS:
 * - recent malformed rate (arbiter/executability failures)
 * - recent arbiter reject rate
 * - recent executability reject rate
 * - reviewed subset quality delta
 *
 * PHASE 6 ONLY — No real training, no automatic deployment
 */

import * as fs from 'fs';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File name for threshold state */
export const THRESHOLD_STATE_FILE = 'nocturnal-threshold-state.json';

/** Default threshold values */
export const DEFAULT_THRESHOLDS = {
  /** Minimum score to pass arbiter validation */
  schemaCompletenessMin: 0.6,
  /** Minimum principle alignment score */
  principleAlignmentMin: 0.7,
  /** Minimum executability score */
  executabilityMin: 0.65,
  /** Minimum boundedness score */
  boundednessMin: 0.5,
  /** Minimum confidence/consistency score */
  confidenceMin: 0.6,
  /** Minimum aggregate score to be tournament-eligible */
  aggregateMin: 0.65,
} as const;

/** Minimum threshold value (safety bound) */
export const THRESHOLD_MIN = 0.0;

/** Maximum threshold value (safety bound) */
export const THRESHOLD_MAX = 1.0;

/** Maximum adjustment per update (bounded step size) */
export const MAX_ADJUSTMENT_PER_STEP = 0.05;

/** Minimum adjustment to trigger a change */
export const MIN_ADJUSTMENT_TO_RECORD = 0.01;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * All threshold names that can be adaptively adjusted.
 */
export type ThresholdName = keyof typeof DEFAULT_THRESHOLDS;

/**
 * Current threshold values.
 */
export interface ThresholdValues {
  schemaCompletenessMin: number;
  principleAlignmentMin: number;
  executabilityMin: number;
  boundednessMin: number;
  confidenceMin: number;
  aggregateMin: number;
}

/**
 * Threshold state for one threshold.
 */
export interface ThresholdState {
  /** Current value */
  currentValue: number;
  /** Minimum bound */
  minValue: number;
  /** Maximum bound */
  maxValue: number;
  /** Last updated timestamp (ISO string) */
  lastUpdatedAt: string;
  /** Reason for last adjustment */
  adjustmentReason?: string;
  /** Number of adjustments made */
  adjustmentCount: number;
}

/**
 * Complete threshold state persisted to disk.
 */
export interface ThresholdPersistenceState {
  /** Individual threshold states */
  thresholds: Record<ThresholdName, ThresholdState>;
  /** When the state was last updated (any threshold) */
  lastUpdatedAt: string;
  /** Version for migration support */
  version: number;
}

/**
 * Observable signals used to adjust thresholds.
 */
export interface ThresholdSignals {
  /** Rate of malformed outputs (0-1) */
  malformedRate: number;
  /** Rate of arbiter rejections (0-1) */
  arbiterRejectRate: number;
  /** Rate of executability rejections (0-1) */
  executabilityRejectRate: number;
  /** Quality delta from reviewed subset comparison (positive = improvement) */
  qualityDelta: number;
}

/**
 * Result of loading threshold state.
 */
export interface LoadThresholdResult {
  /** Whether loading succeeded */
  success: boolean;
  /** Current threshold values */
  thresholds: ThresholdValues;
  /** Whether fallback to defaults was used */
  usedDefaults: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of updating a threshold.
 */
export interface UpdateThresholdResult {
  /** Whether update succeeded */
  success: boolean;
  /** The updated threshold values */
  thresholds: ThresholdValues;
  /** Whether a change actually occurred */
  changed: boolean;
  /** The name of the changed threshold */
  changedThreshold?: ThresholdName;
  /** The old value */
  oldValue?: number;
  /** The new value */
  newValue?: number;
  /** Reason for the change */
  reason?: string;
  /** Error message if failed */
  error?: string;
}

// ---------------------------------------------------------------------------
// State Persistence
// ---------------------------------------------------------------------------

/**
 * Get the threshold state file path.
 */
function getStatePath(stateDir: string): string {
  return path.join(stateDir, THRESHOLD_STATE_FILE);
}

/**
 * Create default threshold persistence state.
 */
function createDefaultState(): ThresholdPersistenceState {
  const now = new Date().toISOString();
  const thresholds: Record<ThresholdName, ThresholdState> = {} as Record<ThresholdName, ThresholdState>;

  for (const [name, defaultValue] of Object.entries(DEFAULT_THRESHOLDS)) {
    thresholds[name as ThresholdName] = {
      currentValue: defaultValue,
      minValue: THRESHOLD_MIN,
      maxValue: THRESHOLD_MAX,
      lastUpdatedAt: now,
      adjustmentCount: 0,
    };
  }

  return {
    thresholds,
    lastUpdatedAt: now,
    version: 1,
  };
}

/**
 * Read threshold state from disk (with locking).
 */
function readState(stateDir: string): ThresholdPersistenceState | null {
  const statePath = getStatePath(stateDir);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(content) as ThresholdPersistenceState;
    return parsed;
  } catch {
    // Corrupted — return null to trigger default fallback
    return null;
  }
}

/**
 * Write threshold state to disk (with locking).
 */
function writeState(stateDir: string, state: ThresholdPersistenceState): void {
  const statePath = getStatePath(stateDir);
  const stateDirPath = path.dirname(statePath);

  if (!fs.existsSync(stateDirPath)) {
    fs.mkdirSync(stateDirPath, { recursive: true });
  }

  withLock(statePath, () => {
    const tmpPath = `${statePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, statePath);
  });
}

// ---------------------------------------------------------------------------
// Core Threshold Operations
// ---------------------------------------------------------------------------

/**
 * Load threshold values with fallback to defaults on corruption.
 *
 * @param stateDir - State directory
 * @returns LoadThresholdResult with current values and status
 */
export function loadThresholdState(stateDir: string): LoadThresholdResult {
  const rawState = readState(stateDir);

  if (!rawState) {
    return {
      success: true,
      thresholds: { ...DEFAULT_THRESHOLDS } as ThresholdValues,
      usedDefaults: true,
    };
  }

  // Validate and reconstruct threshold values
  const thresholds: Record<ThresholdName, number> = { ...DEFAULT_THRESHOLDS } as Record<ThresholdName, number>;
  let usedDefaults = false;

  for (const [name, defaultValue] of Object.entries(DEFAULT_THRESHOLDS)) {
    const key = name as ThresholdName;
    const state = rawState.thresholds[key];
    if (state && typeof state.currentValue === 'number') {
      // Clamp to bounds (defensive)
      thresholds[key] = Math.max(
        state.minValue,
        Math.min(state.maxValue, state.currentValue)
      );
    } else {
      thresholds[key] = defaultValue;
      usedDefaults = true;
    }
  }

  return {
    success: true,
    thresholds: thresholds as ThresholdValues,
    usedDefaults,
  };
}

/**
 * Get effective threshold values (alias for loadThresholdState).
 *
 * @param stateDir - State directory
 * @returns Current threshold values
 */
export function getEffectiveThresholds(stateDir: string): ThresholdValues {
  const result = loadThresholdState(stateDir);
  return result.thresholds;
}

/**
 * Update a single threshold with bounded step size.
 *
 * @param stateDir - State directory
 * @param thresholdName - Name of threshold to update
 * @param newValue - New value (will be clamped to bounds)
 * @param reason - Reason for the adjustment (required for tracking)
 * @returns UpdateThresholdResult
 */
 
export function updateThresholdState(
  stateDir: string,
  thresholdName: ThresholdName,
  newValue: number,
  reason: string
): UpdateThresholdResult {
  // Read current state
  let rawState = readState(stateDir);
  if (!rawState) {
    rawState = createDefaultState();
  }

  const currentState = rawState.thresholds[thresholdName];
  if (!currentState) {
    return {
      success: false,
      thresholds: { ...DEFAULT_THRESHOLDS } as ThresholdValues,
      changed: false,
      error: `Unknown threshold: ${thresholdName}`,
    };
  }

  // Calculate bounded new value
  const clampedValue = Math.max(
    currentState.minValue,
    Math.min(currentState.maxValue, newValue)
  );

  // Check if change is meaningful
  const delta = Math.abs(clampedValue - currentState.currentValue);
  if (delta < MIN_ADJUSTMENT_TO_RECORD) {
    return {
      success: true,
      thresholds: getEffectiveThresholds(stateDir),
      changed: false,
    };
  }

  // Enforce maximum step size for bounded, safe threshold adjustments
  let finalValue = clampedValue;
  if (delta > MAX_ADJUSTMENT_PER_STEP) {
    const direction = clampedValue > currentState.currentValue ? 1 : -1;
    finalValue = currentState.currentValue + direction * MAX_ADJUSTMENT_PER_STEP;
  }

  // Update state
  const now = new Date().toISOString();
  rawState.thresholds[thresholdName] = {
    ...currentState,
    currentValue: finalValue,
    lastUpdatedAt: now,
    adjustmentReason: reason,
    adjustmentCount: currentState.adjustmentCount + 1,
  };
  rawState.lastUpdatedAt = now;

  writeState(stateDir, rawState);

  return {
    success: true,
    thresholds: getEffectiveThresholds(stateDir),
    changed: true,
    changedThreshold: thresholdName,
    oldValue: currentState.currentValue,
    newValue: finalValue,
    reason,
  };
}

/**
 * Reset all thresholds to defaults.
 *
 * @param stateDir - State directory
 */
export function resetThresholdState(stateDir: string): void {
  const defaultState = createDefaultState();
  writeState(stateDir, defaultState);
}

/**
 * Get detailed threshold state for debugging/inspection.
 *
 * @param stateDir - State directory
 * @returns Detailed threshold state or null if corrupted
 */
export function getDetailedThresholdState(
  stateDir: string
): ThresholdPersistenceState | null {
  return readState(stateDir);
}

// ---------------------------------------------------------------------------
// Signal-Based Threshold Adjustment
// ---------------------------------------------------------------------------

/**
 * Adjust thresholds based on observable signals.
 *
 * This is a simple proportional controller that adjusts thresholds
 * based on observed rejection rates. The adjustment is bounded
 * and requires a minimum signal magnitude to trigger.
 *
 * @param stateDir - State directory
 * @param signals - Observable signals
 * @returns UpdateThresholdResult describing the most significant change
 */
    // eslint-disable-next-line complexity -- complexity 15, refactor candidate
export function adjustThresholdsFromSignals(
  stateDir: string,
  signals: ThresholdSignals
): UpdateThresholdResult {
  const currentThresholds = getEffectiveThresholds(stateDir);
  let bestResult: UpdateThresholdResult = {
    success: true,
    thresholds: currentThresholds,
    changed: false,
  };

  // High malformed rate → tighten schema completeness threshold
  if (signals.malformedRate > 0.3) {
    const adjustment = signals.malformedRate * 0.1;
    const newValue = currentThresholds.schemaCompletenessMin + adjustment;
    const result = updateThresholdState(
      stateDir,
      'schemaCompletenessMin',
      newValue,
      `High malformed rate (${signals.malformedRate.toFixed(2)}) → tightening schema threshold`
    );
    if (result.changed) bestResult = result;
  }

  // High arbiter reject rate → tighten principle alignment threshold
  if (signals.arbiterRejectRate > 0.25) {
    const adjustment = signals.arbiterRejectRate * 0.08;
    const result = updateThresholdState(
      stateDir,
      'principleAlignmentMin',
      currentThresholds.principleAlignmentMin + adjustment,
      `High arbiter reject rate (${signals.arbiterRejectRate.toFixed(2)}) → tightening alignment threshold`
    );
    if (result.changed && (!bestResult.changed || ((result.newValue! - result.oldValue!) > 0))) { // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: changed flag guarantees newValue/oldValue are defined
      bestResult = result;
    }
  }

  // High executability reject rate → tighten executability threshold
  if (signals.executabilityRejectRate > 0.3) {
    const adjustment = signals.executabilityRejectRate * 0.1;
    const result = updateThresholdState(
      stateDir,
      'executabilityMin',
      currentThresholds.executabilityMin + adjustment,
      `High executability reject rate (${signals.executabilityRejectRate.toFixed(2)}) → tightening executability threshold`
    );
    if (result.changed && (!bestResult.changed || ((result.newValue! - result.oldValue!) > 0))) { // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: changed flag guarantees newValue/oldValue are defined
      bestResult = result;
    }
  }

  // Good quality delta → slightly loosen thresholds (reward good performance)
  if (signals.qualityDelta > 0.1) {
    const reward = Math.min(signals.qualityDelta * 0.05, MAX_ADJUSTMENT_PER_STEP);
    const result = updateThresholdState(
      stateDir,
      'aggregateMin',
      Math.max(currentThresholds.aggregateMin - reward, THRESHOLD_MIN),
      `Positive quality delta (${signals.qualityDelta.toFixed(2)}) → rewarding with slightly lower aggregate threshold`
    );
    if (result.changed && (!bestResult.changed || ((result.oldValue! - result.newValue!) > 0))) { // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: changed flag guarantees newValue/oldValue are defined
      bestResult = result;
    }
  }

  return bestResult;
}
