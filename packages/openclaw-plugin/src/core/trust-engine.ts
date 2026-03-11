/**
 * Trust Engine V2 - Adaptive Trust System with Cold Start Support
 *
 * Key Features:
 * 1. Cold Start Bonus - New agents get "trial period" with higher initial trust
 * 2. Graceful Failures - First few failures don't penalize
 * 3. Adaptive Penalties - Penalties scale with failure frequency
 * 4. Recovery Boost - Faster trust recovery after failures
 * 5. Streak Bonuses - Exponential rewards for consistency
 */

import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { EventLogService } from './event-log.js';
import { resolvePdPath } from './paths.js';

export interface AgentScorecard {
    /** Current trust score (0-100) */
    trust_score: number;
    /** Total successful operations */
    wins?: number;
    /** Total failed operations */
    losses?: number;
    /** Consecutive successes (streak) */
    success_streak?: number;
    /** Consecutive failures */
    failure_streak?: number;
    /** Timestamp of first activity (for cold start detection) */
    first_activity_at?: string;
    /** Timestamp of last activity */
    last_activity_at?: string;
    /** Remaining "grace" failures (no penalty) */
    grace_failures_remaining?: number;
    /** History of recent results (for adaptive penalties) */
    recent_history?: ('success' | 'failure')[];
}

/**
 * Stage thresholds and limits
 */
export const TRUST_CONFIG = {
    STAGES: {
        STAGE_1_OBSERVER: 30,
        STAGE_2_EDITOR: 60,
        STAGE_3_DEVELOPER: 80,
    },

    // Cold Start Configuration
    COLD_START: {
        /** Initial trust score for new agents */
        INITIAL_TRUST: 59, // Stage 2 upper bound
        /** Number of failure-free attempts */
        GRACE_FAILURES: 3,
        /** Cold start period in milliseconds (24 hours) */
        COLD_START_PERIOD: 24 * 60 * 60 * 1000,
    },

    // Adaptive Penalties (scale with failure frequency)
    PENALTIES: {
        /** Base penalty for tool failure */
        TOOL_FAILURE_BASE: -8,
        /** Base penalty for risky operation failure */
        RISKY_FAILURE_BASE: -15,
        /** Penalty for gate bypass attempt */
        GATE_BYPASS_ATTEMPT: -5,
        /** Additional penalty per consecutive failure */
        FAILURE_STREAK_MULTIPLIER: -3,
        /** Maximum penalty cap (prevents single mistake from ruining everything) */
        MAX_PENALTY: -25,
    },

    // Rewards (scale with success consistency)
    REWARDS: {
        /** Base reward for successful operation */
        SUCCESS_BASE: 1,
        /** Bonus for subagent success */
        SUBAGENT_SUCCESS: 3,
        /** Streak bonus (exponential) */
        STREAK_BONUS_THRESHOLD: 5,
        STREAK_BONUS: 5,
        /** Recovery boost after failures */
        RECOVERY_BOOST: 3,
        /** Maximum reward per operation */
        MAX_REWARD: 10,
    },

    LIMITS: {
        STAGE_2_MAX_LINES: 10,
        STAGE_3_MAX_LINES: 100,
        /** Size of recent history window */
        RECENT_HISTORY_SIZE: 20,
    }
};

/**
 * Check if agent is in cold start period
 */
function isColdStart(scorecard: AgentScorecard): boolean {
    if (!scorecard.first_activity_at) return true;

    const firstActivity = new Date(scorecard.first_activity_at).getTime();
    const now = Date.now();
    return (now - firstActivity) < TRUST_CONFIG.COLD_START.COLD_START_PERIOD;
}

/**
 * Calculate adaptive penalty based on failure history
 */
