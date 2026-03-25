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
import { randomBytes } from 'crypto';
import { SystemLogger } from './system-logger.js';
// 阶段对应的中文标签
export const STAGE_LABELS = {
    pain_detected: '痛点检测',
    queued: '加入队列',
    started: '开始处理',
    analyzing: '分析中',
    principle_generated: '原则生成',
    completed: '完成',
    failed: '失败',
};
// 阶段对应的颜色（用于 UI）
export const STAGE_COLORS = {
    pain_detected: '#ef4444', // 红色
    queued: '#f59e0b', // 橙色
    started: '#3b82f6', // 蓝色
    analyzing: '#8b5cf6', // 紫色
    principle_generated: '#10b981', // 绿色
    completed: '#22c55e', // 绿色
    failed: '#dc2626', // 深红色
};
/**
 * 创建新的 trace_id
 * 格式: ev_{timestamp}_{random}
 * 使用 crypto.randomBytes 确保不可预测性
 */
export function createTraceId() {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(3).toString('hex');
    return `ev_${timestamp}_${random}`;
}
/**
 * EvolutionLogger 类
 * 管理进化流程的日志记录
 */
export class EvolutionLogger {
    workspaceDir;
    trajectory;
    constructor(workspaceDir, trajectory) {
        this.workspaceDir = workspaceDir;
        this.trajectory = trajectory || null;
    }
    /**
     * 记录进化事件
     * 同时写入 SYSTEM_LOG 和 evolution_events 表
     */
    log(input) {
        const entry = {
            ...input,
            level: input.level || 'info',
            timestamp: new Date().toISOString(),
        };
        // 1. 写入 SYSTEM_LOG (技术细节)
        SystemLogger.log(this.workspaceDir, 'EVOLUTION', JSON.stringify({
            traceId: entry.traceId,
            stage: entry.stage,
            level: entry.level,
            message: entry.message,
            taskId: entry.taskId,
            sessionId: entry.sessionId,
            metadata: entry.metadata,
        }));
        // 2. 写入 evolution_events 表 (如果有 trajectory)
        if (this.trajectory) {
            try {
                this.trajectory.recordEvolutionEvent({
                    traceId: entry.traceId,
                    taskId: entry.taskId,
                    stage: entry.stage,
                    level: entry.level,
                    message: entry.message,
                    summary: entry.summary,
                    metadata: entry.metadata,
                    createdAt: entry.timestamp,
                });
            }
            catch (err) {
                // 数据库写入失败不影响主流程
                console.error(`[EvolutionLogger] Failed to write to trajectory: ${String(err)}`);
            }
        }
    }
    /**
     * 记录 pain_detected 事件
     */
    logPainDetected(params) {
        this.log({
            traceId: params.traceId,
            stage: 'pain_detected',
            level: 'info',
            message: `Pain detected: ${params.source} - ${params.reason}`,
            summary: `检测到痛点：${params.source} - ${params.reason}`,
            metadata: {
                score: params.score,
                toolName: params.toolName,
                filePath: params.filePath,
            },
            sessionId: params.sessionId,
        });
    }
    /**
     * 记录 queued 事件
     */
    logQueued(params) {
        this.log({
            traceId: params.traceId,
            taskId: params.taskId,
            stage: 'queued',
            level: 'info',
            message: `Task ${params.taskId} enqueued with score ${params.score}`,
            summary: `任务 ${params.taskId} 已加入进化队列，优先级分数 ${params.score}`,
            metadata: {
                score: params.score,
                source: params.source,
                reason: params.reason,
            },
        });
    }
    /**
     * 记录 started 事件
     */
    logStarted(params) {
        this.log({
            traceId: params.traceId,
            taskId: params.taskId,
            stage: 'started',
            level: 'info',
            message: `Task ${params.taskId} started processing`,
            summary: `任务 ${params.taskId} 开始处理，Diagnostician 正在分析...`,
        });
    }
    /**
     * 记录 analyzing 事件
     */
    logAnalyzing(params) {
        this.log({
            traceId: params.traceId,
            taskId: params.taskId,
            stage: 'analyzing',
            level: 'info',
            message: `Task ${params.taskId} analysis started`,
            summary: `任务 ${params.taskId} 正在分析根因...`,
            metadata: {
                analysisType: params.analysisType,
            },
        });
    }
    /**
     * 记录 principle_generated 事件
     */
    logPrincipleGenerated(params) {
        const truncatedText = params.principleText.length > 100
            ? params.principleText.substring(0, 100) + '...'
            : params.principleText;
        this.log({
            traceId: params.traceId,
            taskId: params.taskId,
            stage: 'principle_generated',
            level: 'info',
            message: `Principle ${params.principleId} generated for task ${params.taskId}`,
            summary: `生成新原则：${truncatedText}`,
            metadata: {
                principleId: params.principleId,
                principleText: params.principleText,
            },
        });
    }
    /**
     * 记录 completed 事件
     */
    logCompleted(params) {
        let summary;
        if (params.resolution === 'marker_detected') {
            summary = `任务 ${params.taskId} 完成，已生成 ${params.principlesGenerated || 0} 条原则`;
        }
        else if (params.resolution === 'auto_completed_timeout') {
            summary = `任务 ${params.taskId} 超时自动完成`;
        }
        else {
            summary = `任务 ${params.taskId} 已完成`;
        }
        this.log({
            traceId: params.traceId,
            taskId: params.taskId,
            stage: 'completed',
            level: params.resolution === 'auto_completed_timeout' ? 'warn' : 'info',
            message: `Task ${params.taskId} completed with resolution: ${params.resolution}`,
            summary,
            metadata: {
                resolution: params.resolution,
                durationMs: params.durationMs,
                principlesGenerated: params.principlesGenerated,
            },
        });
    }
    /**
     * 记录 failed 事件
     */
    logFailed(params) {
        this.log({
            traceId: params.traceId,
            taskId: params.taskId,
            stage: 'failed',
            level: 'error',
            message: `Task ${params.taskId} failed: ${params.error}`,
            summary: `任务 ${params.taskId} 失败：${params.error}`,
            metadata: {
                error: params.error,
                stack: params.stack,
            },
        });
    }
}
// 单例缓存：键格式为 "workspaceDir" 或 "workspaceDir::with_trajectory"
const loggerCache = new Map();
/**
 * 获取 EvolutionLogger 实例（单例）
 *
 * 注意：带 trajectory 和不带 trajectory 的请求会返回不同的实例，
 * 因为 trajectory 影响事件持久化行为。
 */
export function getEvolutionLogger(workspaceDir, trajectory) {
    // 缓存键区分是否带 trajectory，避免持久化行为不一致
    const cacheKey = trajectory ? `${workspaceDir}::with_trajectory` : workspaceDir;
    const cached = loggerCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const logger = new EvolutionLogger(workspaceDir, trajectory);
    loggerCache.set(cacheKey, logger);
    return logger;
}
/**
 * 清理指定 workspace 的 logger 缓存
 */
export function disposeEvolutionLogger(workspaceDir) {
    return loggerCache.delete(workspaceDir);
}
/**
 * 清理所有 logger 缓存（用于测试或进程退出）
 */
export function disposeAllEvolutionLoggers() {
    loggerCache.clear();
}
