export type {
  ActivationRiskLevel,
  ActivationActor,
  RolloutActivationDecision,
  DispatchInput,
  ActivationDecision,
  PIArtifactSnapshot,
  ActivationArtifactReadModel,
  ActivationStatusRecord,
  ActivationStateReadModel,
  WriterInput,
  WriterResult,
  CanActivateResult,
  ChannelWriter,
  InternalizationChannel,
  PIArtifactKind,
  PIArtifactValidationStatus,
  ApprovalStatus,
  ApprovalRecord,
  ApprovalEnqueueInput,
  ApprovalFilter,
  ApprovalDecisionResult,
  ApprovalQueueStore,
  ConfidenceLabel,
  ApprovalWithContext,
  ApprovalListFilter,
  ArtifactLineageIdentity,
  ApprovalStats,
  ApprovalListResult,
} from './activation-types.js';

export {
  isArtifactRevisionOf,
  LOW_RISK_CHANNELS,
  HIGH_RISK_CHANNEL_MAP,
  makeIdempotencyKey,
  isLowRiskChannel,
  getChannelRiskLevel,
  AUTO_PROMOTION_CONFIDENCE_THRESHOLD,
  AUTO_PROMOTABLE_CHANNELS,
  mapConfidenceToLabel,
} from './activation-types.js';

export { ActivationDispatcher } from './activation-dispatcher.js';
export type { DispatcherConfig } from './activation-dispatcher.js';

export {
  PromptWriter,
  DeferArchiveWriter,
  extractPrincipleId,
} from './low-risk-writers.js';

export {
  MemoryActivationStateStore,
  MemoryArtifactReadModel,
} from './memory-activation-state-store.js';

export { SqliteActivationStateStore } from './sqlite-activation-state-store.js';

export { ApprovalQueue, decideAutoPromotion } from './approval-queue.js';

export { MemoryApprovalQueueStore } from './memory-approval-store.js';

export { SqliteApprovalQueueStore } from './sqlite-approval-store.js';

export { RuleHostWriter } from './writers/rule-host-writer.js';
export type { RuleHostWriterConfig } from './writers/rule-host-writer.js';

// Story A (PRI-408): Production gate deps factory — canonical vm-based rule
// compilation for RuleHostWriter gateDeps. Available to all packages that
// depend on @principles/core (pd-cli, pd-console, plugin).
export { createProductionGateDeps } from './production-gate-deps.js';

// Story A (PRI-408): Formal approval-completion production service.
// Replaces demo "approve → direct writer" with structured, idempotent path.
export { ApprovalCompletionService } from './approval-completion-service.js';
export type { ApprovalCompletionInput, ApprovalCompletionResult } from './approval-completion-service.js';

export {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  isRecord as isArtifactRecord,
  filterPromptActivations,
  resolvePrincipleFromArtifact,
  trimToBudget,
  renderPrinciplesToDirectives,
} from './prompt-activation-reader-contract.js';

export type {
  ActivatedPrinciple,
  PromptActivationReaderResult,
} from './prompt-activation-reader-contract.js';
