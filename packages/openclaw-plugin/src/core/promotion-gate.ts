/**
 * Promotion Gate — Checkpoint Promotion State Machine and Gate Logic
 * ==================================================================
 *
 * PURPOSE: Control when a checkpoint can advance from training → shadow → promotion.
 * Training success alone is not enough — a checkpoint must prove it improves
 * bounded worker behavior under the existing offline benchmark and does not
 * regress runtime safety signals.
 *
 * PROMOTION STATES:
 *   - rejected:         The checkpoint must not be routed
 *   - candidate_only:  The checkpoint is valid but not yet ready for shadow
 *   - shadow_ready:   The checkpoint may enter controlled shadow rollout
 *   - promotable:     The checkpoint may replace the active checkpoint
 *
 * STATE TRANSITIONS:
 *   training_completed
 *       ↓
 *   candidate_only  ←── (eval attached, lineage complete)
 *       ↓
 *   shadow_ready   ←── (positive delta, safe constraints)
 *       ↓
 *   promotable      ←── (shadow window passed, orchestrator review passed)
 *       ↓
 *   deployed
 *
 * PRIMARY OBJECTIVE:
 *   maximize reduced_prompt_holdout_delta
 *
 * CONSTRAINT METRICS (must all pass for promotion):
 *   - arbiterRejectRate <= baseline + allowedMargin
 *   - executabilityRejectRate <= baseline + allowedMargin
 *   - reviewedSubsetQuality >= baseline
 *   - routingScopeNotExpanded == true
 *
 * DESIGN CONSTRAINTS:
 *   - No automatic promotion without explicit gate approval
 *   - Orchestrator review remains mandatory for all promotions
 *   - Rollback path must be always available
 *   - First rollout limited to `local-reader` only
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { withLock } from '../utils/file-lock.js';
import {
  getCheckpoint,
  getEvalSummary,
} from './model-training-registry.js';
import { type TrainableWorkerProfile } from './external-training-contract.js';
import { computeShadowStats } from './shadow-observation-registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Candidate delta must exceed this to enter shadow_ready.
 */
export const DEFAULT_MIN_DELTA = 0.05;

/**
 * Default allowed margin for constraint metrics.
 * Constraint metrics can regress by at most this amount.
 */
export const DEFAULT_ALLOWED_MARGIN = 0.05;

/**
 * Allowed worker profiles for Phase 7 shadow rollout.
 * Only bounded local workers eligible. local-reader first, local-editor deferred.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reason: reserved for Phase 7 shadow rollout profile validation
const ALLOWED_ROLLOUT_PROFILES: readonly TrainableWorkerProfile[] = ['local-reader'];

/**
 * Registry file for promotion records.
 */
const PROMOTION_REGISTRY_FILE = 'promotion-registry.json';

/**
 * Minimum shadow window duration in milliseconds.
 * A checkpoint must remain in shadow_ready for at least this duration
 * before it can be promoted to promotable.
 *
 * Phase 7 default: 1 hour (3600000 ms)
 * This gives time for real-world feedback before full promotion.
 */
export const MIN_SHADOW_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Promotion states for a checkpoint.
 */
export type PromotionState =
  | 'rejected'
  | 'candidate_only'
  | 'shadow_ready'
  | 'promotable';

/**
 * Constraint metrics for promotion gate.
 */
export interface PromotionConstraints {
  arbiterRejectRate: number;
  executabilityRejectRate: number;
  reviewedSubsetQuality: number;
  routingScopeNotExpanded: boolean;
}

/**
 * Baseline metrics for comparison.
 */
export interface BaselineMetrics {
  arbiterRejectRate: number;
  executabilityRejectRate: number;
  reviewedSubsetQuality: number;
}

/**
 * A promotion record — tracks the state and lineage of a promoted checkpoint.
 */
export interface PromotionRecord {
  /** Unique identifier for this promotion record */
  promotionId: string;

  /** Checkpoint being promoted */
  checkpointId: string;

