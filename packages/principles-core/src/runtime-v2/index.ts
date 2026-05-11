/**
 * PD Runtime v2 — Foundation Contracts
 *
 * This module is the single canonical source for all runtime-v2 type definitions.
 * Future milestones (M2-M9) import from here instead of inventing local types.
 *
 * Re-export hierarchy:
 *   schema-version  → versioning utilities
 *   error-categories → PDErrorCategory, PDRuntimeError
 *   agent-spec      → AgentSpec, well-known agent IDs
 *   runtime-protocol → PDRuntimeAdapter, RuntimeKind, run lifecycle types
 *   runtime-selector → RuntimeSelector interface
 *   task-status     → PDTaskStatus, TaskRecord, DiagnosticianTaskRecord
 *   context-payload → ContextPayload, history/trajectory types
 *   diagnostician-output → DiagnosticianOutputV1
 */

// Schema versioning
export { RUNTIME_V2_SCHEMA_VERSION, schemaRef } from './schema-version.js';

// Schema exports (new — TypeBox schemas for runtime validation)
export { PDErrorCategorySchema } from './error-categories.js';
export { AgentCapabilityRequirementsSchema, AgentTimeoutPolicySchema, AgentRetryPolicySchema, AgentSpecSchema } from './agent-spec.js';
export { SchemaVersionRefSchema, RuntimeV2SchemaVersionSchema } from './schema-version.js';
export { RuntimeKindSchema, RuntimeCapabilitiesSchema, RuntimeHealthSchema, RunHandleSchema, RunExecutionStatusSchema, RunStatusSchema, ContextItemSchema, AgentSpecRefSchema, WorkflowRefSchema, TaskRefSchema, StartRunInputSchema, StructuredRunOutputSchema, RuntimeArtifactRefSchema } from './runtime-protocol.js';
export { PDTaskStatusSchema, TaskRecordSchema, DiagnosticianTaskRecordSchema } from './task-status.js';
export { RuntimeSelectionCriteriaSchema } from './runtime-selector.js';
// Context payload schemas (Phase 2)
export { HistoryQueryEntrySchema, TrajectoryLocateQuerySchema, TrajectoryCandidateSchema, TrajectoryLocateResultSchema, HistoryQueryResultSchema, DiagnosisTargetSchema, ContextPayloadSchema, DiagnosticianContextPayloadSchema } from './context-payload.js';
// Diagnostician output schemas (Phase 2)
export { DiagnosticianViolatedPrincipleSchema, DiagnosticianEvidenceSchema, RecommendationKindSchema, DiagnosticianRecommendationSchema, DiagnosticianOutputV1Schema, DiagnosticianInvocationInputSchema } from './diagnostician-output.js';

// Candidate intake schemas (M7)
export { CandidateIntakeInputSchema, CandidateIntakeOutputSchema, LedgerPrincipleEntrySchema } from './candidate-intake.js';

// Error categories
export { PD_ERROR_CATEGORIES, PDRuntimeError, FAILURE_CATEGORY_MAP, mapFailureCategory } from './error-categories.js';
// Candidate intake errors (M7)
export { INTAKE_ERROR_CODES, CandidateIntakeError } from './candidate-intake.js';
export type { PDErrorCategory } from './error-categories.js';
export { isPDErrorCategory } from './error-categories.js';

// Agent specification
export { AGENT_IDS } from './agent-spec.js';
export type {
  AgentSpec,
  AgentCapabilityRequirements,
  AgentTimeoutPolicy,
  AgentRetryPolicy,
  WellKnownAgentId,
} from './agent-spec.js';

// Runtime protocol
export type {
  RuntimeKind,
  RuntimeCapabilities,
  RuntimeHealth,
  RunHandle,
  RunExecutionStatus,
  RunStatus,
  ContextItem,
  AgentSpecRef,
  WorkflowRef,
  TaskRef,
  StartRunInput,
  StructuredRunOutput,
  RuntimeArtifactRef,
  PDRuntimeAdapter,
} from './runtime-protocol.js';

