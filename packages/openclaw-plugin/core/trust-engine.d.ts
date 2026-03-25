/**
 * Trust Engine V2.1 - Recalibrated for Action Classification
 * Differentiates between Exploratory (safe) and Constructive (risky) actions.
 */
export interface TrustScorecard {
    trust_score: number;
    success_streak: number;
    failure_streak: number;
    exploratory_failure_streak: number;
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
    frozen?: boolean;
    reward_policy?: 'frozen_all_positive' | 'frozen_atomic_positive_keep_plan_ready';
}
export type TrustStage = 1 | 2 | 3 | 4;
export declare const EXPLORATORY_TOOLS: Set<string>;
export declare class TrustEngine {
    private scorecard;
    private workspaceDir;
    private stateDir;
    constructor(workspaceDir: string);
    private get config();
    private get trustSettings();
    private loadScorecard;
    private applyLegacyFreezeMetadata;
    private saveScorecard;
    getScore(): number;
    getScorecard(): TrustScorecard;
    getStage(): TrustStage;
    isColdStart(): boolean;
    recordSuccess(reason: string, context?: {
        sessionId?: string;
        api?: any;
        toolName?: string;
    }, isSubagent?: boolean): void;
    recordFailure(type: 'tool' | 'risky' | 'bypass', context: {
        sessionId?: string;
        api?: any;
        toolName?: string;
        error?: string;
    }): void;
    private touchScorecard;
    private updateScore;
    resetTrust(newScore?: number): void;
    getStatusSummary(): {
        stage: TrustStage;
        successRate: number;
        isInColdStart: boolean;
        graceRemaining: number;
        currentStreak: {
            type: string;
            count: number;
        };
    };
    private calculateSuccessRate;
}
export declare function recordSuccess(workspaceDir: string, reason: string, context?: {
    sessionId?: string;
    api?: any;
    toolName?: string;
}, isSubagent?: boolean): void;
export declare function recordFailure(type: 'tool' | 'risky' | 'bypass', workspaceDir: string, ctx: {
    sessionId?: string;
    api?: any;
    toolName?: string;
    error?: string;
}): void;
export declare function getAgentScorecard(workspaceDir: string): TrustScorecard;
export declare function getTrustStats(scorecard: TrustScorecard): {
    stage: TrustStage;
    successRate: any;
    isInColdStart: boolean;
    graceRemaining: number;
    currentStreak: {
        type: string;
        count: number;
    };
};
export declare function getTrustStatus(workspaceDir: string): {
    stage: TrustStage;
    successRate: number;
    isInColdStart: boolean;
    graceRemaining: number;
    currentStreak: {
        type: string;
        count: number;
    };
};
