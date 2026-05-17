/**
 * Event types for structured logging and daily statistics.
 */
import { Type, type Static } from '@sinclair/typebox';

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
      | 'rulehost_requireApproval'
      | 'rulehost_auto_correct_proposed';

export const EventTypeSchema = Type.Union([
  Type.Literal('tool_call'),
  Type.Literal('pain_signal'),
  Type.Literal('rule_match'),
  Type.Literal('rule_promotion'),
  Type.Literal('hook_execution'),
  Type.Literal('gate_block'),
  Type.Literal('gate_bypass'),
  Type.Literal('plan_approval'),
  Type.Literal('evolution_task'),
  Type.Literal('empathy_rollback'),
  Type.Literal('error'),
  Type.Literal('warn'),
  Type.Literal('diagnosis_task'),
  Type.Literal('heartbeat_diagnosis'),
  Type.Literal('diagnostician_report'),
  Type.Literal('principle_candidate'),
  Type.Literal('rule_enforced'),
  Type.Literal('nocturnal_dreamer_completed'),
  Type.Literal('nocturnal_artifact_persisted'),
  Type.Literal('nocturnal_code_candidate_created'),
  Type.Literal('rulehost_evaluated'),
  Type.Literal('rulehost_blocked'),
  Type.Literal('rulehost_requireApproval'),
  Type.Literal('rulehost_auto_correct_proposed'),
]);

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
      | 'requireApproval'  // Used by: rulehost_requireApproval
      | 'auto_correct';  // Used by: rulehost_auto_correct_proposed (PRI-114)

export const EventCategorySchema = Type.Union([
  Type.Literal('success'),
  Type.Literal('failure'),
  Type.Literal('detected'),
  Type.Literal('blocked'),
  Type.Literal('bypassed'),
  Type.Literal('approved'),
  Type.Literal('enqueued'),
  Type.Literal('completed'),
  Type.Literal('promoted'),
  Type.Literal('passed'),
  Type.Literal('changed'),
  Type.Literal('rolled_back'),
  Type.Literal('written'),
  Type.Literal('injected'),
  Type.Literal('created'),
  Type.Literal('matched'),
  Type.Literal('evaluated'),
  Type.Literal('requireApproval'),
  Type.Literal('auto_correct'),
]);

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

export const EventLogEntrySchema = Type.Object({
  ts: Type.String(),
  date: Type.String(),
  type: EventTypeSchema,
  category: EventCategorySchema,
  sessionId: Type.Optional(Type.String()),
  workspaceDir: Type.Optional(Type.String()),
  data: Type.Record(Type.String(), Type.Any()),
});
export type EventLogEntryStatic = Static<typeof EventLogEntrySchema>;

// ============== Specific Event Data ==============

export interface ToolCallEventData {
  toolName: string;
  filePath?: string;
  error?: string;
  errorType?: string;
  /** @deprecated use gfiBefore/gfiAfter instead */
  gfi?: number;
  consecutiveErrors?: number;
  exitCode?: number;
  /** PRI-79: GFI value before this tool call */
  gfiBefore?: number;
  /** PRI-79: GFI value after this tool call (post-friction or post-relief) */
  gfiAfter?: number;
}

export const ToolCallEventDataSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  errorType: Type.Optional(Type.String()),
  gfi: Type.Optional(Type.Number()),
  consecutiveErrors: Type.Optional(Type.Number()),
  exitCode: Type.Optional(Type.Number()),
  gfiBefore: Type.Optional(Type.Number()),
  gfiAfter: Type.Optional(Type.Number()),
});
export type ToolCallEventDataStatic = Static<typeof ToolCallEventDataSchema>;

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

export const PainSignalEventDataSchema = Type.Object({
  score: Type.Number(),
  source: Type.String(),
  eventId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  isRisky: Type.Optional(Type.Boolean()),
  origin: Type.Optional(Type.Union([
    Type.Literal('assistant_self_report'),
    Type.Literal('user_manual'),
    Type.Literal('system_infer'),
  ])),
  severity: Type.Optional(Type.Union([
    Type.Literal('mild'),
    Type.Literal('moderate'),
    Type.Literal('severe'),
  ])),
  confidence: Type.Optional(Type.Number()),
  detection_mode: Type.Optional(Type.Union([
    Type.Literal('structured'),
    Type.Literal('legacy_tag'),
  ])),
  deduped: Type.Optional(Type.Boolean()),
  trigger_text_excerpt: Type.Optional(Type.String()),
  raw_score: Type.Optional(Type.Number()),
  calibrated_score: Type.Optional(Type.Number()),
});
export type PainSignalEventDataStatic = Static<typeof PainSignalEventDataSchema>;

