/**
 * Principle Training State Store
 * ================================================================
 *
 * Independent persistence layer for principle internalization tracking.
 * Clearly separates the four truth states defined in the architecture:
 *   1. sample_generated       — reflection pair produced and passed arbiter
 *   2. sample_included_in_train_run — training run consumed the sample
 *   3. checkpoint_deployed    — adapter/checkpoint is routable in OpenClaw
 *   4. behavior_internalized — deployed worker improves on holdout eval
 *
 * DESIGN CONSTRAINTS (Phase 1):
 * - No runtime target selection (Task 1.2 scope)
 * - No training logic (Phase 2+ scope)
 * - No evolution-reducer modifications
 *
 * FILE: {stateDir}/principle_training_state.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { withLock, withLockAsync } from '../utils/file-lock.js';
import type { PrincipleEvaluatorLevel } from './evolution-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File name for principle training state persistence */
export const PRINCIPLE_TRAINING_FILE = 'principle_training_state.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// PrincipleEvaluatorLevel is imported from evolution-types.ts to ensure a single canonical definition.
// Do not re-define here — use the import instead.

/**
 * Internalization status — tracks progress through the four truth states:
 *   sample_generated → sample_included_in_train_run → checkpoint_deployed → behavior_internalized
 */
export type InternalizationStatus =
  | 'prompt_only'        // Principle has no machine-checkable detector; stays in prompts only
  | 'needs_training'     // Evaluable but not yet included in any training run
  | 'in_training'        // Currently being used in an active training run
  | 'deployed_pending_eval'  // Checkpoint deployed, awaiting holdout evaluation
  | 'internalized'       // Passed holdout eval — behavior is learned
  | 'regressed';         // Previously internalized but recent eval shows degradation

/**
 * Per-principle training state record.
 * Tracks the full lineage from sample generation through deployment.
 */
export interface PrincipleTrainingState {
  /** Principle identifier (e.g., "T-01", "P_write_before_delete") */
  principleId: string;

  /** Evaluability classification — controls whether automatic targeting is allowed */
  evaluability: PrincipleEvaluatorLevel;

  /** Number of applicable decision-point opportunities observed */
  applicableOpportunityCount: number;

  /** Number of violations of this principle observed */
  observedViolationCount: number;

  /** Observed compliance rate (0.0 – 1.0) */
  complianceRate: number;

  /** Trend direction for violations (+1 = improving, 0 = stable, -1 = worsening) */
  violationTrend: number;

  /** Number of reflection samples generated for this principle */
  generatedSampleCount: number;

  /** Number of generated samples approved by arbiter */
  approvedSampleCount: number;

  /** Training run IDs that included samples from this principle */
  includedTrainRunIds: string[];

  /** Deployed checkpoint IDs for this principle */
  deployedCheckpointIds: string[];

  /** Last holdout evaluation score (0.0 – 1.0), if available */
  lastEvalScore?: number;

  /** Current internalization status */
  internalizationStatus: InternalizationStatus;
}

/**
 * The full principle training store — a map of principleId -> state.
 * Stored as a single JSON object in principle_training_state.json.
 */
export type PrincipleTrainingStore = Record<string, PrincipleTrainingState>;

// ---------------------------------------------------------------------------
// Valid Status Values (for validation)
// ---------------------------------------------------------------------------

const VALID_EVALUABILITIES: PrincipleEvaluatorLevel[] = ['deterministic', 'weak_heuristic', 'manual_only'];
const VALID_INTERNALIZATION_STATUSES: InternalizationStatus[] = [
  'prompt_only',
  'needs_training',
  'in_training',
  'deployed_pending_eval',
  'internalized',
  'regressed',
];

// ---------------------------------------------------------------------------
// Schema Version
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a default principle training state for a newly tracked principle.
 * Safe defaults: evaluability='manual_only' (requires explicit upgrade to auto-training),
 * internalizationStatus='prompt_only' (starts as prompt-only, not eligible for
 * automatic training until upgraded).
 */
export function createDefaultPrincipleState(principleId: string): PrincipleTrainingState {
  return {
    principleId,
    evaluability: 'manual_only', // Safe default: requires explicit upgrade
    applicableOpportunityCount: 0,
    observedViolationCount: 0,
    complianceRate: 0,
    violationTrend: 0,
    generatedSampleCount: 0,
    approvedSampleCount: 0,
    includedTrainRunIds: [],
    deployedCheckpointIds: [],
    internalizationStatus: 'prompt_only', // Safe default: starts as prompt-only
  };
}

