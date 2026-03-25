/**
 * EvolutionLogger - 进化流程日志服务
 *
 * 提供两层日志：
 * - 技术层：结构化 JSON，包含 trace_id、stage、metadata
 * - 用户层：中文摘要，便于小白用户理解
 *
 * 日志写入两个地方：
 * 1. SYSTEM_LOG (system.jsonl) - 技术细节
 * 2. evolution_events 表 (SQLite) - 结构化查询
 */
import type { TrajectoryDatabase } from './trajectory.js';
export type EvolutionStage = 'pain_detected' | 'queued' | 'started' | 'analyzing' | 'principle_generated' | 'completed' | 'failed';
export type EvolutionLogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface EvolutionLogEntry {
    traceId: string;
    stage: EvolutionStage;
    level: EvolutionLogLevel;
    message: string;
    summary: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
    taskId?: string;
    sessionId?: string;
}
export interface EvolutionLogInput {
    traceId: string;
    stage: EvolutionStage;
    level?: EvolutionLogLevel;
    message: string;
    summary: string;
    metadata?: Record<string, unknown>;
    taskId?: string;
    sessionId?: string;
}
export declare const STAGE_LABELS: Record<EvolutionStage, string>;
export declare const STAGE_COLORS: Record<EvolutionStage, string>;
/**
 * 创建新的 trace_id
 * 格式: ev_{timestamp}_{random}
 * 使用 crypto.randomBytes 确保不可预测性
 */
export declare function createTraceId(): string;
/**
 * EvolutionLogger 类
 * 管理进化流程的日志记录
 */
export declare class EvolutionLogger {
    private readonly workspaceDir;
    private readonly trajectory;
    constructor(workspaceDir: string, trajectory?: TrajectoryDatabase);
    /**
     * 记录进化事件
     * 同时写入 SYSTEM_LOG 和 evolution_events 表
     */
    log(input: EvolutionLogInput): void;
    /**
     * 记录 pain_detected 事件
     */
    logPainDetected(params: {
        traceId: string;
        source: string;
        reason: string;
        score: number;
        toolName?: string;
        filePath?: string;
        sessionId?: string;
    }): void;
    /**
     * 记录 queued 事件
     */
    logQueued(params: {
        traceId: string;
        taskId: string;
        score: number;
        source: string;
        reason: string;
    }): void;
    /**
     * 记录 started 事件
     */
    logStarted(params: {
        traceId: string;
        taskId: string;
    }): void;
    /**
     * 记录 analyzing 事件
     */
    logAnalyzing(params: {
        traceId: string;
        taskId: string;
        analysisType?: string;
    }): void;
    /**
     * 记录 principle_generated 事件
     */
    logPrincipleGenerated(params: {
        traceId: string;
        taskId: string;
        principleId: string;
        principleText: string;
    }): void;
    /**
     * 记录 completed 事件
     */
    logCompleted(params: {
        traceId: string;
        taskId: string;
        resolution: 'marker_detected' | 'auto_completed_timeout' | 'manual';
        durationMs?: number;
        principlesGenerated?: number;
    }): void;
    /**
     * 记录 failed 事件
     */
    logFailed(params: {
        traceId: string;
        taskId: string;
        error: string;
        stack?: string;
    }): void;
}
/**
 * 获取 EvolutionLogger 实例（单例）
 *
 * 注意：带 trajectory 和不带 trajectory 的请求会返回不同的实例，
 * 因为 trajectory 影响事件持久化行为。
 */
export declare function getEvolutionLogger(workspaceDir: string, trajectory?: TrajectoryDatabase): EvolutionLogger;
/**
 * 清理指定 workspace 的 logger 缓存
 */
export declare function disposeEvolutionLogger(workspaceDir: string): boolean;
/**
 * 清理所有 logger 缓存（用于测试或进程退出）
 */
export declare function disposeAllEvolutionLoggers(): void;
