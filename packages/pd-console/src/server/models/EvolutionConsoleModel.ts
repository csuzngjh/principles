import * as path from 'path';
import * as fs from 'fs';
import {
  RuntimeStateManager,
  InternalizationQueueReadModel,
} from '@principles/core/runtime-v2';

export type PrincipleStatus = 'candidate' | 'active' | 'archived' | 'deprecated' | 'probation';

export interface EvolutionStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  stageDistribution: Array<{ stage: string; count: number }>;
}

export interface EvolutionTaskItem {
  taskId: string;
  taskKind: string;
  status: string;
  createdAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

export interface EvolutionTasksOutput {
  items: EvolutionTaskItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface PrincipleLifecycleSummary {
  candidate: number;
  probation: number;
  active: number;
  deprecated: number;
  archived: number;
  total: number;
}

export interface PrincipleTransition {
  principleId: string;
  status: PrincipleStatus;
  text: string;
  triggerPattern: string;
  action: string;
  evaluability: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvolutionPrinciplesOutput {
  summary: PrincipleLifecycleSummary;
  recent: PrincipleTransition[];
}

export interface QueueHealthOutput {
  pendingCount: number;
  retryWaitCount: number;
  countsByTaskKind: Record<string, number>;
  countsByChannel: Record<string, number>;
  invalidMetadataCount: number;
  blockedCount: number;
  dependencyFailedCount: number;
  readyTaskCount: number;
  noReadyTasksReason: string | null;
}

export class EvolutionConsoleModel {
  private readonly workspaceDir: string;
  private stateManager: RuntimeStateManager | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private async ensureInitialized(): Promise<RuntimeStateManager> {
    if (!this.stateManager) {
      this.stateManager = new RuntimeStateManager({ workspaceDir: this.workspaceDir });
      this.initPromise = this.stateManager.initialize();
    }
    await this.initPromise;
    return this.stateManager;
  }

  async getStats(): Promise<EvolutionStats> {
    const mgr = await this.ensureInitialized();
    const allTasks = await mgr.listTasks();

    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    let failed = 0;
    const stageMap: Record<string, number> = {};

    for (const task of allTasks) {
      switch (task.status) {
        case 'pending': pending++; break;
        case 'leased': inProgress++; break;
        case 'succeeded': completed++; break;
        case 'retry_wait': inProgress++; break;
        case 'failed': failed++; break;
      }
      const stage = task.status;
      stageMap[stage] = (stageMap[stage] ?? 0) + 1;
    }

    const stageDistribution = Object.entries(stageMap)
      .map(([stage, count]) => ({ stage, count }))
      .sort((a, b) => b.count - a.count);

    return {
      total: allTasks.length,
      pending,
      inProgress,
      completed,
      failed,
      stageDistribution,
    };
  }

  async getTasks(filters: {
    status?: string;
    taskKind?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<EvolutionTasksOutput> {
    const mgr = await this.ensureInitialized();
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(Math.max(1, filters.pageSize ?? 20), 100);

    let tasks = await mgr.listTasks();

    if (filters.status && filters.status !== 'all') {
      tasks = tasks.filter(t => t.status === filters.status);
    }
    if (filters.taskKind && filters.taskKind !== 'all') {
      tasks = tasks.filter(t => t.taskKind === filters.taskKind);
    }

    tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const total = tasks.length;
    const offset = (page - 1) * pageSize;
    const items = tasks.slice(offset, offset + pageSize).map(t => ({
      taskId: t.taskId,
      taskKind: t.taskKind,
      status: t.status,
      createdAt: t.createdAt,
      leaseOwner: t.leaseOwner ?? null,
      leaseExpiresAt: t.leaseExpiresAt ?? null,
    }));

    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      },
    };
  }

  async getPrinciples(): Promise<EvolutionPrinciplesOutput> {
    const stateDir = path.join(this.workspaceDir, '.state');
    const ledgerPath = path.join(stateDir, 'principle_training_state.json');

    const summary: PrincipleLifecycleSummary = {
      candidate: 0,
      probation: 0,
      active: 0,
      deprecated: 0,
      archived: 0,
      total: 0,
    };

    const recent: PrincipleTransition[] = [];

    if (!fs.existsSync(ledgerPath)) {
      return { summary, recent };
    }

    try {
      const raw = fs.readFileSync(ledgerPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        tree?: {
          principles?: Record<string, {
            id: string;
            status: PrincipleStatus;
            text: string;
            triggerPattern: string;
            action: string;
            evaluability: string;
            createdAt: string;
            updatedAt: string;
          }>;
        };
      };
      const principles = Object.values(parsed.tree?.principles ?? {});

      for (const p of principles) {
        summary.total++;
        switch (p.status) {
          case 'candidate': summary.candidate++; break;
          case 'probation': summary.probation++; break;
          case 'active': summary.active++; break;
          case 'deprecated': summary.deprecated++; break;
          case 'archived': summary.archived++; break;
        }
      }

      const sorted = [...principles].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );

      for (const p of sorted.slice(0, 20)) {
        recent.push({
          principleId: p.id,
          status: p.status,
          text: p.text,
          triggerPattern: p.triggerPattern,
          action: p.action,
          evaluability: p.evaluability,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        });
      }
    } catch {
      // ledger file may be corrupted or empty
    }

    return { summary, recent };
  }

  async getQueueHealth(): Promise<QueueHealthOutput> {
    const mgr = await this.ensureInitialized();
    const readModel = new InternalizationQueueReadModel(mgr);
    try {
      const snapshot = await readModel.getSnapshot();
      return {
        pendingCount: snapshot.pendingCount,
        retryWaitCount: snapshot.retryWaitCount,
        countsByTaskKind: snapshot.countsByTaskKind,
        countsByChannel: snapshot.countsByChannel,
        invalidMetadataCount: snapshot.invalidMetadataCount,
        blockedCount: snapshot.blockedSummary.count,
        dependencyFailedCount: snapshot.dependencyFailedSummary.count,
        readyTaskCount: snapshot.readyTasks.length,
        noReadyTasksReason: snapshot.noReadyTasks?.reason ?? null,
      };
    } finally {
      await readModel.close();
    }
  }

  dispose(): void {
    if (this.stateManager) {
      this.stateManager.close().catch(() => {});
      this.stateManager = null;
    }
    this.initPromise = null;
  }
}
