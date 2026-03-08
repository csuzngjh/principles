/**
 * Event types for structured logging and daily statistics.
 */

// ============== Event Types ==============

export type EventType = 
  | 'tool_call'
  | 'pain_signal'
  | 'rule_match'
  | 'rule_promotion'
  | 'hook_execution'
  | 'gate_block'
  | 'evolution_task'
  | 'error'
  | 'warn';

export type EventCategory = 
  | 'success'
  | 'failure'
  | 'detected'
  | 'blocked'
  | 'enqueued'
  | 'completed'
  | 'promoted';

/**
 * Base event structure for JSONL logging.
 */
export interface EventLogEntry {
  /** ISO timestamp */
  ts: string;
  /** Date for partitioning (YYYY-MM-DD) */
  date: string;
  /** Event type */
  type: EventType;
  /** Event category */
  category: EventCategory;
  /** Session identifier */
  sessionId?: string;
  /** Workspace directory */
  workspaceDir?: string;
  /** Event-specific data */
  data: Record<string, unknown>;
}

// ============== Specific Event Data ==============

export interface ToolCallEventData {
  toolName: string;
  filePath?: string;
  error?: string;
  errorType?: string;
  gfi?: number;
  consecutiveErrors?: number;
  exitCode?: number;
}

export interface PainSignalEventData {
  score: number;
  source: string;
  reason?: string;
  isRisky?: boolean;
}

export interface RuleMatchEventData {
  ruleId: string;
  layer: 'L1' | 'L2' | 'L3';
  severity: number;
  textPreview: string;
}

export interface RulePromotionEventData {
  fingerprint: string;
  ruleId: string;
  phrase: string;
  sampleCount: number;
  avgSimilarity: number;
}

export interface HookExecutionEventData {
  hookName: string;
  durationMs?: number;
  error?: string;
}

export interface GateBlockEventData {
  toolName: string;
  filePath: string;
  reason: string;
  planStatus?: string;
}

export interface EvolutionTaskEventData {
  taskId: string;
  taskType: string;
  reason: string;
}

// ============== Daily Statistics ==============

export interface ToolCallStats {
  total: number;
  success: number;
  failure: number;
  byTool: Record<string, { success: number; failure: number }>;
}

export interface ErrorStats {
  total: number;
  byType: Record<string, number>;
  byTool: Record<string, number>;
}

export interface PainStats {
  signalsDetected: number;
  signalsBySource: Record<string, number>;
  rulesMatched: Record<string, number>;
  candidatesPromoted: number;
  avgScore: number;
  maxScore: number;
}

export interface GfiStats {
  peak: number;
  samples: number;
  total: number;
  resetCount: number;
  hourlyDistribution: number[];  // 24 hourly samples
}

export interface EvolutionStats {
  tasksEnqueued: number;
  tasksCompleted: number;
  rulesPromoted: number;
}

export interface HookStats {
  byType: Record<string, number>;
  errors: number;
  totalDurationMs: number;
}

/**
 * Daily aggregated statistics.
 */
export interface DailyStats {
  /** Date (YYYY-MM-DD) */
  date: string;
  /** Timestamp when stats were created */
  createdAt: string;
  /** Timestamp when stats were last updated */
  updatedAt: string;
  /** Tool call statistics */
  toolCalls: ToolCallStats;
  /** Error statistics */
  errors: ErrorStats;
  /** Pain signal statistics */
  pain: PainStats;
  /** GFI statistics */
  gfi: GfiStats;
  /** Evolution statistics */
  evolution: EvolutionStats;
  /** Hook execution statistics */
  hooks: HookStats;
}

/**
 * Creates an empty daily stats object.
 */
export function createEmptyDailyStats(date: string): DailyStats {
  const now = new Date().toISOString();
  return {
    date,
    createdAt: now,
    updatedAt: now,
    toolCalls: {
      total: 0,
      success: 0,
      failure: 0,
      byTool: {},
    },
    errors: {
      total: 0,
      byType: {},
      byTool: {},
    },
    pain: {
      signalsDetected: 0,
      signalsBySource: {},
      rulesMatched: {},
      candidatesPromoted: 0,
      avgScore: 0,
      maxScore: 0,
    },
    gfi: {
      peak: 0,
      samples: 0,
      total: 0,
      resetCount: 0,
      hourlyDistribution: new Array(24).fill(0),
    },
    evolution: {
      tasksEnqueued: 0,
      tasksCompleted: 0,
      rulesPromoted: 0,
    },
    hooks: {
      byType: {},
      errors: 0,
      totalDurationMs: 0,
    },
  };
}