// Runtime selector
export type {
  RuntimeSelector,
  RuntimeSelectionCriteria,
  RuntimeSelectionResult,
} from './runtime-selector.js';

// Task status and records
export type {
  PDTaskStatus,
  TaskRecord,
  DiagnosticianTaskRecord,
} from './task-status.js';

// Context payload and history retrieval
export type {
  HistoryQueryEntry,
  TrajectoryLocateQuery,
  TrajectoryCandidate,
  TrajectoryLocateResult,
  HistoryQueryResult,
  DiagnosisTarget,
  ContextPayload,
  DiagnosticianContextPayload,
} from './context-payload.js';

// Diagnostician output
export type {
  DiagnosticianOutputV1,
  DiagnosticianViolatedPrinciple,
  DiagnosticianEvidence,
  RecommendationKind,
  DiagnosticianRecommendation,
  DiagnosticianInvocationInput,
} from './diagnostician-output.js';

// Candidate intake types (M7)
export type {
  CandidateIntakeInput,
  CandidateIntakeOutput,
  LedgerPrincipleEntry,
  LedgerAdapter,
} from './candidate-intake.js';
export { CandidateIntakeService, CandidateIntakeServiceOptions } from './candidate-intake-service.js';

// Store
export { SqliteTaskStore } from './store/task/sqlite-task-store.js';
export { SqliteRunStore } from './store/run/sqlite-run-store.js';
export { MemoryTaskStore } from './store/task/memory-task-store.js';
export { MemoryRunStore } from './store/run/memory-run-store.js';
export { MemoryCommitStore } from './store/commit/memory-commit-store.js';
export { MemoryCandidateStore } from './store/candidate/memory-candidate-store.js';
export { MemoryArtifactStore } from './store/artifact/memory-artifact-store.js';
export { SqliteConnection } from './store/sqlite-connection.js';
export { SqliteTrajectoryLocator } from './store/trajectory/sqlite-trajectory-locator.js';
export { SqliteHistoryQuery } from './store/history/sqlite-history-query.js';
export { SqliteContextAssembler } from './store/context/sqlite-context-assembler.js';
export { SqliteDiagnosticianCommitter } from './store/commit/diagnostician-committer.js';
export { ResilientContextAssembler } from './store/context/resilient-context-assembler.js';
export { ResilientHistoryQuery } from './store/history/resilient-history-query.js';
export type {
  HistoryQuery,
  HistoryQueryCursorData,
  HistoryQueryOptions,
} from './store/history/history-query.js';
export type { ContextAssembler } from './store/context/context-assembler.js';
export {
  DEFAULT_HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  DEFAULT_TIME_WINDOW_MS,
} from './store/history/history-query.js';
export type {
  TaskStore,
  TaskStoreFilter,
  TaskStoreUpdatePatch,
} from './store/task/task-store.js';
export type {
  RunStore,
  RunRecord,
} from './store/run/run-store.js';
export type { TrajectoryLocator } from './store/trajectory/trajectory-locator.js';
export type {
  DiagnosticianCommitter,
  CommitInput,
  CommitResult,
} from './store/commit/diagnostician-committer.js';

// Lease & Recovery
export { DefaultLeaseManager } from './store/lifecycle/lease-manager.js';
export type { LeaseManager, AcquireLeaseOptions } from './store/lifecycle/lease-manager.js';
export { DefaultRetryPolicy } from './store/lifecycle/retry-policy.js';
export type { RetryPolicy, RetryPolicyConfig } from './store/lifecycle/retry-policy.js';
export { DefaultRecoverySweep } from './store/lifecycle/recovery-sweep.js';
export type { RecoverySweep, RecoveryResult } from './store/lifecycle/recovery-sweep.js';

// Event emitter
export { StoreEventEmitter, storeEmitter } from './store/event-emitter.js';
export type { TelemetryEvent } from '../telemetry-event.js';

// Runtime integration layer
export { RuntimeStateManager } from './store/runtime-state-manager.js';
export type { RuntimeStateManagerOptions } from './store/runtime-state-manager.js';

