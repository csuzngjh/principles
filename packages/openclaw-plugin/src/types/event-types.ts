export type {
  EventType,
  EventCategory,
  EventLogEntry,
  ToolCallEventData,
  PainSignalEventData,
  RulePromotionEventData,
  GovernanceActionEventData,
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
  // EvolutionStats-as-EventEvolutionStats re-export removed (PRI-770): the
  // Evolution Points stats type died with its subsystem; the live event-log
  // stats type is EventEvolutionStats from core's event types.
  EmpathyEventStats,
  GfiStats,
  HookStats,
  DailyStats,
} from '@principles/core/runtime-v2';

export {
  createEmptyDailyStats,
} from '@principles/core/runtime-v2';
