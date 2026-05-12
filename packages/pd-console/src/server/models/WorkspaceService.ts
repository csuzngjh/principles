import { OverviewConsoleModel } from './OverviewConsoleModel.js';
import type { WorkspaceConfigStore } from '../config/WorkspaceConfigStore.js';
import type { WorkspaceEntry, SyncResult } from '../types/index.js';

export interface CentralOverviewOutput {
  generatedAt: string;
  workspaceCount: number;
  workspaces: Array<{
    name: string;
    path: string;
    status: 'healthy' | 'degraded' | 'error';
    gfi: number;
    principleCount: number;
  }>;
}

export interface CentralHealthOutput {
  generatedAt: string;
  overallStatus: 'healthy' | 'degraded' | 'error';
  workspaces: Array<{
    name: string;
    status: 'healthy' | 'degraded' | 'error';
    gfi: number;
    activePrinciples: number;
    pendingTasks: number;
  }>;
}

export class WorkspaceService {
  private readonly configStore: WorkspaceConfigStore;
  private readonly models: Map<string, OverviewConsoleModel> = new Map();

  constructor(configStore: WorkspaceConfigStore) {
    this.configStore = configStore;
  }

  async getCentralOverview(): Promise<CentralOverviewOutput> {
    const workspaces = this.configStore.getWorkspaces().filter(w => w.config?.enabled !== false);
    const results: CentralOverviewOutput['workspaces'] = [];

    for (const ws of workspaces) {
      try {
        const model = this.getModel(ws);
        const overview = await model.getOverview();
        results.push({
          name: ws.name,
          path: ws.path,
          status: overview.health.status,
          gfi: overview.health.gfi.current,
          principleCount: overview.summary.principleEventCount,
        });
      } catch {
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
        const model = this.getModel(ws);
        const health = await model.getHealth();
        if (health.status !== 'healthy') {
          overallStatus = 'degraded';
        }
        results.push({
          name: ws.name,
          status: health.status,
          gfi: health.gfi.current,
          activePrinciples: health.principles.active,
          pendingTasks: health.queue.pending,
        });
      } catch {
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

    this.models.delete(name);
    this.configStore.updateSyncTime(name);

    return {
      success: true,
      syncedAt: new Date().toISOString(),
      items: {},
    };
  }

  dispose(): void {
    for (const model of this.models.values()) {
      model.dispose();
    }
    this.models.clear();
  }

  private getModel(entry: WorkspaceEntry): OverviewConsoleModel {
    let model = this.models.get(entry.name);
    if (!model) {
      model = new OverviewConsoleModel(entry.path);
      this.models.set(entry.name, model);
    }
    return model;
  }
}
