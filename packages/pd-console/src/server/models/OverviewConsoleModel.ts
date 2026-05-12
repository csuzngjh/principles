import {
  OperatorHealthReadModel,
  PainChainReadModel,
  PruningReadModel,
  RuntimeStateManager,
} from '@principles/core/runtime-v2';
import type { SamplePreview } from '../types/index.js';

export interface OverviewHealthOutput {
  status: 'healthy' | 'degraded' | 'error';
  gfi: {
    current: number;
    stage: string;
    peakToday: number;
    threshold: number;
  };
  trust: {
    stage: number;
    score: number;
  };
  principles: {
    candidate: number;
    probation: number;
    active: number;
    deprecated: number;
  };
  queue: {
    pending: number;
    inProgress: number;
    completed: number;
  };
}

export interface OverviewOutput {
  workspaceDir: string;
  generatedAt: string;
  dataFreshness: 'fresh' | 'stale' | 'error';

  summary: {
    repeatErrorRate: number;
    userCorrectionRate: number;
    pendingSamples: number;
    approvedSamples: number;
    painEvents: number;
    principleEventCount: number;
    gateBlocks: number;
    taskOutcomes: number;
  };

  health: OverviewHealthOutput;

  dailyTrend: Array<{
    day: string;
    toolCalls: number;
    failures: number;
    userCorrections: number;
    painEvents: number;
  }>;

  topRegressions: Array<{
    toolName: string;
    errorType: string;
    occurrences: number;
  }>;

  sampleQueue: {
    counters: Record<string, number>;
    preview: SamplePreview[];
  };
}

export class OverviewConsoleModel {
  private readonly workspaceDir: string;
  private healthReadModel: OperatorHealthReadModel | null = null;
  private painChainReadModel: PainChainReadModel | null = null;
  private pruningReadModel: PruningReadModel | null = null;
  private stateManager: RuntimeStateManager | null = null;
  private ownsHealthReadModel = false;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getOverview(_days?: number): Promise<OverviewOutput> {
    const snapshot = await this.getHealthReadModel().getSnapshot();
    const pruningSummary = this.getPruningReadModel().getHealthSummary();

    const { byStatus } = pruningSummary;
    const principleActive = (byStatus.active ?? 0) + (byStatus.candidate ?? 0);
    const principlePending = (byStatus.probation ?? 0) + (byStatus.deprecated ?? 0);

    const gfiSnapshot = snapshot.gfi;
    const activeGfi = gfiSnapshot.active;

    const health: OverviewHealthOutput = {
      status: snapshot.overallStatus,
      gfi: {
        current: activeGfi?.currentGfi ?? 0,
        stage: activeGfi?.stage ?? 'stable',
        peakToday: activeGfi?.dailyGfiPeak ?? 0,
        threshold: activeGfi?.policy?.criticalThreshold ?? 0,
      },
      trust: {
        stage: 0,
        score: 0,
      },
      principles: {
        candidate: byStatus.candidate ?? 0,
        probation: byStatus.probation ?? 0,
        active: byStatus.active ?? 0,
        deprecated: byStatus.deprecated ?? 0,
      },
      queue: {
        pending: snapshot.candidateLedger.orphanCandidateCount,
        inProgress: 0,
        completed: snapshot.totalTaskCount,
      },
    };

    return {
      workspaceDir: this.workspaceDir,
      generatedAt: snapshot.generatedAt,
      dataFreshness: snapshot.overallStatus === 'error' ? 'error' : 'fresh',
      summary: {
        repeatErrorRate: 0,
        userCorrectionRate: 0,
        pendingSamples: byStatus.candidate ?? 0,
        approvedSamples: byStatus.active ?? 0,
        painEvents: snapshot.painChain.failureCategory ? 1 : 0,
        principleEventCount: principleActive + principlePending,
        gateBlocks: 0,
        taskOutcomes: snapshot.totalTaskCount,
      },
      health,
      dailyTrend: [],
      topRegressions: [],
      sampleQueue: {
        counters: byStatus,
        preview: [],
      },
    };
  }

  async getHealth(): Promise<OverviewHealthOutput> {
    const overview = await this.getOverview();
    return overview.health;
  }

  dispose(): void {
    if (this.healthReadModel && this.ownsHealthReadModel) {
      this.healthReadModel.close().catch((err) => {
        console.error('[OverviewConsoleModel] Failed to close health read model:', err);
      });
    }
    if (this.painChainReadModel) {
      this.painChainReadModel.close().catch((err) => {
        console.error('[OverviewConsoleModel] Failed to close pain chain read model:', err);
      });
    }
    if (this.stateManager) {
      this.stateManager.close().catch((err) => {
        console.error('[OverviewConsoleModel] Failed to close state manager:', err);
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