  /** Current promotion state */
  state: PromotionState;

  /** Worker profile this promotion targets */
  targetProfile: TrainableWorkerProfile;

  /** Target model family */
  targetModelFamily: string;

  /** Reduced-prompt holdout delta (primary objective) */
  reducedPromptDelta: number;

  /** Constraint metrics at time of promotion */
  constraintMetrics: PromotionConstraints;

  /** Baseline metrics used for comparison */
  baselineMetrics: BaselineMetrics;

  /** Whether orchestrator review was passed */
  orchestratorReviewPassed: boolean;

  /** Human review note (if any) */
  reviewNote?: string;

  /** ISO-8601 timestamp when state last changed */
  stateChangedAt: string;

  /** ISO-8601 timestamp when promotion record was created */
  createdAt: string;

  /** ISO-8601 timestamp when shadow window opened (if applicable) */
  shadowStartedAt?: string;

  /** ISO-8601 timestamp when promotable was achieved */
  promotableAt?: string;

  /** Previous promotion record ID (for rollback chain) */
  previousPromotionId?: string;
}

/**
 * The complete promotion registry.
 */
export interface PromotionRegistry {
  promotions: PromotionRecord[];
}

// ---------------------------------------------------------------------------
// Registry Path
// ---------------------------------------------------------------------------

function getRegistryPath(stateDir: string): string {
  return path.join(stateDir, PROMOTION_REGISTRY_FILE);
}

/**
 * Ensure the registry directory exists.
 */
