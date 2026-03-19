/**
 * Trust Engine V2.1 - Recalibrated for Action Classification
 * Differentiates between Exploratory (safe) and Constructive (risky) actions.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginApi, SubagentWaitResult } from '../openclaw-sdk.js';
import { EventLogService } from './event-log.js';
import { resolvePdPath } from './paths.js';
import { ConfigService } from './config-service.js';
import { TrajectoryRegistry } from './trajectory.js';

export interface TrustScorecard {
    trust_score: number;
    success_streak: number;      // Constructive success streak
    failure_streak: number;      // Constructive failure streak
    exploratory_failure_streak: number; // For harmless failures (like file not found)
    grace_failures_remaining?: number;
    last_updated: string;
    cold_start_end?: string;
    first_activity_at?: string;
    history: Array<{
        type: 'success' | 'failure' | 'penalty' | 'info';
        delta: number;
        reason: string;
        timestamp: string;
    }>;
}

export type TrustStage = 1 | 2 | 3 | 4;

export const EXPLORATORY_TOOLS = [
    // 文件读取
    'read', 'read_file', 'read_many_files', 'image_read',
    // 搜索和列表
    'search_file_content', 'grep', 'grep_search', 'list_directory', 'ls', 'glob',
    // Web
    'web_fetch', 'web_search',
    // 用户交互
    'ask_user', 'ask_user_question',
    // LSP
    'lsp_hover', 'lsp_goto_definition', 'lsp_find_references',
    // 内存和状态
    'memory_recall', 'save_memory', 'todo_read', 'todo_write',
    // 状态查询
    'pd-status', 'trust', 'report',
];

export const CONSTRUCTIVE_TOOLS = [
    'write', 'write_file', 'edit', 'edit_file', 'replace', 'apply_patch',
    'insert', 'patch', 'delete_file', 'move_file', 'run_shell_command',
    'pd_spawn_agent', 'sessions_spawn', 'evolve-task', 'init-strategy'
];

export class TrustEngine {
    private scorecard: TrustScorecard;
    private workspaceDir: string;
    private stateDir: string;

    constructor(workspaceDir: string) {
        this.workspaceDir = workspaceDir;
        this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
        this.scorecard = this.loadScorecard();
        
        const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
        if (!fs.existsSync(scorecardPath)) {
            this.saveScorecard();
        }
    }

    private get config() {
        return ConfigService.get(this.stateDir);
    }

    private get trustSettings() {
        const settings = this.config.get('trust');
        return settings || {
            stages: { stage_1_observer: 30, stage_2_editor: 60, stage_3_developer: 80 },
            cold_start: { initial_trust: 85, grace_failures: 5, cold_start_period_ms: 86400000 },
            penalties: { tool_failure_base: -2, risky_failure_base: -10, gate_bypass_attempt: -5, failure_streak_multiplier: -2, max_penalty: -20 },
            rewards: { success_base: 2, subagent_success: 5, tool_success_reward: 0.2, streak_bonus_threshold: 3, streak_bonus: 5, recovery_boost: 5, max_reward: 15 },
            limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
        };
    }

    private loadScorecard(): TrustScorecard {
        const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
        const settings = this.trustSettings;

        if (fs.existsSync(scorecardPath)) {
            try {
                const raw = fs.readFileSync(scorecardPath, 'utf8');
                const data = JSON.parse(raw);
                if (data.score !== undefined && data.trust_score === undefined) data.trust_score = data.score;
                if (!data.history) data.history = [];
                if (data.exploratory_failure_streak === undefined) data.exploratory_failure_streak = 0;
                return data;
            } catch (e) {
                console.error(`[PD:TrustEngine] FATAL: Failed to parse scorecard at ${scorecardPath}. Resetting.`);
            }
        }

        const now = new Date();
        const coldStartEnd = new Date(now.getTime() + settings.cold_start.cold_start_period_ms);

        return {
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

    public getScore(): number { return this.scorecard.trust_score; }
    public getScorecard(): TrustScorecard { return this.scorecard; }

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

    public recordSuccess(reason: string, context?: { sessionId?: string; api?: any; toolName?: string }, isSubagent: boolean = false): void {
        const settings = this.trustSettings;
        const rewards = settings.rewards;
        const toolName = context?.toolName;

        // 1. Check if this is an exploratory tool success
        const isExploratory = toolName && EXPLORATORY_TOOLS.includes(toolName);

        if (reason === 'tool_success' && isExploratory) {
            // Exploratory tools don't grant trust points, but they:
            // 1. Reset the exploratory failure streak
            // 2. Prove the agent isn't stuck (no delta, no success_streak increment)
            this.scorecard.exploratory_failure_streak = 0;
            this.updateScore(0, `Exploratory Success: ${toolName}`, 'info', context);
            return;
        }

        let delta = rewards.success_base;
        if (isSubagent) {
            delta = rewards.subagent_success;
        } else if (reason === 'tool_success') {
            delta = rewards.tool_success_reward ?? 0.2;
        } else if (reason === 'plan_ready') {
            delta = 5; // Strategic reward
        }

        this.scorecard.success_streak++;
        this.scorecard.failure_streak = 0; // Reset failure streak on constructive success
        this.scorecard.exploratory_failure_streak = 0;
        
        if (this.scorecard.success_streak >= rewards.streak_bonus_threshold) {
            delta += rewards.streak_bonus;
        }

        if (this.scorecard.trust_score < settings.stages.stage_1_observer) {
            delta += rewards.recovery_boost;
        }

        this.updateScore(delta, reason, 'success', context);
    }

    public recordFailure(type: 'tool' | 'risky' | 'bypass', context: { sessionId?: string; api?: any; toolName?: string }): void {
        const settings = this.trustSettings;
        const penalties = settings.penalties;
        const toolName = context?.toolName;

        // 1. Classification: Is this an exploratory failure?
        const isExploratory = toolName && EXPLORATORY_TOOLS.includes(toolName);

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

        // 3. Constructive Failure (Risky or failed writes)
        let delta = 0;
        switch (type) {
            case 'tool': delta = penalties.tool_failure_base; break;
            case 'risky': delta = penalties.risky_failure_base; break;
            case 'bypass': delta = penalties.gate_bypass_attempt; break;
        }

        this.scorecard.failure_streak++;
        this.scorecard.success_streak = 0;

        // Safety cap: streak multiplier only applies up to 5 consecutive failures
        // to prevent "death spiral" from cascading errors
        const effectiveStreak = Math.min(this.scorecard.failure_streak, 5);
        if (effectiveStreak > 1) {
            delta += (effectiveStreak - 1) * penalties.failure_streak_multiplier;
        }

        if (delta < penalties.max_penalty) delta = penalties.max_penalty;

        this.updateScore(delta, `Failure: ${toolName || type}`, 'failure', context);
    }

    private updateScore(delta: number, reason: string, type: 'success' | 'failure' | 'penalty' | 'info', context?: { sessionId?: string; api?: any }): void {
        const oldScore = this.scorecard.trust_score;
        this.scorecard.trust_score += delta;
        if (this.scorecard.trust_score < 0) this.scorecard.trust_score = 0;
        if (this.scorecard.trust_score > 100) this.scorecard.trust_score = 100;

        this.scorecard.last_updated = new Date().toISOString();
        if (!this.scorecard.history) this.scorecard.history = [];
        this.scorecard.history.push({ type, delta, reason, timestamp: new Date().toISOString() });

        if (context?.sessionId) {
            const eventLog = EventLogService.get(this.stateDir);
            eventLog.recordTrustChange(context.sessionId, { previousScore: oldScore, newScore: this.scorecard.trust_score, delta, reason });
        }
        try {
            TrajectoryRegistry.use(this.workspaceDir, (trajectory) => {
                trajectory.recordTrustChange({
                    sessionId: context?.sessionId,
                    previousScore: oldScore,
                    newScore: this.scorecard.trust_score,
                    delta,
                    reason,
                });
            });
        } catch {
            // Do not block trust updates if trajectory storage is unavailable.
        }

        const limit = this.trustSettings.history_limit || 50;
        if (this.scorecard.history.length > limit) {
            this.scorecard.history.shift();
        }
        this.saveScorecard();
    }

    public resetTrust(newScore?: number): void {
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
        this.saveScorecard();
    }

    public getStatusSummary() {
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

    private calculateSuccessRate(scorecard: TrustScorecard): number {
        if (!scorecard.history || scorecard.history.length === 0) return 100;
        const recent = scorecard.history.slice(-20);
        const successes = recent.filter(h => h.type === 'success').length;
        return Math.round((successes / recent.length) * 100);
    }
}

export function recordSuccess(workspaceDir: string, reason: string, context?: { sessionId?: string; api?: any; toolName?: string }, isSubagent: boolean = false): void {
    new TrustEngine(workspaceDir).recordSuccess(reason, context, isSubagent);
}

export function recordFailure(type: 'tool' | 'risky' | 'bypass', workspaceDir: string, ctx: { sessionId?: string; api?: any; toolName?: string }): void {
    new TrustEngine(workspaceDir).recordFailure(type, ctx);
}

export function getAgentScorecard(workspaceDir: string): TrustScorecard {
    return new TrustEngine(workspaceDir).getScorecard();
}

export function getTrustStats(scorecard: TrustScorecard) {
    const dummy = new TrustEngine(process.cwd()); 
    const successRate = (dummy as any).calculateSuccessRate(scorecard);
    const stages = { stage_1_observer: 30, stage_2_editor: 60, stage_3_developer: 80 };
    let stage: TrustStage = scorecard.trust_score < stages.stage_1_observer ? 1 : 
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

export function getTrustStatus(workspaceDir: string) {
    return new TrustEngine(workspaceDir).getStatusSummary();
}
