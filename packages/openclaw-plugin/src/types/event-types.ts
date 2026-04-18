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
  | 'gate_bypass'
  | 'plan_approval'
  | 'evolution_task'
  | 'deep_reflection'
  | 'empathy_rollback'
  | 'error'
  | 'warn'
  // C: Diagnostician heartbeat chain events
  | 'diagnosis_task'        // Diagnostician task written to task store
  | 'heartbeat_diagnosis'  // Heartbeat injected diagnostician tasks
  | 'diagnostician_report' // Diagnostician completed and wrote report
  | 'principle_candidate'  // Principle candidate created from report
  | 'rule_enforced'       // Rule enforced (matched) during tool call
      // C: Nocturnal funnel stage events (PD-FUNNEL-2.3)
      | 'nocturnal_dreamer_completed'
      | 'nocturnal_artifact_persisted'
      | 'nocturnal_code_candidate_created'
      // C: RuleHost funnel events (PD-FUNNEL-2.4)
      | 'rulehost_evaluated'
      | 'rulehost_blocked'
      | 'rulehost_requireApproval';

export type EventCategory =
  | 'success'
  | 'failure'
  | 'detected'
  | 'blocked'
  | 'bypassed'
  | 'approved'
  | 'enqueued'
  | 'completed'
  | 'promoted'
  | 'passed'
  | 'changed'
  | 'rolled_back'
  // C: New categories for diagnostician heartbeat chain
  | 'written'
  | 'injected'
  | 'created'
  | 'matched'
      // C: New categories for RuleHost funnel (PD-FUNNEL-2.4) — completed/created already exist
      | 'evaluated'   // Used by: rulehost_evaluated
      | 'blocked'     // Used by: rulehost_blocked
      | 'requireApproval';  // Used by: rulehost_requireApproval

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
  eventId?: string;
  reason?: string;
  isRisky?: boolean;
  origin?: 'assistant_self_report' | 'user_manual' | 'system_infer';
  severity?: 'mild' | 'moderate' | 'severe';
  confidence?: number;
  detection_mode?: 'structured' | 'legacy_tag';
  deduped?: boolean;
  trigger_text_excerpt?: string;
  raw_score?: number;
  calibrated_score?: number;
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
  hook: string;
  sessionId?: string;
  durationMs?: number;
  error?: string;
}

export interface GateBlockEventData {
  toolName: string;
  filePath: string;
  reason: string;
  planStatus?: string;
  /** Source module that triggered the block (for audit trail) */
  blockSource?: string;
}

