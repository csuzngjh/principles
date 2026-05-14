import * as path from 'path';
import { EventLogReadModel } from './EventLogReadModel.js';
import { RuntimeStateManager } from '@principles/core/runtime-v2';

export type PipelineStageStatus = 'normal' | 'slow' | 'stuck';

export interface PipelineStage {
  id: string;
  name: string;
  status: PipelineStageStatus;
  count: number;
  avgDuration: number | null;
  lastProcessed: string | null;
  gapMinutes: number | null;
}

export interface Bottleneck {
  fromStage: string;
  toStage: string;
  gapMinutes: number;
  severity: 'warning' | 'critical';
  description: string;
}

export interface PipelineStats {
  generatedAt: string;
  stages: PipelineStage[];
  bottlenecks: Bottleneck[];
  totalProcessed: number;
  throughput: number;
}

const STAGE_CONFIG = [
  { id: 'pain_signal', name: 'Pain Signal', eventTypes: ['pain_signal'] },
  { id: 'task_created', name: 'Task Created', eventTypes: ['task_created', 'diagnostician_run'] },
  { id: 'candidate_generated', name: 'Candidate Generated', eventTypes: ['candidate_generated'] },
  { id: 'principle_added', name: 'Principle Added', eventTypes: ['principle_added'] },
];

const THRESHOLD_MINUTES = {
  slow: 15,
  stuck: 30,
  bottleneckWarning: 5,
  bottleneckCritical: 15,
};

const noop = (): void => { /* intentional no-op for promise catch */ };

export class PipelineStatsModel {
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private eventLog: EventLogReadModel | null = null;
  private runtime: RuntimeStateManager | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = path.join(workspaceDir, '.state');
  }

  async getPipelineStats(): Promise<PipelineStats> {
    const eventLog = this.getEventLogReadModel();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayISO = today.toISOString();

    const stages: PipelineStage[] = [];
    const bottlenecks: Bottleneck[] = [];
    let totalProcessed = 0;

    const stageEvents = await Promise.all(
      STAGE_CONFIG.map(async (config) => {
        const events = await eventLog.getEventsByTypes(config.eventTypes, 1000);
        const todayEvents = events.filter(e => e.ts >= todayISO);
        return { config, events: todayEvents, allEvents: events };
      })
    );

    for (let i = 0; i < stageEvents.length; i++) {
      const { config, events: todayEvents, allEvents } = stageEvents[i];
      const count = todayEvents.length;
      totalProcessed += count;

      const [firstEvent] = allEvents;
      const lastProcessed = firstEvent ? firstEvent.ts : null;

      let gapMinutes: number | null = null;
      let status: PipelineStageStatus = 'normal';

      if (lastProcessed) {
        const lastTime = new Date(lastProcessed);
        gapMinutes = (now.getTime() - lastTime.getTime()) / (1000 * 60);

        if (gapMinutes > THRESHOLD_MINUTES.stuck) {
          status = 'stuck';
        } else if (gapMinutes > THRESHOLD_MINUTES.slow) {
          status = 'slow';
        }
      } else if (count === 0) {
        status = 'stuck';
      }

      let avgDuration: number | null = null;
      if (allEvents.length > 1) {
        const timestamps = allEvents.map(e => new Date(e.ts).getTime());
        const intervals: number[] = [];
        for (let j = 0; j < timestamps.length - 1; j++) {
          intervals.push(timestamps[j] - timestamps[j + 1]);
        }
        avgDuration = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      }

      stages.push({
        id: config.id,
        name: config.name,
        status,
        count,
        avgDuration,
        lastProcessed,
        gapMinutes,
      });

      if (i < stageEvents.length - 1) {
        const currentLastProcessed = lastProcessed;
        const [nextFirstEvent] = stageEvents[i + 1].allEvents;
        const nextLastProcessed = nextFirstEvent?.ts ?? null;

        if (currentLastProcessed && nextLastProcessed) {
          const currentTime = new Date(currentLastProcessed);
          const nextTime = new Date(nextLastProcessed);
          const gap = (nextTime.getTime() - currentTime.getTime()) / (1000 * 60);

          if (gap > THRESHOLD_MINUTES.bottleneckWarning) {
            bottlenecks.push({
              fromStage: config.name,
              toStage: stageEvents[i + 1].config.name,
              gapMinutes: gap,
              severity: gap > THRESHOLD_MINUTES.bottleneckCritical ? 'critical' : 'warning',
              description: `从 ${config.name} 到 ${stageEvents[i + 1].config.name} 延迟 ${Math.floor(gap)} 分钟`,
            });
          }
        }
      }
    }

    const throughput = totalProcessed / 24;

    return {
      generatedAt: now.toISOString(),
      stages,
      bottlenecks,
      totalProcessed,
      throughput: Math.round(throughput * 10) / 10,
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

  dispose(): void {
    if (this.eventLog) {
      this.eventLog.dispose();
      this.eventLog = null;
    }
    if (this.runtime) {
      this.runtime.close().catch(noop);
      this.runtime = null;
    }
  }
}