// Runner (M4)
export { DiagnosticianRunner } from './runner/diagnostician-runner.js';
export { RunnerPhase } from './runner/runner-phase.js';
export { PassThroughValidator } from './runner/diagnostician-validator.js';
export { DefaultDiagnosticianValidator } from './runner/default-validator.js';
export { resolveRunnerOptions, DEFAULT_RUNNER_OPTIONS } from './runner/diagnostician-runner-options.js';
export type { RunnerResult, RunnerResultStatus } from './runner/runner-result.js';
export type { DiagnosticianRunnerOptions, ResolvedDiagnosticianRunnerOptions } from './runner/diagnostician-runner-options.js';
export type { DiagnosticianValidator, DiagnosticianValidationResult } from './runner/diagnostician-validator.js';

// Runtime Adapter (M4)
export { TestDoubleRuntimeAdapter } from './adapter/index.js';
export type { TestDoubleBehaviorOverrides } from './adapter/index.js';

// OpenClawCliRuntimeAdapter (M6)
export { OpenClawCliRuntimeAdapter } from './adapter/index.js';
export type { OpenClawCliRuntimeAdapterOptions } from './adapter/openclaw-cli-runtime-adapter.js';

// PiAiRuntimeAdapter (M9)
export { PiAiRuntimeAdapter } from './adapter/index.js';
export type { PiAiRuntimeAdapterConfig } from './adapter/pi-ai-runtime-adapter.js';

// PrincipleTreeLedgerAdapter (M8)
export { PrincipleTreeLedgerAdapter } from './adapter/principle-tree-ledger-adapter.js';

// Diagnostician Prompt Builder (M6)
export { DiagnosticianPromptBuilder, summarizeConversationWindow } from './diagnostician-prompt-builder.js';
export type { PromptInput, PromptBuildResult } from './diagnostician-prompt-builder.js';

// CLI surface (M4)
export { run, status, candidateList, candidateShow, artifactShow, probeRuntime } from './cli/index.js';
export type { DiagnoseRunOptions, DiagnoseStatusOptions, DiagnoseStatusResult, CandidateListOptions, CandidateShowOptions, ArtifactShowOptions, ProbeOptions, ProbeResult } from './cli/index.js';

// Pain signal bridge (M8) — INTERNAL: PainSignalBridge is a core implementation detail.
// CLI/plugin consumers MUST use PainToPrincipleService (write) and PainChainReadModel (read).
export {
  /** @deprecated Internal implementation detail — use PainToPrincipleService instead */
  PainSignalBridge,
} from './pain-signal-bridge.js';
export type {
  /** @deprecated Use PainToPrincipleServiceOptions instead */
  PainSignalBridgeOptions,
  PainDetectedData,
  /** @deprecated Use PainToPrincipleOutput instead */
  PainSignalBridgeResult,
  /** @deprecated Internal — use PainToPrincipleOutput.status */
  PainSignalBridgeStatus,
} from './pain-signal-bridge.js';
/** @deprecated Internal implementation detail — observability is handled by PainToPrincipleService */
export { recordPainSignalObservability } from './pain-signal-observability.js';
export type { PainSignalObservabilityResult, RecordPainSignalObservabilityOptions } from './pain-signal-observability.js';
/** @deprecated Internal factory — use PainToPrincipleService constructor instead */
export { createPainSignalBridge, invalidatePainSignalBridge, resolveRuntimeConfig, validateRuntimeConfig, type PainSignalRuntimeFactoryOptions, type RuntimeConfig } from './pain-signal-runtime-factory.js';

// Pain-to-Principle service facade (PRI-12)
export { PainToPrincipleService } from './pain-to-principle-service.js';
export type { PainToPrincipleServiceOptions, PainToPrincipleInput, PainToPrincipleOutput, FailureCategory } from './pain-to-principle-service.js';

// Pain-chain read model (PRI-14)
export { PainChainReadModel } from './pain-chain-read-model.js';
export type { PainChainTrace, PainChainTraceLatencyMs, PainChainReadModelOptions } from './pain-chain-read-model.js';

