import * as path from 'path';
import {
  OperatorHealthReadModel,
  PainChainReadModel,
  PruningReadModel,
  RuntimeStateManager,
} from '@principles/core/runtime-v2';
import { EventLogReadModel } from './EventLogReadModel.js';
import type { OverviewOutput, OverviewHealthOutput } from '../types/index.js';

export class OverviewConsoleModel {
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

  async getHealth(): Promise<OverviewHealthOutput> {
    const snapshot = await this.getHealthReadModel().getSnapshot();
    const pruningSummary = this.getPruningReadModel().getHealthSummary();
    const { byStatus } = pruningSummary;

    const gfiSnapshot = snapshot.gfi;
    const activeGfi = gfiSnapshot.active;

    return {
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
        inProgress: await this.getInProgressCount(),
        completed: snapshot.totalTaskCount,
      },
    };
  }

  async getOverview(_days?: number): Promise<OverviewOutput> {
    const snapshot = await this.getHealthReadModel().getSnapshot();
    const pruningSummary = this.getPruningReadModel().getHealthSummary();

    const { byStatus } = pruningSummary;
    const principleActive = (byStatus.active ?? 0) + (byStatus.candidate ?? 0);
    const principlePending = (byStatus.probation ?? 0) + (byStatus.deprecated ?? 0);

    const gfiSnapshot = snapshot.gfi;
    const activeGfi = gfiSnapshot.active;

    const eventLog = this.getEventLogReadModel();
    const [gateBlocksToday, painEventsToday] = await Promise.all([
      eventLog.countEventsByTypeToday('gate_block'),
      eventLog.countEventsByTypeToday('pain_signal'),
    ]);

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
        inProgress: await this.getInProgressCount(),
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
        painEvents: painEventsToday,
        principleEventCount: principleActive + principlePending,
        gateBlocks: gateBlocksToday,
        taskOutcomes: snapshot.totalTaskCount,
      },
      health,
      dailyTrend: await this.getDailyTrend(),
      topRegressions: [],
      sampleQueue: {
        counters: byStatus,
        preview: [],
      },
    };
  }

  private async getInProgressCount(): Promise<number> {
    try {
      const mgr = this.getStateManager();
      const tasks = await mgr.listTasks({ status: 'leased' });
      return tasks.length;
    } catch {
      return 0;
    }
  }

  private async getDailyTrend(): Promise<OverviewOutput['dailyTrend']> {
    const eventLog = this.getEventLogReadModel();
    const trend: OverviewOutput['dailyTrend'] = [];

    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const [day] = date.toISOString().split('T');

      const [toolCalls, failures, painEvents] = await Promise.all([
        eventLog.countEventsByTypeAndDate('tool_call', day),
        eventLog.countEventsByCategoryAndDate('failure', day),
        eventLog.countEventsByTypeAndDate('pain_signal', day),
      ]);

      trend.push({
        day,
        toolCalls,
        failures,
        userCorrections: 0,
        painEvents,
      });
    }

    return trend;
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
    if (this.eventLogReadModel) {
      this.eventLogReadModel.dispose();
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
