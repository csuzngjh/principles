/**
 * Trust Engine V2 - Adaptive Trust System with Cold Start Support
 */

import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { EventLogService } from './event-log.js';
import { resolvePdPath } from './paths.js';
import { ConfigService } from './config-service.js';

export interface TrustScorecard {
    trust_score: number;
    success_streak: number;
    failure_streak: number;
    grace_failures_remaining?: number;
    last_updated: string;
    cold_start_end?: string;
    first_activity_at?: string;
    history: Array<{
        type: 'success' | 'failure' | 'penalty';
        delta: number;
        reason: string;
        timestamp: string;
    }>;
}

export type TrustStage = 1 | 2 | 3 | 4;

export class TrustEngine {
    private scorecard: TrustScorecard;
    private workspaceDir: string;
    private stateDir: string;

    constructor(workspaceDir: string) {
        this.workspaceDir = workspaceDir;
        this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
        this.scorecard = this.loadScorecard();
    }

    private get config() {
        return ConfigService.get(this.stateDir);
    }

    private get trustSettings() {
        const settings = this.config.get('trust');
        return settings || {
            stages: { stage_1_observer: 30, stage_2_editor: 60, stage_3_developer: 80 },
            cold_start: { initial_trust: 59, grace_failures: 3, cold_start_period_ms: 86400000 },
            penalties: { tool_failure_base: -8, risky_failure_base: -15, gate_bypass_attempt: -5, failure_streak_multiplier: -3, max_penalty: -25 },
            rewards: { success_base: 1, subagent_success: 3, streak_bonus_threshold: 5, streak_bonus: 5, recovery_boost: 3, max_reward: 10 },
            limits: { stage_2_max_lines: 10, stage_3_max_lines: 100 }
        };
    }

    private loadScorecard(): TrustScorecard {
        const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
        const settings = this.trustSettings;

        if (fs.existsSync(scorecardPath)) {
            try {
                const raw = fs.readFileSync(scorecardPath, 'utf8');
                const data = JSON.parse(raw);
                
                // Compatibility: handle migration from 'score' to 'trust_score' if needed
                if (data.score !== undefined && data.trust_score === undefined) {
                    data.trust_score = data.score;
                }
                
                // Ensure history exists
                if (!data.history) data.history = [];
                return data;
            } catch (e) {
                console.error(`[PD:TrustEngine] FATAL: Failed to parse scorecard at ${scorecardPath}. Data may be corrupted. Error: ${String(e)}`);
                // Note: We return default below, effectively resetting. 
                // In a production app, we might want to backup the corrupt file first.
            }
        }

        const now = new Date();
        const coldStartEnd = new Date(now.getTime() + settings.cold_start.cold_start_period_ms);

        return {
            trust_score: settings.cold_start.initial_trust,
            success_streak: 0,
            failure_streak: 0,
            grace_failures_remaining: settings.cold_start.grace_failures,
            last_updated: now.toISOString(),
            cold_start_end: coldStartEnd.toISOString(),
            first_activity_at: now.toISOString(),
            history: []
        };
    }

