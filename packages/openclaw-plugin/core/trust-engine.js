/**
 * Trust Engine V2.1 - Recalibrated for Action Classification
 * Differentiates between Exploratory (safe) and Constructive (risky) actions.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EventLogService } from './event-log.js';
import { resolvePdPath } from './paths.js';
import { ConfigService } from './config-service.js';
import { TrajectoryRegistry } from './trajectory.js';
import { EXPLORATORY_TOOLS as SHARED_EXPLORATORY_TOOLS } from '../constants/tools.js';
export const EXPLORATORY_TOOLS = new Set(SHARED_EXPLORATORY_TOOLS);
const LEGACY_TRUST_REWARD_POLICY = 'frozen_all_positive';
export class TrustEngine {
    scorecard;
    workspaceDir;
    stateDir;
    constructor(workspaceDir) {
        this.workspaceDir = workspaceDir;
        this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
        this.scorecard = this.loadScorecard();
        const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
        if (!fs.existsSync(scorecardPath)) {
            this.saveScorecard();
        }
    }
    get config() {
        return ConfigService.get(this.stateDir);
    }
    get trustSettings() {
        const settings = this.config.get('trust');
        return settings || {
            stages: { stage_1_observer: 30, stage_2_editor: 60, stage_3_developer: 80 },
            cold_start: { initial_trust: 85, grace_failures: 5, cold_start_period_ms: 86400000 },
            // BUGFIX #84: Reduced penalties to prevent Trust collapse
            penalties: { tool_failure_base: -1, risky_failure_base: -5, gate_bypass_attempt: -3, failure_streak_multiplier: -1, max_penalty: -10 },
            rewards: { success_base: 2, subagent_success: 5, tool_success_reward: 0.2, streak_bonus_threshold: 3, streak_bonus: 5, recovery_boost: 5, max_reward: 15 },
            limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
        };
    }
    loadScorecard() {
        const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
        const settings = this.trustSettings;
        if (fs.existsSync(scorecardPath)) {
            try {
                const raw = fs.readFileSync(scorecardPath, 'utf8');
                const data = JSON.parse(raw);
                if (data.score !== undefined && data.trust_score === undefined)
                    data.trust_score = data.score;
                if (!data.history)
                    data.history = [];
                if (data.exploratory_failure_streak === undefined)
                    data.exploratory_failure_streak = 0;
                this.applyLegacyFreezeMetadata(data);
                return data;
            }
            catch (e) {
                console.error(`[PD:TrustEngine] FATAL: Failed to parse scorecard at ${scorecardPath}. Resetting.`);
            }
        }
        const now = new Date();
        const coldStartEnd = new Date(now.getTime() + settings.cold_start.cold_start_period_ms);
        const scorecard = {
            trust_score: settings.cold_start.initial_trust,
            success_streak: 0,
            failure_streak: 0,
            exploratory_failure_streak: 0,
            grace_failures_remaining: settings.cold_start.grace_failures,
            last_updated: now.toISOString(),
            cold_start_end: coldStartEnd.toISOString(),
            first_activity_at: now.toISOString(),
            history: []
        };
        this.applyLegacyFreezeMetadata(scorecard);
        return scorecard;
    }
    applyLegacyFreezeMetadata(scorecard) {
        scorecard.frozen = true;
        scorecard.reward_policy = LEGACY_TRUST_REWARD_POLICY;
    }
    saveScorecard() {
        const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
        try {
            const dir = path.dirname(scorecardPath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(scorecardPath, JSON.stringify(this.scorecard, null, 2), 'utf8');
        }
        catch (e) {
            console.error(`[PD:TrustEngine] Failed to save scorecard: ${String(e)}`);
        }
    }
    getScore() { return this.scorecard.trust_score; }
    getScorecard() { return this.scorecard; }
    getStage() {
        const score = this.scorecard.trust_score;
        const stages = this.trustSettings.stages;
        if (score < stages.stage_1_observer)
            return 1;
        if (score < stages.stage_2_editor)
            return 2;
        if (score < stages.stage_3_developer)
            return 3;
        return 4;
    }
    isColdStart() {
        if (!this.scorecard.cold_start_end)
            return false;
        return new Date() < new Date(this.scorecard.cold_start_end);
    }
    recordSuccess(reason, context, isSubagent = false) {
        const toolName = context?.toolName;
        // 1. Check if this is an exploratory tool success
        const isExploratory = toolName ? EXPLORATORY_TOOLS.has(toolName) : false;
        if (reason === 'tool_success' && isExploratory) {
            this.scorecard.exploratory_failure_streak = 0;
            this.touchScorecard();
            return;
        }
        // Phase 1 freeze: do not let atomic successes inflate legacy trust.
        this.scorecard.success_streak = 0;
        this.scorecard.failure_streak = 0; // Reset failure streak on constructive success
        this.scorecard.exploratory_failure_streak = 0;
        this.touchScorecard();
    }
    recordFailure(type, context) {
        const settings = this.trustSettings;
        const penalties = settings.penalties;
        const toolName = context?.toolName;
        // 1. Classification: Is this an exploratory failure?
        const isExploratory = toolName ? EXPLORATORY_TOOLS.has(toolName) : false;
        // 2. Cold start grace (only for non-risky actions)
        if (type !== 'risky' && this.isColdStart() && (this.scorecard.grace_failures_remaining || 0) > 0) {
            this.scorecard.grace_failures_remaining = (this.scorecard.grace_failures_remaining || 0) - 1;
            this.updateScore(0, `Grace Failure consumed (${toolName || type})`, 'failure', context);
            return;
        }
        if (isExploratory) {
            // Exploratory failures are minor and don't trigger streak multipliers
            this.scorecard.exploratory_failure_streak++;
            this.updateScore(-1, `Exploratory Failure: ${toolName}`, 'failure', context);
            return;
        }
        // BUGFIX #84: sessions_send timeout should not be penalized
        // Communication timeouts are not agent failures - the message may have been delivered
        const errorStr = String(context?.error || '');
        if (toolName === 'sessions_send' && (errorStr.includes('timeout') || errorStr === 'timeout')) {
            this.updateScore(0, `Communication timeout (sessions_send): ignored`, 'info', context);
            return;
        }
        // 3. Constructive Failure (Risky or failed writes)
        let delta = 0;
        switch (type) {
            case 'tool':
                delta = penalties.tool_failure_base;
                break;
            case 'risky':
                delta = penalties.risky_failure_base;
                break;
            case 'bypass':
                delta = penalties.gate_bypass_attempt;
                break;
        }
        this.scorecard.failure_streak++;
        this.scorecard.success_streak = 0;
        // Safety cap: streak multiplier only applies up to 5 consecutive failures
        // to prevent "death spiral" from cascading errors
        const effectiveStreak = Math.min(this.scorecard.failure_streak, 5);
        if (effectiveStreak > 1) {
            delta += (effectiveStreak - 1) * penalties.failure_streak_multiplier;
        }
        if (delta < penalties.max_penalty)
            delta = penalties.max_penalty;
        this.updateScore(delta, `Failure: ${toolName || type}`, 'failure', context);
    }
    touchScorecard() {
        this.applyLegacyFreezeMetadata(this.scorecard);
        this.scorecard.last_updated = new Date().toISOString();
        this.saveScorecard();
    }
    updateScore(delta, reason, type, context) {
        const oldScore = this.scorecard.trust_score;
        this.applyLegacyFreezeMetadata(this.scorecard);
        this.scorecard.trust_score += delta;
        // Floor score: never drop below 30 (prevents Trust collapse from cascades)
        if (this.scorecard.trust_score < 30)
            this.scorecard.trust_score = 30;
        if (this.scorecard.trust_score > 100)
            this.scorecard.trust_score = 100;
        this.scorecard.last_updated = new Date().toISOString();
        if (!this.scorecard.history)
            this.scorecard.history = [];
        this.scorecard.history.push({ type, delta, reason, timestamp: new Date().toISOString() });
        if (context?.sessionId) {
            const eventLog = EventLogService.get(this.stateDir);
            eventLog.recordTrustChange(context.sessionId, { previousScore: oldScore, newScore: this.scorecard.trust_score, delta, reason });
        }
        if (context?.sessionId) {
            try {
                TrajectoryRegistry.use(this.workspaceDir, (trajectory) => {
                    trajectory.recordTrustChange({
                        sessionId: context.sessionId,
                        previousScore: oldScore,
                        newScore: this.scorecard.trust_score,
                        delta,
                        reason,
                    });
                });
            }
            catch {
                // Do not block trust updates if trajectory storage is unavailable.
            }
        }
        const limit = this.trustSettings.history_limit || 50;
        if (this.scorecard.history.length > limit) {
            this.scorecard.history.shift();
        }
        this.saveScorecard();
    }
    resetTrust(newScore) {
        const settings = this.trustSettings;
        const now = new Date();
        const coldStartEnd = new Date(now.getTime() + settings.cold_start.cold_start_period_ms);
        this.scorecard.trust_score = newScore ?? settings.cold_start.initial_trust;
        this.scorecard.success_streak = 0;
        this.scorecard.failure_streak = 0;
        this.scorecard.exploratory_failure_streak = 0;
        this.scorecard.grace_failures_remaining = settings.cold_start.grace_failures;
        this.scorecard.last_updated = now.toISOString();
        this.scorecard.first_activity_at = now.toISOString();
        this.scorecard.cold_start_end = coldStartEnd.toISOString();
        this.scorecard.history.push({ type: 'success', delta: 0, reason: 'Manual trust reset (Spiritual Cleanse)', timestamp: now.toISOString() });
        this.applyLegacyFreezeMetadata(this.scorecard);
        this.saveScorecard();
    }
    getStatusSummary() {
        const scorecard = this.scorecard;
        const successRate = this.calculateSuccessRate(scorecard);
        return {
            stage: this.getStage(),
            successRate,
            isInColdStart: this.isColdStart(),
            graceRemaining: scorecard.grace_failures_remaining ?? 0,
            currentStreak: {
                type: scorecard.success_streak > scorecard.failure_streak ? 'success' : 'failure',
                count: Math.max(scorecard.success_streak, scorecard.failure_streak)
            }
        };
    }
    calculateSuccessRate(scorecard) {
        if (!scorecard.history || scorecard.history.length === 0)
            return 100;
        const recent = scorecard.history.slice(-20);
        const successes = recent.filter(h => h.type === 'success').length;
        return Math.round((successes / recent.length) * 100);
    }
}
export function recordSuccess(workspaceDir, reason, context, isSubagent = false) {
    new TrustEngine(workspaceDir).recordSuccess(reason, context, isSubagent);
}
export function recordFailure(type, workspaceDir, ctx) {
    new TrustEngine(workspaceDir).recordFailure(type, ctx);
}
export function getAgentScorecard(workspaceDir) {
    return new TrustEngine(workspaceDir).getScorecard();
}
export function getTrustStats(scorecard) {
    const dummy = new TrustEngine(process.cwd());
    const successRate = dummy.calculateSuccessRate(scorecard);
    const stages = { stage_1_observer: 30, stage_2_editor: 60, stage_3_developer: 80 };
    let stage = scorecard.trust_score < stages.stage_1_observer ? 1 :
        scorecard.trust_score < stages.stage_2_editor ? 2 :
            scorecard.trust_score < stages.stage_3_developer ? 3 : 4;
    return {
        stage, successRate,
        isInColdStart: scorecard.cold_start_end ? new Date() < new Date(scorecard.cold_start_end) : false,
        graceRemaining: scorecard.grace_failures_remaining ?? 0,
        currentStreak: {
            type: (scorecard.success_streak || 0) > (scorecard.failure_streak || 0) ? 'success' : 'failure',
            count: Math.max(scorecard.success_streak || 0, scorecard.failure_streak || 0)
        }
    };
}
export function getTrustStatus(workspaceDir) {
    return new TrustEngine(workspaceDir).getStatusSummary();
}
