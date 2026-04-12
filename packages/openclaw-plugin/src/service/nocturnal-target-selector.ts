/**
 * Nocturnal Target Selector — Principle + Session Selection for Sleep-Mode Reflection
 * ================================================================================
 *
 * PURPOSE: Select one target principle and one violating session for nocturnal
 * reflection processing. This module is a PURE SELECTOR — it does NOT execute
 * reflection or write any artifacts.
 *
 * SELECTION LOGIC:
 * 1. Filter principles to evaluable candidates (not manual_only, not cooldown)
 * 2. Score candidates by: compliance health, violation trend, sample scarcity
 * 3. Select top principle
 * 4. Find violating sessions for that principle
 * 5. Select best violating session by violation density
 *
 * SKIP CONDITIONS (return no-op cleanly):
 * - no_evaluable_principles: No principles with auto-trainable evaluability
 * - all_targets_in_cooldown: All candidates are in cooldown
 * - no_violating_sessions: No sessions show violation signals for selected principle
 * - workspace_not_idle: Workspace is active, nocturnal run not allowed
 * - quota_exhausted: Max runs per window reached
 * - insufficient_snapshot_data: Sessions exist but lack tool calls
 *
 * DESIGN CONSTRAINTS:
 * - This is a PURE SELECTOR — no reflection execution
 * - No raw text exposure
 * - No artifact writing
 * - No真实 subagent 调用
 * - Deterministic based on inputs (no random selection)
 *
 * OUTPUT: NocturnalSelectionResult with:
 * - decision: 'selected' | 'skip'
 * - selectedPrincipleId?: string
 * - selectedSessionId?: string
 * - skipReason?: SkipReason
 * - diagnostics: scoring and filtering details
 */

import type {
  NocturnalTrajectoryExtractor,
  NocturnalSessionSummary,
} from '../core/nocturnal-trajectory-extractor.js';
import {
  listEvaluablePrinciples,
  type PrincipleTrainingState,
} from '../core/principle-training-state.js';
import {
  checkWorkspaceIdle,
  checkCooldown,
  DEFAULT_IDLE_THRESHOLD_MS,
  type IdleCheckResult,
} from './nocturnal-runtime.js';
import { detectViolation } from '../core/nocturnal-compliance.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkipReason =
  | 'no_evaluable_principles'       // No principles with evaluability !== manual_only
  | 'all_targets_in_cooldown'       // All candidates are in per-principle cooldown
  | 'no_violating_sessions'         // No sessions show violation signals for selected principle
  | 'workspace_not_idle'            // Workspace is active, nocturnal not allowed
  | 'quota_exhausted'              // Max runs per quota window reached
  | 'insufficient_snapshot_data'    // Sessions exist but lack tool calls / events
  | 'global_cooldown_active';       // Global cooldown is in effect

export interface SelectionDiagnostics {
  /** Total evaluable principles found */
  totalEvaluablePrinciples: number;
  /** Principles filtered out by cooldown */
  filteredByCooldown: number;
  /** Principles that passed all filters */
  passedPrinciples: string[];
  /** Violating sessions found for selected principle */
  violatingSessionCount: number;
  /** Violation density of selected session (failures / total tool calls) */
  selectedSessionViolationDensity: number | null;
  /** Score of selected principle */
  selectedPrincipleScore: number | null;
  /** Score breakdown */
  scoringBreakdown: Record<string, number>;
  /** Whether workspace idle check passed */
  idleCheckPassed: boolean;
  /** Whether cooldown check passed */
  cooldownCheckPassed: boolean;
  /** Whether quota check passed */
  quotaCheckPassed: boolean;
  /** Recent pain context used for ranking bias (if available) */
  painContext?: {
    recentPainCount: number;
    recentMaxPainScore: number;
    hasRecentPain: boolean;
    painSource?: string;
  };
}

