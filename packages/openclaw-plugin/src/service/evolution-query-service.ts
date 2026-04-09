/**
 * EvolutionQueryService - 进化流程查询服务
 *
 * 提供 WebUI 所需的查询 API：
 * - getTasks() - 获取任务列表
 * - getEvents() - 获取事件流
 * - getTrace() - 获取完整追踪
 * - getStats() - 获取统计数据
 */

import type { TrajectoryDatabase, EvolutionTaskRecord, EvolutionEventRecord } from '../core/trajectory.js';
import { STAGE_LABELS, STAGE_COLORS } from '../core/evolution-logger.js';

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
  items: {
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
  }[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface EventsResponse {
  items: {
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
  }[];
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
  events: {
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
  }[];
  timeline: {
    stage: string;
    stageLabel: string;
    stageColor: string;
    timestamp: string;
    message: string;
    summary: string | null;
  }[];
}

export interface EvolutionStatsResponse {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  recentActivity: {
    day: string;
    created: number;
    completed: number;
  }[];
  stageDistribution: {
    stage: string;
    stageLabel: string;
    count: number;
  }[];
}

/**
 * 计算任务持续时间（毫秒）
 */
function calculateDuration(task: EvolutionTaskRecord): number | null {
  if (!task.startedAt) return null;
  const start = new Date(task.startedAt).getTime();
  const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  return end - start;
}

/**
 * EvolutionQueryService 类
 * 封装进化流程的查询逻辑
 */
export class EvolutionQueryService {
  private readonly trajectory: TrajectoryDatabase;

  constructor(trajectory: TrajectoryDatabase) {
    this.trajectory = trajectory;
  }

  /**
   * 释放资源
   * 注意：不关闭 trajectory，因为它是单例由 TrajectoryRegistry 管理
   */
  dispose(): void {
    // EvolutionQueryService 不拥有 trajectory，所以不关闭它
    // trajectory 是由 TrajectoryRegistry 管理的单例
  }

  /**
   * 获取任务列表（带分页、筛选）
   */
  getTasks(filters: TaskListFilters = {}): TasksResponse {
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    // 获取任务列表
    const tasks = this.trajectory.listEvolutionTasks({
      status: filters.status,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      limit: pageSize + 1, // 多取一条判断 hasMore
      offset,
    });

    // 获取总数（简化实现，使用全量计数）
    const allTasks = this.trajectory.listEvolutionTasks({
      status: filters.status,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      limit: 10000,
      offset: 0,
    });
    const total = allTasks.length;
    const totalPages = Math.ceil(total / pageSize);

    // 组装响应
    const items = tasks.slice(0, pageSize).map((task) => {
      // 获取事件数量
      const events = this.trajectory.listEvolutionEvents(task.traceId, { limit: 1000 });

      return {
        taskId: task.taskId,
        traceId: task.traceId,
        source: task.source,
        reason: task.reason,
        score: task.score,
        status: task.status,
        enqueuedAt: task.enqueuedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        duration: calculateDuration(task),
        resolution: task.resolution,
        eventCount: events.length,
        createdAt: task.createdAt,
      };
    });

    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    };
  }

  /**
   * 获取事件流
   */
  getEvents(filters: EventFilters = {}): EventsResponse {
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    // 获取更多事件以支持 stage 过滤
    const fetchLimit = filters.stage ? 500 : limit + 1;
    const events = this.trajectory.listEvolutionEvents(filters.traceId, {
      limit: fetchLimit,
      offset: 0, // 从头获取，后续再过滤和分页
    });

    // 应用 stage 过滤
    let filteredEvents = events;
    if (filters.stage) {
      filteredEvents = events.filter(event => event.stage === filters.stage);
    }

    // 应用分页
    const hasMore = filteredEvents.length > offset + limit;
    const items = filteredEvents.slice(offset, offset + limit).map((event) => ({
      id: event.id,
      traceId: event.traceId,
      taskId: event.taskId,
      stage: event.stage,
      stageLabel: STAGE_LABELS[event.stage as keyof typeof STAGE_LABELS] || event.stage,
      stageColor: STAGE_COLORS[event.stage as keyof typeof STAGE_COLORS] || '#6b7280',
      level: event.level,
      message: event.message,
      summary: event.summary,
      metadata: event.metadata,
      createdAt: event.createdAt,
    }));

    return {
      items,
      pagination: {
        limit,
        offset,
        hasMore,
      },
    };
  }

  /**
   * 获取完整追踪（单个 trace 的所有事件）
   */
  getTrace(traceId: string): TraceDetailResponse | null {
    // 获取任务信息
    const task = this.trajectory.getEvolutionTaskByTraceId(traceId);
    if (!task) return null;

    // 获取所有事件
    const events = this.trajectory.listEvolutionEvents(traceId, { limit: 1000 });

    // 构建时间线
    const timeline = events.map((event) => ({
      stage: event.stage,
      stageLabel: STAGE_LABELS[event.stage as keyof typeof STAGE_LABELS] || event.stage,
      stageColor: STAGE_COLORS[event.stage as keyof typeof STAGE_COLORS] || '#6b7280',
      timestamp: event.createdAt,
      message: event.message,
      summary: event.summary,
    }));

    return {
      traceId,
      task: {
        taskId: task.taskId,
        traceId: task.traceId,
        source: task.source,
        reason: task.reason,
        score: task.score,
        status: task.status,
        enqueuedAt: task.enqueuedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        duration: calculateDuration(task),
        resolution: task.resolution,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      events: events.map((event) => ({
        id: event.id,
        traceId: event.traceId,
        taskId: event.taskId,
        stage: event.stage,
        stageLabel: STAGE_LABELS[event.stage as keyof typeof STAGE_LABELS] || event.stage,
        stageColor: STAGE_COLORS[event.stage as keyof typeof STAGE_COLORS] || '#6b7280',
        level: event.level,
        message: event.message,
        summary: event.summary,
        metadata: event.metadata,
        createdAt: event.createdAt,
      })),
      timeline,
    };
  }

  /**
   * 获取统计数据
   */
  getStats(days = 30): EvolutionStatsResponse {
    // 获取基础统计
    const stats = this.trajectory.getEvolutionStats();

    // 获取近期活动
    const now = new Date();
    const daysAgo = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const recentTasks = this.trajectory.listEvolutionTasks({
      dateFrom: daysAgo.toISOString(),
      limit: 10000,
    });

    // 按天分组
    const activityByDay = new Map<string, { created: number; completed: number }>();
    for (let i = 0; i < days; i++) {
      const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayStr = day.toISOString().split('T')[0];
      activityByDay.set(dayStr, { created: 0, completed: 0 });
    }

    for (const task of recentTasks) {
      const [createdDay] = task.createdAt.split('T');
      if (activityByDay.has(createdDay)) {
        const entry = activityByDay.get(createdDay)!;
        entry.created++;
      }
      if (task.completedAt) {
        const [completedDay] = task.completedAt.split('T');
        if (activityByDay.has(completedDay)) {
          const entry = activityByDay.get(completedDay)!;
          entry.completed++;
        }
      }
    }

    const recentActivity = Array.from(activityByDay.entries())
      .map(([day, data]) => ({ day, ...data }))
      .sort((a, b) => a.day.localeCompare(b.day));

    // 获取阶段分布
    const allEvents = this.trajectory.listEvolutionEvents(undefined, { limit: 10000 });
    const stageCount = new Map<string, number>();
    for (const event of allEvents) {
      stageCount.set(event.stage, (stageCount.get(event.stage) || 0) + 1);
    }

    const stageDistribution = Array.from(stageCount.entries())
      .map(([stage, count]) => ({
        stage,
        stageLabel: STAGE_LABELS[stage as keyof typeof STAGE_LABELS] || stage,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      ...stats,
      recentActivity,
      stageDistribution,
    };
  }
}

// 单例缓存
const serviceCache = new Map<string, EvolutionQueryService>();

/**
 * 获取 EvolutionQueryService 实例（单例）
 */
export function getEvolutionQueryService(trajectory: TrajectoryDatabase): EvolutionQueryService {
  // 使用 trajectory 的 dbPath 作为缓存键
  const cacheKey = (trajectory as any).dbPath || 'default';
  const cached = serviceCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const service = new EvolutionQueryService(trajectory);
  serviceCache.set(cacheKey, service);
  return service;
}