// Migration bridge
export { EvolutionQueueItemMigrator } from './store/task-migration.js';

// Ledger file utilities (for audit/consistency checks)
export { loadLedger, saveLedger, getLedgerFilePathPublic, updatePrinciple } from '../principle-tree-ledger.js';

// Pruning read model (PRI-15)
export { PruningReadModel } from './pruning-read-model.js';
export type { PrinciplePruningSignal, PruningHealthSummary, PruningReadModelOptions, PruningRiskLevel, OrphanDerivedCandidate, OrphanDetectionResult } from './pruning-read-model.js';

// Pruning review audit log (PRI-24)
export { appendPruningReview, listPruningReviews } from './pruning-review-log.js';
export type { PruningReviewDecision, PruningReviewRecord, AppendPruningReviewInput } from './pruning-review-log.js';

// Candidate audit (PRI-28)
export { auditCandidateLedgerConsistency } from './candidate-audit.js';
export type { CandidateAuditResult } from './candidate-audit.js';

// Operator health snapshot (PRI-28)
export { OperatorHealthReadModel } from './operator-health-read-model.js';
export type { OperatorHealthSnapshot, OperatorHealthReadModelOptions, OverallHealthStatus } from './operator-health-read-model.js';

// Internalization contracts (PRI-42)
export type {
  RuleHostInput,
  RuleHostDecision,
  RuleHostMeta,
  RuleHostResult,
  LoadedImplementation,
} from './internalization/rule-host-contracts.js';
export type { RuleHostHelpers } from './internalization/rule-host-helpers.js';
export { createRuleHostHelpers } from './internalization/rule-host-helpers.js';

// Internalization route model (PRI-43)
export type { InternalizationRouteKind, InternalizationRouteDecision } from './internalization/internalization-route.js';
export { decideInternalizationRoute } from './internalization/internalization-route.js';

// Principle compiler core contracts (PRI-44)
export type { PainPattern } from './internalization/template-generator.js';
export { generateFromTemplate } from './internalization/template-generator.js';
export type { ValidationResult } from './internalization/rule-code-validator.js';
export { checkForbiddenPatterns } from './internalization/rule-code-validator.js';
export type { CompileResult } from './internalization/compile-result.js';

// Pruning mask — builds masked principle set from review log (PRI-48)
export { buildMaskedPrincipleSet, getCachedMaskedPrincipleSet, clearPruningMaskCache } from './pruning-mask.js';

// Decision merge and adapter interface (PRI-45)
export type { DecisionMergeLogger, RuleHostLogger } from './internalization/rule-host-evaluator.js';
export { mergeDecisions } from './internalization/rule-host-evaluator.js';
export type { RuleHostImplementationProvider } from './internalization/rule-host-adapter.js';

// Principle tree domain types (PRI-51)
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
  Principle,
  Rule,
  Implementation,
  ArtifactKind,
  ArtifactLineageRecord,
  ReplayResult,
  ClassificationSummary,
  ReplayReport,
} from './types/index.js';

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
} from './internalization/lifecycle-types.js';

// Lifecycle metrics (PRI-52)
export type { RuleMetricResult, PrincipleAdherenceResult } from './internalization/lifecycle-metrics.js';
export { computeRuleMetrics, computePrincipleAdherence } from './internalization/lifecycle-metrics.js';

// Deprecated readiness (PRI-53)
export type { DeprecatedReadinessStatus, DeprecatedReadinessAssessment } from './internalization/deprecated-readiness.js';
export { assessDeprecatedReadiness } from './internalization/deprecated-readiness.js';

// Lifecycle routing policy (PRI-54)
export type { LifecycleRoute, LifecycleRouteEvidenceSummary, LifecycleRouteRecommendation } from './internalization/routing-policy.js';
export { recommendLifecycleRoute } from './internalization/routing-policy.js';

// Lifecycle datasource adapter + read model builder (PRI-56)
export type { LifecycleDatasource } from './internalization/lifecycle-datasource.js';
export { buildLifecycleReadModel } from './internalization/lifecycle-read-model.js';

