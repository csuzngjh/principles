import * as path from 'path';
import { EventLogReadModel } from './EventLogReadModel.js';
import { GateConsoleModel } from './GateConsoleModel.js';
import type { GateBlockItem, EmpathyEvent } from '../types/index.js';

export class FeedbackConsoleModel {
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private gateModel: GateConsoleModel | null = null;
  private eventLogReadModel: EventLogReadModel | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = path.join(workspaceDir, '.state');
  }

  async getGfi(): Promise<{ current: number; peakToday: number; threshold: number; trend: { hour: string; value: number }[]; sources: Record<string, number> }> {
    const stats = await this.getGateModel().getGateStats();
    return {
      current: stats.gfi.current,
      peakToday: stats.gfi.peakToday,
      threshold: stats.gfi.threshold,
      trend: stats.gfi.trend,
      sources: stats.gfi.sources,
    };
  }

  async getEmpathyEvents(_limit?: number): Promise<EmpathyEvent[]> {
    const events = await this.getEventLogReadModel().getEventsByTypes(
      ['empathy_rollback', 'user_empathy', 'pain_signal'],
      _limit ?? 50
    );

    return events
      .filter(e => e.type === 'empathy_rollback' ||
                   e.type === 'user_empathy' ||
                   (e.type === 'pain_signal' && (e.data?.source as string) === 'user_empathy'))
      .map(event => ({
        timestamp: event.ts,
        severity: FeedbackConsoleModel.convertScoreToSeverity((event.data?.score as number) ?? 50),
        score: (event.data?.score as number) ?? 50,
        reason: (event.data?.reason as string) ?? '',
        origin: (event.data?.origin as string) ?? 'system_infer',
        gfiAfter: 0,
      }));
  }

  async getGateBlocks(limit?: number): Promise<GateBlockItem[]> {
    return this.getGateModel().getGateBlocks(limit);
  }

  private static convertScoreToSeverity(score: number): 'low' | 'medium' | 'high' {
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  private getGateModel(): GateConsoleModel {
    if (!this.gateModel) {
      this.gateModel = new GateConsoleModel(this.workspaceDir);
    }
    return this.gateModel;
  }

  private getEventLogReadModel(): EventLogReadModel {
    if (!this.eventLogReadModel) {
      this.eventLogReadModel = new EventLogReadModel(this.stateDir);
    }
    return this.eventLogReadModel;
  }

  dispose(): void {
    if (this.gateModel) {
      this.gateModel.dispose();
      this.gateModel = null;
    }
    if (this.eventLogReadModel) {
      this.eventLogReadModel.dispose();
      this.eventLogReadModel = null;
    }
  }
}
