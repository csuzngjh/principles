import * as path from 'path';
import * as fs from 'fs';
import { EventLogReadModel } from './EventLogReadModel.js';
import { GateConsoleModel } from './GateConsoleModel.js';
import type { GateBlockItem, EmpathyEvent } from '../types/index.js';

interface EmpathyDailyStats {
  totalEvents: number;
  totalPenaltyScore: number;
  rollbackCount: number;
  bySeverity: Record<string, number>;
  byOrigin: Record<string, number>;
}

interface RuleHostDailyStats {
  rulehostEvaluated: number;
  rulehostBlocked: number;
  rulehostRequireApproval: number;
}

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
                   (e.type === 'pain_signal' && typeof e.data?.source === 'string'))
      .map(event => ({
        timestamp: event.ts,
        severity: FeedbackConsoleModel.convertScoreToSeverity((event.data?.score as number) ?? 50),
        score: (event.data?.score as number) ?? 50,
        reason: (event.data?.reason as string) ?? '',
        origin: typeof event.data?.origin === 'string' ? event.data.origin : typeof event.data?.source === 'string' ? event.data.source : 'unknown',
        gfiAfter: 0,
      }));
  }

  async getEmpathySummary(): Promise<{
    totalEvents: number;
    totalPenaltyScore: number;
    rollbackCount: number;
    bySeverity: Record<string, number>;
    byOrigin: Record<string, number>;
  }> {
    const dailyStats = await this.readDailyStats();
    let totalEvents = 0;
    let totalPenaltyScore = 0;
    let rollbackCount = 0;
    const bySeverity: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};

    for (const day of Object.values(dailyStats)) {
      const emp = day?.empathy as EmpathyDailyStats | undefined;
      if (!emp) continue;
      totalEvents += Number(emp.totalEvents) || 0;
      totalPenaltyScore += Number(emp.totalPenaltyScore) || 0;
      rollbackCount += Number(emp.rollbackCount) || 0;
      if (emp.bySeverity) {
        for (const [k, v] of Object.entries(emp.bySeverity)) {
          bySeverity[k] = (bySeverity[k] ?? 0) + (Number(v) || 0);
        }
      }
      if (emp.byOrigin) {
        for (const [k, v] of Object.entries(emp.byOrigin)) {
          byOrigin[k] = (byOrigin[k] ?? 0) + (Number(v) || 0);
        }
      }
    }

    return { totalEvents, totalPenaltyScore, rollbackCount, bySeverity, byOrigin };
  }

  async getGateBlocks(limit?: number): Promise<GateBlockItem[]> {
    return this.getGateModel().getGateBlocks(limit);
  }

  async getRuleHostSummary(): Promise<{
    totalEvaluated: number;
    totalBlocked: number;
    totalRequireApproval: number;
    blockRate: number;
  }> {
    const dailyStats = await this.readDailyStats();
    let totalEvaluated = 0;
    let totalBlocked = 0;
    let totalRequireApproval = 0;

    for (const day of Object.values(dailyStats)) {
      const evo = day?.evolution as RuleHostDailyStats | undefined;
      if (!evo) continue;
      totalEvaluated += Number(evo.rulehostEvaluated) || 0;
      totalBlocked += Number(evo.rulehostBlocked) || 0;
      totalRequireApproval += Number(evo.rulehostRequireApproval) || 0;
    }

    return {
      totalEvaluated,
      totalBlocked,
      totalRequireApproval,
      blockRate: totalEvaluated > 0 ? Math.round((totalBlocked / totalEvaluated) * 10000) / 100 : 0,
    };
  }

  private static convertScoreToSeverity(score: number): 'low' | 'medium' | 'high' {
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  private async readDailyStats(): Promise<Record<string, Record<string, unknown>>> {
    const statsPath = path.join(this.stateDir, 'logs', 'daily-stats.json');
    try {
      const raw = await fs.promises.readFile(statsPath, 'utf8');
      return JSON.parse(raw) as Record<string, Record<string, unknown>>;
    } catch {
      console.warn('[FeedbackConsoleModel] Failed to parse daily-stats.json at ' + statsPath);
      return {};
    }
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
