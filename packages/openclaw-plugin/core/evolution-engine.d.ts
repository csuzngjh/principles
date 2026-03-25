/**
 * Evolution Engine V2.0 - MVP
 *
 * 成长驱动的进化积分系统，替代惩罚驱动的 Trust Engine。
 *
 * 核心原则：
 * 1. 起点0分，只能增加，不扣分
 * 2. 失败记录教训，不扣分
 * 3. 同类任务失败后首次成功 = 双倍奖励（1小时冷却）
 * 4. 高等级做低级任务积分衰减
 * 5. 原子写入防止并发损坏
 */
import { EvolutionTier, EvolutionScorecard, EvolutionStats, EvolutionConfig, TaskDifficulty, TierDefinition, TierPermissions, GateDecision, ToolCallContext } from './evolution-types.js';
export declare class EvolutionEngine {
    private scorecard;
    private workspaceDir;
    private stateDir;
    private config;
    private storagePath;
    constructor(workspaceDir: string, config?: Partial<EvolutionConfig>);
    /** 获取当前积分 */
    getPoints(): number;
    /** 获取可用积分 */
    getAvailablePoints(): number;
    /** 获取当前等级 */
    getTier(): EvolutionTier;
    /** 获取当前等级定义 */
    getTierDefinition(): TierDefinition;
    /** 获取完整积分卡 */
    getScorecard(): EvolutionScorecard;
    /** 获取统计信息 */
    getStats(): EvolutionStats;
    /** 获取状态摘要 */
    getStatusSummary(): {
        tier: EvolutionTier;
        tierName: string;
        totalPoints: number;
        availablePoints: number;
        permissions: TierPermissions;
        stats: EvolutionStats;
        nextTier: {
            tier: EvolutionTier;
            name: string;
            pointsNeeded: number;
        } | null;
    };
    recordSuccess(toolName: string, options?: {
        filePath?: string;
        difficulty?: TaskDifficulty;
        reason?: string;
        sessionId?: string;
    }): {
        pointsAwarded: number;
        isDoubleReward: boolean;
        newTier?: EvolutionTier;
    };
    recordFailure(toolName: string, options?: {
        filePath?: string;
        difficulty?: TaskDifficulty;
        reason?: string;
        sessionId?: string;
    }): {
        pointsAwarded: number;
        lessonRecorded: boolean;
    };
    /** 工具调用前检查 */
    beforeToolCall(context: ToolCallContext): GateDecision;
    private calculatePoints;
    private getDifficultyPenalty;
    private canReceiveDoubleReward;
    private checkAndApplyPromotion;
    private inferDifficulty;
    private computeTaskHash;
    private createEvent;
    private addEvent;
    private loadOrCreateScorecard;
    private createNewScorecard;
    /** 持久化评分卡（含锁保护） */
    private saveScorecard;
    /** Per-instance retry queue (P0 fix: was static, causing cross-instance race) */
    private retryQueue;
    private retryTimer;
    /** 调度重试保存 */
    private scheduleRetrySave;
    /** 处理重试队列 */
    private processRetryQueue;
    /** 无锁快速保存（用于重试） */
    private saveScorecardImmediate;
    private generateId;
    dispose(): void;
}
/** 获取指定 workspace 的引擎实例 */
export declare function getEvolutionEngine(workspaceDir: string): EvolutionEngine;
export declare function disposeEvolutionEngine(workspaceDir: string): void;
export declare function disposeAllEvolutionEngines(): void;
/** 记录成功（便捷函数） */
export declare function recordEvolutionSuccess(workspaceDir: string, toolName: string, options?: {
    filePath?: string;
    difficulty?: TaskDifficulty;
    reason?: string;
    sessionId?: string;
}): {
    pointsAwarded: number;
    isDoubleReward: boolean;
    newTier?: EvolutionTier;
};
/** 记录失败（便捷函数） */
export declare function recordEvolutionFailure(workspaceDir: string, toolName: string, options?: {
    filePath?: string;
    difficulty?: TaskDifficulty;
    reason?: string;
    sessionId?: string;
}): {
    pointsAwarded: number;
    lessonRecorded: boolean;
};
/** Gate 检查（便捷函数） */
export declare function checkEvolutionGate(workspaceDir: string, context: ToolCallContext): GateDecision;
