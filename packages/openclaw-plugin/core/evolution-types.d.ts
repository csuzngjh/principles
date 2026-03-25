/**
 * Evolution Points System V2.0 - MVP
 *
 * Core Philosophy: Growth-driven替代Penalty-driven
 * - 起点0分，只能增加，不扣分
 * - 失败记录教训，不扣分
 * - 同类任务失败后首次成功 = 双倍奖励（1小时冷却）
 * - 5级成长路径：Seed → Forest
 */
export declare enum EvolutionTier {
    Seed = 1,// 萌芽：只读 + 基础文档
    Sprout = 2,// 新芽：单文件编辑 (<50行)
    Sapling = 3,// 幼苗：多文件 + 测试 + 子智能体
    Tree = 4,// 大树：重构 + 风险路径
    Forest = 5
}
export interface TierPermissions {
    maxLinesPerWrite: number;
    maxFilesPerTask: number;
    allowRiskPath: boolean;
    allowSubagentSpawn: boolean;
}
export interface TierDefinition {
    tier: EvolutionTier;
    name: string;
    requiredPoints: number;
    permissions: TierPermissions;
}
export declare const TIER_DEFINITIONS: readonly TierDefinition[];
export declare function getTierDefinition(tier: EvolutionTier): TierDefinition;
export declare function getTierByPoints(totalPoints: number): EvolutionTier;
export type TaskDifficulty = 'trivial' | 'normal' | 'hard';
export interface TaskDifficultyConfig {
    basePoints: number;
    description: string;
}
export declare const TASK_DIFFICULTY_CONFIG: Record<TaskDifficulty, TaskDifficultyConfig>;
export type EvolutionEventType = 'success' | 'failure';
export interface EvolutionEvent {
    id: string;
    timestamp: string;
    type: EvolutionEventType;
    taskHash: string;
    taskDifficulty: TaskDifficulty;
    toolName?: string;
    filePath?: string;
    reason?: string;
    pointsAwarded: number;
    isDoubleReward: boolean;
    sessionId?: string;
}
export interface EvolutionScorecard {
    version: '2.0';
    agentId: string;
    totalPoints: number;
    availablePoints: number;
    currentTier: EvolutionTier;
    lastDoubleRewardTime?: string;
    recentFailureHashes: Map<string, string>;
    stats: EvolutionStats;
    recentEvents: EvolutionEvent[];
    lastUpdated: string;
}
export interface EvolutionStats {
    totalSuccesses: number;
    totalFailures: number;
    consecutiveSuccesses: number;
    consecutiveFailures: number;
    doubleRewardsEarned: number;
    tierPromotions: number;
    pointsByDifficulty: Record<TaskDifficulty, number>;
}
export interface EvolutionStorage {
    scorecard: EvolutionScorecard;
    archivedStats: {
        totalEventsProcessed: number;
        pointsFromTrivial: number;
        pointsFromNormal: number;
        pointsFromHard: number;
    };
}
export interface EvolutionConfig {
    /** 双倍奖励冷却时间（毫秒），默认1小时 */
    doubleRewardCooldownMs: number;
    /** 保存的最近事件数量，默认50 */
    maxRecentEvents: number;
    /** 高等级做低级任务的积分衰减系数 */
    difficultyPenalty: {
        tier4Trivial: number;
        tier4Normal: number;
        tier5Trivial: number;
        tier5Normal: number;
    };
    /** 信任分系统双轨运行时的配置 */
    dualTrack: {
        enabled: boolean;
        primarySystem: 'trust' | 'evolution';
    };
}
export declare const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig;
export interface ArchivedEventStats {
    totalEventsProcessed: number;
    pointsFromTrivial: number;
    pointsFromNormal: number;
    pointsFromHard: number;
}
export interface GateDecision {
    allowed: boolean;
    reason?: string;
    currentTier?: EvolutionTier;
    requiredTier?: EvolutionTier;
}
export interface ToolCallContext {
    toolName: string;
    filePath?: string;
    content?: string;
    lineCount?: number;
    isRiskPath?: boolean;
}
export interface TierPromotionEvent {
    previousTier: EvolutionTier;
    newTier: EvolutionTier;
    totalPoints: number;
    timestamp: string;
    newPermissions: TierPermissions;
}
export type PrincipleStatus = 'candidate' | 'probation' | 'active' | 'deprecated';
export interface Principle {
    id: string;
    version: number;
    text: string;
    source: {
        painId: string;
        painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
        timestamp: string;
    };
    trigger: string;
    action: string;
    guardrails?: string[];
    contextTags: string[];
    validation: {
        successCount: number;
        conflictCount: number;
    };
    status: PrincipleStatus;
    feedbackScore: number;
    usageCount: number;
    createdAt: string;
    activatedAt?: string;
    deprecatedAt?: string;
}
export type EvolutionLoopEventType = 'pain_detected' | 'candidate_created' | 'principle_promoted' | 'principle_deprecated' | 'principle_rolled_back' | 'circuit_breaker_opened' | 'legacy_import';
export interface PainDetectedData {
    painId: string;
    painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
    source: string;
    reason: string;
    score?: number;
    sessionId?: string;
    agentId?: string;
    taskId?: string;
    traceId?: string;
}
export interface CandidateCreatedData {
    painId: string;
    principleId: string;
    trigger: string;
    action: string;
    status: 'candidate';
}
export interface PrinciplePromotedData {
    principleId: string;
    from: 'candidate' | 'probation';
    to: 'probation' | 'active';
    reason: string;
    successCount?: number;
}
export interface PrincipleDeprecatedData {
    principleId: string;
    reason: string;
    triggeredBy: 'auto' | 'manual';
}
export interface PrincipleRolledBackData {
    principleId: string;
    reason: string;
    triggeredBy: 'user_command' | 'auto_conflict';
    blacklistPattern?: string;
    relatedPainId?: string;
}
export interface CircuitBreakerOpenedData {
    taskId: string;
    painId: string;
    failCount: number;
    reason: string;
    requireHuman: boolean;
    nextRetryAt?: string;
}
export interface LegacyImportData {
    sourceFile: string;
    content: string;
    contentHash?: string;
}
export type EvolutionLoopEvent = {
    ts: string;
    type: 'pain_detected';
    data: PainDetectedData;
} | {
    ts: string;
    type: 'pain_recorded';
    data: PainDetectedData;
} | {
    ts: string;
    type: 'candidate_created';
    data: CandidateCreatedData;
} | {
    ts: string;
    type: 'principle_promoted';
    data: PrinciplePromotedData;
} | {
    ts: string;
    type: 'principle_deprecated';
    data: PrincipleDeprecatedData;
} | {
    ts: string;
    type: 'principle_rolled_back';
    data: PrincipleRolledBackData;
} | {
    ts: string;
    type: 'circuit_breaker_opened';
    data: CircuitBreakerOpenedData;
} | {
    ts: string;
    type: 'legacy_import';
    data: LegacyImportData;
};
