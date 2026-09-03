/**
 * Event types for structured logging and daily statistics.
 */
import { Type, type Static } from '@sinclair/typebox';

// ============== Event Types ==============

export type EventType =
  | 'tool_call'
  | 'pain_signal'
  | 'rule_promotion'
  | 'governance_action'
  | 'hook_execution'
  | 'gate_block'
  | 'gate_bypass'
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
      // C: RuleHost funnel events (PD-FUNNEL-2.4)
      | 'rulehost_evaluated'
      | 'rulehost_blocked'
      | 'rulehost_requireApproval'
      | 'rulehost_auto_correct_proposed'
      | 'rulehost_auto_correct_applied'
      | 'runtime_v2_prompt_activations_injected'
      // PRI-437: RuleHost health — approved rule failed to compile/load
      | 'rulehost_unhealthy'
      // PRI-491: RuleHost skipped — active activation skipped at load (flag-off, unsupported action, etc.)
      | 'rulehost_skipped'
      // PRI-647: trajectory observability failed (closed/disposed connection) but prompt build continued (fail-open)
      | 'trajectory_observability_failure';

export const EventTypeSchema = Type.Union([
  Type.Literal('tool_call'),
  Type.Literal('pain_signal'),
  Type.Literal('rule_promotion'),
  Type.Literal('governance_action'),
  Type.Literal('hook_execution'),
  Type.Literal('gate_block'),
  Type.Literal('gate_bypass'),
  Type.Literal('evolution_task'),
  Type.Literal('empathy_rollback'),
  Type.Literal('error'),
  Type.Literal('warn'),
  Type.Literal('diagnosis_task'),
  Type.Literal('heartbeat_diagnosis'),
  Type.Literal('diagnostician_report'),
  Type.Literal('principle_candidate'),
  Type.Literal('rule_enforced'),
  Type.Literal('rulehost_evaluated'),
  Type.Literal('rulehost_blocked'),
  Type.Literal('rulehost_requireApproval'),
  Type.Literal('rulehost_auto_correct_proposed'),
  Type.Literal('rulehost_auto_correct_applied'),
  Type.Literal('runtime_v2_prompt_activations_injected'),
  Type.Literal('rulehost_unhealthy'),
  Type.Literal('rulehost_skipped'),
  Type.Literal('trajectory_observability_failure'),
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

export interface GovernanceActionEventData {
  action: 'deactivate' | 'promote' | 'global_pause';
  activationId?: string;
  subject?: 'all_live_rulecode';
  actor: 'owner' | 'cli' | 'session';
  reasonCode: string;
  outcome: 'authorized';
}

export const GovernanceActionEventDataSchema = Type.Object({
  action: Type.Union([
    Type.Literal('deactivate'),
    Type.Literal('promote'),
    Type.Literal('global_pause'),
  ]),
  activationId: Type.Optional(Type.String({ minLength: 1 })),
  subject: Type.Optional(Type.Literal('all_live_rulecode')),
  actor: Type.Union([
    Type.Literal('owner'),
    Type.Literal('cli'),
    Type.Literal('session'),
  ]),
  reasonCode: Type.String({ minLength: 1, maxLength: 200 }),
  outcome: Type.Literal('authorized'),
});
export type GovernanceActionEventDataStatic = Static<typeof GovernanceActionEventDataSchema>;

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
  /** Source module that triggered the block (for audit trail) */
  blockSource?: string;
}

export const GateBlockEventDataSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.String(),
  reason: Type.String(),
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

// PRI-286 retirement cleanup (2026-08-19): the plan_approval event type and
// PlanApprovalEventData were removed — zero production writers remained after
// the confirm-first gate deletion. Historical JSONL entries are tolerated as
// extra data by tolerant readers; nothing parses old logs against this union
// strictly.

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
  source: 'diagnostician' | 'manual';
}