    private saveScorecard(): void {
        const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
        try {
            const dir = path.dirname(scorecardPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(scorecardPath, JSON.stringify(this.scorecard, null, 2), 'utf8');
        } catch (e) {
            console.error(`[PD:TrustEngine] Failed to save scorecard: ${String(e)}`);
        }
    }

    public getScorecard(): TrustScorecard {
        return this.scorecard;
    }

    public getScore(): number {
        return this.scorecard.trust_score;
    }

    public getStage(): TrustStage {
        const score = this.scorecard.trust_score;
        const stages = this.trustSettings.stages;

        if (score < stages.stage_1_observer) return 1;
        if (score < stages.stage_2_editor) return 2;
        if (score < stages.stage_3_developer) return 3;
        return 4;
    }

    public isColdStart(): boolean {
        if (!this.scorecard.cold_start_end) return false;
        return new Date() < new Date(this.scorecard.cold_start_end);
    }

    public recordSuccess(reason: string, context?: { sessionId?: string; api?: any }, isSubagent: boolean = false): void {
        const settings = this.trustSettings;
        const rewards = settings.rewards;
        
        let delta = rewards.success_base;
        if (isSubagent) delta = rewards.subagent_success;

        this.scorecard.success_streak++;
        this.scorecard.failure_streak = 0;
        
        if (this.scorecard.success_streak >= rewards.streak_bonus_threshold) {
            delta += rewards.streak_bonus;
        }

        if (this.scorecard.trust_score < settings.stages.stage_1_observer) {
            delta += rewards.recovery_boost;
        }

        this.updateScore(delta, reason, 'success', context);
    }

    public recordFailure(type: 'tool' | 'risky' | 'bypass', context: { sessionId?: string; api?: any }): void {
        const settings = this.trustSettings;
        const penalties = settings.penalties;
        
        // Cold start grace
        if (this.isColdStart() && (this.scorecard.grace_failures_remaining || 0) > 0) {
            this.scorecard.grace_failures_remaining = (this.scorecard.grace_failures_remaining || 0) - 1;
            
            // 👈 FIX: Still record to history for auditability even if score doesn't change
            this.updateScore(0, `Grace Failure consumed (${type})`, 'failure', context);
            return;
        }

        let delta = 0;
        switch (type) {
            case 'tool': delta = penalties.tool_failure_base; break;
            case 'risky': delta = penalties.risky_failure_base; break;
            case 'bypass': delta = penalties.gate_bypass_attempt; break;
        }

        this.scorecard.failure_streak++;
        this.scorecard.success_streak = 0;

        if (this.scorecard.failure_streak > 1) {
            delta += (this.scorecard.failure_streak - 1) * penalties.failure_streak_multiplier;
        }

        if (delta < penalties.max_penalty) delta = penalties.max_penalty;

        this.updateScore(delta, `Failure: ${type}`, 'failure', context);
    }

    private updateScore(delta: number, reason: string, type: 'success' | 'failure' | 'penalty', context?: { sessionId?: string; api?: any }): void {
        const oldScore = this.scorecard.trust_score;
        this.scorecard.trust_score += delta;
        
        // Clamp score 0-100
        if (this.scorecard.trust_score < 0) this.scorecard.trust_score = 0;
        if (this.scorecard.trust_score > 100) this.scorecard.trust_score = 100;

        const newScore = this.scorecard.trust_score;
        this.scorecard.last_updated = new Date().toISOString();
        if (!this.scorecard.history) this.scorecard.history = [];
        this.scorecard.history.push({
            type,
            delta,
            reason,
            timestamp: new Date().toISOString()
        });

        // 👈 FIX: Record trust change event
        if (context?.sessionId) {
            const eventLog = EventLogService.get(this.stateDir);
            eventLog.recordTrustChange(context.sessionId, {
                oldScore,
                newScore,
                delta,
                reason,
                stage: this.getStage()
            });
        }

        // 👈 FIX: Use configurable history limit
        const limit = this.trustSettings.history_limit || 50;
        if (this.scorecard.history.length > limit) {
            this.scorecard.history.shift();
        }

        this.saveScorecard();
    }

    public getStatusSummary() {
        const scorecard = this.scorecard;
        const successStreak = scorecard.success_streak || 0;
        const failureStreak = scorecard.failure_streak || 0;
        const successRate = this.calculateSuccessRate(scorecard);

        return {
            stage: this.getStage(),
            successRate,
            isInColdStart: this.isColdStart(),
            graceRemaining: scorecard.grace_failures_remaining ?? 0,
            currentStreak: {
                type: successStreak > failureStreak ? 'success' : 'failure',
                count: Math.max(successStreak, failureStreak)
            }
        };
    }

    private calculateSuccessRate(scorecard: TrustScorecard): number {
        if (!scorecard.history || scorecard.history.length === 0) return 100;
        const recent = scorecard.history.slice(-20);
        const successes = recent.filter(h => h.type === 'success').length;
        return Math.round((successes / recent.length) * 100);
    }
}

/**
 * Backward compatibility wrappers
 */

export function recordSuccess(workspaceDir: string, reason: string, context?: { sessionId?: string; api?: any }, isSubagent: boolean = false): void {
    new TrustEngine(workspaceDir).recordSuccess(reason, context, isSubagent);
}

export function recordFailure(type: 'tool' | 'risky' | 'bypass', workspaceDir: string, ctx: { sessionId?: string; api?: any }): void {
    new TrustEngine(workspaceDir).recordFailure(type, ctx);
}

export function getAgentScorecard(workspaceDir: string): TrustScorecard {
    return new TrustEngine(workspaceDir).getScorecard();
}

export function getTrustStats(scorecard: TrustScorecard) {
    const dummy = new TrustEngine(process.cwd()); 
    const successRate = (dummy as any).calculateSuccessRate(scorecard);
    
    const successStreak = scorecard.success_streak || 0;
    const failureStreak = scorecard.failure_streak || 0;
    const now = new Date();
    const isInColdStart = scorecard.cold_start_end ? now < new Date(scorecard.cold_start_end) : false;

    const stages = { stage_1_observer: 30, stage_2_editor: 60, stage_3_developer: 80 };
    let stage: TrustStage = 4;
    if (scorecard.trust_score < stages.stage_1_observer) stage = 1;
    else if (scorecard.trust_score < stages.stage_2_editor) stage = 2;
    else if (scorecard.trust_score < stages.stage_3_developer) stage = 3;

    return {
        stage,
        successRate,
        isInColdStart,
        graceRemaining: scorecard.grace_failures_remaining ?? 0,
        currentStreak: {
            type: successStreak > failureStreak ? 'success' : 'failure',
            count: Math.max(successStreak, failureStreak)
        }
    };
}

export function getTrustStatus(workspaceDir: string) {
    const engine = new TrustEngine(workspaceDir);
    return engine.getStatusSummary();
}