// Ledger domain types needed by plugin datasource implementations (PRI-56)
export type { LedgerTreeStore } from '../principle-tree-ledger.js';

// ── Internalization Peer Runner Contracts (PRI-61) ─────────────────────────

export type {
  InternalizationChannel,
  PeerRunnerKind,
  PIArtifactKind,
  PIArtifactValidationStatus,
  ArtifactRef,
  LineageRef,
  PIArtifact,
  PITaskRecord,
} from './internalization/peer-runner-contracts.js';

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
} from './internalization/peer-runner-contracts.js';

// ── Internalization Job Graph (PRI-61) ─────────────────────────────────────

export {
  ALLOWED_EDGES,
  MODEL_TRAINING_CHANNEL,
  TRAINER_KIND,
  validateEdge,
  isAcyclic,
  getAllowedSuccessors,
  getAllowedPredecessors,
} from './internalization/internalization-job-graph.js';

// ── Internalization State Machine Guards (PRI-62) ─────────────────────────────

export {
  canAcquireLease,
  canRetryNow,
  areDependenciesMet,
  canTransitionTo,
  isResultRefImmutable,
  canUpdateLastError,
  isArtifactRejected,
} from './internalization/internalization-task-guards.js';

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
} from './internalization/internalization-state-machine.js';

export {
  validateInternalizationTaskReady,
  validateTaskTransition,
  decideArtifactRejectionFeedback,
  createNextTaskProposal,
  validateInternalizationGraph,
} from './internalization/internalization-state-machine.js';

// ── PITask Persistence & Hydration (PRI-65) ──────────────────────────────────

export type { PITaskMetadata } from './internalization/pitask-metadata.js';

export {
  PI_METADATA_KEY,
  serializePITaskMetadata,
  parsePITaskMetadata,
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
} from './internalization/pitask-metadata.js';

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
} from './internalization/internalization-orchestrator.js';

export { InternalizationOrchestrator, WAKE_ONCE_DECISIONS } from './internalization/internalization-orchestrator.js';

// ── Dreamer Peer Runner (PRI-67/PRI-85) ───────────────────────────────────────

export type {
  DreamerCandidate,
  DreamerOutput,
  DreamerValidationResult,
  DreamerValidator,
} from './internalization/dreamer-output.js';

export { PassThroughDreamerValidator, DefaultDreamerValidator } from './internalization/dreamer-output.js';

export type {
  DreamerRunnerResult,
  DreamerRunnerOptions,
  ResolvedDreamerRunnerOptions,
} from './internalization/dreamer-runner.js';

export {
  resolveDreamerRunnerOptions,
  DEFAULT_DREAMER_RUNNER_OPTIONS,
} from './internalization/dreamer-runner.js';

export { DreamerRunner } from './internalization/dreamer-runner.js';

// ── Philosopher Runner (PRI-90) ────────────────────────────────────────────────

export type {
  PhilosopherOutputV1,
  PhilosopherPrincipleCandidate,
  PhilosopherValidationResult,
  PhilosopherValidator,
} from './internalization/philosopher-output.js';

export {
  DefaultPhilosopherValidator,
} from './internalization/philosopher-output.js';

export type {
  PhilosopherRunnerResultStatus,
  PhilosopherRunnerResult,
  PhilosopherRunnerOptions,
  ResolvedPhilosopherRunnerOptions,
  PhilosopherRunnerDeps,
} from './internalization/philosopher-runner.js';

export {
  PhilosopherRunner,
  resolvePhilosopherRunnerOptions,
  DEFAULT_PHILOSOPHER_RUNNER_OPTIONS,
} from './internalization/philosopher-runner.js';

// ── Scribe Runner (PRI-109) ────────────────────────────────────────────────────

export type {
  ScribeOutputV1,
  ScribePrincipleDraft,
  ScribeSourceTrace,
  ScribeValidationResult,
  ScribeValidator,
} from './internalization/scribe-output.js';

export {
  DefaultScribeValidator,
} from './internalization/scribe-output.js';