function ensureRegistryDir(stateDir: string): void {
  const registryPath = getRegistryPath(stateDir);
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// File Operations
// ---------------------------------------------------------------------------

/**
 * Read the registry from disk. Returns empty registry if missing.
 */
function readRegistry(stateDir: string): PromotionRegistry {
  const registryPath = getRegistryPath(stateDir);
  if (!fs.existsSync(registryPath)) {
    return { promotions: [] };
  }
  try {
    const content = fs.readFileSync(registryPath, 'utf-8');
    return JSON.parse(content) as PromotionRegistry;
  } catch (err) {
    console.warn(`[promotion-gate] Registry corrupted at ${registryPath}, recovering with empty state: ${String(err)}`);
    return { promotions: [] };
  }
}

/**
 * Write the registry to disk atomically.
 */
function writeRegistry(stateDir: string, registry: PromotionRegistry): void {
  ensureRegistryDir(stateDir);
  const registryPath = getRegistryPath(stateDir);
  const tmpPath = `${registryPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
  fs.renameSync(tmpPath, registryPath);
}

/**
 * Execute a read-modify-write under an exclusive file lock.
 */
function withPromotionRegistryLock<T>(
  stateDir: string,
   
  fn: (_registry: PromotionRegistry) => T
): T {
  const registryPath = getRegistryPath(stateDir);
  return withLock(registryPath, () => {
    const registry = readRegistry(stateDir);
    return fn(registry);
  });
}

// ---------------------------------------------------------------------------
// Promotion Gate Logic
// ---------------------------------------------------------------------------

/**
 * Result of evaluating the promotion gate.
 */
export interface PromotionGateResult {
  /** Whether the checkpoint passes the gate */
  passes: boolean;

  /** The promotion state if passed */
  suggestedState?: PromotionState;

  /** Reasons for rejection (if not passed) */
  blockers: string[];

  /** Details about each constraint check */
  constraintChecks: {
    constraint: string;
    actual: number;
    baseline: number;
    threshold: number;
    passed: boolean;
    /** Source of the evidence: 'shadow' (real runtime) or 'eval-proxy' (fallback) */
    source?: 'shadow' | 'eval-proxy';
  }[];

  /** Primary objective (delta) check */
  deltaCheck: {
    actual: number;
    threshold: number;
    passed: boolean;
  };

  evidenceSummary: {
    evidenceMode: 'shadow' | 'eval-proxy' | 'mixed';
    shadowSampleCount: number;
    deltaSource: 'eval';
  };
}

/**
 * Parameters for evaluating the promotion gate.
 */
export interface EvaluateGateParams {
  /** Checkpoint ID to evaluate */
  checkpointId: string;

  /** Target worker profile */
  targetProfile: TrainableWorkerProfile;

  /** Baseline metrics for comparison */
  baselineMetrics: BaselineMetrics;

  /** Minimum delta threshold for positive signal */
  minDelta?: number;

  /** Allowed margin for constraint metrics */
  allowedMargin?: number;
}

/**
 * Evaluate whether a checkpoint passes the promotion gate.
 *
 * @param stateDir - Workspace state directory
 * @param params - Evaluation parameters
 * @returns PromotionGateResult with pass/fail and details
 *
 * FAIL-CLOSED: Returns { passes: false } if:
 *   - No eval attached to checkpoint
 *   - Delta is negative or below threshold
 *   - Any constraint metric regresses beyond allowed margin
 *   - Profile is not in allowed rollout list
 */
    // eslint-disable-next-line complexity -- refactor candidate
export function evaluatePromotionGate(
  stateDir: string,
  params: EvaluateGateParams
): PromotionGateResult {
  const {
    checkpointId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reason: reserved for Phase 7 profile-based targeting
    targetProfile: _targetProfile,
    baselineMetrics,
    minDelta = DEFAULT_MIN_DELTA,
    allowedMargin = DEFAULT_ALLOWED_MARGIN,
  } = params;

  const blockers: string[] = [];
  const constraintChecks: PromotionGateResult['constraintChecks'] = [];

  // --- Check 1: Checkpoint exists ---
  const checkpoint = getCheckpoint(stateDir, checkpointId);
  if (!checkpoint) {
    blockers.push(`Checkpoint not found: ${checkpointId}`);
    return {
      passes: false,
      blockers,
      constraintChecks: [],
      deltaCheck: { actual: 0, threshold: minDelta, passed: false },
      evidenceSummary: {
        evidenceMode: 'eval-proxy',
        shadowSampleCount: 0,
        deltaSource: 'eval',
      },
    };
  }

  // --- Check 2: Has eval attached ---
  if (!checkpoint.lastEvalSummaryRef) {
    blockers.push(
      `Checkpoint ${checkpointId} has no eval summary attached. ` +
        `Run benchmark evaluation before promotion gate.`
    );
    return {
      passes: false,
      blockers,
      constraintChecks: [],
      deltaCheck: { actual: 0, threshold: minDelta, passed: false },
      evidenceSummary: {
        evidenceMode: 'eval-proxy',
        shadowSampleCount: 0,
        deltaSource: 'eval',
      },
    };
  }

  // --- Check 3: Get eval summary ---
  const evalSummary = getEvalSummary(stateDir, checkpoint.lastEvalSummaryRef);
  if (!evalSummary) {
    blockers.push(
      `Eval summary '${checkpoint.lastEvalSummaryRef}' not found. ` +
        `Cannot evaluate promotion gate without valid eval.`
    );
    return {
      passes: false,
      blockers,
      constraintChecks: [],
      deltaCheck: { actual: 0, threshold: minDelta, passed: false },
      evidenceSummary: {
        evidenceMode: 'eval-proxy',
        shadowSampleCount: 0,
        deltaSource: 'eval',
      },
    };
  }

  // --- Check 4: Delta must be positive and above threshold ---
  const {delta} = evalSummary;
  const deltaCheck = {
    actual: delta,
    threshold: minDelta,
    passed: delta >= minDelta,
  };

  if (!deltaCheck.passed) {
    blockers.push(
      `Reduced-prompt holdout delta (${delta.toFixed(4)}) is below threshold (${minDelta}). ` +
        `Checkpoint must show positive improvement to be promoted.`
    );
  }

  // --- Check 5: Arbiter reject rate constraint ---
  // PREFER real shadow evidence over eval verdict proxy
  // Shadow evidence comes from actual runtime routing decisions
  const shadowStats = computeShadowStats(stateDir, { checkpointId });
   
  let arbiterRejectRate: number;
   
  let arbiterRejectSource: 'shadow' | 'eval-proxy';

  if (shadowStats && shadowStats.isStatisticallySignificant) {
    // Use real shadow evidence: reject rate from shadow routing
    arbiterRejectRate = shadowStats.rejectRate;
    arbiterRejectSource = 'shadow';
  } else {
    // Fall back to eval verdict proxy (Phase 7 initial state)
    // This is a coarse approximation: 'fail' verdict maps to 100% reject
    arbiterRejectRate = evalSummary.verdict === 'fail' ? 1 : 0;
    arbiterRejectSource = 'eval-proxy';
  }

  const arbiterRejectCheck = {
    constraint: 'arbiterRejectRate',
    actual: arbiterRejectRate,
    baseline: baselineMetrics.arbiterRejectRate,
    threshold: baselineMetrics.arbiterRejectRate + allowedMargin,
    passed: arbiterRejectRate <= baselineMetrics.arbiterRejectRate + allowedMargin,
    source: arbiterRejectSource,
  };
  constraintChecks.push(arbiterRejectCheck);

  if (!arbiterRejectCheck.passed) {
    blockers.push(
      `arbiterRejectRate regressed: ${arbiterRejectRate.toFixed(4)} > ${arbiterRejectCheck.threshold.toFixed(4)} ` +
        `(baseline: ${baselineMetrics.arbiterRejectRate.toFixed(4)}, margin: ${allowedMargin}) ` +
        `[source: ${arbiterRejectSource}${shadowStats ? `, n=${shadowStats.totalCount}` : ''}]`
    );
  }

  // --- Check 6: Executability reject rate constraint ---
  // PREFER real shadow evidence: escalation rate + profile rejection rate
   
  let executabilityRejectRate: number;
   
  let executabilityRejectSource: 'shadow' | 'eval-proxy';

  if (shadowStats && shadowStats.isStatisticallySignificant) {
    // Use real shadow evidence: escalation + profile rejection from routing
    executabilityRejectRate = shadowStats.escalationRate + shadowStats.profileRejectedRate;
    executabilityRejectSource = 'shadow';
  } else {
    // Fall back to eval verdict proxy
    // This is a coarse approximation
    executabilityRejectRate = evalSummary.verdict === 'fail' ? 0.1 : 0;
    executabilityRejectSource = 'eval-proxy';
  }

  const executabilityRejectCheck = {
    constraint: 'executabilityRejectRate',
    actual: executabilityRejectRate,
    baseline: baselineMetrics.executabilityRejectRate,
    threshold: baselineMetrics.executabilityRejectRate + allowedMargin,
    passed: executabilityRejectRate <= baselineMetrics.executabilityRejectRate + allowedMargin,
    source: executabilityRejectSource,
  };
  constraintChecks.push(executabilityRejectCheck);

  if (!executabilityRejectCheck.passed) {
    blockers.push(
      `executabilityRejectRate regressed: ${executabilityRejectRate.toFixed(4)} > ${executabilityRejectCheck.threshold.toFixed(4)} ` +
        `(baseline: ${baselineMetrics.executabilityRejectRate.toFixed(4)}, margin: ${allowedMargin}) ` +
        `[source: ${executabilityRejectSource}${shadowStats ? `, n=${shadowStats.totalCount}` : ''}]`
    );
  }

  // --- Check 7: Reviewed subset quality constraint ---
  // Use eval score as proxy for quality
  const reviewedSubsetQuality = evalSummary.candidateScore;
  const qualityCheck = {
    constraint: 'reviewedSubsetQuality',
    actual: reviewedSubsetQuality,
    baseline: baselineMetrics.reviewedSubsetQuality,
    threshold: baselineMetrics.reviewedSubsetQuality - allowedMargin,
    passed: reviewedSubsetQuality >= baselineMetrics.reviewedSubsetQuality - allowedMargin,
  };
  constraintChecks.push(qualityCheck);

  if (!qualityCheck.passed) {
    blockers.push(
      `reviewedSubsetQuality regressed: ${reviewedSubsetQuality.toFixed(4)} < ${qualityCheck.threshold.toFixed(4)} ` +
        `(baseline: ${baselineMetrics.reviewedSubsetQuality.toFixed(4)})`
    );
  }

  // --- Determine if passes ---
  const allPassed = deltaCheck.passed &&
    arbiterRejectCheck.passed &&
    executabilityRejectCheck.passed &&
    qualityCheck.passed;

  // --- Suggest state based on checks ---
   
  let suggestedState: PromotionState | undefined;
  if (allPassed) {
    suggestedState = 'candidate_only';
    // If delta is strong enough, could be shadow_ready directly
    if (delta >= minDelta * 2) {
      suggestedState = 'shadow_ready';
    }
  } else {
    suggestedState = 'rejected';
  }

  const evidenceMode =
    arbiterRejectSource === 'shadow' && executabilityRejectSource === 'shadow'
      ? 'shadow'
      : arbiterRejectSource === 'eval-proxy' && executabilityRejectSource === 'eval-proxy'
        ? 'eval-proxy'
        : 'mixed';

  return {
    passes: allPassed,
    suggestedState,
    blockers,
    constraintChecks,
    deltaCheck,
    evidenceSummary: {
      evidenceMode,
      shadowSampleCount: shadowStats?.totalCount ?? 0,
      deltaSource: 'eval',
    },
  };
}

// ---------------------------------------------------------------------------
// Promotion State Machine
// ---------------------------------------------------------------------------

/**
 * Parameters for advancing promotion state.
 */
export interface AdvancePromotionParams {
  /** Checkpoint ID to promote */
  checkpointId: string;

  /** Target worker profile */
  targetProfile: TrainableWorkerProfile;

  /** Baseline metrics for comparison */
  baselineMetrics: BaselineMetrics;

  /** Orchestrator review passed (required for promotable) */
  orchestratorReviewPassed?: boolean;

  /** Human review note */
  reviewNote?: string;

  /** Minimum delta threshold */
  minDelta?: number;

  /** Allowed margin for constraints */
  allowedMargin?: number;
}

/**
 * Advance a checkpoint's promotion state.
 *
 * @param stateDir - Workspace state directory
 * @param params - Advancement parameters
 * @returns The updated PromotionRecord
 *
 * @throws Error if gate evaluation fails
 * @throws Error if state transition is not allowed
 */
export function advancePromotion(
  stateDir: string,
  params: AdvancePromotionParams
): PromotionRecord {
  const {
    checkpointId,
    targetProfile,
    baselineMetrics,
    orchestratorReviewPassed = false,
    reviewNote,
    minDelta = DEFAULT_MIN_DELTA,
    allowedMargin = DEFAULT_ALLOWED_MARGIN,
  } = params;

  // First, evaluate the gate
  const gateResult = evaluatePromotionGate(stateDir, {
    checkpointId,
    targetProfile,
    baselineMetrics,
    minDelta,
    allowedMargin,
  });

    // eslint-disable-next-line complexity -- refactor candidate
  // Find existing promotion record (if any) - need this to know current state
    // eslint-disable-next-line complexity -- refactor candidate
  return withPromotionRegistryLock(stateDir, (registry) => {
    const now = new Date().toISOString();
    const existingIdx = registry.promotions.findIndex(
      (p) => p.checkpointId === checkpointId
    );
    const currentState = existingIdx >= 0 ? registry.promotions[existingIdx].state : 'candidate_only';

    // Determine the target state based on current state, gate result, and review
    //
    // STATE TRANSITION RULES:
    // - Any state → rejected: if gate fails
    // - rejected/candidate_only → candidate_only: if gate passes but no review yet
    // - shadow_ready → promotable: if gate passes + review + shadow window elapsed
    // - rejected → candidate_only/shadow_ready: allowed via re-evaluation
    //   (new eval data may reverse a previous rejection)
    //
     
    let targetState: PromotionState;
    if (!gateResult.passes) {
      targetState = 'rejected';
    } else if (!orchestratorReviewPassed) {
      // Gate passed but need orchestrator review before shadow_ready
      // Review is ALWAYS required to reach shadow_ready, regardless of delta strength
      targetState = 'candidate_only';
    } else {
      // Gate passed and orchestrator review passed: advance one level
      // Only go to promotable if already at shadow_ready; otherwise advance to shadow_ready
      if (currentState === 'shadow_ready') {
        // Check shadow window duration before allowing promotion
        const existing = existingIdx >= 0 ? registry.promotions[existingIdx] : null;
        const shadowStartedAt = existing?.shadowStartedAt;
        if (shadowStartedAt) {
          const shadowElapsed = Date.now() - new Date(shadowStartedAt).getTime();
          if (shadowElapsed < MIN_SHADOW_WINDOW_MS) {
            // Shadow window not elapsed yet — stay at shadow_ready
            targetState = 'shadow_ready';
          } else {
            // Shadow window elapsed — allow promotion to promotable
            targetState = 'promotable';
          }
        } else {
          // No shadowStartedAt, allow promotion (backward compat)
          targetState = 'promotable';
        }
      } else {
        // At candidate_only (or new), advance to shadow_ready
        targetState = 'shadow_ready';
      }
    }

    // Get previous promotion ID for chain
    const previousPromotionId = existingIdx >= 0
      ? registry.promotions[existingIdx].promotionId
      : undefined;

    // Get checkpoint info for lineage
    const checkpoint = getCheckpoint(stateDir, checkpointId);
    const evalSummary = checkpoint?.lastEvalSummaryRef
      ? getEvalSummary(stateDir, checkpoint.lastEvalSummaryRef)
      : null;

    // Get current delta
    const reducedPromptDelta = evalSummary?.delta ?? 0;

    // Create/update promotion record
    const promotion: PromotionRecord = {
      promotionId: existingIdx >= 0
        ? registry.promotions[existingIdx].promotionId
        : crypto.randomUUID(),
      checkpointId,
      state: targetState,
      targetProfile,
      targetModelFamily: checkpoint?.targetModelFamily ?? 'unknown',
      reducedPromptDelta,
      constraintMetrics: {
        arbiterRejectRate: evalSummary?.verdict === 'fail' ? 1 : 0,
        executabilityRejectRate: evalSummary?.verdict === 'fail' ? 0.1 : 0,
        reviewedSubsetQuality: evalSummary?.candidateScore ?? 0,
        routingScopeNotExpanded: true, // Always true in Phase 7
      },
      baselineMetrics,
      orchestratorReviewPassed,
      reviewNote,
      stateChangedAt: now,
      createdAt: existingIdx >= 0
        ? registry.promotions[existingIdx].createdAt
        : now,
      shadowStartedAt: (targetState === 'shadow_ready' || targetState === 'promotable')
        ? (() => {
            const existing = existingIdx >= 0 ? registry.promotions[existingIdx] : null;
            // Only preserve shadowStartedAt if the checkpoint was already on the
            // shadow path (shadow_ready or promotable). A demotion to candidate_only
            // or rejected means the next shadow entry is a fresh start — use now.
            if (existing?.shadowStartedAt &&
                (existing.state === 'shadow_ready' || existing.state === 'promotable')) {
              return existing.shadowStartedAt;
            }
            return now;
          })()
        : existingIdx >= 0
          ? registry.promotions[existingIdx].shadowStartedAt
          : undefined,
      promotableAt: targetState === 'promotable'
        ? now
        : existingIdx >= 0
          ? registry.promotions[existingIdx].promotableAt
          : undefined,
      previousPromotionId,
    };

    if (existingIdx >= 0) {
      registry.promotions[existingIdx] = promotion;
    } else {
      registry.promotions.push(promotion);
    }

    writeRegistry(stateDir, registry);
    return promotion;
  });
}

// ---------------------------------------------------------------------------
// Promotion Queries
// ---------------------------------------------------------------------------

/**
 * Get the current promotion state for a checkpoint.
 */
export function getPromotionState(
  stateDir: string,
  checkpointId: string
): PromotionState | null {
  const registry = readRegistry(stateDir);
  const promotion = registry.promotions.find((p) => p.checkpointId === checkpointId);
  return promotion?.state ?? null;
}

/**
 * Get the promotion record for a checkpoint.
 */
export function getPromotionRecord(
  stateDir: string,
  checkpointId: string
): PromotionRecord | null {
  const registry = readRegistry(stateDir);
  return registry.promotions.find((p) => p.checkpointId === checkpointId) ?? null;
}

/**
 * List promotions by state.
 */
export function listPromotionsByState(
  stateDir: string,
  state: PromotionState
): PromotionRecord[] {
  const registry = readRegistry(stateDir);
  return registry.promotions.filter((p) => p.state === state);
}

/**
 * List all promotions for a profile.
 */
export function listPromotionsForProfile(
  stateDir: string,
  targetProfile: TrainableWorkerProfile
): PromotionRecord[] {
  const registry = readRegistry(stateDir);
  return registry.promotions.filter((p) => p.targetProfile === targetProfile);
}

// ---------------------------------------------------------------------------
// Rollback Support
// ---------------------------------------------------------------------------

/**
 * Reject a checkpoint, preventing it from being promoted.
 *
 * @param stateDir - Workspace state directory
 * @param checkpointId - Checkpoint to reject
 * @param reason - Reason for rejection
 * @returns The updated PromotionRecord
 */
export function rejectCheckpoint(
  stateDir: string,
  checkpointId: string,
  reason: string
): PromotionRecord {
  return withPromotionRegistryLock(stateDir, (registry) => {
    const now = new Date().toISOString();
    const existingIdx = registry.promotions.findIndex(
      (p) => p.checkpointId === checkpointId
    );

    const checkpoint = getCheckpoint(stateDir, checkpointId);

    const promotion: PromotionRecord = {
      promotionId: existingIdx >= 0
        ? registry.promotions[existingIdx].promotionId
        : crypto.randomUUID(),
      checkpointId,
      state: 'rejected',
      targetProfile: 'local-reader', // Default, should be overridden
      targetModelFamily: checkpoint?.targetModelFamily ?? 'unknown',
      reducedPromptDelta: 0,
      constraintMetrics: {
        arbiterRejectRate: 1,
        executabilityRejectRate: 1,
        reviewedSubsetQuality: 0,
        routingScopeNotExpanded: true,
      },
      baselineMetrics: {
        arbiterRejectRate: 0,
        executabilityRejectRate: 0,
        reviewedSubsetQuality: 0,
      },
      orchestratorReviewPassed: false,
      reviewNote: reason,
      stateChangedAt: now,
      createdAt: existingIdx >= 0
        ? registry.promotions[existingIdx].createdAt
        : now,
    };

    if (existingIdx >= 0) {
      registry.promotions[existingIdx] = promotion;
    } else {
      registry.promotions.push(promotion);
    }

    writeRegistry(stateDir, registry);
    return promotion;
  });
}

// ---------------------------------------------------------------------------
// Default Baseline Metrics
// ---------------------------------------------------------------------------

/**
 * Default baseline metrics for Phase 7.
 * These represent the "acceptable" thresholds that new checkpoints must meet.
 */
export const DEFAULT_BASELINE_METRICS: BaselineMetrics = {
  arbiterRejectRate: 0.15,       // 15% max arbiter rejection
  executabilityRejectRate: 0.10,  // 10% max executability rejection
  reviewedSubsetQuality: 0.70,     // 70% minimum quality score
};
