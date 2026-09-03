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

export {
  PRINCIPLE_STATUSES,
  PrincipleStatusSchema,
  PrinciplePrioritySchema,
  PrincipleScopeSchema,
  PrincipleEvaluabilitySchema,
  RuleStatusSchema,
  RuleTypeSchema,
  ImplementationLifecycleStateSchema,
  ImplementationTypeSchema,
  SampleClassificationSchema,
} from './principle-enums.js';

export type {
  Principle,
  Rule,
  Implementation,
} from './principle-schema.js';

export {
  PrincipleSchema,
  RuleSchema,
  ImplementationSchema,
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
export { PrincipleDependencySchema } from './principle-dependency.js';

export type { PrincipleValueMetrics } from './principle-value-metrics.js';
export { PrincipleValueMetricsSchema } from './principle-value-metrics.js';

export type {
  PrincipleEventType,
  PrincipleLifecycleEvent,
} from './principle-lifecycle-event.js';

export {
  PrincipleEventTypeSchema,
  PrincipleLifecycleEventSchema,
} from './principle-lifecycle-event.js';

export type { PrincipleTreeStore } from './principle-tree-store.js';
export { PrincipleTreeStoreSchema } from './principle-tree-store.js';

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
  PersistenceActionSchema,
  HygieneStatsSchema,
  createEmptyHygieneStats,
} from './hygiene-types.js';

// Runtime summary types (migrated from openclaw-plugin)
export type {
  RuntimeTruth,
  AnalyticsTruth,
  TrendMetrics,
} from './runtime-summary-types.js';

export {
  RuntimeTruthSchema,
  AnalyticsTruthSchema,
  TrendMetricsSchema,
} from './runtime-summary-types.js';

// Event types (migrated from openclaw-plugin)
export type {
  EventType,
  EventCategory,
  EventLogEntry,
  ToolCallEventData,
  PainSignalEventData,
  RulePromotionEventData,
  HookExecutionEventData,
  GateBlockEventData,
  GateBypassEventData,
  EvolutionTaskEventData,
  EmpathyRollbackEventData,
  HeartbeatDiagnosisEventData,
  DiagnosisTaskEventData,
  DiagnosticianReportEventData,
  PrincipleCandidateEventData,
  RuleEnforcedEventData,
  RuleHostEvaluatedEventData,
  RuleHostBlockedEventData,
  RuleHostRequireApprovalEventData,
  RuleHostAutoCorrectProposedEventData,
  RuleHostAutoCorrectAppliedEventData,
  RuntimeV2PromptActivationsInjectedEventData,
  RuleHostUnhealthyEventData,
  RuleHostSkippedEventData,
  TrajectoryObservabilityFailureEventData,
  ToolCallStats,
  ErrorStats,
  // PainStats re-export removed (PRI-451 Wave 1.5): no live reader.
  EmpathyEventStats,
  GfiStats,
  EventEvolutionStats,
  HookStats,
  DailyStats,
} from './event-types.js';

export {
  EventTypeSchema,
  EventCategorySchema,
  EventLogEntrySchema,
  ToolCallEventDataSchema,
  PainSignalEventDataSchema,
  RulePromotionEventDataSchema,
  HookExecutionEventDataSchema,
  GateBlockEventDataSchema,
  GateBypassEventDataSchema,
  EvolutionTaskEventDataSchema,
  EmpathyRollbackEventDataSchema,
  HeartbeatDiagnosisEventDataSchema,
  DiagnosisTaskEventDataSchema,
  DiagnosticianReportEventDataSchema,
  PrincipleCandidateEventDataSchema,
  RuleEnforcedEventDataSchema,
  RuleHostEvaluatedEventDataSchema,
  RuleHostBlockedEventDataSchema,
  RuleHostRequireApprovalEventDataSchema,
  RuleHostAutoCorrectProposedEventDataSchema,
  RuleHostAutoCorrectAppliedEventDataSchema,
  RuntimeV2PromptActivationsInjectedEventDataSchema,
  RuleHostUnhealthyEventDataSchema,
  RuleHostSkippedEventDataSchema,
  TrajectoryObservabilityFailureEventDataSchema,
  ToolCallStatsSchema,
  ErrorStatsSchema,
  // PainStatsSchema re-export removed (PRI-451 Wave 1.5): no live reader.
  EmpathyEventStatsSchema,
  GfiStatsSchema,
  EventEvolutionStatsSchema,
  HookStatsSchema,
  DailyStatsSchema,
  createEmptyDailyStats,
} from './event-types.js';

// Event payload discriminated union (migrated from openclaw-plugin)
export type {
  EventLogEntry as DiscriminatedEventLogEntry,
} from './event-payload.js';

export {
  DiscriminatedEventLogEntrySchema,
  isToolCallEventEntry,
  isPainSignalEventEntry,
  isRulePromotionEventEntry,
  isHookExecutionEventEntry,
  isGateBlockEventEntry,
  isGateBypassEventEntry,
  isEvolutionTaskEventEntry,
  isEmpathyRollbackEventEntry,
} from './event-payload.js';

// Pain signal
export type {
  PainSeverity as TypeboxPainSeverity,
  PainSignal,
  PainSignalValidationResult,
} from './pain-signal.js';

export {
  PainSeverity as PainSeveritySchema,
  PainSignalSchema,
  deriveSeverity,
  validatePainSignal,
} from './pain-signal.js';

// PRI-443: Ledger store types — pure types, zero I/O
// Only ledger-specific types are exported here to avoid conflicts with
// the richer Principle/Rule/Implementation from principle-schema.js.
// Consumers needing the ledger versions should import from
// @principles/core/principle-tree-ledger or ./ledger-store.js directly.
export type {
  LedgerPrinciple,
  LedgerRule,
  LedgerTreeStore,
  LegacyPrincipleTrainingState,
  LegacyPrincipleTrainingStore,
  HybridLedgerStore,
} from './ledger-store.js';

export { TREE_NAMESPACE } from './ledger-store.js';

// PD Task types
export type {
  PDTaskSchedule,
  PDTaskExecution,
  PDTaskDelivery,
  PDTaskMeta,
  PDTaskSpec,
} from './pd-task-types.js';

export {
  PDTaskScheduleSchema,
  PDTaskExecutionSchema,
  PDTaskDeliverySchema,
  PDTaskMetaSchema,
  PDTaskSpecSchema,
  BUILTIN_PD_TASKS,
} from './pd-task-types.js';

// Evidence chain contract
export type {
  EvidenceChainState,
  EvidenceChainRecord,
  EvidenceChainResponse,
  ChainStateParams,
  TaskMapEntry as EvidenceTaskMapEntry,
  CandidateInfo as EvidenceCandidateInfo,
  DreamerTaskInfo as EvidenceDreamerTaskInfo,
  LedgerPrinciple as EvidenceLedgerPrinciple,
  // PRI-469: re-exported from diag-rootcause-output via evidence-chain-contract.
  IntentTension as EvidenceChainIntentTension,
} from './evidence-chain-contract.js';

export {
  EvidenceChainStateSchema,
  EvidenceChainRecordSchema,
  EvidenceChainResponseSchema,
  mapSourceKind,
  inferAdmissionDecision,
  determineState,
  determineNextAction,
  resolveSummary,
  normalizeDiagnosticianTaskId,
  crossReferenceByTimestamp,
  assembleEvidenceChain,
  // PRI-469: pure validator for untrusted intentTension from artifacts.
  validateIntentTension,
} from './evidence-chain-contract.js';


