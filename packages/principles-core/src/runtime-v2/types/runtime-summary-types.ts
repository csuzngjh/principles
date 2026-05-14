import { Type, type Static } from '@sinclair/typebox';

/**
 * Runtime truth represents the current state of the system.
 * Used for control decisions, Phase 3 eligibility, and real-time operations.
 * Sources: queue state, active session registry
 */
export interface RuntimeTruth {
  queueState: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    lastUpdated: string;
  };
  activeSessions: string[];
}

export const RuntimeTruthSchema = Type.Object({
  queueState: Type.Object({
    total: Type.Number(),
    pending: Type.Number(),
    inProgress: Type.Number(),
    completed: Type.Number(),
    lastUpdated: Type.String(),
  }),
  activeSessions: Type.Array(Type.String()),
});
export type RuntimeTruthStatic = Static<typeof RuntimeTruthSchema>;

/**
 * Trend metrics for analytics aggregation.
 */
export interface TrendMetrics {
  successRateChange: number;
  toolCallVolumeChange: number;
  painSignalRateChange: number;
}

export const TrendMetricsSchema = Type.Object({
  successRateChange: Type.Number(),
  toolCallVolumeChange: Type.Number(),
  painSignalRateChange: Type.Number(),
});
export type TrendMetricsStatic = Static<typeof TrendMetricsSchema>;

/**
 * Analytics truth represents historical data and aggregated metrics.
 * Used for insights, trends, and supporting evidence (where explicitly allowed).
 * NOT used for control decisions or Phase 3 eligibility.
 * Sources: trajectory.db, daily-stats.json, control-ui DB
 */
export interface AnalyticsTruth {
  trajectoryData: {
    totalTasks: number;
    successRate: number;
    timeoutRate: number;
    lastUpdated: string;
  };
  dailyStats: {
    toolCalls: number;
    painSignals: number;
    evolutionTasks: number;
    lastUpdated: string;
  };
  trends: {
    sevenDay: TrendMetrics;
    thirtyDay: TrendMetrics;
  };
}

export const AnalyticsTruthSchema = Type.Object({
  trajectoryData: Type.Object({
    totalTasks: Type.Number(),
    successRate: Type.Number(),
    timeoutRate: Type.Number(),
    lastUpdated: Type.String(),
  }),
  dailyStats: Type.Object({
    toolCalls: Type.Number(),
    painSignals: Type.Number(),
    evolutionTasks: Type.Number(),
    lastUpdated: Type.String(),
  }),
  trends: Type.Object({
    sevenDay: TrendMetricsSchema,
    thirtyDay: TrendMetricsSchema,
  }),
});
export type AnalyticsTruthStatic = Static<typeof AnalyticsTruthSchema>;
