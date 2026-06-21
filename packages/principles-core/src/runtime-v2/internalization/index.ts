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

// RuleHost input builder (PRI-439 Phase 3 — pure action snapshot)
export type { ExtractFilePathOptions, BuildRuleHostActionOptions } from './rule-host-input-builder.js';
export { normalizePathPure, extractFilePathFromParams, buildRuleHostAction } from './rule-host-input-builder.js';

// Internalization route model (PRI-43)
export type { InternalizationRouteKind, InternalizationRouteDecision } from './internalization-route.js';
export { decideInternalizationRoute } from './internalization-route.js';

// Template generation (PRI-44)
export type { PainPattern } from './template-generator.js';
export { generateFromTemplate } from './template-generator.js';

// Code validation (PRI-44, PRI-439 Phase 2)
export type { ValidationResult } from './rule-code-validator.js';
export { checkForbiddenPatterns, checkReturnStatementsMissingFields, checkMatchedFalseDecisions } from './rule-code-validator.js';

// Compile result (PRI-44)
export type { CompileResult } from './compile-result.js';

// Decision merge (PRI-45)
export type { DecisionMergeLogger, RuleHostLogger } from './rule-host-evaluator.js';
export { mergeDecisions } from './rule-host-evaluator.js';

// RuleHost result validator (PRI-437)
export type { RuleHostResultValidationResult } from './rule-host-validator.js';
export { validateRuleHostResult } from './rule-host-validator.js';

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
  DiagnosticianStageKind,
  RunnerKind,
  PIArtifactKind,
  PIArtifactValidationStatus,
  ArtifactRef,
  LineageRef,
  PIArtifact,
  PITaskRecord,
} from './peer-runner-contracts.js';

export {
  PEER_RUNNER_KINDS,
  DIAGNOSTICIAN_STAGE_KINDS,
  INTERNALIZATION_CHANNELS,
  PI_ARTIFACT_KINDS,
  isPeerRunnerKind,
  isDiagnosticianStageKind,
  isRunnerKind,
  isInternalizationChannel,
  isPIArtifactKind,
  isTerminalTaskStatus,
  isValidPITaskRecord,
  createMinimalPITaskRecord,
} from './peer-runner-contracts.js';

// ── Job Graph Topology (PRI-61) ────────────────────────────────────────────────

export {
  ALLOWED_EDGES,
  DIAGNOSTICIAN_EDGES,
  MODEL_TRAINING_CHANNEL,
  TRAINER_KIND,
  validateEdge,
  validateDiagEdge,
  getDiagSuccessors,
  isAcyclic,
  getAllowedSuccessors,
  getAllowedPredecessors,
} from './internalization-job-graph.js';

// ── State Machine Guards (PRI-62) ────────────────────────────────────────────────

