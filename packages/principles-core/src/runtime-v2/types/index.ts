/**
 * Type definitions barrel — principle tree domain types extracted from plugin (PRI-51).
 */

export type {
  PrincipleStatus,
  PrinciplePriority,
  PrincipleScope,
  PrincipleEvaluability,
  RuleStatus,
  RuleType,
  ImplementationLifecycleState,
  ImplementationType,
  SampleClassification,
} from './principle-enums.js';

export type {
  Principle,
  Rule,
  Implementation,
} from './principle-schema.js';

export type {
  ArtifactKind,
  ArtifactLineageRecord,
} from './artifact-lineage.js';

export type {
  ReplayResult,
  ClassificationSummary,
  ReplayReport,
} from './replay-types.js';

export type { PrincipleDependency } from './principle-dependency.js';

export type { PrincipleValueMetrics } from './principle-value-metrics.js';

export type {
  PrincipleEventType,
  PrincipleLifecycleEvent,
} from './principle-lifecycle-event.js';

export type { PrincipleTreeStore } from './principle-tree-store.js';

// Queue branded types (migrated from openclaw-plugin)
export type {
  Brand,
  QueueItemId,
  WorkflowId,
  SessionKey,
} from './queue-types.js';

export {
  toQueueItemId,
  toWorkflowId,
  toSessionKey,
  isQueueItemId,
  isWorkflowId,
  isSessionKey,
} from './queue-types.js';

// Hygiene tracking types (migrated from openclaw-plugin)
export type {
  PersistenceAction,
  HygieneStats,
} from './hygiene-types.js';

export {
  createEmptyHygieneStats,
} from './hygiene-types.js';

// Runtime summary types (migrated from openclaw-plugin)
export type {
  RuntimeTruth,
  AnalyticsTruth,
  TrendMetrics,
} from './runtime-summary-types.js';

// Event types (migrated from openclaw-plugin)
export type {
  EventType,
  EventCategory,
  EventLogEntry,
  ToolCallEventData,
  PainSignalEventData,
  RuleMatchEventData,
  RulePromotionEventData,
  HookExecutionEventData,
  GateBlockEventData,
  GateBypassEventData,
  PlanApprovalEventData,
  EvolutionTaskEventData,
  EmpathyRollbackEventData,
  HeartbeatDiagnosisEventData,
  DiagnosisTaskEventData,
  DiagnosticianReportEventData,
  PrincipleCandidateEventData,
  RuleEnforcedEventData,
  NocturnalDreamerCompletedEventData,
  NocturnalArtifactPersistedEventData,
  NocturnalCodeCandidateCreatedEventData,
  RuleHostEvaluatedEventData,
  RuleHostBlockedEventData,
  RuleHostRequireApprovalEventData,
  RuleHostAutoCorrectProposedEventData,
  ToolCallStats,
  ErrorStats,
  PainStats,
  EmpathyEventStats,
  GfiStats,
  EvolutionStats as EventEvolutionStats,
  HookStats,
  DailyStats,
} from './event-types.js';

export {
  createEmptyDailyStats,
} from './event-types.js';

// Event payload discriminated union (migrated from openclaw-plugin)
export type {
  EventLogEntry as DiscriminatedEventLogEntry,
} from './event-payload.js';

export {
  isToolCallEventEntry,
  isPainSignalEventEntry,
  isRuleMatchEventEntry,
  isRulePromotionEventEntry,
  isHookExecutionEventEntry,
  isGateBlockEventEntry,
  isGateBypassEventEntry,
  isPlanApprovalEventEntry,
  isEvolutionTaskEventEntry,
  isEmpathyRollbackEventEntry,
} from './event-payload.js';
