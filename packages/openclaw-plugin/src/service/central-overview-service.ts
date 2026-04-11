import { getCentralDatabase, type CentralDatabase } from './central-database.js';
import { getThinkingModelDefinitions } from '../core/thinking-models.js';
import type { OverviewResponse } from './control-ui-query-service.js';

export { OverviewResponse };

export interface CentralOverviewResponse
  extends Omit<OverviewResponse, 'dataSource' | 'runtimeControlPlaneSource'> {
  dataSource: string;
  runtimeControlPlaneSource: string;
  centralInfo: {
    workspaceCount: number;
    enabledWorkspaceCount: number;
    workspaces: string[];
    enabledWorkspaces: string[];
  };
}

export class CentralOverviewService {
  private readonly centralDb: CentralDatabase;

  constructor() {
    this.centralDb = getCentralDatabase();
  }

   
  dispose(): void {
    // Do NOT dispose centralDb — it's a singleton shared across all requests.
    // Individual services that open per-request connections (e.g. HealthQueryService)
    // must dispose their own connections, but the central aggregated DB lives for
    // the lifetime of the process.
  }
   

  getOverview(days = 30): CentralOverviewResponse {
    const stats = this.centralDb.getOverviewStats();
    const trend = this.centralDb.getDailyTrend(days);
    const regressions = this.centralDb.getTopRegressions(5);
    const thinkingStats = this.centralDb.getThinkingModelStats();
    const samplePreviewRows = this.centralDb.getSamplePreview(5);
    const mostRecentSync = this.centralDb.getMostRecentSync();

    // D-02: Query aggregated_task_outcomes for real taskOutcomes (not hardcoded 0)
    let taskOutcomes = 0;
    try {
      taskOutcomes = this.centralDb.getTaskOutcomes();
    } catch {
      console.warn('[CentralOverviewService] Could not query aggregated_task_outcomes, defaulting taskOutcomes to 0');
    }

    // D-03: Query aggregated_principle_events for principleEventCount
    // gate_blocks has no equivalent in central DB -- hardcode to 0 with warning
    let principleEventCount = 0;
    let gateBlocks = 0;
    try {
      principleEventCount = this.centralDb.getPrincipleEventCount();
    } catch {
      console.warn('[CentralOverviewService] Could not query aggregated_principle_events, defaulting principleEventCount to 0');
    }
    // gate_blocks: no equivalent in aggregated DB schema; hardcode to 0

    // D-06: sampleQueue.counters from aggregated_correction_samples GROUP BY review_status
     
    let sampleCounters: Record<string, number> = {};
    try {
      sampleCounters = this.centralDb.getSampleCountersByStatus();
    } catch {
      // Fallback to stats-based counters if query fails
      sampleCounters = {
        pending: stats.pendingSamples,
        approved: stats.approvedSamples,
        rejected: stats.rejectedSamples,
      };
    }

    // D-04: sampleQueue.preview from samplePreviewRows (not [])
    // D-05: dataFreshness from mostRecentSync (not workspaces[0])

    return {
      workspaceDir: 'central',
      generatedAt: new Date().toISOString(),
      dataFreshness: mostRecentSync,
      dataSource: 'central_aggregated_db',
      runtimeControlPlaneSource: 'all_workspaces',
      summary: {
        repeatErrorRate: stats.totalToolCalls > 0
          ? stats.totalFailures / stats.totalToolCalls
          : 0,
        userCorrectionRate: stats.totalToolCalls > 0
          ? stats.totalCorrections / stats.totalToolCalls
          : 0,
        pendingSamples: stats.pendingSamples,
        approvedSamples: stats.approvedSamples,
        thinkingCoverageRate: stats.totalToolCalls > 0
          ? stats.totalThinkingEvents / stats.totalToolCalls
          : 0,
        painEvents: stats.totalPainEvents,
        principleEventCount,
        gateBlocks,
        taskOutcomes,
      },
      dailyTrend: trend,
      topRegressions: regressions,
      sampleQueue: {
        counters: sampleCounters,
        preview: samplePreviewRows.map(row => ({
          sampleId: row.sampleId,
          sessionId: row.sessionId,
          qualityScore: Number(row.qualityScore),
          reviewStatus: row.reviewStatus,
          createdAt: row.createdAt,
        })),
      },
      thinkingSummary: {
        activeModels: thinkingStats.activeModels,
        dormantModels: thinkingStats.totalModels - thinkingStats.activeModels,
        effectiveModels: thinkingStats.models.filter(m => m.coverageRate > 0.1).length,
        coverageRate: stats.totalToolCalls > 0
          ? stats.totalThinkingEvents / stats.totalToolCalls
          : 0,
        modelBreakdown: thinkingStats.models.map(m => ({
          modelId: m.modelId,
          hits: m.hits,
        })),
        modelDefinitions: getThinkingModelDefinitions(),
      },
      centralInfo: {
        workspaceCount: stats.workspaceCount,
        enabledWorkspaceCount: stats.enabledWorkspaceCount,
        workspaces: stats.workspaceNames,
        enabledWorkspaces: stats.enabledWorkspaceNames,
      },
    };
  }
}
