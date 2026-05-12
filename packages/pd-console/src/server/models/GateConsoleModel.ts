import { buildGfiWorkspaceSnapshot, classifyGfiWorkspaceHealth } from '@principles/core/runtime-v2';
import type { GfiReadModelInput } from '@principles/core/runtime-v2';
import { PainChainReadModel, RuntimeStateManager } from '@principles/core/runtime-v2';
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
    trend: Array<{ hour: string; value: number }>;
    sources: Record<string, number>;
    stage: 'stable' | 'elevated' | 'critical' | 'saturated';
  };
}

export class GateConsoleModel {
  private readonly workspaceDir: string;
  private painChainReadModel: PainChainReadModel | null = null;
  private stateManager: RuntimeStateManager | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getGateStats(sessions: GfiReadModelInput['sessions']): Promise<GateStatsOutput> {
    const snapshot = buildGfiWorkspaceSnapshot({
      sessions,
      nowMs: Date.now(),
    });

    const active = snapshot.active;
    const currentGfi = active?.currentGfi ?? 0;
    const health = classifyGfiWorkspaceHealth(snapshot);

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
    return [];
  }

  dispose(): void {
    if (this.painChainReadModel) {
      this.painChainReadModel.close().catch(() => {});
    }
    if (this.stateManager) {
      this.stateManager.close().catch(() => {});
    }
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

  private getStateManager(): RuntimeStateManager {
    if (!this.stateManager) {
      this.stateManager = new RuntimeStateManager({ workspaceDir: this.workspaceDir });
    }
    return this.stateManager;
  }
}
