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
  | 'plan_approval'
  | 'evolution_task'
  | 'deep_reflection'
  | 'trust_change'
  | 'error'
  | 'warn';

export type EventCategory =
  | 'success'
  | 'failure'
  | 'detected'
  | 'blocked'
  | 'approved'
  | 'enqueued'
  | 'completed'
  | 'promoted'
  | 'passed'
  | 'changed';

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

export interface TrustChangeEventData {
  previousScore: number;
  newScore: number;
  delta: number;
  reason: string;
}

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

export interface PlanApprovalEventData {
  toolName: string;
  filePath: string;
  pattern: string;
  planStatus: string;
}

export interface EvolutionTaskEventData {
  taskId: string;
  taskType: string;
  reason: string;
}

export interface DeepReflectionEventData {
  /** 思维模型 ID (T-01 到 T-09)，向后兼容 */
  modelId: string;
  /** 模型选择模式：'manual' = 用户指定 model_id，'auto' = 子智能体自动选择 */
  modelSelectionMode: 'manual' | 'auto';
  /** 反思深度 (1-3) */
  depth: number;
  /** 上下文摘要（前 200 字符） */
  contextPreview: string;
  /** 反思结果摘要 */
  resultPreview?: string;
  /** 执行耗时 (ms) */
  durationMs: number;
  /** 是否通过（未发现显著问题） */
  passed: boolean;
  /** 是否超时 */
  timeout: boolean;
  /** 错误信息 */
  error?: string;
  /** 输出长度 */
  outputLength?: number;
  /** 置信度（从输出中提取） */
  confidence?: 'LOW' | 'MEDIUM' | 'HIGH';
  /** 发现的盲点数量 */
  blindSpotsCount?: number;
  /** 发现的风险数量 */
  risksCount?: number;
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

export interface DeepReflectionStats {
  /** 总调用次数 */
  totalCalls: number;
  /** 通过次数（未发现问题） */
  passedCount: number;
  /** 发现问题的次数 */
  issuesFoundCount: number;
  /** 超时次数 */
  timeoutCount: number;
  /** 错误次数 */
  errorCount: number;
  /** 按模型选择模式统计 */
  bySelectionMode: {
    manual: { count: number; avgDurationMs: number; passedCount: number };
    auto: { count: number; avgDurationMs: number; passedCount: number };
  };
  /** 按模型统计（向后兼容，仅记录手动指定的 model_id） */
  byModel: Record<string, { 
    count: number; 
    avgDurationMs: number;
    passedCount: number;
  }>;
  /** 按深度统计 */
  byDepth: Record<number, number>;
  /** 总耗时 */
  totalDurationMs: number;
  /** 平均耗时 */
  avgDurationMs: number;
  /** 发现的总盲点数 */
  totalBlindSpots: number;
  /** 发现的总风险数 */
  totalRisks: number;
  /** 置信度分布 */
  confidenceDistribution: { LOW: number; MEDIUM: number; HIGH: number };
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
  tools: {
    total: number;
    success: number;
    failure: number;
  };
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
  /** Deep Reflection statistics */
  deepReflection: DeepReflectionStats;
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
    tools: {
      total: 0,
      success: 0,
      failure: 0,
    },
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
    deepReflection: {
      totalCalls: 0,
      passedCount: 0,
      issuesFoundCount: 0,
      timeoutCount: 0,
      errorCount: 0,
      bySelectionMode: {
        manual: { count: 0, avgDurationMs: 0, passedCount: 0 },
        auto: { count: 0, avgDurationMs: 0, passedCount: 0 },
      },
      byModel: {},
      byDepth: {},
      totalDurationMs: 0,
      avgDurationMs: 0,
      totalBlindSpots: 0,
      totalRisks: 0,
      confidenceDistribution: { LOW: 0, MEDIUM: 0, HIGH: 0 },
    },
  };
}