export interface RuleMatchEventData {
  ruleId: string;
  layer: 'L1' | 'L2' | 'L3';
  severity: number;
  textPreview: string;
}

export const RuleMatchEventDataSchema = Type.Object({
  ruleId: Type.String(),
  layer: Type.Union([Type.Literal('L1'), Type.Literal('L2'), Type.Literal('L3')]),
  severity: Type.Number(),
  textPreview: Type.String(),
});
export type RuleMatchEventDataStatic = Static<typeof RuleMatchEventDataSchema>;

export interface RulePromotionEventData {
  fingerprint: string;
  ruleId: string;
  phrase: string;
  sampleCount: number;
  avgSimilarity: number;
}

export const RulePromotionEventDataSchema = Type.Object({
  fingerprint: Type.String(),
  ruleId: Type.String(),
  phrase: Type.String(),
  sampleCount: Type.Number(),
  avgSimilarity: Type.Number(),
});
export type RulePromotionEventDataStatic = Static<typeof RulePromotionEventDataSchema>;

export interface HookExecutionEventData {
  hook: string;
  sessionId?: string;
  durationMs?: number;
  error?: string;
}

export const HookExecutionEventDataSchema = Type.Object({
  hook: Type.String(),
  sessionId: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
});
export type HookExecutionEventDataStatic = Static<typeof HookExecutionEventDataSchema>;

export interface GateBlockEventData {
  toolName: string;
  filePath: string;
  reason: string;
  planStatus?: string;
  /** Source module that triggered the block (for audit trail) */
  blockSource?: string;
}

export const GateBlockEventDataSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.String(),
  reason: Type.String(),
  planStatus: Type.Optional(Type.String()),
  blockSource: Type.Optional(Type.String()),
});
export type GateBlockEventDataStatic = Static<typeof GateBlockEventDataSchema>;

export interface GateBypassEventData {
  toolName: string;
  filePath: string;
  bypassType: 'stage4_architect' | 'whitelisted';
}

export const GateBypassEventDataSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.String(),
  bypassType: Type.Union([Type.Literal('stage4_architect'), Type.Literal('whitelisted')]),
});
export type GateBypassEventDataStatic = Static<typeof GateBypassEventDataSchema>;

export interface PlanApprovalEventData {
  toolName: string;
  filePath: string;
  pattern: string;
  planStatus: string;
}

export const PlanApprovalEventDataSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.String(),
  pattern: Type.String(),
  planStatus: Type.String(),
});
export type PlanApprovalEventDataStatic = Static<typeof PlanApprovalEventDataSchema>;

export interface EvolutionTaskEventData {
  taskId: string;
  taskType: string;
  reason: string;
}

export const EvolutionTaskEventDataSchema = Type.Object({
  taskId: Type.String(),
  taskType: Type.String(),
  reason: Type.String(),
});
export type EvolutionTaskEventDataStatic = Static<typeof EvolutionTaskEventDataSchema>;

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

export const EmpathyRollbackEventDataSchema = Type.Object({
  eventId: Type.String(),
  originalScore: Type.Number(),
  originalSessionId: Type.Optional(Type.String()),
  reason: Type.String(),
  triggeredBy: Type.Union([
    Type.Literal('user_command'),
    Type.Literal('natural_language'),
    Type.Literal('system'),
  ]),
});
export type EmpathyRollbackEventDataStatic = Static<typeof EmpathyRollbackEventDataSchema>;

/**
 * C: New event data types for diagnostician heartbeat chain observability.
 * Maps heartbeat_injected -> when prompt.ts injects diagnostician tasks into heartbeat
 */
export interface HeartbeatDiagnosisEventData {
  taskCount: number;
  taskIds: string[];
  trigger: 'heartbeat' | 'immediate';
}

export const HeartbeatDiagnosisEventDataSchema = Type.Object({
  taskCount: Type.Number(),
  taskIds: Type.Array(Type.String()),
  trigger: Type.Union([Type.Literal('heartbeat'), Type.Literal('immediate')]),
});
export type HeartbeatDiagnosisEventDataStatic = Static<typeof HeartbeatDiagnosisEventDataSchema>;

/**
 * Maps diagnosis_task_written -> when evolution-worker writes to diagnostician_tasks.json
 */
export interface DiagnosisTaskEventData {
  taskId: string;
  painEventId?: string;
  sessionId?: string;
}

