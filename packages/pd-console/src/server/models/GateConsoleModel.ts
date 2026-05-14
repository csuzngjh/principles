import * as path from 'path';
import {
  OperatorHealthReadModel,
  PainChainReadModel,
  PruningReadModel,
  RuntimeStateManager,
  classifyGfiWorkspaceHealth,
} from '@principles/core/runtime-v2';
import { EventLogReadModel } from './EventLogReadModel.js';
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
  private readonly stateDir: string;
  private healthReadModel: OperatorHealthReadModel | null = null;
  private painChainReadModel: PainChainReadModel | null = null;
  private pruningReadModel: PruningReadModel | null = null;
  private stateManager: RuntimeStateManager | null = null;
  private eventLogReadModel: EventLogReadModel | null = null;
  private ownsHealthReadModel = false;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = path.join(workspaceDir, '.state');
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

    const eventLog = this.getEventLogReadModel();
    const [gfiBlocks, stageBlocks, bypassAttempts] = await Promise.all([
      eventLog.countEventsByTypeToday('gate_block'),
      eventLog.countEventsByTypeToday('stage_block'),
      eventLog.countEventsByTypeToday('gate_bypass'),
    ]);

    return {
      generatedAt: snapshot.generatedAt,
      today: {
        gfiBlocks,
        stageBlocks,
        bypassAttempts,
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
    const events = await this.getEventLogReadModel().getGateBlocks(_limit ?? 100);

    return events.map(event => ({
      timestamp: event.ts,
      toolName: event.data.toolName ?? 'unknown',
      filePath: event.data.filePath ?? null,
      reason: event.data.reason ?? '',
      gateType: GateConsoleModel.classifyGateType(event.data.blockSource),
      gfi: 0,
      trustStage: 0,
    }));
  }

  private static classifyGateType(source?: string): 'gfi' | 'stage' | 'p03' | 'other' {
    if (!source) return 'other';
    if (source.includes('gfi') || source.includes('GFI')) return 'gfi';
    if (source.includes('stage') || source.includes('trust')) return 'stage';
    if (source.includes('p03') || source.includes('P03')) return 'p03';
    return 'other';
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
    if (this.eventLogReadModel) {
      this.eventLogReadModel.dispose();
      this.eventLogReadModel = null;
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

  private getEventLogReadModel(): EventLogReadModel {
    if (!this.eventLogReadModel) {
      this.eventLogReadModel = new EventLogReadModel(this.stateDir);
    }
    return this.eventLogReadModel;
  }
}
