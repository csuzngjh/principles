import * as path from 'path';
import {
  OperatorHealthReadModel,
  PainChainReadModel,
  PruningReadModel,
  RuntimeStateManager,
} from '@principles/core/runtime-v2';
import { EventLogReadModel } from './EventLogReadModel.js';

export interface HealthCheckResult {
  id: string;
  name: string;
  status: 'healthy' | 'warning' | 'error';
  message: string;
  lastCheck: string;
}

export interface PipelineTimestamps {
  lastPainSignal: string | null;
  lastTaskCreated: string | null;
  lastCandidateGenerated: string | null;
  lastPrincipleAdded: string | null;
}

export interface SystemHealthStatus {
  overall: 'healthy' | 'degraded' | 'error';
  checks: HealthCheckResult[];
  pipeline: PipelineTimestamps;
  generatedAt: string;
}

const noop = (): void => { /* intentional no-op for promise catch */ };

export class HealthCheckModel {
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private operatorHealth: OperatorHealthReadModel | null = null;
  private painChain: PainChainReadModel | null = null;
  private pruning: PruningReadModel | null = null;
  private runtime: RuntimeStateManager | null = null;
  private eventLog: EventLogReadModel | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = path.join(workspaceDir, '.state');
  }

  async checkSystemHealth(): Promise<SystemHealthStatus> {
    const checks: HealthCheckResult[] = [];

    checks.push(await this.checkEventLog());
    checks.push(await this.checkSqlite());
    checks.push(await this.checkPainChainFlow());
    checks.push(await this.checkTaskQueue());
    checks.push(await this.checkPrincipleTree());
    checks.push(await this.checkGfiHealth());

    const hasError = checks.some(c => c.status === 'error');
    const hasWarning = checks.some(c => c.status === 'warning');
    const overall: 'healthy' | 'degraded' | 'error' =
      hasError ? 'error' : hasWarning ? 'degraded' : 'healthy';

    return {
      overall,
      checks,
      pipeline: await this.getPipelineTimestamps(),
      generatedAt: new Date().toISOString(),
    };
  }

  private async checkEventLog(): Promise<HealthCheckResult> {
    try {
      const eventLog = this.getEventLogReadModel();
      const recentEvents = await eventLog.getEventsByTypes([], 1);
      const now = new Date();

      if (recentEvents.length === 0) {
        return {
          id: 'event_log',
          name: '事件日志',
          status: 'warning',
          message: '暂无事件记录',
          lastCheck: now.toISOString(),
        };
      }

      const [lastEvent] = recentEvents;
      const eventTime = new Date(lastEvent.ts);
      const diffMinutes = (now.getTime() - eventTime.getTime()) / (1000 * 60);

      if (diffMinutes > 60) {
        return {
          id: 'event_log',
          name: '事件日志',
          status: 'warning',
          message: `最后事件超过 ${Math.floor(diffMinutes)} 分钟前`,
          lastCheck: now.toISOString(),
        };
      }

      return {
        id: 'event_log',
        name: '事件日志',
        status: 'healthy',
        message: `正常记录中，最后事件 ${Math.floor(diffMinutes)} 分钟前`,
        lastCheck: now.toISOString(),
      };
    } catch (e) {
      return {
        id: 'event_log',
        name: '事件日志',
        status: 'error',
        message: `读取失败: ${(e as Error).message}`,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async checkSqlite(): Promise<HealthCheckResult> {
    try {
      const runtime = this.getRuntime();
      await runtime.listTasks({ limit: 1 });
      return {
        id: 'sqlite',
        name: '数据库连接',
        status: 'healthy',
        message: '连接正常',
        lastCheck: new Date().toISOString(),
      };
    } catch (e) {
      return {
        id: 'sqlite',
        name: '数据库连接',
        status: 'error',
        message: `连接失败: ${(e as Error).message}`,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async checkPainChainFlow(): Promise<HealthCheckResult> {
    const timestamps = await this.getPipelineTimestamps();
    const now = new Date();

    if (!timestamps.lastPainSignal && !timestamps.lastTaskCreated) {
      return {
        id: 'pain_chain_flow',
        name: 'Pain Chain 流动',
        status: 'warning',
        message: '暂无活动记录',
        lastCheck: now.toISOString(),
      };
    }

    const lastActivity = timestamps.lastTaskCreated || timestamps.lastPainSignal;
    if (lastActivity) {
      const activityTime = new Date(lastActivity);
      const diffMinutes = (now.getTime() - activityTime.getTime()) / (1000 * 60);

      if (diffMinutes > 60) {
        return {
          id: 'pain_chain_flow',
          name: 'Pain Chain 流动',
          status: 'error',
          message: `超过 ${Math.floor(diffMinutes)} 分钟无活动`,
          lastCheck: now.toISOString(),
        };
      } else if (diffMinutes > 30) {
        return {
          id: 'pain_chain_flow',
          name: 'Pain Chain 流动',
          status: 'warning',
          message: `活动较慢，${Math.floor(diffMinutes)} 分钟无更新`,
          lastCheck: now.toISOString(),
        };
      }
    }

    return {
      id: 'pain_chain_flow',
      name: 'Pain Chain 流动',
      status: 'healthy',
      message: '流动正常',
      lastCheck: now.toISOString(),
    };
  }

  private async checkTaskQueue(): Promise<HealthCheckResult> {
    try {
      const runtime = this.getRuntime();
      const pendingTasks = await runtime.listTasks({ status: 'pending', limit: 100 });
      const leasedTasks = await runtime.listTasks({ status: 'leased', limit: 100 });
      const failedTasks = await runtime.listTasks({ status: 'failed', limit: 100 });

      if (failedTasks.length > 20) {
        return {
          id: 'task_queue',
          name: '任务队列',
          status: 'error',
          message: `失败任务过多: ${failedTasks.length} 个`,
          lastCheck: new Date().toISOString(),
        };
      }

      if (pendingTasks.length > 50) {
        return {
          id: 'task_queue',
          name: '任务队列',
          status: 'warning',
          message: `待处理任务积压: ${pendingTasks.length} 个`,
          lastCheck: new Date().toISOString(),
        };
      }

      return {
        id: 'task_queue',
        name: '任务队列',
        status: 'healthy',
        message: `pending: ${pendingTasks.length}, leased: ${leasedTasks.length}`,
        lastCheck: new Date().toISOString(),
      };
    } catch (e) {
      return {
        id: 'task_queue',
        name: '任务队列',
        status: 'error',
        message: `检查失败: ${(e as Error).message}`,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async checkPrincipleTree(): Promise<HealthCheckResult> {
    try {
      const pruning = this.getPruning();
      const summary = pruning.getHealthSummary();
      const total = summary.totalPrinciples;

      if (total === 0) {
        return {
          id: 'principle_tree',
          name: '原则树',
          status: 'warning',
          message: '暂无原则，可能需要初始化',
          lastCheck: new Date().toISOString(),
        };
      }

      return {
        id: 'principle_tree',
        name: '原则树',
        status: 'healthy',
        message: `总计 ${total} 个原则`,
        lastCheck: new Date().toISOString(),
      };
    } catch (e) {
      return {
        id: 'principle_tree',
        name: '原则树',
        status: 'error',
        message: `访问失败: ${(e as Error).message}`,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async checkGfiHealth(): Promise<HealthCheckResult> {
    try {
      const health = this.getOperatorHealth();
      const snapshot = await health.getSnapshot();
      const { gfi } = snapshot;
      const { active } = gfi;

      if (!active) {
        return {
          id: 'gfi_health',
          name: 'GFI 健康度',
          status: 'warning',
          message: 'GFI 数据不可用',
          lastCheck: new Date().toISOString(),
        };
      }

      const currentGfi = active.currentGfi ?? 0;
      const threshold = active.policy?.criticalThreshold ?? 80;

      if (currentGfi >= threshold) {
        return {
          id: 'gfi_health',
          name: 'GFI 健康度',
          status: 'error',
          message: `GFI 过高中: ${currentGfi}/${threshold}`,
          lastCheck: new Date().toISOString(),
        };
      }

      if (currentGfi >= threshold * 0.8) {
        return {
          id: 'gfi_health',
          name: 'GFI 健康度',
          status: 'warning',
          message: `GFI 偏高: ${currentGfi}/${threshold}`,
          lastCheck: new Date().toISOString(),
        };
      }

      return {
        id: 'gfi_health',
        name: 'GFI 健康度',
        status: 'healthy',
        message: `正常: ${currentGfi}/${threshold}`,
        lastCheck: new Date().toISOString(),
      };
    } catch (e) {
      return {
        id: 'gfi_health',
        name: 'GFI 健康度',
        status: 'error',
        message: `检查失败: ${(e as Error).message}`,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async getPipelineTimestamps(): Promise<PipelineTimestamps> {
    const eventLog = this.getEventLogReadModel();

    const [painSignals, tasks, candidates, promotions] = await Promise.all([
      eventLog.getEventsByTypes(['pain_signal'], 1),
      eventLog.getEventsByTypes(['diagnosis_task', 'heartbeat_diagnosis', 'evolution_task'], 1),
      eventLog.getEventsByTypes(['principle_candidate'], 1),
      eventLog.getEventsByTypes(['rule_promotion'], 1),
    ]);

    return {
      lastPainSignal: painSignals[0]?.ts ?? null,
      lastTaskCreated: tasks[0]?.ts ?? null,
      lastCandidateGenerated: candidates[0]?.ts ?? null,
      lastPrincipleAdded: promotions[0]?.ts ?? null,
    };
  }

  private getEventLogReadModel(): EventLogReadModel {
    if (!this.eventLog) {
      this.eventLog = new EventLogReadModel(this.stateDir);
    }
    return this.eventLog;
  }

  private getRuntime(): RuntimeStateManager {
    if (!this.runtime) {
      this.runtime = new RuntimeStateManager({ workspaceDir: this.workspaceDir });
    }
    return this.runtime;
  }

  private getPainChain(): PainChainReadModel {
    if (!this.painChain) {
      this.painChain = new PainChainReadModel({
        workspaceDir: this.workspaceDir,
        stateManager: this.getRuntime(),
      });
    }
    return this.painChain;
  }

  private getPruning(): PruningReadModel {
    if (!this.pruning) {
      this.pruning = new PruningReadModel({ workspaceDir: this.workspaceDir });
    }
    return this.pruning;
  }

  private getOperatorHealth(): OperatorHealthReadModel {
    if (!this.operatorHealth) {
      this.operatorHealth = new OperatorHealthReadModel({
        workspaceDir: this.workspaceDir,
        painChainReadModel: this.getPainChain(),
        pruningReadModel: this.getPruning(),
      });
    }
    return this.operatorHealth;
  }

  dispose(): void {
    if (this.operatorHealth) {
      this.operatorHealth.close().catch(noop);
      this.operatorHealth = null;
    }
    if (this.painChain) {
      this.painChain.close().catch(noop);
      this.painChain = null;
    }
    if (this.runtime) {
      this.runtime.close().catch(noop);
      this.runtime = null;
    }
    if (this.eventLog) {
      this.eventLog.dispose();
      this.eventLog = null;
    }
  }
}