export const DiagnosisTaskEventDataSchema = Type.Object({
  taskId: Type.String(),
  painEventId: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
});
export type DiagnosisTaskEventDataStatic = Static<typeof DiagnosisTaskEventDataSchema>;

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

export const DiagnosticianReportEventDataSchema = Type.Object({
  taskId: Type.String(),
  reportPath: Type.String(),
  category: Type.Union([
    Type.Literal('success'),
    Type.Literal('missing_json'),
    Type.Literal('incomplete_fields'),
  ]),
});
export type DiagnosticianReportEventDataStatic = Static<typeof DiagnosticianReportEventDataSchema>;

/**
 * Maps principle_candidate_created -> when evolution-worker extracts principle from report
 */
export interface PrincipleCandidateEventData {
  principleId: string;
  taskId: string;
  source: 'diagnostician' | 'nocturnal' | 'manual';
}

export const PrincipleCandidateEventDataSchema = Type.Object({
  principleId: Type.String(),
  taskId: Type.String(),
  source: Type.Union([
    Type.Literal('diagnostician'),
    Type.Literal('nocturnal'),
    Type.Literal('manual'),
  ]),
});
export type PrincipleCandidateEventDataStatic = Static<typeof PrincipleCandidateEventDataSchema>;

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

export const RuleEnforcedEventDataSchema = Type.Object({
  ruleId: Type.String(),
  principleId: Type.String(),
  enforcement: Type.Union([
    Type.Literal('warn'),
    Type.Literal('block'),
    Type.Literal('requireApproval'),
  ]),
  toolName: Type.String(),
  filePath: Type.String(),
});
export type RuleEnforcedEventDataStatic = Static<typeof RuleEnforcedEventDataSchema>;

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

export const NocturnalDreamerCompletedEventDataSchema = Type.Object({
  workflowId: Type.String(),
  principleId: Type.String(),
  sessionId: Type.String(),
  candidateCount: Type.Number(),
  chainMode: Type.Union([Type.Literal('trinity'), Type.Literal('single-reflector')]),
});
export type NocturnalDreamerCompletedEventDataStatic = Static<typeof NocturnalDreamerCompletedEventDataSchema>;

/**
 * nocturnal_artifact_persisted — Artifact saved to .state/nocturnal/samples/.
 * Emitted from persistArtifact() after atomicWriteFileSync.
 */
export interface NocturnalArtifactPersistedEventData {
  artifactId: string;
  principleId: string;
  persistedPath: string;
}

export const NocturnalArtifactPersistedEventDataSchema = Type.Object({
  artifactId: Type.String(),
  principleId: Type.String(),
  persistedPath: Type.String(),
});
export type NocturnalArtifactPersistedEventDataStatic = Static<typeof NocturnalArtifactPersistedEventDataSchema>;

/**
 * nocturnal_code_candidate_created — Rule implementation candidate persisted.
 * Emitted from persistCodeCandidate() after successful creation.
 */
export interface NocturnalCodeCandidateCreatedEventData {
  implementationId: string;
  artifactId: string;
  ruleId: string;
  persistedPath: string;
}

export const NocturnalCodeCandidateCreatedEventDataSchema = Type.Object({
  implementationId: Type.String(),
  artifactId: Type.String(),
  ruleId: Type.String(),
  persistedPath: Type.String(),
});
export type NocturnalCodeCandidateCreatedEventDataStatic = Static<typeof NocturnalCodeCandidateCreatedEventDataSchema>;

// ============== RuleHost Funnel Events (PD-FUNNEL-2.4) ==============

/**
 * rulehost_evaluated — RuleHost.evaluate() was called.
 * Emitted from gate.ts for every evaluate() call (matched or not).
 */
export interface RuleHostEvaluatedEventData {
  toolName: string;
  filePath: string;
  matched: boolean;
  decision: 'allow' | 'block' | 'requireApproval' | 'auto_correct';
  ruleId?: string;
}

export const RuleHostEvaluatedEventDataSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.String(),
  matched: Type.Boolean(),
  decision: Type.Union([
    Type.Literal('allow'),
    Type.Literal('block'),
    Type.Literal('requireApproval'),
    Type.Literal('auto_correct'),
  ]),
  ruleId: Type.Optional(Type.String()),
});
export type RuleHostEvaluatedEventDataStatic = Static<typeof RuleHostEvaluatedEventDataSchema>;

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

export const RuleHostBlockedEventDataSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.String(),
  reason: Type.String(),
  ruleId: Type.Optional(Type.String()),
});
export type RuleHostBlockedEventDataStatic = Static<typeof RuleHostBlockedEventDataSchema>;

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

export const RuleHostRequireApprovalEventDataSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.String(),
  reason: Type.String(),
  ruleId: Type.Optional(Type.String()),
});
export type RuleHostRequireApprovalEventDataStatic = Static<typeof RuleHostRequireApprovalEventDataSchema>;

/**
 * rulehost_auto_correct_proposed — RuleHost proposed an auto-correction (PRI-114).
 * Emitted from gate.ts when hostResult.decision === 'auto_correct'.
 * Supports shadow/live proposal modes; application behavior is decided by gate policy.
 */
export interface RuleHostAutoCorrectProposedEventData {
  toolName: string;
  filePath: string;
  ruleId: string;
  principleId?: string;
  confidence: number;
  reason: string;
  applicationMode: 'shadow' | 'live';
  correctedFields: string[];
  validationValid: boolean;
}

export const RuleHostAutoCorrectProposedEventDataSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.String(),
  ruleId: Type.String(),
  principleId: Type.Optional(Type.String()),
  confidence: Type.Number(),
  reason: Type.String(),
  applicationMode: Type.Union([Type.Literal('shadow'), Type.Literal('live')]),
  correctedFields: Type.Array(Type.String()),
  validationValid: Type.Boolean(),
});
export type RuleHostAutoCorrectProposedEventDataStatic = Static<typeof RuleHostAutoCorrectProposedEventDataSchema>;

// ============== Daily Statistics ==============

export interface ToolCallStats {
  total: number;
  success: number;
  failure: number;
  byTool: Record<string, { success: number; failure: number }>;
}

export const ToolCallStatsSchema = Type.Object({
  total: Type.Number(),
  success: Type.Number(),
  failure: Type.Number(),
  byTool: Type.Record(Type.String(), Type.Object({
    success: Type.Number(),
    failure: Type.Number(),
  })),
});
export type ToolCallStatsStatic = Static<typeof ToolCallStatsSchema>;

export interface ErrorStats {
  total: number;
  byType: Record<string, number>;
  byTool: Record<string, number>;
}

export const ErrorStatsSchema = Type.Object({
  total: Type.Number(),
  byType: Type.Record(Type.String(), Type.Number()),
  byTool: Type.Record(Type.String(), Type.Number()),
});
export type ErrorStatsStatic = Static<typeof ErrorStatsSchema>;

export interface PainStats {
  signalsDetected: number;
  signalsBySource: Record<string, number>;
  rulesMatched: Record<string, number>;
  candidatesPromoted: number;
  avgScore: number;
  maxScore: number;
}

export const PainStatsSchema = Type.Object({
  signalsDetected: Type.Number(),
  signalsBySource: Type.Record(Type.String(), Type.Number()),
  rulesMatched: Type.Record(Type.String(), Type.Number()),
  candidatesPromoted: Type.Number(),
  avgScore: Type.Number(),
  maxScore: Type.Number(),
});
export type PainStatsStatic = Static<typeof PainStatsSchema>;

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

export const EmpathyEventStatsSchema = Type.Object({
  totalEvents: Type.Number(),
  dedupedCount: Type.Number(),
  dedupeHitRate: Type.Number(),
  totalPenaltyScore: Type.Number(),
  rolledBackScore: Type.Number(),
  rollbackCount: Type.Number(),
  bySeverity: Type.Object({
    mild: Type.Number(),
    moderate: Type.Number(),
    severe: Type.Number(),
  }),
  scoreBySeverity: Type.Object({
    mild: Type.Number(),
    moderate: Type.Number(),
    severe: Type.Number(),
  }),
  byDetectionMode: Type.Object({
    structured: Type.Number(),
    legacy_tag: Type.Number(),
  }),
  byOrigin: Type.Object({
    assistant_self_report: Type.Number(),
    user_manual: Type.Number(),
    system_infer: Type.Number(),
  }),
  confidenceDistribution: Type.Object({
    high: Type.Number(),
    medium: Type.Number(),
    low: Type.Number(),
  }),
  dailyTrend: Type.Array(Type.Object({
    date: Type.String(),
    count: Type.Number(),
    score: Type.Number(),
  })),
});
export type EmpathyEventStatsStatic = Static<typeof EmpathyEventStatsSchema>;

export interface GfiStats {
  peak: number;
  samples: number;
  total: number;
  resetCount: number;
  hourlyDistribution: number[];
}

