/**
 * Runtime truth represents the current state of the system.
 * Used for control decisions, Phase 3 eligibility, and real-time operations.
 * Sources: queue state, workspace trust scorecard, active session registry
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
  currentTrustScore: number | null;
  workspaceState: {
    frozen: boolean | null;
    lastUpdated: string | null;
    trustClassification: 'authoritative' | 'unknown' | 'rejected';
  };
}

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
    trustChanges: number;
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

/**
 * Trend metrics for analytics aggregation.
 */
export interface TrendMetrics {
  successRateChange: number;
  toolCallVolumeChange: number;
  painSignalRateChange: number;
}