function calculateAdaptivePenalty(
    basePenalty: number,
    scorecard: AgentScorecard,
    failureType: 'tool' | 'risky' | 'bypass'
): { penalty: number; graceUsed: boolean; reason: string } {
    const failureStreak = scorecard.failure_streak || 0;
    const recentHistory = scorecard.recent_history || [];
    const isInColdStart = isColdStart(scorecard);

    // Check grace failures
    const graceRemaining = scorecard.grace_failures_remaining ?? TRUST_CONFIG.COLD_START.GRACE_FAILURES;
    if (graceRemaining > 0) {
        // Use a grace failure - no penalty
        return {
            penalty: 0,
            graceUsed: true,
            reason: `grace_failure_remaining_${graceRemaining - 1}`
        };
    }

    // Calculate base penalty with streak multiplier
    let penalty = basePenalty + (failureStreak * TRUST_CONFIG.PENALTIES.FAILURE_STREAK_MULTIPLIER);

    // Cold start reduction (50% less penalty during cold start)
    if (isInColdStart) {
        penalty = Math.floor(penalty * 0.5);
    }

    // Recent failure rate adjustment
    const recentFailures = recentHistory.slice(-10).filter(r => r === 'failure').length;
    if (recentFailures >= 7) {
        // 70%+ failure rate - increase penalty
        penalty = Math.floor(penalty * 1.3);
    } else if (recentFailures <= 3) {
        // 30%- failure rate - reduce penalty
        penalty = Math.floor(penalty * 0.7);
    }

    // Cap the penalty
    penalty = Math.max(TRUST_CONFIG.PENALTIES.MAX_PENALTY, penalty);

    return {
        penalty,
        graceUsed: false,
        reason: `${failureType}_failure_streak_${failureStreak}`
    };
}

/**
 * Calculate adaptive reward based on success history
 */
function calculateAdaptiveReward(
    scorecard: AgentScorecard,
    operationType: 'success' | 'subagent_success'
): { reward: number; reason: string } {
    const successStreak = scorecard.success_streak || 0;
    const failureStreak = scorecard.failure_streak || 0;
    const recentHistory = scorecard.recent_history || [];

    let reward = TRUST_CONFIG.REWARDS.SUCCESS_BASE;

    // Subagent success bonus
    if (operationType === 'subagent_success') {
        reward += TRUST_CONFIG.REWARDS.SUBAGENT_SUCCESS;
    }

    // Recovery boost (was failing, now succeeding)
    if (failureStreak > 0) {
        reward += TRUST_CONFIG.REWARDS.RECOVERY_BOOST;
        reward = Math.min(reward, TRUST_CONFIG.REWARDS.MAX_REWARD);
        return { reward, reason: `recovery_from_${failureStreak}_failures` };
    }

    // Streak bonus (exponential for consistency)
    if (successStreak >= TRUST_CONFIG.REWARDS.STREAK_BONUS_THRESHOLD) {
        const streakBonus = Math.min(
            TRUST_CONFIG.REWARDS.STREAK_BONUS * Math.floor(successStreak / 5),
            TRUST_CONFIG.REWARDS.MAX_REWARD
        );
        reward += streakBonus;
        reward = Math.min(reward, TRUST_CONFIG.REWARDS.MAX_REWARD);
        return { reward, reason: `streak_bonus_${successStreak}` };
    }

    // Recent success rate adjustment
    const recentSuccesses = recentHistory.slice(-10).filter(r => r === 'success').length;
    if (recentSuccesses >= 8) {
        // 80%+ success rate - boost reward
        reward = Math.min(reward + 2, TRUST_CONFIG.REWARDS.MAX_REWARD);
        return { reward, reason: 'high_success_rate' };
    }

    // Apply global cap to total reward
    reward = Math.min(reward, TRUST_CONFIG.REWARDS.MAX_REWARD);

    return { reward, reason: 'base_success' };
}

/**
 * Update recent history (maintains fixed size)
 */
function updateRecentHistory(scorecard: AgentScorecard, result: 'success' | 'failure'): void {
    if (!scorecard.recent_history) {
        scorecard.recent_history = [];
    }
    scorecard.recent_history.push(result);
    if (scorecard.recent_history.length > TRUST_CONFIG.LIMITS.RECENT_HISTORY_SIZE) {
        scorecard.recent_history.shift();
    }
}

/**
 * Get or create agent scorecard with smart defaults
 */