export const GfiStatsSchema = Type.Object({
  peak: Type.Number(),
  samples: Type.Number(),
  total: Type.Number(),
  resetCount: Type.Number(),
  hourlyDistribution: Type.Array(Type.Number()),
});
export type GfiStatsStatic = Static<typeof GfiStatsSchema>;

export interface EventEvolutionStats {
  tasksEnqueued: number;
  tasksCompleted: number;
  rulesPromoted: number;
  diagnosisTasksWritten: number;
  heartbeatsInjected: number;
  diagnosticianReportsWritten: number;
  reportsMissingJson: number;
  reportsIncompleteFields: number;
  principleCandidatesCreated: number;
  rulesEnforced: number;
  nocturnalDreamerCompleted: number;
  nocturnalTrinityCompleted: number;
  nocturnalArtifactPersisted: number;
  nocturnalCodeCandidateCreated: number;
  rulehostEvaluated: number;
  rulehostBlocked: number;
  rulehostRequireApproval: number;
  rulehostAutoCorrectProposed: number;
}

// Backward compatibility alias
/** @deprecated Use EventEvolutionStats instead. Alias for backward compatibility. */
export type EvolutionStats = EventEvolutionStats;

export const EventEvolutionStatsSchema = Type.Object({
  tasksEnqueued: Type.Number(),
  tasksCompleted: Type.Number(),
  rulesPromoted: Type.Number(),
  diagnosisTasksWritten: Type.Number(),
  heartbeatsInjected: Type.Number(),
  diagnosticianReportsWritten: Type.Number(),
  reportsMissingJson: Type.Number(),
  reportsIncompleteFields: Type.Number(),
  principleCandidatesCreated: Type.Number(),
  rulesEnforced: Type.Number(),
  nocturnalDreamerCompleted: Type.Number(),
  nocturnalTrinityCompleted: Type.Number(),
  nocturnalArtifactPersisted: Type.Number(),
  nocturnalCodeCandidateCreated: Type.Number(),
  rulehostEvaluated: Type.Number(),
  rulehostBlocked: Type.Number(),
  rulehostRequireApproval: Type.Number(),
  rulehostAutoCorrectProposed: Type.Number(),
});
export type EventEvolutionStatsStatic = Static<typeof EventEvolutionStatsSchema>;

// Backward compatibility alias for schema
/** @deprecated Use EventEvolutionStatsSchema instead. Alias for backward compatibility. */
export const EvolutionStatsSchema = EventEvolutionStatsSchema;

export interface HookStats {
  total: number;
  success: number;
  failure: number;
  byType: Record<string, { total: number; success: number; failure: number }>;
  errors: number;
  totalDurationMs: number;
}

export const HookStatsSchema = Type.Object({
  total: Type.Number(),
  success: Type.Number(),
  failure: Type.Number(),
  byType: Type.Record(Type.String(), Type.Object({
    total: Type.Number(),
    success: Type.Number(),
    failure: Type.Number(),
  })),
  errors: Type.Number(),
  totalDurationMs: Type.Number(),
});
export type HookStatsStatic = Static<typeof HookStatsSchema>;

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
}

export const DailyStatsSchema = Type.Object({
  date: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  tools: Type.Object({
    total: Type.Number(),
    success: Type.Number(),
    failure: Type.Number(),
  }),
  toolCalls: ToolCallStatsSchema,
  errors: ErrorStatsSchema,
  pain: PainStatsSchema,
  empathy: EmpathyEventStatsSchema,
  gfi: GfiStatsSchema,
  evolution: EventEvolutionStatsSchema,
  hooks: HookStatsSchema,
});
export type DailyStatsStatic = Static<typeof DailyStatsSchema>;

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
      diagnosisTasksWritten: 0,
      heartbeatsInjected: 0,
      diagnosticianReportsWritten: 0,
      reportsMissingJson: 0,
      reportsIncompleteFields: 0,
      principleCandidatesCreated: 0,
      rulesEnforced: 0,
      nocturnalDreamerCompleted: 0,
      nocturnalTrinityCompleted: 0,
      nocturnalArtifactPersisted: 0,
      nocturnalCodeCandidateCreated: 0,
      rulehostEvaluated: 0,
      rulehostBlocked: 0,
      rulehostRequireApproval: 0,
      rulehostAutoCorrectProposed: 0,
    },
    hooks: {
      total: 0,
      success: 0,
      failure: 0,
      byType: {},
      errors: 0,
      totalDurationMs: 0,
    },
  };
}
