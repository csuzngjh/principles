export type {
  EventLogEntry as DiscriminatedEventLogEntry,
} from '@principles/core/runtime-v2';

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
} from '@principles/core/runtime-v2';
