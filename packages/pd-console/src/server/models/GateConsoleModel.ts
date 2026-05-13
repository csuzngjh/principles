import {
  OperatorHealthReadModel,
  PainChainReadModel,
  PruningReadModel,
  RuntimeStateManager,
  classifyGfiWorkspaceHealth,
} from '@principles/core/runtime-v2';
import type { GateBlockItem } from '../types/index.js';

export interface GateStatsOutput {
  generatedAt: string;

  today: {
    gfiBlocks: number;
    stageBlocks: number;
    bypassAttempts: number;
  };

  trust: {
    stage: number;
    score: number;
    status: 'healthy' | 'warning' | 'critical';
  };

  evolution: {
    tier: string;
    points: number;
    status: string;
  };

  gfi: {
    current: number;
    peakToday: number;
    threshold: number;
    trend: { hour: string; value: number }[];
    sources: Record<string, number>;
    stage: 'stable' | 'elevated' | 'critical' | 'saturated';
  };
}

export class GateConsoleModel {
  private readonly workspaceDir: string;
  private healthReadModel: OperatorHealthReadModel | null = null;
  private painChainReadModel: PainChainReadModel | null = null;
  private pruningReadModel: PruningReadModel | null = null;
  private stateManager: RuntimeStateManager | null = null;
  private ownsHealthReadModel = false;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getGateStats(): Promise<GateStatsOutput> {
    const snapshot = await this.getHealthReadModel().getSnapshot();
    const gfiSnapshot = snapshot.gfi;
    const {active} = gfiSnapshot;
    const currentGfi = active?.currentGfi ?? 0;
    const health = classifyGfiWorkspaceHealth(gfiSnapshot);

    const trustStatus: 'healthy' | 'warning' | 'critical' =
      health.status === 'degraded' ? 'warning' : 'healthy';

    const sources: Record<string, number> = {};
    if (active?.sources) {
      for (const [key, value] of Object.entries(active.sources)) {
        if (value !== undefined) {
          sources[key] = value;
        }
      }
    }

    return {
      generatedAt: snapshot.generatedAt,
      today: {
        gfiBlocks: 0,
        stageBlocks: 0,
        bypassAttempts: 0,
      },
      trust: {
        stage: 0,
        score: 0,
        status: trustStatus,
      },
      evolution: {
        tier: '',
        points: 0,
        status: '',
      },
      gfi: {
        current: currentGfi,
        peakToday: active?.dailyGfiPeak ?? 0,
        threshold: active?.policy?.criticalThreshold ?? 80,
        trend: [],
        sources,
        stage: active?.stage ?? 'stable',
      },
    };
  }

  async getGateBlocks(_limit?: number): Promise<GateBlockItem[]> {
    return this.getGateModel().getGateBlocks(_limit);
  }

  dispose(): void {
    if (this.healthReadModel && this.ownsHealthReadModel) {
      this.healthReadModel.close().catch((err) => {
        console.error('[GateConsoleModel] Failed to close health read model:', err);
      });
    }
    if (this.painChainReadModel) {
      this.painChainReadModel.close().catch((err) => {
        console.error('[GateConsoleModel] Failed to close pain chain read model:', err);
      });
    }
    if (this.stateManager) {
      this.stateManager.close().catch((err) => {
        console.error('[GateConsoleModel] Failed to close state manager:', err);
      });
    }
  }

  private getHealthReadModel(): OperatorHealthReadModel {
    if (!this.healthReadModel) {
      const painChainReadModel = this.getPainChainReadModel();
      const pruningReadModel = this.getPruningReadModel();
      this.healthReadModel = new OperatorHealthReadModel({
        workspaceDir: this.workspaceDir,
        painChainReadModel,
        pruningReadModel,
      });
      this.ownsHealthReadModel = true;
    }
    return this.healthReadModel;
  }

  private getPainChainReadModel(): PainChainReadModel {
    if (!this.painChainReadModel) {
      this.painChainReadModel = new PainChainReadModel({
        workspaceDir: this.workspaceDir,
        stateManager: this.getStateManager(),
      });
    }
    return this.painChainReadModel;
  }

  private getPruningReadModel(): PruningReadModel {
    if (!this.pruningReadModel) {
      this.pruningReadModel = new PruningReadModel({
        workspaceDir: this.workspaceDir,
      });
    }
    return this.pruningReadModel;
  }

  private getStateManager(): RuntimeStateManager {
    if (!this.stateManager) {
      this.stateManager = new RuntimeStateManager({ workspaceDir: this.workspaceDir });
    }
    return this.stateManager;
  }
}