export function getAgentScorecard(workspaceDir: string): AgentScorecard {
    const scorecardPath = resolvePdPath(workspaceDir, 'AGENT_SCORECARD');
    if (!fs.existsSync(scorecardPath)) {
        // New agent - initialize with cold start benefits
        return {
            trust_score: TRUST_CONFIG.COLD_START.INITIAL_TRUST,
            wins: 0,
            losses: 0,
            success_streak: 0,
            failure_streak: 0,
            grace_failures_remaining: TRUST_CONFIG.COLD_START.GRACE_FAILURES,
            recent_history: [],
            first_activity_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
        };
    }

    try {
        const content = fs.readFileSync(scorecardPath, 'utf8');
        const scorecard = JSON.parse(content);

        // Ensure all fields exist (migration support)
        if (scorecard.first_activity_at === undefined) {
            scorecard.first_activity_at = new Date().toISOString();
        }
        if (scorecard.grace_failures_remaining === undefined) {
            scorecard.grace_failures_remaining = TRUST_CONFIG.COLD_START.GRACE_FAILURES;
        }
        if (scorecard.recent_history === undefined) {
            scorecard.recent_history = [];
        }

        return scorecard;
    } catch (e) {
        return {
            trust_score: TRUST_CONFIG.COLD_START.INITIAL_TRUST,
            wins: 0,
            losses: 0,
            success_streak: 0,
            failure_streak: 0,
            grace_failures_remaining: TRUST_CONFIG.COLD_START.GRACE_FAILURES,
            recent_history: [],
            first_activity_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
        };
    }
}

/**
 * Save agent scorecard with validation
 */
