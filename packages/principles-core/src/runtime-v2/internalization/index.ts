/**
 * Internalization module barrel — RuleHost contracts and helpers
 *
 * PRI-42: Pure domain contracts extracted from the plugin layer.
 * These types have zero infrastructure dependency and are reusable
 * by pd-cli and future non-OpenClaw hosts.
 */

// Contracts
export type {
  RuleHostInput,
  RuleHostDecision,
  RuleHostMeta,
  RuleHostResult,
  LoadedImplementation,
} from './rule-host-contracts.js';

// Helpers
export type { RuleHostHelpers } from './rule-host-helpers.js';
export { createRuleHostHelpers } from './rule-host-helpers.js';

// Internalization route model (PRI-43)
export type { InternalizationRouteKind, InternalizationRouteDecision } from './internalization-route.js';
export { decideInternalizationRoute } from './internalization-route.js';

// Template generation (PRI-44)
export type { PainPattern } from './template-generator.js';
export { generateFromTemplate } from './template-generator.js';

// Code validation (PRI-44)
export type { ValidationResult } from './rule-code-validator.js';
export { checkForbiddenPatterns } from './rule-code-validator.js';

// Compile result (PRI-44)
export type { CompileResult } from './compile-result.js';

// Decision merge (PRI-45)
export type { DecisionMergeLogger, RuleHostLogger } from './rule-host-evaluator.js';
export { mergeDecisions } from './rule-host-evaluator.js';

// Adapter interface (PRI-45)
export type { RuleHostImplementationProvider } from './rule-host-adapter.js';

// Lifecycle read model types (PRI-51)
export type {
  LifecycleClassificationTotals,
  RuleReplayEvidence,
  RuleLiveEvidence,
  RuleLineageEvidence,
  ImplementationLifecycleEvidence,
  RuleLifecycleEvidence,
  PrincipleLifecycleEvidence,
  LifecycleReadModel,
} from './lifecycle-types.js';

// Lifecycle metrics (PRI-52)
export type { RuleMetricResult, PrincipleAdherenceResult } from './lifecycle-metrics.js';
export { computeRuleMetrics, computePrincipleAdherence } from './lifecycle-metrics.js';

// Deprecated readiness (PRI-53)
export type { DeprecatedReadinessStatus, DeprecatedReadinessAssessment } from './deprecated-readiness.js';
export { assessDeprecatedReadiness } from './deprecated-readiness.js';

// Routing policy (PRI-54)
export type { LifecycleRoute, LifecycleRouteEvidenceSummary, LifecycleRouteRecommendation } from './routing-policy.js';
export { recommendLifecycleRoute } from './routing-policy.js';

// Lifecycle datasource adapter (PRI-56)
export type { LifecycleDatasource } from './lifecycle-datasource.js';
// Lifecycle read model builder (PRI-56)
export { buildLifecycleReadModel } from './lifecycle-read-model.js';
// Ledger types needed by datasource implementations
export type { LedgerTreeStore } from '../../principle-tree-ledger.js';

// ── Peer Runner Contracts (PRI-61) ───────────────────────────────────────────

export type {
  InternalizationChannel,
  PeerRunnerKind,
  PIArtifactKind,
  PIArtifactValidationStatus,
  ArtifactRef,
  LineageRef,
  PIArtifact,
  PITaskRecord,
} from './peer-runner-contracts.js';

export {
  PEER_RUNNER_KINDS,
  INTERNALIZATION_CHANNELS,
  PI_ARTIFACT_KINDS,
  isPeerRunnerKind,
  isInternalizationChannel,
  isPIArtifactKind,
  isTerminalTaskStatus,
  isValidPITaskRecord,
  createMinimalPITaskRecord,
} from './peer-runner-contracts.js';

// ── Job Graph Topology (PRI-61) ────────────────────────────────────────────────

export {
  ALLOWED_EDGES,
  MODEL_TRAINING_CHANNEL,
  TRAINER_KIND,
  validateEdge,
  isAcyclic,
  getAllowedSuccessors,
  getAllowedPredecessors,
} from './internalization-job-graph.js';

// ── State Machine Guards (PRI-62) ────────────────────────────────────────────────

export {
  canAcquireLease,
  areDependenciesMet,
  canTransitionTo,
  isResultRefImmutable,
  canUpdateLastError,
  isArtifactRejected,
} from './internalization-task-guards.js';

export type {
  DependencyGateDecision,
  DependencyGateResult,
  TransitionValidation,
  RejectionFeedbackAction,
  RejectionFeedbackResult,
  NextTaskProposal,
  GraphErrorType,
  GraphValidationError,
  GraphValidationResult,
} from './internalization-state-machine.js';

export {
  validateInternalizationTaskReady,
  validateTaskTransition,
  decideArtifactRejectionFeedback,
  createNextTaskProposal,
  validateInternalizationGraph,
} from './internalization-state-machine.js';

// ── PITask Persistence & Hydration (PRI-65) ───────────────────────────────────

export type { PITaskMetadata } from './pitask-metadata.js';

export {
  PI_METADATA_KEY,
  serializePITaskMetadata,
  parsePITaskMetadata,
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
} from './pitask-metadata.js';

// ── Internalization Orchestrator (PRI-68) ─────────────────────────────────────

export type {
  WakeOnceDecision,
  WakeOnceResult,
  NoReadyTasksResult,
  BlockedResult,
  DependencyFailedResult,
  LeasedResult,
  WouldLeaseResult,
  LeaseConflictResult,
  InvalidTaskMetadataResult,
  ProposalCreatedResult,
  ProposeNextTaskResult,
  InternalizationOrchestratorOptions,
  InternalizationOrchestratorDeps,
} from './internalization-orchestrator.js';

export { InternalizationOrchestrator } from './internalization-orchestrator.js';