// ---------------------------------------------------------------------------
// File Operations
// ---------------------------------------------------------------------------

function getFilePath(stateDir: string): string {
  return path.join(stateDir, PRINCIPLE_TRAINING_FILE);
}

/**
 * Applies migration-safe defaults to a raw parsed store.
 * Handles:
 * - Missing top-level entries (principles added since last load)
 * - Missing fields on existing entries (schema evolution)
 * - Invalid enum values (falls back to safe defaults)
 * - NaN / out-of-range numeric values (clamped or defaulted)
 */
function applyMigrationDefaults(raw: unknown): PrincipleTrainingStore {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const store = raw as Record<string, unknown>;
  const result: PrincipleTrainingStore = {};

  for (const [principleId, state] of Object.entries(store)) {
    if (!state || typeof state !== 'object') {
      // Corrupted entry — skip
      continue;
    }

    const s = state as Record<string, unknown>;

    // evaluability — validate enum
    const rawEval = s.evaluability;
    const evaluability: PrincipleEvaluatorLevel = VALID_EVALUABILITIES.includes(rawEval as PrincipleEvaluatorLevel)
      ? (rawEval as PrincipleEvaluatorLevel)
      : 'manual_only';

    // internalizationStatus — validate enum
    const rawStatus = s.internalizationStatus;
    const internalizationStatus: InternalizationStatus = VALID_INTERNALIZATION_STATUSES.includes(rawStatus as InternalizationStatus)
      ? (rawStatus as InternalizationStatus)
      : 'prompt_only';

    // Numeric fields — clamp to valid ranges
    const applicableOpportunityCount = clampInt(s.applicableOpportunityCount, 0, Infinity, 0);
    const observedViolationCount = clampInt(s.observedViolationCount, 0, Infinity, 0);
    const complianceRate = clampFloat(s.complianceRate, 0, 1, 0);
    const violationTrend = clampFloat(s.violationTrend, -1, 1, 0);
    const generatedSampleCount = clampInt(s.generatedSampleCount, 0, Infinity, 0);
    const approvedSampleCount = clampInt(s.approvedSampleCount, 0, Infinity, 0);

    // Optional float — only set if in range [0, 1]
    const rawLastEval = s.lastEvalScore;
    let lastEvalScore: number | undefined;
    if (rawLastEval != null && typeof rawLastEval === 'number') {
      const clamped = Math.max(0, Math.min(1, rawLastEval));
      if (Number.isFinite(clamped)) {
        lastEvalScore = clamped;
      }
    }

    // Arrays — ensure always arrays
    const includedTrainRunIds = Array.isArray(s.includedTrainRunIds)
      ? s.includedTrainRunIds.filter((id): id is string => typeof id === 'string')
      : [];
    const deployedCheckpointIds = Array.isArray(s.deployedCheckpointIds)
      ? s.deployedCheckpointIds.filter((id): id is string => typeof id === 'string')
      : [];

    // Skip entries where the stored principleId doesn't match the map key.
    // This indicates a corrupted or tampered entry.
    const storedPrincipleId = s.principleId;
    if (typeof storedPrincipleId !== 'string' || storedPrincipleId !== principleId) {
      continue;
    }

    result[principleId] = {
      principleId,
      evaluability,
      applicableOpportunityCount,
      observedViolationCount,
      complianceRate,
      violationTrend,
      generatedSampleCount,
      approvedSampleCount,
      includedTrainRunIds,
      deployedCheckpointIds,
      lastEvalScore,
      internalizationStatus,
    };
  }

  return result;
}

/** Clamp an unknown value to a float range, returning default if invalid */
function clampFloat(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** Clamp an unknown value to an integer range, returning default if invalid */
function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.max(min, Math.min(max, rounded));
}

// ---------------------------------------------------------------------------
// Synchronous Read/Write
// ---------------------------------------------------------------------------

/**
 * Loads the full principle training store from disk.
 * Returns an empty store if the file does not exist or is corrupted.
 */
