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

// Legacy contract dependency scanner — detects persisted RuleCode that
// still references retired RuleHost contract symbols (recentThinking,
// planStatus, hasPlanFile, getPlanStatus(), hasPlanFile()).
export type { LegacyRuleContractSymbol, LegacyRuleContractRuleSource, LegacyRuleContractFinding } from './legacy-rule-contract-scanner.js';
export { scanLegacyRuleContractDependencies, formatLegacyRuleContractRemediation } from './legacy-rule-contract-scanner.js';

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
  DEFAULT_RETRY_WAIT_STALE_TTL_MS,
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

// ── Philosopher Runner (PRI-90) — MVP-Quiet: de-surfaced from internal barrel (PRI-458) ──
// Types/classes remain in philosopher-output.ts and philosopher-runner.ts.
// Import directly from those source files if needed (not from this barrel).

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

// ── Evaluator Runner (PRI-EVAL) — MVP-Quiet: de-surfaced from internal barrel (PRI-458) ──
// Types/classes remain in evaluator-output.ts, evaluator-runner.ts, and evaluator-prompt-builder.ts.
// Import directly from those source files if needed (not from this barrel).

// PRI-634 A2 (authority migration): code-bearing Artificer artifact 判定 —
// deterministic gate 的执行 authority（durable artifact，非 LLM output shape）。
export type { ArtificerCodeBearingAssessment } from './artificer-code-bearing.js';
export { assessArtificerCodeBearing } from './artificer-code-bearing.js';

// ── Rollout Reviewer Runner (PRI-RR) — MVP-Quiet: de-surfaced from internal barrel (PRI-458) ──
// Types/classes remain in rollout-reviewer-output.ts, rollout-reviewer-runner.ts, and rollout-reviewer-prompt-builder.ts.
// Import directly from those source files if needed (not from this barrel).

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

// Layer 2 progressive disclosure — CandidateLineage (PR 3/5)
export { CandidateLineage } from './candidate-lineage.js';
export type { LineageTaskReader, LineageNode, LineageNote, LineageResult, LineageChain, LineageError } from './candidate-lineage.js';