export type {
  ScribeRunnerResultStatus,
  ScribeRunnerResult,
  ScribeRunnerOptions,
  ResolvedScribeRunnerOptions,
  ScribeRunnerDeps,
} from './internalization/scribe-runner.js';

export {
  ScribeRunner,
  resolveScribeRunnerOptions,
  DEFAULT_SCRIBE_RUNNER_OPTIONS,
} from './internalization/scribe-runner.js';

// ── Artificer Runner (PRI-111) ────────────────────────────────────────────────

export type {
  ArtificerOutputV1,
  ArtificerImplementationPlan,
  ArtificerSourceTrace,
  ArtificerValidationResult,
  ArtificerValidator,
} from './internalization/artificer-output.js';

export {
  DefaultArtificerValidator,
  ArtificerOutputV1Schema,
  ArtificerImplementationPlanSchema,
  ArtificerSourceTraceSchema,
} from './internalization/artificer-output.js';

export type {
  ArtificerRunnerResultStatus,
  ArtificerRunnerResult,
  ArtificerRunnerOptions,
  ResolvedArtificerRunnerOptions,
  ArtificerRunnerDeps,
} from './internalization/artificer-runner.js';

export {
  ArtificerRunner,
  resolveArtificerRunnerOptions,
  DEFAULT_ARTIFICER_RUNNER_OPTIONS,
} from './internalization/artificer-runner.js';

// ── Evaluator Runner (PRI-EVAL) ────────────────────────────────────────────────

export type {
  EvaluatorEvaluation,
  EvaluatorSourceTrace,
  EvaluatorOutputV1,
  EvaluatorValidationResult,
  EvaluatorValidator,
} from './internalization/evaluator-output.js';

export {
  DefaultEvaluatorValidator,
  EvaluatorOutputV1Schema,
  EvaluatorEvaluationSchema,
  EvaluatorSourceTraceSchema,
  EVALUATOR_DECISIONS,
} from './internalization/evaluator-output.js';

export type {
  EvaluatorRunnerResultStatus,
  EvaluatorRunnerResult,
  EvaluatorRunnerOptions,
  ResolvedEvaluatorRunnerOptions,
  EvaluatorRunnerDeps,
} from './internalization/evaluator-runner.js';

export {
  EvaluatorRunner,
  resolveEvaluatorRunnerOptions,
  DEFAULT_EVALUATOR_RUNNER_OPTIONS,
} from './internalization/evaluator-runner.js';

export {
  EvaluatorPromptBuilder,
  EVALUATOR_PROTOCOL_INSTRUCTION,
  EVALUATOR_PROMPT_CONTRACT_VERSION,
} from './internalization/evaluator-prompt-builder.js';

export type {
  EvaluatorPromptBuilderInput,
  EvaluatorPromptInput,
  EvaluatorPromptBuildResult,
} from './internalization/evaluator-prompt-builder.js';

// ── Rollout Reviewer Runner (PRI-RR) ────────────────────────────────────────

export type {
  RolloutReviewerReview,
  RolloutReviewerSourceTrace,
  RolloutReviewerOutputV1,
  RolloutReviewerValidationResult,
  RolloutReviewerValidator,
} from './internalization/rollout-reviewer-output.js';

export {
  DefaultRolloutReviewerValidator,
  RolloutReviewerOutputV1Schema,
  RolloutReviewerReviewSchema,
  RolloutReviewerSourceTraceSchema,
  ROLLOUT_REVIEWER_DECISIONS,
} from './internalization/rollout-reviewer-output.js';

export type {
  RolloutReviewerRunnerResultStatus,
  RolloutReviewerRunnerResult,
  RolloutReviewerRunnerOptions,
  ResolvedRolloutReviewerRunnerOptions,
  RolloutReviewerRunnerDeps,
} from './internalization/rollout-reviewer-runner.js';

export {
  RolloutReviewerRunner,
  resolveRolloutReviewerRunnerOptions,
  DEFAULT_ROLLOUT_REVIEWER_RUNNER_OPTIONS,
} from './internalization/rollout-reviewer-runner.js';

