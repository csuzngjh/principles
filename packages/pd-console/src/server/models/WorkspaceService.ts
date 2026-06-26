import {
  OperatorHealthReadModel,
  PainChainReadModel,
  PruningReadModel,
  RuntimeStateManager,
} from '@principles/core/runtime-v2';
import type { WorkspaceConfigStore } from '../config/WorkspaceConfigStore.js';
import type { WorkspaceEntry, SyncResult } from '../types/index.js';

export interface CentralOverviewOutput {
  generatedAt: string;
  workspaceCount: number;
  workspaces: {
    name: string;
    path: string;
    status: 'healthy' | 'degraded' | 'error';
    gfi: number;
    principleCount: number;
  }[];
}

export interface CentralHealthOutput {
  generatedAt: string;
  overallStatus: 'healthy' | 'degraded' | 'error';
  workspaces: {
    name: string;
    status: 'healthy' | 'degraded' | 'error';
    gfi: number;
    activePrinciples: number;
    pendingTasks: number;
  }[];
}

interface WorkspaceModels {
  operatorHealth: OperatorHealthReadModel;
  painChain: PainChainReadModel;
  pruning: PruningReadModel;
  runtime: RuntimeStateManager;
}

const noop = (): void => { /* intentional no-op for promise catch */ };

export class WorkspaceService {
  private readonly configStore: WorkspaceConfigStore;
  private readonly models: Map<string, WorkspaceModels> = new Map();

  constructor(configStore: WorkspaceConfigStore) {
    this.configStore = configStore;
  }

  async getCentralOverview(): Promise<CentralOverviewOutput> {
    const workspaces = this.configStore.getWorkspaces().filter(w => w.config?.enabled !== false);
    const results: CentralOverviewOutput['workspaces'] = [];

    for (const ws of workspaces) {
      try {
        const models = this.getModels(ws);
        const [snapshot, pruningSummary] = await Promise.all([
          models.operatorHealth.getSnapshot(),
          Promise.resolve(models.pruning.getHealthSummary()),
        ]);
        const { byStatus } = pruningSummary;
        results.push({
          name: ws.name,
          path: ws.path,
          status: snapshot.overallStatus === 'healthy' ? 'healthy' : snapshot.overallStatus === 'degraded' ? 'degraded' : 'error',
          gfi: snapshot.gfi.active?.currentGfi ?? 0,
          principleCount: (byStatus.active ?? 0) + (byStatus.candidate ?? 0),
        });
      } catch (e) {
        console.warn('WorkspaceService.getCentralOverview: workspace health check failed:', e);
        results.push({
          name: ws.name,
          path: ws.path,
          status: 'error',
          gfi: -1,
          principleCount: 0,
        });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      workspaceCount: workspaces.length,
      workspaces: results,
    };
  }

  async getCentralHealth(): Promise<CentralHealthOutput> {
    const workspaces = this.configStore.getWorkspaces().filter(w => w.config?.enabled !== false);
    const results: CentralHealthOutput['workspaces'] = [];
    let overallStatus: 'healthy' | 'degraded' | 'error' = 'healthy';

    for (const ws of workspaces) {
      try {
        const models = this.getModels(ws);
        const [snapshot, pruningSummary, pendingTasks] = await Promise.all([
          models.operatorHealth.getSnapshot(),
          Promise.resolve(models.pruning.getHealthSummary()),
          models.runtime.listTasks({ status: 'pending', limit: 100 }),
        ]);
        const { byStatus } = pruningSummary;
        const wsStatus: 'healthy' | 'degraded' | 'error' =
          snapshot.overallStatus === 'healthy' ? 'healthy' : snapshot.overallStatus === 'degraded' ? 'degraded' : 'error';

        if (wsStatus === 'error') {
          overallStatus = 'error';
        } else if (wsStatus !== 'healthy' && overallStatus === 'healthy') {
          overallStatus = 'degraded';
        }

        results.push({
          name: ws.name,
          status: wsStatus,
          gfi: snapshot.gfi.active?.currentGfi ?? 0,
          activePrinciples: (byStatus.active ?? 0) + (byStatus.candidate ?? 0),
          pendingTasks: pendingTasks.length,
        });
      } catch (e) {
        console.warn('WorkspaceService.getCentralHealth: workspace health check failed:', e);
        overallStatus = 'error';
        results.push({
          name: ws.name,
          status: 'error',
          gfi: -1,
          activePrinciples: 0,
          pendingTasks: 0,
        });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      overallStatus,
      workspaces: results,
    };
  }

  async syncWorkspace(name: string): Promise<SyncResult> {
    const entry = this.configStore.getWorkspace(name);
    if (!entry) {
      throw new Error(`Workspace "${name}" not found`);
    }

    this.disposeWorkspace(name);
    this.configStore.updateSyncTime(name);

    return {
      success: true,
      syncedAt: new Date().toISOString(),
      items: {},
    };
  }

  dispose(): void {
    for (const name of this.models.keys()) {
      this.disposeWorkspace(name);
    }
    this.models.clear();
  }

  private disposeWorkspace(name: string): void {
    const existing = this.models.get(name);
    if (existing) {
      existing.operatorHealth.close().catch(noop);
      existing.painChain.close().catch(noop);
      existing.runtime.close().catch(noop);
      this.models.delete(name);
    }
  }

  private getModels(entry: WorkspaceEntry): WorkspaceModels {
    let existing = this.models.get(entry.name);
    if (!existing) {
      const runtime = new RuntimeStateManager({ workspaceDir: entry.path });
      const painChain = new PainChainReadModel({ workspaceDir: entry.path, stateManager: runtime });
      const pruning = new PruningReadModel({ workspaceDir: entry.path });
      const operatorHealth = new OperatorHealthReadModel({
        workspaceDir: entry.path,
        painChainReadModel: painChain,
        pruningReadModel: pruning,
      });
      existing = { operatorHealth, painChain, pruning, runtime };
      this.models.set(entry.name, existing);
    }
    return existing;
  }
}
