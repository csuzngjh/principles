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
} from './activation-types.js';

export {
  LOW_RISK_CHANNELS,
  HIGH_RISK_CHANNEL_MAP,
  makeIdempotencyKey,
  isLowRiskChannel,
  getChannelRiskLevel,
  AUTO_PROMOTION_CONFIDENCE_THRESHOLD,
  AUTO_PROMOTABLE_CHANNELS,
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
> (feat(runtime): add ApprovalQueue & auto-promotion by confidence (PRI-145))