export {
  canAcquireLease,
  canRetryNow,
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

// ── Dreamer Peer Runner (PRI-67) ───────────────────────────────────────────────

export type {
  DreamerCandidate,
  DreamerOutput,
  DreamerValidationResult,
  DreamerValidator,
} from './dreamer-output.js';

export { PassThroughDreamerValidator, DefaultDreamerValidator } from './dreamer-output.js';

export type {
  DreamerRunnerResult,
  DreamerRunnerOptions,
  ResolvedDreamerRunnerOptions,
} from './dreamer-runner.js';

export {
  resolveDreamerRunnerOptions,
  DEFAULT_DREAMER_RUNNER_OPTIONS,
} from './dreamer-runner.js';

export { DreamerRunner } from './dreamer-runner.js';

// ── Philosopher Runner (PRI-90) ────────────────────────────────────────────────

export type {
  PhilosopherOutputV1,
  PhilosopherPrincipleCandidate,
  PhilosopherValidationResult,
  PhilosopherValidator,
} from './philosopher-output.js';

export {
  DefaultPhilosopherValidator,
} from './philosopher-output.js';

export type {
  PhilosopherRunnerResultStatus,
  PhilosopherRunnerResult,
  PhilosopherRunnerOptions,
  ResolvedPhilosopherRunnerOptions,
  PhilosopherRunnerDeps,
} from './philosopher-runner.js';

export {
  PhilosopherRunner,
  resolvePhilosopherRunnerOptions,
  DEFAULT_PHILOSOPHER_RUNNER_OPTIONS,
} from './philosopher-runner.js';

// ── Scribe Runner (PRI-109) ────────────────────────────────────────────────────

export type {
  ScribeOutputV1,
  ScribePrincipleDraft,
  ScribeSourceTrace,
  ScribeValidationResult,
  ScribeValidator,
} from './scribe-output.js';

export {
  DefaultScribeValidator,
} from './scribe-output.js';

export type {
  ScribeRunnerResultStatus,
  ScribeRunnerResult,
  ScribeRunnerOptions,
  ResolvedScribeRunnerOptions,
  ScribeRunnerDeps,
} from './scribe-runner.js';

export {
  ScribeRunner,
  resolveScribeRunnerOptions,
  DEFAULT_SCRIBE_RUNNER_OPTIONS,
} from './scribe-runner.js';

// ── Artificer Runner (PRI-111) ────────────────────────────────────────────────

export type {
  ArtificerRuleOutput,
  ArtificerSourceTrace,
  ArtificerValidationResult,
  ArtificerValidator,
  GoldenTraceCaseInput,
} from './artificer-output.js';

export {
  DefaultArtificerValidator,
  ArtificerRuleOutputSchema,
  ArtificerSourceTraceSchema,
} from './artificer-output.js';

export type {
  ArtificerRunnerResultStatus,
  ArtificerRunnerResult,
  ArtificerRunnerOptions,
  ResolvedArtificerRunnerOptions,
  ArtificerRunnerDeps,
} from './artificer-runner.js';

export {
  ArtificerRunner,
  resolveArtificerRunnerOptions,
  DEFAULT_ARTIFICER_RUNNER_OPTIONS,
} from './artificer-runner.js';

// ── Evaluator Runner (PRI-EVAL) ────────────────────────────────────────────────

export type {
  EvaluatorEvaluation,
  EvaluatorSourceTrace,
  EvaluatorOutputV1,
  EvaluatorOutputV2,
  EvaluatorValidationResult,
  EvaluatorValidator,
  EvaluatorCodeReview,
  EvaluatorAdversarialResult,
  AdversarialCase,
  AdversarialFailedCase,
  AdversarialAttackType,
} from './evaluator-output.js';

export {
  DefaultEvaluatorValidator,
  EvaluatorOutputV1Schema,
  EvaluatorEvaluationSchema,
  EvaluatorSourceTraceSchema,
  EVALUATOR_DECISIONS,
  isEvaluatorOutputV2,
} from './evaluator-output.js';

export type {
  EvaluatorRunnerResultStatus,
  EvaluatorRunnerResult,
  EvaluatorRunnerOptions,
  ResolvedEvaluatorRunnerOptions,
  EvaluatorRunnerDeps,
} from './evaluator-runner.js';

export {
  EvaluatorRunner,
  resolveEvaluatorRunnerOptions,
  DEFAULT_EVALUATOR_RUNNER_OPTIONS,
} from './evaluator-runner.js';

export {
  EvaluatorPromptBuilder,
  EVALUATOR_PROTOCOL_INSTRUCTION,
  EVALUATOR_PROMPT_CONTRACT_VERSION,
} from './evaluator-prompt-builder.js';

export type {
  EvaluatorPromptBuilderInput,
  EvaluatorPromptInput,
  EvaluatorPromptBuildResult,
} from './evaluator-prompt-builder.js';

// ── Rollout Reviewer Runner (PRI-RR) ────────────────────────────────────────

export type {
  RolloutReviewerReview,
  RolloutReviewerSourceTrace,
  RolloutReviewerOutputV1,
  RolloutReviewerValidationResult,
  RolloutReviewerValidator,
} from './rollout-reviewer-output.js';

export {
  DefaultRolloutReviewerValidator,
  RolloutReviewerOutputV1Schema,
  RolloutReviewerReviewSchema,
  RolloutReviewerSourceTraceSchema,
  ROLLOUT_REVIEWER_DECISIONS,
} from './rollout-reviewer-output.js';

export type {
  RolloutReviewerRunnerResultStatus,
  RolloutReviewerRunnerResult,
  RolloutReviewerRunnerOptions,
  ResolvedRolloutReviewerRunnerOptions,
  RolloutReviewerRunnerDeps,
} from './rollout-reviewer-runner.js';

export {
  RolloutReviewerRunner,
  resolveRolloutReviewerRunnerOptions,
  DEFAULT_ROLLOUT_REVIEWER_RUNNER_OPTIONS,
} from './rollout-reviewer-runner.js';

export {
  RolloutReviewerPromptBuilder,
  ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION,
  ROLLOUT_REVIEWER_PROMPT_CONTRACT_VERSION,
} from './rollout-reviewer-prompt-builder.js';

export type {
  RolloutReviewerPromptBuilderInput,
  RolloutReviewerPromptInput,
  RolloutReviewerPromptBuildResult,
} from './rollout-reviewer-prompt-builder.js';

// ── Trainer Runner (PRI-116) ────────────────────────────────────────────────

export type {
  TrainerRuleCandidate,
  TrainerSafety,
  TrainerSourceTrace,
  TrainerOutputV1,
  TrainerValidationResult,
  TrainerValidator,
} from './trainer-output.js';

export {
  DefaultTrainerValidator,
  TrainerOutputV1Schema,
  TrainerRuleCandidateSchema,
  TrainerSafetySchema,
  TrainerSourceTraceSchema,
  TRAINER_DECISIONS,
} from './trainer-output.js';

export type {
  TrainerRunnerResultStatus,
  TrainerRunnerResult,
  TrainerRunnerOptions,
  ResolvedTrainerRunnerOptions,
  TrainerRunnerDeps,
} from './trainer-runner.js';

export {
  TrainerRunner,
  resolveTrainerRunnerOptions,
  DEFAULT_TRAINER_RUNNER_OPTIONS,
} from './trainer-runner.js';

export {
  TrainerPromptBuilder,
  TRAINER_PROTOCOL_INSTRUCTION,
  TRAINER_PROMPT_CONTRACT_VERSION,
} from './trainer-prompt-builder.js';

export type {
  TrainerPromptBuilderInput,
  TrainerPromptInput,
  TrainerPromptBuildResult,
} from './trainer-prompt-builder.js';

// ── Internalization Orchestrator (PRI-68) ─────────────────────────────────────

export type {
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
  CommitNextTaskResult,
  InternalizationOrchestratorOptions,
  InternalizationOrchestratorDeps,
} from './internalization-orchestrator.js';

export { InternalizationOrchestrator, WAKE_ONCE_DECISIONS } from './internalization-orchestrator.js';

// ── PIArtifact Durable Store (PRI-84) ────────────────────────────────────────

export type { PIArtifactRecord, PIArtifactStore } from './pi-artifact.js';
export { MemoryPIArtifactStore } from './pi-artifact-store.js';
export { SqlitePIArtifactStore } from '../store/artifact/sqlite-pi-artifact-store.js';

// ── Intake To Internalization Bridge (PRI-142) ────────────────────────────────

export type {
  IntakeToInternalizationBridgeInput,
  BridgeDecision,
  BridgeTaskSeed,
  BridgeTaskStore,
} from './intake-to-internalization-bridge.js';

// RuleHost MVP Activation (PRI-421..428, ADR-0014 Amendment 2026-06-17)
// Adversarial case → GoldenTrace conversion + feedback formatter.
export type { AdversarialConversionResult } from './adversarial-case.js';
export { adversarialCasesToGoldenTrace } from './adversarial-case.js';
export { formatAdversarialFeedback } from './adversarial-feedback.js';

// ── Artificer L2 Adapter (PRI-424 / PRI-439 Phase 4) ───────────────────────
export { ArtificerL2Adapter } from '../adapter/artificer-l2-adapter.js';
export type { ArtificerL2AdapterConfig } from '../adapter/artificer-l2-adapter.js';

// ── Artificer L2 Agent Loop Tools (PRI-439 Phase 4) ────────────────────────
// TypeBox redeclaration + 4-tool contract used by ArtificerL2Adapter.
export {
  ArtificerRuleOutputTypebox,
  ArtificerSourceTraceTypebox,
  GoldenTraceCaseInputTypebox,
} from '../tools/artificer-output-typebox.js';
export {
  buildArtificerL2Tools,
  ARTIFICER_L2_TOOL_WHITELIST,
  RULECODE_SPEC_TEXT,
} from '../tools/artificer-l2-tool-contract.js';
export type {
  ArtificerL2ToolContext,
  ArtificerL2OutputCapture,
} from '../tools/artificer-l2-tool-contract.js';

export {
  ROUTE_CHANNEL_MAP,
  MVP_ENABLED_CHANNELS,
  CANDIDATE_KIND_TO_ROUTE,
  computeBridgeDecision,
  buildDreamerTaskSeed,
  buildDreamerSeedFromCandidate,
  seedIntakeTask,
} from './intake-to-internalization-bridge.js';
