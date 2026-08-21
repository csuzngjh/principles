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
export { SqliteActivationSafetyStore } from './sqlite-activation-safety-store.js';
export type { ActivationDecisionRecord, ActivationDecisionSubject, ActivationDecisionKind, ActivationControlState, GlobalRuleCodePause } from './activation-control-types.js';
export { RuleCodeOwnerDecisionService } from './rulecode-owner-decision-service.js';
export type {
  PromotionEvidenceSnapshot, PromotionFailedCheck, PromotionReadinessResult,
  OwnerPromotionActor, OwnerPromotionRequest, PromotionCommitInput, OwnerPromotionResult,
  RuleCodeOwnerDecisionServiceDeps,
} from './rulecode-owner-decision-service.js';
export { REQUIRED_PROMOTION_CHECK_IDS, evaluateRuleCodePromotionReadiness } from './promotion-readiness-evaluator.js';
export type { PromotionCheckId, PromotionReadinessCheck, PromotionReadinessEvaluationInput } from './promotion-readiness-evaluator.js';
export { PromotionReadinessReader } from './promotion-readiness-reader.js';
export type { PromotionReadinessReaderDeps } from './promotion-readiness-reader.js';
export { evaluateRuleCodeSafetyCircuit, initialRuleCodeSafetyCircuitState } from './rulecode-safety-circuit-breaker.js';
export type { RuleCodeSafetySample, RuleCodeSafetyCircuitState, RuleCodeSafetyTripReason } from './rulecode-safety-circuit-breaker.js';
export { collectOpenClawPromotionChecks } from './openclaw-promotion-checks.js';
export type { HostLivenessContract } from './openclaw-promotion-checks.js';
export { summarizeRuleCodeShadowEvents } from './rulecode-shadow-summary.js';
export type { RuleCodeShadowSummary } from './rulecode-shadow-summary.js';
export { buildPromotionEvidenceSnapshot, computeArtifactDigest, normalizeOwnerIdentity } from './promotion-evidence-snapshot.js';
export type { BuildPromotionEvidenceSnapshotInput, PromotionEvidenceOwnerIdentity } from './promotion-evidence-snapshot.js';

export { ApprovalQueue, decideAutoPromotion } from './approval-queue.js';

export { MemoryApprovalQueueStore } from './memory-approval-store.js';

export { SqliteApprovalQueueStore } from './sqlite-approval-store.js';

export { RuleHostWriter, extractEvidenceRefs } from './writers/rule-host-writer.js';
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