export {
  RolloutReviewerPromptBuilder,
  ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION,
  ROLLOUT_REVIEWER_PROMPT_CONTRACT_VERSION,
} from './internalization/rollout-reviewer-prompt-builder.js';

export type {
  RolloutReviewerPromptBuilderInput,
  RolloutReviewerPromptInput,
  RolloutReviewerPromptBuildResult,
} from './internalization/rollout-reviewer-prompt-builder.js';

// ── PIArtifact Durable Store (PRI-84) ────────────────────────────────────────

export type { PIArtifactRecord, PIArtifactStore } from './internalization/pi-artifact.js';
export { MemoryPIArtifactStore } from './internalization/pi-artifact-store.js';

// ── Internalization Queue Read Model (PRI-73) ──────────────────────────────

export { InternalizationQueueReadModel } from './internalization-queue-read-model.js';
export type {
  InternalizationQueueSnapshot,
  NoReadyTasksDiagnosis,
  QueueNoReadyTasksReason,
  ReadyTask,
  BlockedSample,
  DependencyFailedSample,
  RetryWaitPendingSample,
  LeaseConflictSample,
} from './internalization-queue-read-model.js';

// ── GFI Core Kernel (PRI-76) ────────────────────────────────────────────────

export {
  DEFAULT_GFI_POLICY,
  applyFriction,
  applyDecay,
  applyRelief,
  classifyGfiStage,
  createGfiSnapshot,
} from './gfi/index.js';
export type {
  GfiState,
  GfiEvent,
  GfiPolicy,
  GfiStage,
  GfiSource,
  GfiSnapshot,
} from './gfi/index.js';

// ── GFI Workspace Read Model (PRI-78) ──────────────────────────────────────

export { buildGfiWorkspaceSnapshot, classifyGfiWorkspaceHealth } from './gfi/index.js';
export type { GfiReadModelInput, GfiWorkspaceSnapshot, GfiWorkspaceHealthAssessment } from './gfi/index.js';

// ── Schema Conformance Read Model (PRI-95) ──────────────────────────────────

export { SchemaConformanceReadModel } from './schema-conformance-read-model.js';
export type { SchemaConformanceResult, SchemaConformanceTableResult, SchemaConformanceReadModelOptions } from './schema-conformance-read-model.js';

// ── Internalization Chain Integrity Read Model (PRI-97) ─────────────────────

export { InternalizationChainIntegrityReadModel, extractPIMetadata } from './internalization-chain-integrity-read-model.js';
export type { BrokenLink, ChainIntegrityResult, InternalizationChainIntegrityReadModelOptions } from './internalization-chain-integrity-read-model.js';

export { InternalizationIntegrityRemediation } from './internalization-integrity-remediation.js';
export type { InternalizationIntegrityRemediationOptions } from './internalization-integrity-remediation.js';

export {
  createRemediationResult,
  remediationAction,
} from './remediation-contract.js';

export type {
  RemediationAction,
  RemediationMode,
  RemediationResult,
  RemediationStatus,
  CreateRemediationResultInput,
} from './remediation-contract.js';

// ── Control Plane Triage (PRI-99) ───────────────────────────────────────────

export { classifyCanaryFindings } from './control-plane-triage.js';
export type { TriageCategory, TriageCategoryName, TriagePlan } from './control-plane-triage.js';

// ── GoldenTrace L2 artifact model (PRI-113) ────────────────────────────────

export {
  GoldenTraceCaseSchema,
  GoldenTraceSchema,
  CorrectionApplicationModeSchema,
  GoldenTraceDecisionSchema,
  GoldenTraceCaseKindSchema,
  validateGoldenTraceCase,
  validateGoldenTrace,
  createSyntheticRuleHostInput,
  createGoldenTraceFixture,
} from './golden-trace.js';

export type {
  CorrectionApplicationMode,
  GoldenTraceDecision,
  GoldenTraceCaseKind,
  GoldenTraceCase,
  GoldenTrace,
  GoldenTraceValidationResult,
  ToolCallSnapshot,
  SyntheticRuleHostInputOverrides,
  GoldenTraceFixtureInput,
} from './golden-trace.js';