export function loadStore(stateDir: string): PrincipleTrainingStore {
  const filePath = getFilePath(stateDir);

  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return applyMigrationDefaults(parsed);
  } catch (err) {
    // Corrupted file — fail-safe, return empty store
    console.warn(`[principle-training-state] Failed to load store from "${filePath}": ${err instanceof Error ? err.message : String(err)}. Returning empty store.`);
    return {};
  }
}

/**
 * Synchronously saves the full principle training store to disk.
 * Uses file locking to prevent concurrent write corruption.
 */
export function saveStore(stateDir: string, store: PrincipleTrainingStore): void {
  const filePath = getFilePath(stateDir);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  withLock(filePath, () => {
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
  });
}

// ---------------------------------------------------------------------------
// Async Read/Write (for use in async contexts)
// ---------------------------------------------------------------------------

/**
 * Asynchronously loads the full principle training store from disk.
 * Returns an empty store if the file does not exist or is corrupted.
 */
export async function loadStoreAsync(stateDir: string): Promise<PrincipleTrainingStore> {
  const filePath = getFilePath(stateDir);

  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return applyMigrationDefaults(parsed);
  } catch (err) {
    console.warn(`[principle-training-state] Failed to load store asynchronously from "${filePath}": ${err instanceof Error ? err.message : String(err)}. Returning empty store.`);
    return {};
  }
}

/**
 * Asynchronously saves the full principle training store to disk.
 * Uses file locking to prevent concurrent write corruption.
 */
export async function saveStoreAsync(stateDir: string, store: PrincipleTrainingStore): Promise<void> {
  const filePath = getFilePath(stateDir);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  await withLockAsync(filePath, async () => {
    await fs.promises.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  });
}

// ---------------------------------------------------------------------------
// Single-Principle Accessors
// ---------------------------------------------------------------------------

/**
 * Gets the training state for a single principle.
 * Returns a default state if the principle is not yet tracked.
 */
export function getPrincipleState(
  stateDir: string,
  principleId: string
): PrincipleTrainingState {
  const store = loadStore(stateDir);
  return store[principleId] ?? createDefaultPrincipleState(principleId);
}

/**
 * Updates or inserts the training state for a single principle.
 * Persists the full store after the update.
 *
 * Uses file locking around the entire read-modify-write sequence to prevent
 * concurrent updates from causing lost writes.
 */
export function setPrincipleState(
  stateDir: string,
  state: PrincipleTrainingState
): void {
  const filePath = getFilePath(stateDir);
  withLock(filePath, () => {
    // Read current store while holding the lock
    const store = loadStoreUnlocked(filePath);
    store[state.principleId] = state;
    // Write directly — no nested lock needed (we hold the outer lock)
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
  });
}

/**
 * Internal: loads store from a specific file path without acquiring a lock.
 * Caller must hold the lock. Use only inside locked sections.
 */
function loadStoreUnlocked(filePath: string): PrincipleTrainingStore {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return applyMigrationDefaults(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Removes a principle from the training store.
 * Does nothing if the principle is not tracked.
 *
 * Uses file locking around the entire read-modify-write sequence.
 */
export function removePrincipleState(stateDir: string, principleId: string): void {
  const filePath = getFilePath(stateDir);
  withLock(filePath, () => {
    const store = loadStoreUnlocked(filePath);
    if (Object.prototype.hasOwnProperty.call(store, principleId)) {
      delete store[principleId];
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
    }
  });
}

/**
 * Returns all principles currently tracked in the store.
 */
export function listPrincipleIds(stateDir: string): string[] {
  return Object.keys(loadStore(stateDir));
}

/**
 * Returns all principles matching a given internalization status.
 */
export function listPrinciplesByStatus(
  stateDir: string,
  status: InternalizationStatus
): PrincipleTrainingState[] {
  const store = loadStore(stateDir);
  return Object.values(store).filter((s) => s.internalizationStatus === status);
}

/**
 * Returns all principles with 'deterministic' or 'weak_heuristic' evaluability
 * that are eligible for automatic nocturnal targeting.
 */
export function listEvaluablePrinciples(stateDir: string): PrincipleTrainingState[] {
  const store = loadStore(stateDir);
  return Object.values(store).filter(
    (s) => s.evaluability !== 'manual_only' && s.internalizationStatus !== 'prompt_only'
  );
}