export const PrincipleCandidateEventDataSchema = Type.Object({
  principleId: Type.String(),
  taskId: Type.String(),
  source: Type.Union([
    Type.Literal('diagnostician'),
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

// ============== RuleHost Funnel Events (PD-FUNNEL-2.4) ==============

/**
 * rulehost_evaluated — RuleHost.evaluate() was called.
 * Emitted from gate.ts for every evaluate() call (matched or not).
 */
export interface RuleHostEvaluatedEventData {
  toolName: string;
  filePath: string;
  matched: boolean;
  /**
   * PRI-567: 'no_rules_armed' — the live set was empty, so nothing enforced or
   * allowed. Previously this case logged decision='allow', making enforcement
   * statistics read as if rules were active when none were.
   */
  decision: 'allow' | 'block' | 'requireApproval' | 'auto_correct' | 'no_rules_armed' | 'evaluation_failed';
  ruleId?: string;
  activationId?: string;
  activationMode?: 'shadow' | 'live';
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
    Type.Literal('no_rules_armed'),
    Type.Literal('evaluation_failed'),
  ]),
  ruleId: Type.Optional(Type.String()),
  activationId: Type.Optional(Type.String()),
  activationMode: Type.Optional(Type.Union([
    Type.Literal('shadow'),
    Type.Literal('live'),
  ])),
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

/**
 * rulehost_auto_correct_applied — Gate applied a live auto-correction (PRI-174).
 * Emitted from gate.ts when applicationMode='live' and validation passed.
 * Distinct from 'proposed' event - this confirms params were actually mutated.
 */
export interface RuleHostAutoCorrectAppliedEventData {
  toolName: string;
  filePath: string;
  ruleId: string;
  principleId?: string;
  confidence: number;
  reason: string;
  correctedFields: {
    field: string;
    original: unknown;
    applied: unknown;
  }[];
}

export const RuleHostAutoCorrectAppliedEventDataSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.String(),
  ruleId: Type.String(),
  principleId: Type.Optional(Type.String()),
  confidence: Type.Number(),
  reason: Type.String(),
  correctedFields: Type.Array(Type.Object({
    field: Type.String(),
    original: Type.Unknown(),
    applied: Type.Unknown(),
  })),
});
export type RuleHostAutoCorrectAppliedEventDataStatic = Static<typeof RuleHostAutoCorrectAppliedEventDataSchema>;

// ============== Runtime V2 Prompt Activation Observability ==============

/**
 * runtime_v2_prompt_activations_injected — Runtime V2 prompt activations were read and injected.
 * Emitted from prompt.ts after readActivatedPrinciples() completes.
 *
 * Index-pairing contract (PRI-537): principleIds[i], activationIds[i] and
 * artifactIds[i] describe the SAME injected principle — the three arrays are
 * index-aligned and each length equals injectedCount.
 */
export interface RuntimeV2PromptActivationsInjectedEventData {
  sessionId: string;
  workspaceDir: string;
  principleIds: string[];
  activationIds: string[];
  artifactIds: string[];
  injectedCount: number;
  skippedWarnings: string[];
  injectedCharCount: number;
  budget: number;
  /** Present when no principles were injected */
  skipReason?: string;
  nextAction?: string;
  /** PRI-562 Phase 0: principles injected via the legacy evolution block in the same build. */
  legacySelectedCount?: number;
  /** PRI-562 Phase 0: rendered character length of the legacy evolution block. */
  legacyTotalChars?: number;
  /** PRI-562 Phase 0: legacy active/probation selection hit its char budget. */
  legacyTruncated?: boolean;
  /** PRI-562 Phase 0: runtime-v2 render hit its char budget this build. */
  v2Truncated?: boolean;
  /** PRI-562 Phase 0: principle ids injected via BOTH blocks in the same build. */
  crossBlockDuplicateIds?: string[];
}

export const RuntimeV2PromptActivationsInjectedEventDataSchema = Type.Object({
  sessionId: Type.String(),
  workspaceDir: Type.String(),
  principleIds: Type.Array(Type.String()),
  activationIds: Type.Array(Type.String()),
  artifactIds: Type.Array(Type.String()),
  injectedCount: Type.Number(),
  skippedWarnings: Type.Array(Type.String()),
  injectedCharCount: Type.Number(),
  budget: Type.Number(),
  skipReason: Type.Optional(Type.String()),
  nextAction: Type.Optional(Type.String()),
  legacySelectedCount: Type.Optional(Type.Number()),
  legacyTotalChars: Type.Optional(Type.Number()),
  legacyTruncated: Type.Optional(Type.Boolean()),
  v2Truncated: Type.Optional(Type.Boolean()),
  crossBlockDuplicateIds: Type.Optional(Type.Array(Type.String())),
});
export type RuntimeV2PromptActivationsInjectedEventDataStatic = Static<typeof RuntimeV2PromptActivationsInjectedEventDataSchema>;

// ============== RuleHost Health (PRI-437) ==============

/**
 * rulehost_unhealthy — An approved rule failed to compile or load.
 *
 * PRI-437: When an activation exists in SQLite but the RuleCode cannot be
 * compiled or loaded, the failure MUST be recorded in EventLog (not just
 * logger.warn). This makes the unhealthy state visible to CLI and Console.
 *
 * Emitted from rule-host.ts when:
 *   - Compilation throws (syntax error, etc.)
 *   - Module has no evaluate function
 *   - content_json is missing implementationCode
 */
export interface RuleHostUnhealthyEventData {
  activationId: string;
  artifactId: string;
  ruleId: string;
  /** What went wrong (compilation error, missing export, etc.) */
  reason: string;
  /** What the operator should do to fix it */
  nextAction: string;
}

export const RuleHostUnhealthyEventDataSchema = Type.Object({
  activationId: Type.String(),
  artifactId: Type.String(),
  ruleId: Type.String(),
  reason: Type.String(),
  nextAction: Type.String(),
});
export type RuleHostUnhealthyEventDataStatic = Static<typeof RuleHostUnhealthyEventDataSchema>;

// ============== RuleHost Skipped Activations (PRI-491) ==============

/**
 * rulehost_skipped — An active activation was skipped at load time for a
 * structured reason (not a compile/load failure — those use rulehost_unhealthy).
 *
 * PRI-491: Skipped activations must be visible to the owner, not just
 * logger.warn. Skip reasons include:
 *   - flag-off v2 rule suspended (rulecode_context_v2 disabled)
 *   - unsupported context version
 *   - unsupported action
 *   - missing target_ref
 *
 * ERR-002: degradation/suspension includes reason + nextAction (rc-9).
 */
export interface RuleHostSkippedEventData {
  activationId: string;
  artifactId: string;
  ruleId: string;
  /**
   * 'shadow' or 'live' — the mode the activation WOULD have had if loaded.
   * Optional: when the action itself is unrecognized (neither shadow nor
   * live), mode is genuinely indeterminate.
   */
  mode?: 'shadow' | 'live';
  /** Why the activation was skipped (structured reason code + detail) */
  reason: string;
  /** What the operator should do to resolve the skip */
  nextAction: string;
}

export const RuleHostSkippedEventDataSchema = Type.Object({
  activationId: Type.String(),
  artifactId: Type.String(),
  ruleId: Type.String(),
  mode: Type.Optional(Type.Union([Type.Literal('shadow'), Type.Literal('live')])),
  reason: Type.String(),
  nextAction: Type.String(),
});
export type RuleHostSkippedEventDataStatic = Static<typeof RuleHostSkippedEventDataSchema>;

// ============== Trajectory Observability Failure (PRI-647) ==============

/**
 * trajectory_observability_failure — trajectory side-channel recording failed
 * during before_prompt_build (e.g. SQLite connection closed by plugin service
 * stop) but the prompt build continued (fail-open).
 *
 * PRI-647: previously this failure class only surfaced as logger.warn; it is
 * now a structured EventLog row so the trajectory-unavailable state stays
 * observable to the owner via the existing events read model without any new
 * health subsystem.
 */
export interface TrajectoryObservabilityFailureEventData {
  /** Session being processed when the observability call failed. */
  sessionId?: string;
  /** What went wrong (closed connection, transient IO error, ...). */
  reason: string;
  /** What the operator should do to restore trajectory observability. */
  nextAction: string;
}

export const TrajectoryObservabilityFailureEventDataSchema = Type.Object({
  sessionId: Type.Optional(Type.String()),
  reason: Type.String(),
  nextAction: Type.String(),
});
export type TrajectoryObservabilityFailureEventDataStatic = Static<typeof TrajectoryObservabilityFailureEventDataSchema>;

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

// PainStats interface + PainStatsSchema + PainStatsStatic removed (PRI-451
// Wave 1.5): the DailyStats.pain block they backed had no live reader. The
// pain field is also removed from DailyStats below.

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
  rulehostEvaluated: number;
  rulehostBlocked: number;
  rulehostRequireApproval: number;
  rulehostAutoCorrectProposed: number;
  rulehostAutoCorrectApplied: number;
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
  rulehostEvaluated: Type.Number(),
  rulehostBlocked: Type.Number(),
  rulehostRequireApproval: Type.Number(),
  rulehostAutoCorrectProposed: Type.Number(),
  rulehostAutoCorrectApplied: Type.Number(),
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
  // pain: PainStats field removed (PRI-451 Wave 1.5): no live reader.
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
  // pain: PainStatsSchema removed (PRI-451 Wave 1.5): no live reader.
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
    // pain: { ... } zero-defaults removed (PRI-451 Wave 1.5): no live reader.
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
      rulehostEvaluated: 0,
      rulehostBlocked: 0,
      rulehostRequireApproval: 0,
      rulehostAutoCorrectProposed: 0,
      rulehostAutoCorrectApplied: 0,
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
