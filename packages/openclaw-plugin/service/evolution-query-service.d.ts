/**
 * EvolutionQueryService - 进化流程查询服务
 *
 * 提供 WebUI 所需的查询 API：
 * - getTasks() - 获取任务列表
 * - getEvents() - 获取事件流
 * - getTrace() - 获取完整追踪
 * - getStats() - 获取统计数据
 */
import type { TrajectoryDatabase } from '../core/trajectory.js';
export interface TaskListFilters {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
}
export interface EventFilters {
    traceId?: string;
    stage?: string;
    limit?: number;
    offset?: number;
}
export interface TasksResponse {
    items: Array<{
        taskId: string;
        traceId: string;
        source: string;
        reason: string | null;
        score: number;
        status: string;
        enqueuedAt: string | null;
        startedAt: string | null;
        completedAt: string | null;
        duration: number | null;
        resolution: string | null;
        eventCount: number;
        createdAt: string;
    }>;
    pagination: {
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
    };
}
export interface EventsResponse {
    items: Array<{
        id: number;
        traceId: string;
        taskId: string | null;
        stage: string;
        stageLabel: string;
        stageColor: string;
        level: string;
        message: string;
        summary: string | null;
        metadata: Record<string, unknown>;
        createdAt: string;
    }>;
    pagination: {
        limit: number;
        offset: number;
        hasMore: boolean;
    };
}
export interface TraceDetailResponse {
    traceId: string;
    task: {
        taskId: string;
        traceId: string;
        source: string;
        reason: string | null;
        score: number;
        status: string;
        enqueuedAt: string | null;
        startedAt: string | null;
        completedAt: string | null;
        duration: number | null;
        resolution: string | null;
        createdAt: string;
        updatedAt: string;
    };
    events: Array<{
        id: number;
        traceId: string;
        taskId: string | null;
        stage: string;
        stageLabel: string;
        stageColor: string;
        level: string;
        message: string;
        summary: string | null;
        metadata: Record<string, unknown>;
        createdAt: string;
    }>;
    timeline: Array<{
        stage: string;
        stageLabel: string;
        stageColor: string;
        timestamp: string;
        message: string;
        summary: string | null;
    }>;
}
export interface EvolutionStatsResponse {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    recentActivity: Array<{
        day: string;
        created: number;
        completed: number;
    }>;
    stageDistribution: Array<{
        stage: string;
        stageLabel: string;
        count: number;
    }>;
}
/**
 * EvolutionQueryService 类
 * 封装进化流程的查询逻辑
 */
export declare class EvolutionQueryService {
    private readonly trajectory;
    constructor(trajectory: TrajectoryDatabase);
    /**
     * 释放资源
     * 注意：不关闭 trajectory，因为它是单例由 TrajectoryRegistry 管理
     */
    dispose(): void;
    /**
     * 获取任务列表（带分页、筛选）
     */
    getTasks(filters?: TaskListFilters): TasksResponse;
    /**
     * 获取事件流
     */
    getEvents(filters?: EventFilters): EventsResponse;
    /**
     * 获取完整追踪（单个 trace 的所有事件）
     */
    getTrace(traceId: string): TraceDetailResponse | null;
    /**
     * 获取统计数据
     */
    getStats(): EvolutionStatsResponse;
}
/**
 * 获取 EvolutionQueryService 实例（单例）
 */
export declare function getEvolutionQueryService(trajectory: TrajectoryDatabase): EvolutionQueryService;