export interface NocturnalSelectionResult {
  /** Whether a target was selected */
  decision: 'selected' | 'skip';
  /** Selected principle ID (if decision === 'selected') */
  selectedPrincipleId?: string;
  /** Selected violating session ID (if decision === 'selected') */
  selectedSessionId?: string;
  /** Reason for skip (if decision === 'skip') */
  skipReason?: SkipReason;
  /** Detailed diagnostics for observability */
  diagnostics: SelectionDiagnostics;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ScoredPrinciple {
  principleId: string;
  state: PrincipleTrainingState;
  score: number;
  violationDensity: number; // violations / applicable opportunities
  cooldownActive: boolean;
}

interface ViolationSignal {
  sessionId: string;
  hasViolation: boolean;
  violationSeverity: number; // 0-1
  failureCount: number;
  painEventCount: number;
  gateBlockCount: number;
  toolCallCount: number;
}

/**
 * Score a principle for nocturnal targeting.
 * Higher score = better candidate for reflection.
 *
 * Scoring dimensions:
 * 1. Compliance health (higher compliance = more worth teaching)
 * 2. Violation trend (worsening trend = higher priority)
 * 3. Sample scarcity (fewer samples = more valuable)
 * 4. Cooldown penalty (in cooldown = lower priority)
 * 5. Pain context bias (recent pain = higher priority for related principles)
 *
 * Score range: 0-100 (normalized)
 */
function scorePrinciple(
  state: PrincipleTrainingState,
  cooldownActive: boolean,
  recentPainContext?: {
    mostRecent: { score: number; source: string; reason: string; timestamp: string } | null;
    recentPainCount: number;
    recentMaxPainScore: number;
  }
): number {
  let score = 50; // Base score

  // Compliance contribution: 0-25 points
  // High compliance = well-understood principle = good teaching target
  // But very low compliance = confused principle = also needs work
  const complianceContribution = Math.round(state.complianceRate * 25);
  score += complianceContribution;

  // Trend contribution: -10 to +10 points
  // worsening trend (+1) = higher priority = +10
  // improving trend (-1) = lower priority = -10
  // stable (0) = neutral = 0
  score += state.violationTrend * 10;

  // Sample scarcity contribution: 0-15 points
  // Fewer samples generated = more valuable new data
  // Max at 0 samples, decreases as samples accumulate
  const scarcityPenalty = Math.min(state.generatedSampleCount / 10, 1) * 15;
  score += Math.round(15 - scarcityPenalty);

  // Cooldown penalty: -30 points
  if (cooldownActive) {
    score -= 30;
  }

  // Pain context bias: up to +25 points
  // Bias toward principles related to recent pain signals
  if (recentPainContext && recentPainContext.recentPainCount > 0) {
    // Most recent pain score contributes up to 15 points (pain scores are 1-10)
    const mostRecentPainScore = recentPainContext.mostRecent?.score ?? 0;
    const painScoreContribution = Math.round((mostRecentPainScore / 10) * 15);
    score += painScoreContribution;

    // Additional pain count adds up to 5 more points
    const additionalPainContribution = Math.min(recentPainContext.recentPainCount - 1, 5) * 1;
    score += additionalPainContribution;

    // High pain scores (> 7) get extra 5-point boost
    if (recentPainContext.recentMaxPainScore > 7) {
      score += 5;
    }
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Compute violation signal density for a session.
 * Returns 0-1 score (higher = more violation evidence).
 */
function computeViolationDensity(session: NocturnalSessionSummary): number {
  const total = session.toolCallCount;
  if (total === 0) return 0;

  // Violation signals: failures, pain events, gate blocks
  const violationSignals =
    session.failureCount + session.painEventCount * 0.5 + session.gateBlockCount * 0.3;

  return Math.min(violationSignals / total, 1);
}

// ---------------------------------------------------------------------------
// Core Selector
// ---------------------------------------------------------------------------

export interface NocturnalTargetSelectorOptions {
  /**
   * Minimum violation density threshold for a session to be considered "violating".
   * Default: 0.1 (at least 10% of tool calls are violation signals)
   */
  minViolationDensity?: number;

  /**
   * Maximum number of recent sessions to consider for violation matching.
   * Default: 50
   */
  maxSessionCandidates?: number;

  /**
   * Idle threshold override (ms).
   * Default: from nocturnal-runtime DEFAULT_IDLE_THRESHOLD_MS
   */
  idleThresholdMs?: number;

  /**
   * Override idle check result (for testing).
   * If provided, this result is used instead of calling checkWorkspaceIdle.
   */
  idleCheckOverride?: IdleCheckResult;

  /**
   * Recent pain context from evolution worker.
   * When provided, principles related to recent pain signals get ranking bias.
   * This threads recent pain into sleep_reflection targeting without merging task kinds.
   */
  recentPainContext?: {
    mostRecent: {
      score: number;
      source: string;
      reason: string;
      timestamp: string;
    } | null;
    recentPainCount: number;
    recentMaxPainScore: number;
  };
}

/**
 * Nocturnal Target Selector.
 *
 * Selects one target principle and one violating session for nocturnal reflection.
 * This is a PURE FUNCTION — no side effects, no artifact writing.
 */
export class NocturnalTargetSelector {
  private readonly extractor: NocturnalTrajectoryExtractor;
  private readonly stateDir: string;
  private readonly workspaceDir: string;
  private readonly opts: {
    minViolationDensity: number;
    maxSessionCandidates: number;
    idleThresholdMs: number;
  };
  private readonly idleCheckOverride?: IdleCheckResult;
  private readonly recentPainContext?: {
    mostRecent: {
      score: number;
      source: string;
      reason: string;
      timestamp: string;
    } | null;
    recentPainCount: number;
    recentMaxPainScore: number;
  };

   
  constructor(
    workspaceDir: string,
    stateDir: string,
    extractor: NocturnalTrajectoryExtractor,
    options: NocturnalTargetSelectorOptions = {}
  ) {
    this.workspaceDir = workspaceDir;
    this.stateDir = stateDir;
    this.extractor = extractor;
    // Destructure so they are NOT included in opts (stored separately)
    const { idleCheckOverride, recentPainContext, ...restOptions } = options;
    this.idleCheckOverride = idleCheckOverride;
    this.recentPainContext = recentPainContext;
    this.opts = {
      minViolationDensity: restOptions.minViolationDensity ?? 0.1,
      maxSessionCandidates: restOptions.maxSessionCandidates ?? 300,  // TEMP: increased from 50 to cover real violations (#244)
      idleThresholdMs: restOptions.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS,
    };
  }

  /**
   * Select a target principle and violating session.
   *
   * @returns NocturnalSelectionResult with either selected targets or skip reason
   */
  select(): NocturnalSelectionResult {
    const diagnostics: SelectionDiagnostics = {
      totalEvaluablePrinciples: 0,
      filteredByCooldown: 0,
      passedPrinciples: [],
      violatingSessionCount: 0,
      selectedSessionViolationDensity: null,
      selectedPrincipleScore: null,
      scoringBreakdown: {},
      idleCheckPassed: false,
      cooldownCheckPassed: false,
      quotaCheckPassed: false,
      painContext: this.recentPainContext ? {
        recentPainCount: this.recentPainContext.recentPainCount,
        recentMaxPainScore: this.recentPainContext.recentMaxPainScore,
        hasRecentPain: this.recentPainContext.recentPainCount > 0,
        painSource: this.recentPainContext.mostRecent?.source,
      } : undefined,
    };

    // Step 1: Idle check — if workspace is not idle, skip
    const idleResult = this.idleCheckOverride ?? checkWorkspaceIdle(this.workspaceDir, {
      idleThresholdMs: this.opts.idleThresholdMs,
    });
    diagnostics.idleCheckPassed = idleResult.isIdle;

    if (!idleResult.isIdle) {
      return {
        decision: 'skip',
        skipReason: 'workspace_not_idle',
        diagnostics,
      };
    }

    // Step 2: Cooldown and quota check
    const cooldownResult = checkCooldown(this.stateDir);
    diagnostics.cooldownCheckPassed = !cooldownResult.globalCooldownActive;
    diagnostics.quotaCheckPassed = !cooldownResult.quotaExhausted;

    if (cooldownResult.globalCooldownActive) {
      return {
        decision: 'skip',
        skipReason: 'global_cooldown_active',
        diagnostics,
      };
    }

    if (cooldownResult.quotaExhausted) {
      return {
        decision: 'skip',
        skipReason: 'quota_exhausted',
        diagnostics,
      };
    }

    // Step 3: Get evaluable principles
    const evaluablePrinciples = listEvaluablePrinciples(this.stateDir);
    diagnostics.totalEvaluablePrinciples = evaluablePrinciples.length;

    if (evaluablePrinciples.length === 0) {
      return {
        decision: 'skip',
        skipReason: 'no_evaluable_principles',
        diagnostics,
      };
    }

    // Step 4: Score and filter candidates
    const scoredPrinciples: ScoredPrinciple[] = [];

    for (const state of evaluablePrinciples) {
      const cooldownCheck = checkCooldown(this.stateDir, state.principleId);
      const cooldownActive = cooldownCheck.principleCooldownActive;
      const score = scorePrinciple(state, cooldownActive, this.recentPainContext);

      if (cooldownActive) {
        diagnostics.filteredByCooldown++;
      }

      scoredPrinciples.push({
        principleId: state.principleId,
        state,
        score,
        violationDensity:
          state.applicableOpportunityCount > 0
            ? state.observedViolationCount / state.applicableOpportunityCount
            : 0,
        cooldownActive,
      });

      diagnostics.scoringBreakdown[state.principleId] = score;
    }

    // Filter out principles in cooldown (score already penalized but keep them in diagnostics)
    const activeCandidates = scoredPrinciples.filter((p) => !p.cooldownActive);

    if (activeCandidates.length === 0) {
      diagnostics.passedPrinciples = [];
      return {
        decision: 'skip',
        skipReason: 'all_targets_in_cooldown',
        diagnostics,
      };
    }

    // Sort by score descending
    activeCandidates.sort((a, b) => b.score - a.score);
    diagnostics.passedPrinciples = activeCandidates.map((p) => p.principleId);

    // Select the top candidate
    const [selected] = activeCandidates;
    diagnostics.selectedPrincipleScore = selected.score;

    // Step 5: Find violating sessions for the selected principle
    const recentSessions = this.extractor.listRecentNocturnalCandidateSessions({
      limit: this.opts.maxSessionCandidates,
      minToolCalls: 1,
    });

    if (recentSessions.length === 0) {
      return {
        decision: 'skip',
        skipReason: 'insufficient_snapshot_data',
        diagnostics,
      };
    }

    // Compute violation signals for each session
    const violatingSessions: ViolationSignal[] = recentSessions.map((session) => {
      const violationDensity = computeViolationDensity(session);
      const snapshot = this.extractor.getNocturnalSessionSnapshot(session.sessionId);

      // Use nocturnal-compliance to detect violations for the selected principle
      let hasViolation = false;
      if (snapshot) {
        const violationResult = detectViolation(selected.principleId, {
          sessionId: session.sessionId,
          toolCalls: snapshot.toolCalls.map((tc) => ({
            toolName: tc.toolName,
            filePath: tc.filePath ?? undefined,
            outcome: tc.outcome,
            errorMessage: tc.errorMessage ?? undefined,
          })),
          painSignals: snapshot.painEvents.map((pe) => ({
            source: pe.source,
            score: pe.score,
            reason: pe.reason ?? undefined,
          })),
          gateBlocks: snapshot.gateBlocks.map((gb) => ({
            toolName: gb.toolName,
            reason: gb.reason,
          })),
          userCorrections: [],
          planApprovals: [],
        });
        hasViolation = violationResult.violated;
      }

      return {
        sessionId: session.sessionId,
        hasViolation,
        violationSeverity: violationDensity,
        failureCount: session.failureCount,
        painEventCount: session.painEventCount,
        gateBlockCount: session.gateBlockCount,
        toolCallCount: session.toolCallCount,
      };
    });

    // Filter to sessions with violations above threshold
    const violating = violatingSessions.filter(
      (s) => s.hasViolation && s.violationSeverity >= this.opts.minViolationDensity
    );
    diagnostics.violatingSessionCount = violating.length;

    if (violating.length === 0) {
      return {
        decision: 'skip',
        skipReason: 'no_violating_sessions',
        diagnostics,
      };
    }

    // Sort by violation severity descending (most violating first)
    violating.sort((a, b) => b.violationSeverity - a.violationSeverity);
    const [selectedSession] = violating;
    diagnostics.selectedSessionViolationDensity = selectedSession.violationSeverity;

    return {
      decision: 'selected',
      selectedPrincipleId: selected.principleId,
      selectedSessionId: selectedSession.sessionId,
      diagnostics,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * Select a nocturnal target (principle + session) with default options.
 *
 * This is a convenience wrapper for the common case.
 */
 
export function selectNocturnalTarget(
  workspaceDir: string,
  stateDir: string,
  extractor: NocturnalTrajectoryExtractor,
  options: NocturnalTargetSelectorOptions = {}
): NocturnalSelectionResult {
  const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor, options);
  return selector.select();
}