export function saveAgentScorecard(workspaceDir: string, scorecard: AgentScorecard): void {
    const scorecardPath = resolvePdPath(workspaceDir, 'AGENT_SCORECARD');
    const dir = path.dirname(scorecardPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Ensure trust_score stays within bounds
    if (scorecard.trust_score !== undefined) {
        scorecard.trust_score = Math.max(0, Math.min(100, scorecard.trust_score));
    }

    // Update last activity timestamp
    scorecard.last_activity_at = new Date().toISOString();

    fs.writeFileSync(scorecardPath, JSON.stringify(scorecard, null, 2), 'utf8');
}

/**
 * Record a successful operation
 */
export function recordSuccess(
    workspaceDir: string,
    operationType: 'success' | 'subagent_success',
    ctx?: { sessionId?: string; stateDir?: string; api?: OpenClawPluginApi }
): number {
    const scorecard = getAgentScorecard(workspaceDir);
    const previousScore = scorecard.trust_score;

    // Calculate adaptive reward
    const { reward, reason } = calculateAdaptiveReward(scorecard, operationType);

    // Update scorecard
    scorecard.trust_score = Math.min(100, previousScore + reward);
    scorecard.wins = (scorecard.wins || 0) + 1;
    scorecard.success_streak = (scorecard.success_streak || 0) + 1;
    scorecard.failure_streak = 0;
    updateRecentHistory(scorecard, 'success');

    saveAgentScorecard(workspaceDir, scorecard);

    // Record the change in the event log
    if (ctx) {
        const stateDir = ctx.stateDir || path.join(workspaceDir, 'memory', '.state');
        const eventLog = EventLogService.get(stateDir, ctx.api?.logger);
        eventLog.recordTrustChange(ctx.sessionId, {
            previousScore,
            newScore: scorecard.trust_score,
            delta: reward,
            reason: `success_${reason}`
        });
    }

    return scorecard.trust_score;
}

/**
 * Record a failed operation with adaptive penalties
 */
export function recordFailure(
    workspaceDir: string,
    failureType: 'tool' | 'risky' | 'bypass',
    ctx?: { sessionId?: string; stateDir?: string; api?: OpenClawPluginApi }
): number {
    const scorecard = getAgentScorecard(workspaceDir);
    const previousScore = scorecard.trust_score;

    // Determine base penalty
    let basePenalty = TRUST_CONFIG.PENALTIES.TOOL_FAILURE_BASE;
    if (failureType === 'risky') {
        basePenalty = TRUST_CONFIG.PENALTIES.RISKY_FAILURE_BASE;
    } else if (failureType === 'bypass') {
        basePenalty = TRUST_CONFIG.PENALTIES.GATE_BYPASS_ATTEMPT;
    }

    // Calculate adaptive penalty
    const { penalty, graceUsed, reason } = calculateAdaptivePenalty(basePenalty, scorecard, failureType);

    // Update scorecard
    if (graceUsed) {
        // Grace period - no penalty, just consume one grace
        scorecard.grace_failures_remaining = (scorecard.grace_failures_remaining || 1) - 1;
    } else {
        scorecard.trust_score = Math.max(0, previousScore + penalty);
        scorecard.losses = (scorecard.losses || 0) + 1;
        scorecard.failure_streak = (scorecard.failure_streak || 0) + 1;
        scorecard.success_streak = 0;
    }

    updateRecentHistory(scorecard, 'failure');
    saveAgentScorecard(workspaceDir, scorecard);

    // Record the change in the event log
    if (ctx) {
        const stateDir = ctx.stateDir || path.join(workspaceDir, 'memory', '.state');
        const eventLog = EventLogService.get(stateDir, ctx.api?.logger);
        eventLog.recordTrustChange(ctx.sessionId, {
            previousScore,
            newScore: scorecard.trust_score,
            delta: graceUsed ? 0 : penalty,
            reason: graceUsed ? `grace_${reason}` : `failure_${reason}`
        });
    }

    return scorecard.trust_score;
}

/**
 * Legacy compatibility - adjusts trust score directly
 * @deprecated Use recordSuccess() or recordFailure() instead
 */
export function adjustTrustScore(
    workspaceDir: string,
    delta: number,
    reason: string,
    ctx?: { sessionId?: string; stateDir?: string; api?: OpenClawPluginApi }
): number {
    const scorecard = getAgentScorecard(workspaceDir);
    const previousScore = scorecard.trust_score ?? 50;
    const newScore = Math.max(0, Math.min(100, previousScore + delta));

    scorecard.trust_score = newScore;

    if (delta > 0) {
        scorecard.wins = (scorecard.wins || 0) + 1;
        scorecard.success_streak = (scorecard.success_streak || 0) + 1;
        scorecard.failure_streak = 0;
        updateRecentHistory(scorecard, 'success');
    } else if (delta < 0) {
        scorecard.losses = (scorecard.losses || 0) + 1;
        scorecard.failure_streak = (scorecard.failure_streak || 0) + 1;
        scorecard.success_streak = 0;
        updateRecentHistory(scorecard, 'failure');
    }

    saveAgentScorecard(workspaceDir, scorecard);

    if (ctx) {
        const stateDir = ctx.stateDir || path.join(workspaceDir, 'memory', '.state');
        const eventLog = EventLogService.get(stateDir, ctx.api?.logger);
        eventLog.recordTrustChange(ctx.sessionId, {
            previousScore,
            newScore,
            delta,
            reason
        });
    }

    return newScore;
}

/**
 * Get current trust stage
 */
export function getTrustStage(scorecard: AgentScorecard): number {
    const trustScore = scorecard.trust_score ?? 50;

    if (trustScore < TRUST_CONFIG.STAGES.STAGE_1_OBSERVER) return 1;
    if (trustScore < TRUST_CONFIG.STAGES.STAGE_2_EDITOR) return 2;
    if (trustScore <= TRUST_CONFIG.STAGES.STAGE_3_DEVELOPER) return 3;
    return 4;
}

/**
 * Get trust statistics for debugging/analytics
 */
export function getTrustStats(scorecard: AgentScorecard): {
    stage: number;
    successRate: number;
    isInColdStart: boolean;
    graceRemaining: number;
    currentStreak: { type: 'success' | 'failure'; count: number };
} {
    const recentHistory = scorecard.recent_history || [];
    const successCount = recentHistory.filter(r => r === 'success').length;
    const successRate = recentHistory.length > 0
        ? Math.round((successCount / recentHistory.length) * 100)
        : 0;

    const successStreak = scorecard.success_streak || 0;
    const failureStreak = scorecard.failure_streak || 0;

    return {
        stage: getTrustStage(scorecard),
        successRate,
        isInColdStart: isColdStart(scorecard),
        graceRemaining: scorecard.grace_failures_remaining ?? 0,
        currentStreak: {
            type: successStreak > failureStreak ? 'success' : 'failure',
            count: Math.max(successStreak, failureStreak)
        }
    };
}