export interface GateBypassEventData {
  toolName: string;
  filePath: string;
  bypassType: 'stage4_architect' | 'whitelisted';
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

export interface EmpathyRollbackEventData {
  /** Event ID being rolled back */
  eventId: string;
  /** Original penalty score that was applied */
  originalScore: number;
  /** Session ID where the original event occurred */
  originalSessionId?: string;
  /** Reason for rollback (manual, false_positive, etc.) */
  reason: string;
  /** Who initiated the rollback */
  triggeredBy: 'user_command' | 'natural_language' | 'system';
}

/**
 * C: New event data types for diagnostician heartbeat chain observability.
 * Maps heartbeat_injected -> when prompt.ts injects diagnostician tasks into heartbeat
 */
export interface HeartbeatDiagnosisEventData {
  taskCount: number;
  taskIds: string[];
  trigger: 'heartbeat' | 'immediate';
}

/**
 * Maps diagnosis_task_written -> when evolution-worker writes to diagnostician_tasks.json
 */
export interface DiagnosisTaskEventData {
  taskId: string;
  painEventId?: string;
  sessionId?: string;
}

/**
 * Maps diagnostician_report_written -> when diagnostician completes and writes report
 */
export interface DiagnosticianReportEventData {
  taskId: string;
  reportPath: string;
  /** Three-state category replacing boolean success field.
   * - 'success': JSON exists and has principle field
   * - 'missing_json': marker exists but JSON does not (Issue #366, LLM output truncation)
   * - 'incomplete_fields': JSON exists but missing principle field
   */
  category: 'success' | 'missing_json' | 'incomplete_fields';
}

/**
 * Maps principle_candidate_created -> when evolution-worker extracts principle from report
 */
export interface PrincipleCandidateEventData {
  principleId: string;
  taskId: string;
  source: 'diagnostician' | 'nocturnal' | 'manual';
}

/**
 * Maps rule_enforced -> when RuleHost evaluate() returns matched during tool call
 */
export interface RuleEnforcedEventData {
  ruleId: string;
  principleId: string;
  enforcement: 'warn' | 'block' | 'requireApproval';
  toolName: string;
  filePath: string;
}

// ============== Nocturnal Funnel Events (PD-FUNNEL-2.3) ==============

/**
 * nocturnal_dreamer_completed — Trinity Dreamer stage completed.
 * Emitted from nocturnal-workflow-manager.ts after Trinity chain success.
 */
export interface NocturnalDreamerCompletedEventData {
  workflowId: string;
  principleId: string;
  sessionId: string;
  candidateCount: number;
  chainMode: 'trinity' | 'single-reflector';
}

/**
 * nocturnal_artifact_persisted — Artifact saved to .state/nocturnal/samples/.
 * Emitted from nocturnal-service.ts persistArtifact() after atomicWriteFileSync.
 */
export interface NocturnalArtifactPersistedEventData {
  artifactId: string;
  principleId: string;
  persistedPath: string;
}

/**
 * nocturnal_code_candidate_created — Rule implementation candidate persisted.
 * Emitted from nocturnal-service.ts persistCodeCandidate() after successful creation.
 */
export interface NocturnalCodeCandidateCreatedEventData {
  implementationId: string;
  artifactId: string;
  ruleId: string;
  persistedPath: string;
}

// ============== RuleHost Funnel Events (PD-FUNNEL-2.4) ==============

/**
 * rulehost_evaluated — RuleHost.evaluate() was called.
 * Emitted from gate.ts for every evaluate() call (matched or not).
 */
export interface RuleHostEvaluatedEventData {
  toolName: string;
  filePath: string;
  matched: boolean;
  decision: 'allow' | 'block' | 'requireApproval';
  ruleId?: string;
}

/**
 * rulehost_blocked — Tool call was blocked by RuleHost.
 * Emitted from gate.ts when hostResult.decision === 'block'.
 */
export interface RuleHostBlockedEventData {
  toolName: string;
  filePath: string;
  reason: string;
  ruleId?: string;
}

/**
 * rulehost_requireApproval — Tool call requires approval by RuleHost.
 * Emitted from gate.ts when hostResult.decision === 'requireApproval'.
 */
export interface RuleHostRequireApprovalEventData {
  toolName: string;
  filePath: string;
  reason: string;
  ruleId?: string;
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

/**
 * Empathy Engine event statistics for tracking emotional signals.
 * Used for /pd-status empathy card and effectiveness metrics.
 */
export interface EmpathyEventStats {
  /** Total empathy events detected (excluding deduped) */
  totalEvents: number;
  /** Events that were deduped (not counted in totalEvents) */
  dedupedCount: number;
  /** Dedupe hit rate (dedupedCount / (totalEvents + dedupedCount)) */
  dedupeHitRate: number;
  /** Total penalty score applied */
  totalPenaltyScore: number;
  /** Score rolled back via manual rollback */
  rolledBackScore: number;
  /** Number of rollback operations */
  rollbackCount: number;
  /** Events by severity level */
  bySeverity: {
    mild: number;
    moderate: number;
    severe: number;
  };
  /** Score by severity level */
  scoreBySeverity: {
    mild: number;
    moderate: number;
    severe: number;
  };
  /** Events by detection mode */
  byDetectionMode: {
    structured: number;
    legacy_tag: number;
  };
  /** Events by origin */
  byOrigin: {
    assistant_self_report: number;
    user_manual: number;
    system_infer: number;
  };
  /** Confidence distribution */
  confidenceDistribution: {
    high: number;  // confidence >= 0.8
    medium: number; // 0.5 <= confidence < 0.8
    low: number;   // confidence < 0.5
  };
  /** Daily trend (last 7 days) */
  dailyTrend: {
    date: string;
    count: number;
    score: number;
  }[];
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
  // C: Diagnostician heartbeat chain counters
  diagnosisTasksWritten: number;
  heartbeatsInjected: number;
  diagnosticianReportsWritten: number;
  reportsMissingJson: number;
  reportsIncompleteFields: number;
  principleCandidatesCreated: number;
  rulesEnforced: number;
  // C: Nocturnal funnel counters (PD-FUNNEL-2.3)
  nocturnalDreamerCompleted: number;
  nocturnalTrinityCompleted: number;
  nocturnalArtifactPersisted: number;
  nocturnalCodeCandidateCreated: number;
  // C: RuleHost funnel counters (PD-FUNNEL-2.4)
  rulehostEvaluated: number;
  rulehostBlocked: number;
  rulehostRequireApproval: number;
}

export interface HookStats {
  total: number;
  success: number;
  failure: number;
  byType: Record<string, { total: number; success: number; failure: number }>;
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
  /** Empathy Engine event statistics */
  empathy: EmpathyEventStats;
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
    empathy: {
      totalEvents: 0,
      dedupedCount: 0,
      dedupeHitRate: 0,
      totalPenaltyScore: 0,
      rolledBackScore: 0,
      rollbackCount: 0,
      bySeverity: {
        mild: 0,
        moderate: 0,
        severe: 0,
      },
      scoreBySeverity: {
        mild: 0,
        moderate: 0,
        severe: 0,
      },
      byDetectionMode: {
        structured: 0,
        legacy_tag: 0,
      },
      byOrigin: {
        assistant_self_report: 0,
        user_manual: 0,
        system_infer: 0,
      },
      confidenceDistribution: {
        high: 0,
        medium: 0,
        low: 0,
      },
      dailyTrend: [],
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
      // C: Diagnostician heartbeat chain counters
      diagnosisTasksWritten: 0,
      heartbeatsInjected: 0,
      diagnosticianReportsWritten: 0,
      reportsMissingJson: 0,
      reportsIncompleteFields: 0,
      principleCandidatesCreated: 0,
      rulesEnforced: 0,
      // C: Nocturnal funnel counters (PD-FUNNEL-2.3)
      nocturnalDreamerCompleted: 0,
      nocturnalTrinityCompleted: 0,
      nocturnalArtifactPersisted: 0,
      nocturnalCodeCandidateCreated: 0,
      // C: RuleHost funnel counters (PD-FUNNEL-2.4)
      rulehostEvaluated: 0,
      rulehostBlocked: 0,
      rulehostRequireApproval: 0,
    },
    hooks: {
      total: 0,
      success: 0,
      failure: 0,
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
