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
export { GovernanceChannelSchema, LineageConfidenceSchema, SourceRefSchema, RevisionIdentitySchema, PrincipleFactSchema, TaskFactSchema, RunnerVerdictFactSchema, ApprovalFactSchema, ActivationFactSchema, DerivedRelationFactSchema, TimelineEventSchema, DataQualityIssueSchema, LineageContextSchema, GovernanceFactsSchema, PrincipleStateSchema, ProcessViewSchema, AutomationViewSchema, AttentionItemSchema, AttentionViewSchema, ActivationSummarySchema, OwnerGovernanceSummarySchema, DataQualitySchema, OwnerGovernanceViewSchema } from './governance-projection-contract.js';
export type { GovernanceChannel, LineageConfidence, SourceRef, RevisionIdentity, PrincipleFact, TaskFact, RunnerVerdictFact, ApprovalFact, ActivationFact, DerivedRelationFact, TimelineEvent, DataQualityIssue, LineageContext, GovernanceFacts, PrincipleState, ProcessView, AutomationView, AttentionItem, AttentionView, ActivationSummary, OwnerGovernanceSummary, DataQuality, OwnerGovernanceView } from './governance-projection-contract.js';
export { GOVERNANCE_HEADLINE_CODES, deriveOwnerGovernanceView } from './governance-projection.js';
export {
  GovernancePrimaryAttentionSchema, GovernanceExperienceReasonCodeSchema, GovernanceExperienceNextActionCodeSchema,
  WorkspaceEnvironmentSchema, EnvironmentContextInputSchema, SourceAvailabilityInputSchema, UnlinkedRecordGroupSchema,
  OwnerConfigSnapshotSchema, GovernanceViewInputSchema, FrontierEvidenceSchema, GovernanceExperienceInputsSchema,
  GovernanceActionKindSchema, GovernanceObservedAuthoritySchema, GovernanceActionReadinessSchema, OwnerGovernanceReadinessSchema,
  GovernanceActivityCategorySchema, GovernanceActivityItemSchema, GovernanceActivityCategorySummarySchema, GovernanceActivitySnapshotSchema,
  GovernanceLineageTransparencySchema, GovernanceTrustContextSchema, GovernanceDataQualityIssueGroupSchema, GovernanceDataQualitySchema,
  GovernanceExperienceSummarySchema, GovernanceExperienceSnapshotSchema,
} from './governance-experience-contract.js';
export type {
  WorkspaceEnvironment, EnvironmentContextInput, SourceAvailabilityInput, UnlinkedRecordGroup, OwnerConfigSnapshot,
  GovernanceViewInput, FrontierEvidence, GovernanceExperienceInputs, GovernanceActionKind, GovernanceObservedAuthority,
  GovernanceActionReadiness, OwnerGovernanceReadiness, GovernancePrimaryAttention, GovernanceActivityCategory,
  GovernanceActivityItem, GovernanceActivityCategorySummary, GovernanceActivitySnapshot, GovernanceLineageTransparency,
  GovernanceTrustContext, GovernanceDataQualityIssueGroup, GovernanceDataQuality, GovernanceExperienceReasonCode,
  GovernanceExperienceNextActionCode, GovernanceExperienceSummary, GovernanceExperienceSnapshot,
} from './governance-experience-contract.js';
export { GOVERNANCE_EXPERIENCE_ITEMS_LIMIT, GOVERNANCE_EXPERIENCE_ISSUE_GROUPS_LIMIT, deriveGovernanceExperienceSnapshot } from './governance-experience.js';
// Receipt evidence coverage disclosure contract (PRI-590)
export { RECEIPT_RETENTION_POLICY_DAYS } from './receipt-coverage.js';
export type { ReceiptSourceStatus, ReceiptValidationStatus, ReceiptEvidenceCoverage } from './receipt-coverage.js';
// Owner identity registration (ADR-0022, PRI-578) — env > ~/.pd/owner.json > none
export {
  OWNER_IDENTITY_SCHEMA_VERSION,
  OWNER_IDENTITY_FILE_NAME,
  resolveOwnerIdentity,
  readOwnerIdentityFile,
  writeOwnerIdentityFile,
  deleteOwnerIdentityFile,
  ownerIdentityFilePath,
  defaultOwnerIdentityHomeDir,
} from './owner-identity.js';
export type { OwnerIdentityRecord, OwnerIdentitySource, OwnerIdentityResolved, OwnerIdentityFileResult, OwnerIdentityDeleteResult } from './owner-identity.js';
// Anonymous Product Telemetry v1 (PRI-595~603) — pure contract, no I/O.
// Durable-fact readers and the HTTPS exporter live in @principles/host-runtime.
export {
  generateTelemetrySecretHex,
  isValidTelemetrySecretHex,
  bucketDateFromTime,
  isValidBucketDate,
  deriveWorkspaceScopeId,
  deriveDailyTelemetryId,
  isValidDailyTelemetryId,
  TELEMETRY_SECRET_BYTES,
  DAILY_TELEMETRY_ID_HEX_LENGTH,
  WORKSPACE_SCOPE_ID_HEX_LENGTH,
} from './product-telemetry/daily-identity.js';
export {
  ProductTelemetrySnapshotV1Schema,
  PRODUCT_TELEMETRY_SNAPSHOT_SCHEMA_VERSION,
  PRODUCT_TELEMETRY_CONSENT_VERSION,
  PRODUCT_TELEMETRY_HOST_KINDS,
  PRODUCT_TELEMETRY_TOP_LEVEL_FIELDS,
  PROHIBITED_TELEMETRY_FIELD_TOKENS,
  PRODUCT_TELEMETRY_PD_VERSION_MAX_LENGTH,
  assertTelemetrySchemaPrivacy,
  validateProductTelemetrySnapshot,
  buildProductTelemetrySnapshot,
} from './product-telemetry/snapshot-contract.js';
export type { TelemetryFact } from './product-telemetry/snapshot-contract.js';
export type {
  ProductTelemetryHostKind,
  ProductTelemetrySnapshotV1,
  ProductTelemetryMilestoneInput,
  ProductTelemetryReliabilityInput,
  BuildSnapshotInput,
  SnapshotValidationResult,
} from './product-telemetry/snapshot-contract.js';
export { AgentCapabilityRequirementsSchema, AgentTimeoutPolicySchema, AgentRetryPolicySchema, AgentSpecSchema } from './agent-spec.js';
export { SchemaVersionRefSchema, RuntimeV2SchemaVersionSchema } from './schema-version.js';
export { RuntimeKindSchema, RuntimeCapabilitiesSchema, RuntimeHealthSchema, RunHandleSchema, RunExecutionStatusSchema, RunStatusSchema, ContextItemSchema, AgentSpecRefSchema, WorkflowRefSchema, TaskRefSchema, StartRunInputSchema, StructuredRunOutputSchema, RuntimeArtifactRefSchema } from './runtime-protocol.js';
export { PDTaskStatusSchema, TaskRecordSchema, DiagnosticianTaskRecordSchema, PD_TASK_STATUSES, isPDTaskStatus } from './task-status.js';
export { RuntimeSelectionCriteriaSchema } from './runtime-selector.js';
// Context payload schemas (Phase 2)
export { HistoryQueryEntrySchema, TrajectoryLocateQuerySchema, TrajectoryCandidateSchema, TrajectoryLocateResultSchema, HistoryQueryResultSchema, DiagnosisTargetSchema, ContextPayloadSchema, DiagnosticianContextPayloadSchema, ToolCallEntrySchema, PainContextSchema, FullTracePayloadSchema, FullTracePayloadV2Schema, TraceSourceRefSchema, TraceTimelineEntrySchema, TraceEventKindSchema, SourceRefKindSchema, validateFullTracePayload, sanitizeFullTracePayload, buildFullTraceTimeline, buildSourceRefs, checkFullTracePayloadSchema, TRACE_EVENT_KINDS, SOURCE_REF_KINDS } from './context-payload.js';
// Trace refiner (PRI-191)
export { refineFullTrace, REFINED_EVENT_KINDS, SEVERITY_LEVELS } from './trace-refiner.js';
export type { RefinedTraceEvent, RefinedEventKind, RefinedTracePayload, SeverityLevel, TraceRefinerOptions } from './trace-refiner.js';
// Trace refiner agent shadow contract (PRI-192)
export { createTraceRefinerAgentInput, validateTraceRefinerAgentOutput, applyTraceRefinerAgentShadowResult } from './trace-refiner-agent.js';
export type { TraceRefinerAgentObjective, TraceRefinerAgentMode, TraceRefinerAgentInput, TraceRefinerEvidenceClaim, TraceRefinerRejectedEvidence, TraceRefinerAgentStatus, TraceRefinerAgentOutput } from './trace-refiner-agent.js';
// GoldenTrace candidate builder (PRI-193)
export { buildGoldenTraceCandidate } from './golden-trace-candidate-builder.js';
export type { GoldenTraceCandidateDecision, GoldenTraceCandidateBuilderInput, GoldenTraceCandidateRefusal, GoldenTraceCandidateCreated, GoldenTraceCandidateBuilderResult } from './golden-trace-candidate-builder.js';
// Diagnostician output schemas (Phase 2)
export { DiagnosticianViolatedPrincipleSchema, DiagnosticianEvidenceSchema, RecommendationKindSchema, DiagnosticianRecommendationSchema, DiagnosticianOutputV1Schema, DiagnosticianInvocationInputSchema } from './diagnostician-output.js';
// Principle tree types schemas
export { PRINCIPLE_STATUSES, PrincipleStatusSchema, PrinciplePrioritySchema, PrincipleScopeSchema, PrincipleEvaluabilitySchema, RuleStatusSchema, RuleTypeSchema, ImplementationLifecycleStateSchema, ImplementationTypeSchema, SampleClassificationSchema, PrincipleSchema, RuleSchema, ImplementationSchema, PrincipleDependencySchema, PrincipleValueMetricsSchema, PrincipleEventTypeSchema, PrincipleLifecycleEventSchema, PrincipleTreeStoreSchema, EvidenceChainStateSchema, EvidenceChainRecordSchema, EvidenceChainResponseSchema } from './types/index.js';
// Hygiene types schemas
export { PersistenceActionSchema, HygieneStatsSchema } from './types/hygiene-types.js';
// Runtime summary types schemas
export { RuntimeTruthSchema, AnalyticsTruthSchema, TrendMetricsSchema } from './types/runtime-summary-types.js';
// Event types schemas
export { EventTypeSchema, EventCategorySchema, EventLogEntrySchema, ToolCallEventDataSchema, PainSignalEventDataSchema, RulePromotionEventDataSchema, GovernanceActionEventDataSchema, HookExecutionEventDataSchema, GateBlockEventDataSchema, GateBypassEventDataSchema, EvolutionTaskEventDataSchema, EmpathyRollbackEventDataSchema, HeartbeatDiagnosisEventDataSchema, DiagnosisTaskEventDataSchema, DiagnosticianReportEventDataSchema, PrincipleCandidateEventDataSchema, RuleEnforcedEventDataSchema, RuleHostEvaluatedEventDataSchema, RuleHostBlockedEventDataSchema, RuleHostRequireApprovalEventDataSchema, RuleHostAutoCorrectProposedEventDataSchema, RuleHostAutoCorrectAppliedEventDataSchema, RuntimeV2PromptActivationsInjectedEventDataSchema, RuleHostUnhealthyEventDataSchema, RuleHostSkippedEventDataSchema, ToolCallStatsSchema, ErrorStatsSchema, EmpathyEventStatsSchema, GfiStatsSchema, EventEvolutionStatsSchema, HookStatsSchema, DailyStatsSchema } from './types/event-types.js';
// Event payload discriminated union schemas
export { DiscriminatedEventLogEntrySchema } from './types/event-payload.js';

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
  TraceAvailability,
  TraceUnavailableDetail,
  ContextPayload,
  DiagnosticianContextPayload,
  ToolCallEntry,
  PainContext,
  FullTracePayload,
  FullTracePayloadV2,
  TraceSourceRef,
  TraceTimelineEntry,
  TraceEventKind,
  SourceRefKind,
  FullTraceValidationResult,
  SanitizeFullTraceResult,
  RunRecordLike,
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
  Recommendation,
} from './candidate-intake.js';
export { validateRecommendation } from './candidate-intake.js';
export { CandidateIntakeService } from './candidate-intake-service.js';
export type { CandidateIntakeServiceOptions } from './candidate-intake-service.js';

// Store
export { SqliteTaskStore } from './store/task/sqlite-task-store.js';
export type { FailedTaskSummary, FailedTaskDetail, FailedTaskFilter } from './store/task/task-types.js';
export { SqliteRunStore, MalformedRunError } from './store/run/sqlite-run-store.js';
export { MemoryTaskStore } from './store/task/memory-task-store.js';
export { MemoryRunStore } from './store/run/memory-run-store.js';
export { MemoryCommitStore } from './store/commit/memory-commit-store.js';
export { MemoryCandidateStore } from './store/candidate/memory-candidate-store.js';
export { MemoryArtifactStore } from './store/artifact/memory-artifact-store.js';
export { SqliteConnection } from './store/sqlite-connection.js';
export {
  SqliteReconciliationCursorStore,
  SUCCEEDED_TRANSITIONS_SCOPE,
} from './store/reconciliation-cursor-store.js';
export type { ReconciliationCursor } from './store/reconciliation-cursor-store.js';
export type { SqlitePragmaReport } from './store/sqlite-connection.js';
export { guardWorkspaceLeak, isMockLeakPath } from './store/workspace-leak-guard.js';
export { SqliteTrajectoryLocator } from './store/trajectory/sqlite-trajectory-locator.js';
export { SqliteSourceTraceLocator } from './store/trajectory/sqlite-source-trace-locator.js';
export type { SourceTraceLocator, SourceTraceLocateDecision, SourceTraceLocateQuery, SourceTraceLocateResult, SourceTraceCandidate } from './store/trajectory/source-trace-locator.js';
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
export type { PainDiagnosisRecord, PainDiagnosisWriteInput } from './store/runtime-state-manager.js';

// Runner (M4)
export { RunnerPhase } from './runner/runner-phase.js';
export type { RunnerResult, RunnerResultStatus } from './runner/runner-result.js';
export { SplitDiagnosticianRunner } from './internalization/split-diagnostician-runner.js';
export { DiagRootCauseRunner } from './internalization/diag-rootcause-runner.js';
export { DiagDistillerRunner } from './internalization/diag-distiller-runner.js';
export { DiagRouterRunner } from './internalization/diag-router-runner.js';
// Layer 2 progressive disclosure — CandidateLineage (PR 3/5)
export { CandidateLineage } from './internalization/candidate-lineage.js';
export type { LineageTaskReader, LineageNode, LineageNote, LineageResult, LineageChain, LineageError } from './internalization/candidate-lineage.js';
export { DefaultDiagRootCauseValidator } from './diagnostician/diag-rootcause-output.js';
export {
  IntentTensionSchema,
  IntentTensionSourceSchema,
  EvidenceStrengthSchema,
  IntentRelatedFieldSchema,
  SuggestedOwnerActionSchema,
  isIntentTensionSource,
  isEvidenceStrength,
  isIntentRelatedField,
  isSuggestedOwnerAction,
} from './diagnostician/diag-rootcause-output.js';
export type {
  IntentTension,
  IntentTensionSource,
  EvidenceStrength,
  IntentRelatedField,
  SuggestedOwnerAction,
} from './diagnostician/diag-rootcause-output.js';
export { DefaultDiagDistillerValidator } from './diagnostician/diag-distiller-output.js';
export { DisabledDiagnosticianRunner } from './pain-signal-runtime-factory.js';
// Runtime Adapter (M4)
export { TestDoubleRuntimeAdapter } from './adapter/index.js';
export type { TestDoubleBehaviorOverrides } from './adapter/index.js';

// OpenClawCliRuntimeAdapter (M6)
export { OpenClawCliRuntimeAdapter } from './adapter/index.js';
export type { OpenClawCliRuntimeAdapterOptions } from './adapter/openclaw-cli-runtime-adapter.js';

// PiAiRuntimeAdapter (M9)
export { PiAiRuntimeAdapter } from './adapter/index.js';
export type { PiAiRuntimeAdapterConfig } from './adapter/pi-ai-runtime-adapter.js';
// PRI-621 PR2 review: core capability wrapper so cross-package callers query
// the pi-ai builtin catalog without declaring pi-ai themselves (EP-06).
export { builtinPiAiProviderIds, isBuiltinPiAiProvider } from './adapter/pi-ai-catalog.js';

// PrincipleTreeLedgerAdapter (M8)
export { PrincipleTreeLedgerAdapter } from './adapter/principle-tree-ledger-adapter.js';

// Diagnostician Prompt Builder (M6)
export { summarizeConversationWindow } from './diagnostician-prompt-builder.js';
export type { PromptInput, PromptBuildResult } from './diagnostician-prompt-builder.js';

// Language directive for principle generation (PRI-336)
export {
  buildLanguageDirective,
  resolveOutputLanguage,
  isValidOutputLanguage,
  VALID_OUTPUT_LANGUAGES,
  DEFAULT_OUTPUT_LANGUAGE,
} from './language-directive.js';
export type { OutputLanguage, ResolvedOutputLanguage } from './language-directive.js';

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
  PainEvidenceEntry,
  /** @deprecated Use PainToPrincipleOutput instead */
  PainSignalBridgeResult,
  /** @deprecated Internal — use PainToPrincipleOutput.status */
  PainSignalBridgeStatus,
  /** Minimal interface for a diagnostician runner (monolith or split pipeline). */
  DiagnosticianRunnerLike,
} from './pain-signal-bridge.js';
export { MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_NOTE_CHARS } from './pain-signal-bridge.js';
/** Deterministic diagnostician task id (`diagnosis_<painId>`) — the pain→task dedup key (Codex Governance Closure §13). */
export { createDiagnosticianTaskId } from './pain-signal-bridge.js';
/** @deprecated Internal implementation detail — observability is handled by PainToPrincipleService */
export { recordPainSignalObservability } from './pain-signal-observability.js';
export type { PainSignalObservabilityResult, RecordPainSignalObservabilityOptions } from './pain-signal-observability.js';
export { sanitizeString, sanitizeValue, sanitizeToolParams, convergePath, MAX_EVIDENCE_VALUE_CHARS } from './evidence-sanitizer.js';
/** @deprecated Internal factory — use PainToPrincipleService constructor instead */
export { createPainSignalBridge, invalidatePainSignalBridge, disposePainSignalBridgesForWorkspace, resolveRuntimeConfig, validateRuntimeConfig, isRuntimeConfigError, resolveRuntimeConfigFromPdConfig, SPLIT_PIPELINE_TOTAL_TIMEOUT_MS, type PainSignalRuntimeFactoryOptions, type RuntimeConfig, type RuntimeConfigError, type RuntimeConfigResult, type ResolveRuntimeConfigOptions } from './pain-signal-runtime-factory.js';

// Pain-to-Principle service facade (PRI-12)
export { PainToPrincipleService } from './pain-to-principle-service.js';
export type { PainToPrincipleServiceOptions, PainToPrincipleInput, PainToPrincipleOutput, FailureCategory } from './pain-to-principle-service.js';

// Admission gate (PRI-256)
export { evaluateAdmission, evaluateCandidateAdmissions, evaluateCandidateAdmissionFromRecord, ADMISSION_CONFIDENCE_THRESHOLD } from './admission-gate.js';
export type { AdmissionDecision, AdmissionGateInput, AdmissionGateResult, CandidateAdmissionResult, PainProvenance } from './admission-gate.js';

// Evidence guards (PRI-345) — shared owner-exemption + short-circuit logic
export { isOwnerExplicitManual, shouldShortCircuitEmptyEvidence } from './evidence-guards.js';

// Pain-chain read model (PRI-14)
export { PainChainReadModel } from './pain-chain-read-model.js';
export type { PainChainTrace, PainChainTraceLatencyMs, PainChainReadModelOptions } from './pain-chain-read-model.js';

// Migration bridge
export { EvolutionQueueItemMigrator } from './store/task-migration.js';

// Workspace guidance migration (PRI-286) — remove stale PLAN.md gate guidance from installed workspaces
export { migrateWorkspaceGuidance, containsStalePlanMdGuidance, STALE_PLAN_MD_PATTERNS } from './workspace-guidance-migration.js';
export type { MigrationResult as WorkspaceGuidanceMigrationResult } from './workspace-guidance-migration.js';

// Ledger file utilities — PRI-443 Phase 5: removed from runtime-v2 barrel.
// I/O functions (loadLedger, saveLedger, getLedgerFilePathPublic, updatePrinciple)
// are now imported directly from @principles/core/principle-tree-ledger by consumers
// (pd-cli, openclaw-plugin). The runtime-v2 barrel must stay pure-types-only.

// Pruning read model (PRI-15)
export { PruningReadModel, removeOrphanReferencesFromLedger } from './pruning-read-model.js';
export type { PrinciplePruningSignal, PruningHealthSummary, PruningReadModelOptions, PruningRiskLevel, OrphanDerivedCandidate, OrphanDetectionResult, RemovedOrphanReference } from './pruning-read-model.js';

// Pruning review audit log (PRI-24)
export { appendPruningReview, listPruningReviews } from './pruning-review-log.js';
export type { PruningReviewDecision, PruningReviewRecord, AppendPruningReviewInput } from './pruning-review-log.js';

// Recovery actions audit log (Governance Recovery Actions v1)
export { appendRecoveryAction, listRecoveryActions } from './recovery-actions-log.js';
export type {
  RecoveryActionRecord,
  RecoveryActionKind,
  RecoveryActionResult,
  AppendRecoveryActionInput,
} from './recovery-actions-log.js';

// Candidate audit (PRI-28)
export { auditCandidateLedgerConsistency } from './candidate-audit.js';
export type { CandidateAuditResult } from './candidate-audit.js';

// Operator health snapshot (PRI-28)
export { OperatorHealthReadModel } from './operator-health-read-model.js';
export type { OperatorHealthSnapshot, OperatorHealthReadModelOptions, OverallHealthStatus } from './operator-health-read-model.js';

// Stalled diagnostician task read model (PRI-377)
export { StalledDiagnosticianTaskReadModel } from './stalled-diagnostician-task-read-model.js';
export type { StalledDiagnosticianTaskInfo, StalledDiagnosticianTaskReadModelOptions } from './stalled-diagnostician-task-read-model.js';

// Synthetic baseline (PRI-206) — pure contract/helpers only; I/O runner lives in pd-cli
export { computeOverallStatus, boundedEvidence, safeStringify, truncateReason, makeDeterministicDiagnosticianOutput, recommendNextIssue } from './synthetic-baseline.js';
export type { SyntheticBaselineSummary, SyntheticBaselineStage, SyntheticBaselineStageName, SyntheticBaselineFailStage, SyntheticBaselineOptions } from './synthetic-baseline.js';

// Feature Flag Registry (PRI-239) — MVP-Quiet loadable feature flags

export {
  VALID_CATEGORIES,
  validateFeatureFlagRaw,
  computeEffectiveFlags,
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_ALIASES,
  normalizeFeatureFlagOverrides,
} from './feature-flags/index.js';

export type {
  FeatureFlagCategory,
  FeatureFlagDefinition,
  EffectiveFeatureFlags,
  FeatureFlagOverrideNormalization,
  ValidationResult as FeatureFlagValidationResult,
  ValidationResultOk as FeatureFlagValidationResultOk,
  ValidationResultErr as FeatureFlagValidationResultErr,
} from './feature-flags/index.js';

// Core Principle Registry (PRI-367) — canonical built-in principle definitions
// (exactly 10: 6 foundational axioms + 4 operating principles, PRI-606/607)
export {
  CORE_PRINCIPLES,
  CORE_PRINCIPLE_IDS,
  getFoundationalPrinciples,
  getOperatingPrinciples,
  isCorePrincipleId,
  getCorePrinciple,
  CorePrincipleSchema,
  stripFabricatedCorePrincipleIds,
  formatCorePrinciplesList,
  buildCoreAxiomBlock,
} from './core-principles/index.js';

export type {
  CorePrinciple,
  CorePrincipleLayer,
  CorePrincipleScope,
} from './core-principles/index.js';

// Plugin Surface Registry (PRI-289) — MVP hook/service/startup surface guard

export {
  VALID_SURFACE_KINDS,
  VALID_MVP_CATEGORIES,
  PLUGIN_SURFACE_REGISTRY,
  validateSurfaceRegistry,
  getEnabledSurfaces,
  getSurfacesByCategory,
  getSurfacesByKind,
  findUnclassifiedSurfaces,
} from './feature-flags/index.js';

export type {
  SurfaceKind,
  MvpCategory,
  PluginSurfaceEntry,
  SurfaceRegistryValidationResult,
} from './feature-flags/index.js';

// Surface guard (Stage 3) — pure logic migrated from plugin
export {
  checkSurfaceGuard,
  getSurfaceIdForHook,
  getSurfaceIdForService,
  isSurfaceEnabled,
  guardHook,
  guardService,
  __resetSurfaceGuardSkipLogStateForTests,
} from './feature-flags/index.js';

export type {
  SurfaceGuardResult,
  HookHandler,
} from './feature-flags/index.js';

// Proven channel baseline (PRI-240) — MVP activation continuity fixtures
export {
  runPromptFixture,
  runRuleHostFixture,
  runDeferArchiveFixture,
  computeProvenChannelStatus,
  generateContinuityMatrix,
  recommendProvenChannelNextIssue,
  isMvpChannel,
  parseChannels,
  makePrincipleArtifact,
  makeRuleArtifact,
  makeSandboxAlwaysPass,
  classifyLegacyDependency,
  MVP_CHANNELS,
} from './proven-channel-baseline.js';
export type { MvpChannel, ChannelFixtureResult, ProvenChannelBaselineSummary, ContinuityMatrixEntry, InputValidationFailure } from './proven-channel-baseline.js';

// Story A' demo scenario (PRI-246) — pure types + helpers; I/O runner lives in pd-cli
export {
  STORY_A_CHANNELS,
  makeRunId,
  makePrincipleArtifactRecord,
  makeRuleArtifactRecord,
  computeDemoStatus,
  buildFollowUpObservation,
  buildDemoNarrative,
  validateDemoChannels,
  createDemoSandboxEvaluate,
  evaluateDemoGoldenTrace,
  type DemoNarrativeInput,
} from './story-a-demo.js';
export type { StoryADemoResult, StoryADemoStage, StoryADemoStageName, StoryADemoChannelOutcome, StoryADemoInputValidationFailure, StoryADemoOptions } from './story-a-demo.js';

// RuleHost MVP Activation — multi-round adversarial loop (PRI-428)
export { runAdversarialLoop, DEFAULT_MAX_ROUNDS } from './adversarial-loop.js';
export type { AdversarialLoopInput, AdversarialLoopResult } from './adversarial-loop.js';

// RuleHost MVP Activation — Artificer L2 Adapter (PRI-424 / PRI-439 Phase 4)
export { ArtificerL2Adapter } from './adapter/artificer-l2-adapter.js';
export type { ArtificerL2AdapterConfig } from './adapter/artificer-l2-adapter.js';

// Pain flood simulation (PRI-208) — pure contract/helpers only; I/O runner lives in pd-cli
export {
  computeFloodStatus, computeFloodTotals, formatContextBudgetSummary, recommendFloodNextIssue,
  boundedFloodEvidence, maxEvidencePreviewLength, FLOOD_SCENARIO_EXPECTATIONS,
  computeMaxAllowedTasks,
} from './pain-flood-simulation.js';
export type { PainFloodSimulationSummary, PainFloodStage, PainFloodScenarioName, PainFloodSimulationOptions, PainFloodScenarioExpectation } from './pain-flood-simulation.js';

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
// Legacy RuleHost contract dependency scanner (2026-08-19) — shared
// detection for runtime load backstops and upgrade preflights.
export type { LegacyRuleContractSymbol, LegacyRuleContractRuleSource, LegacyRuleContractFinding } from './internalization/legacy-rule-contract-scanner.js';
export { scanLegacyRuleContractDependencies, formatLegacyRuleContractRemediation } from './internalization/legacy-rule-contract-scanner.js';
// Correction proposal (PRI-114)
export type { CorrectionProposal, CorrectionProposalValidationResult, PathValidationResult } from './internalization/correction-proposal.js';
export { validateProposedParams, validateCorrectionProposal, isPathWithinWorkspace, validateProposedPathBounds } from './internalization/correction-proposal.js';

// RuleHost input builder pure helpers (PRI-482 Phase 3: re-exported so the
// openclaw-plugin assembler can normalise historical tool-call paths using the
// same pure logic as buildRuleHostAction, avoiding production/replay drift.)
export type { ExtractFilePathOptions, BuildRuleHostActionOptions } from './internalization/rule-host-input-builder.js';
export { normalizePathPure, extractFilePathFromParams, buildRuleHostAction } from './internalization/rule-host-input-builder.js';

// RuleContext v2 — Phase 1 Core ABI (PRI-480): pure-logic types + canonicalize +
// validators + behavior-facts computation + the frozen unavailable sentinel.
// Zero I/O; gates nothing in production yet (the flag from PRI-479 is still off).
export type {
  CanonicalKind,
  EvidenceState,
  RuleToolOutcome,
  RuleHistoryStatus,
  RuleToolCallRecord,
  RuleHistoryWindow,
  RuleBehaviorFacts,
  RuleContextV2,
  ValidationResult as RuleContextValidationResult,
} from './internalization/rule-context-v2.js';
export {
  UNAVAILABLE_RULE_CONTEXT,
  canonicalizeToolKind,
  validateRuleToolCallRecord,
  validateRuleHistoryWindow,
  validateRuleBehaviorFacts,
  validateRuleContextV2,
  computeBehaviorFacts,
} from './internalization/rule-context-v2.js';

// BehaviorExamplePack (PRI-484 — Phase 5 Artificer)
export type { BehaviorExamplePack, BehaviorExamplePackValidationResult } from './internalization/behavior-example-pack.js';
export { validateBehaviorExamplePack } from './internalization/behavior-example-pack.js';

// Internalization route model (PRI-43)
export type { InternalizationRouteKind, InternalizationRouteDecision } from './internalization/internalization-route.js';
export { decideInternalizationRoute } from './internalization/internalization-route.js';

// Principle compiler core contracts (PRI-44)
export type { PainPattern } from './internalization/template-generator.js';
export { generateFromTemplate } from './internalization/template-generator.js';
export type { ValidationResult } from './internalization/rule-code-validator.js';
export { checkForbiddenPatterns, checkReturnStatementsMissingFields, checkMatchedFalseDecisions } from './internalization/rule-code-validator.js';
export type { CompileResult } from './internalization/compile-result.js';

// Pruning mask — builds masked principle set from review log (PRI-48)
export { buildMaskedPrincipleSet, getCachedMaskedPrincipleSet, clearPruningMaskCache } from './pruning-mask.js';

// L1 Hard Cap & LRU Eviction (PRI-139)
export { enforceL1HardCap, validateL1CapConfig, DEFAULT_L1_HARD_CAP, MAX_L1_HARD_CAP } from './l1-hard-cap.js';
export type { L1CapConfig, L1EvictionCandidate, L1EvictionResult } from './l1-hard-cap.js';

// Decision merge and adapter interface (PRI-45)
export type { DecisionMergeLogger, RuleHostLogger } from './internalization/rule-host-evaluator.js';
export { mergeDecisions } from './internalization/rule-host-evaluator.js';
// RuleHost result validator (PRI-437)
export type { RuleHostResultValidationResult } from './internalization/rule-host-validator.js';
export { validateRuleHostResult } from './internalization/rule-host-validator.js';
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
  PrincipleDependency,
  PrincipleValueMetrics,
  PrincipleEventType,
  PrincipleLifecycleEvent,
  PrincipleTreeStore,
} from './types/index.js';

// Migrated types & schemas (PRI-213)
export type {
  TypeboxPainSeverity as PainSeverity,
  PainSignal,
  PainSignalValidationResult,
  PDTaskSchedule,
  PDTaskExecution,
  PDTaskDelivery,
  PDTaskMeta,
  PDTaskSpec,
  EvidenceChainState,
  EvidenceChainRecord,
  EvidenceChainResponse,
} from './types/index.js';

export {
  PainSeveritySchema,
  PainSignalSchema,
  deriveSeverity,
  validatePainSignal,
  PDTaskScheduleSchema,
  PDTaskExecutionSchema,
  PDTaskDeliverySchema,
  PDTaskMetaSchema,
  PDTaskSpecSchema,
  BUILTIN_PD_TASKS,
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
// PRI-443 Phase 5: import from pure types module, not the I/O module
export type { LedgerTreeStore } from './types/ledger-store.js';

// ── Internalization Peer Runner Contracts (PRI-61) ─────────────────────────

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
} from './internalization/peer-runner-contracts.js';

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
} from './internalization/peer-runner-contracts.js';

// ── Internalization Job Graph (PRI-61) ─────────────────────────────────────

export {
  ALLOWED_EDGES,
  DIAGNOSTICIAN_EDGES,
  validateEdge,
  validateDiagEdge,
  getDiagSuccessors,
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
  isUnresolvable,
  recordRejection,
  isRetryWaitBackoffElapsed,
  DEFAULT_UNRESOLVABLE_THRESHOLD,
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

// ── Internalization Transition Decision (P0-D, INV-02/INV-07) ────────────────

export type {
  InternalizationTransitionDecisionKind,
  TransitionDecision,
  TransitionDecisionInput,
} from './internalization/internalization-transition-decision.js';
export {
  decideInternalizationTransition,
  transitionInputFromTask,
} from './internalization/internalization-transition-decision.js';

// ── PITask Persistence & Hydration (PRI-65) ──────────────────────────────────

export type {
  PITaskMetadata,
  RunnerDecision,
  RolloutRevisionPayload,
  HumanReviewContext,
  OwnerResolutionRecord,
  OwnerResolutionAction,
  OwnerResolutionStatus,
} from './internalization/pitask-metadata.js';

export {
  PI_METADATA_KEY,
  serializePITaskMetadata,
  parsePITaskMetadata,
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
  mergePITaskMetadata,
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

// Golden fixtures (PRI-385)
export type { FixtureDataSet } from './internalization/golden-dogfood-fixtures.js';
export { GOLDEN_FIXTURES } from './internalization/golden-dogfood-fixtures.js';

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

// ── Base Peer Runner (PRI-302) ───────────────────────────────────────────────

export { BasePeerRunner } from './runner/base-peer-runner.js';

export type {
  PeerRunnerOptions,
  ResolvedPeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerConfig,
  PeerRunnerResult,
  PeerRunnerResultStatus,
  PeerRunnerValidationResult,
  FailureContext,
  ValidationErrorContext,
} from './runner/peer-runner-types.js';

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
  ArtificerRuleOutput,
  ArtificerSourceTrace,
  ArtificerValidationResult,
  ArtificerValidator,
  GoldenTraceCaseInput,
} from './internalization/artificer-output.js';

export {
  DefaultArtificerValidator,
  ArtificerRuleOutputSchema,
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
  EvaluatorOutputV2,
  EvaluatorValidationResult,
  EvaluatorValidator,
  EvaluatorCodeReview,
  EvaluatorAdversarialResult,
  AdversarialCase,
  AdversarialFailedCase,
  AdversarialAttackType,
} from './internalization/evaluator-output.js';

export {
  DefaultEvaluatorValidator,
  EvaluatorOutputV1Schema,
  EvaluatorEvaluationSchema,
  EvaluatorSourceTraceSchema,
  EVALUATOR_DECISIONS,
  isEvaluatorOutputV2,
} from './internalization/evaluator-output.js';

export type {
  EvaluatorRunnerResultStatus,
  EvaluatorRunnerResult,
  EvaluatorRunnerOptions,
  ResolvedEvaluatorRunnerOptions,
  EvaluatorRunnerDeps,
  // PRI-510: re-export so the CLI plugin layer can reference the seeder contract
  // without importing the runner source file directly (EP-02: production path
  // wiring must use the barrel, not deep imports).
  SeedArtificerRepairParams,
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
  RolloutAutoDispatchInput,
  RolloutAutoDispatchOutcome,
  RolloutRevisionRoutingInput,
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
export { SqlitePIArtifactStore } from './store/artifact/sqlite-pi-artifact-store.js';

// ── L2 Agent Loop Adapter (PRI-419) ──────────────────────────────────────────

export { L2AgentLoopAdapter } from './adapter/l2-agent-loop-adapter.js';
export type { L2AgentLoopAdapterConfig, L2AgentLoopAdapterDeps } from './adapter/l2-agent-loop-adapter.js';

// ── L2 Agent Loop Tools (PRI-419) ─────────────────────────────────────────────

export {
  buildDreamerL2Tools,
  DREAMER_L2_TOOL_WHITELIST,
} from './tools/agent-tool-contract.js';
export type {
  PdL2ToolContext,
  PdL2ArtifactReader,
  PdL2PrincipleReader,
  L2OutputCapture,
} from './tools/agent-tool-contract.js';
export { DreamerOutputV1Typebox, DreamerCandidateTypebox } from './tools/dreamer-output-typebox.js';

// ── Artificer L2 Agent Loop Tools (PRI-439 Phase 4) ────────────────────────────
//
// TypeBox redeclaration of ArtificerRuleOutput for pi-agent-core tool parameter
// schemas, plus the 4-tool contract (read_rulecode_spec, validate_rulecode,
// replay_rulecode, submit_rulecode) used by ArtificerL2Adapter.

export {
  ArtificerRuleOutputTypebox,
  ArtificerSourceTraceTypebox,
  GoldenTraceCaseInputTypebox,
} from './tools/artificer-output-typebox.js';

export {
  buildArtificerL2Tools,
  ARTIFICER_L2_TOOL_WHITELIST,
  RULECODE_SPEC_TEXT,
} from './tools/artificer-l2-tool-contract.js';
export type {
  ArtificerL2ToolContext,
  ArtificerL2OutputCapture,
} from './tools/artificer-l2-tool-contract.js';

// ── L2 Principle Reader (PRI-431) ─────────────────────────────────────────────
// Only export the pure-logic entry point from the core barrel.
// buildL2PrincipleReader() performs file I/O and is imported directly
// from the module by pd-cli/openclaw-plugin — NOT re-exported here.

export { buildL2PrincipleReaderFromLedger } from './build-l2-principle-reader.js';
export type { BuildL2PrincipleReaderOptions } from './build-l2-principle-reader.js';

// ── Intake To Internalization Bridge (PRI-142) ────────────────────────────────

export type {
  IntakeToInternalizationBridgeInput,
  BridgeDecision,
  BridgeTaskSeed,
  BridgeTaskStore,
} from './internalization/intake-to-internalization-bridge.js';

export {
  ROUTE_CHANNEL_MAP,
  CANDIDATE_KIND_TO_ROUTE,
  MVP_ENABLED_CHANNELS,
  computeBridgeDecision,
  buildDreamerTaskSeed,
  buildDreamerSeedFromCandidate,
  seedIntakeTask,
} from './internalization/intake-to-internalization-bridge.js';

// ── Internalization Queue Read Model (PRI-73) ──────────────────────────────

export { InternalizationQueueReadModel, createInternalizationQueueReadModel } from './internalization-queue-read-model.js';
export type {
  InternalizationQueueSnapshot,
  NoReadyTasksDiagnosis,
  QueueNoReadyTasksReason,
  ReadyTask,
  BlockedSample,
  DependencyFailedSample,
  RetryWaitPendingSample,
  LeaseConflictSample,
  UnresolvableSample,
  InternalizationQueueReadModelHandle,
  CreateQueueReadModelOptions,
} from './internalization-queue-read-model.js';

// ── Queue Actionability Policy (PRI-253) ─────────────────────────────────────

export { classifyTaskActionability, MVP_CORE_TASK_KINDS } from './internalization/queue-actionability.js';
export type {
  ActionabilityPolicyInput,
  SuppressedDiagnostic,
  TaskActionabilityResult,
  TaskClassificationInput,
} from './internalization/queue-actionability.js';

// ── Internalization Consumer Decision (PRI-381) ────────────────────────────

export {
  computeConsumerDecision,
  DEFAULT_CONSUMER_MAX_TASKS_PER_CYCLE,
  DEFAULT_CONSUMER_RUNNER_KINDS,
  FULL_CHAIN_CONSUMER_RUNNER_KINDS,
} from './internalization/internalization-consumer-decision.js';
export type {
  ConsumerDecision,
  ConsumerDecisionInput,
} from './internalization/internalization-consumer-decision.js';

// ── Recovery Sweep Service (PRI-149 Tier 2) ────────────────────────────────

export { createRecoverySweepService } from './recovery-sweep-service.js';
export type { RecoverySweepService, RecoverySweepServiceHandle, FailedTaskRecoveryInfo, FailedTaskRecoveryResult } from './recovery-sweep-service.js';

// Owner authority reset for needs_human_review tasks (shared by CLI retry and
// Console recovery — Governance Recovery Actions v1)
export { ownerRetryNeedsHumanReviewTask } from './internalization/owner-retry.js';
export type { OwnerRetryOutcome } from './internalization/owner-retry.js';
// PRI-629 unified Owner Decision (Console/CLI/Runner 共用策略层)
export {
  HUMAN_REVIEW_REASON,
  DECISION_CAPABLE_HUMAN_REVIEW_REASONS,
  LEGACY_EVALUATOR_BUDGET_EXHAUSTED,
  LEGACY_ROLLOUT_BUDGET_EXHAUSTED,
  buildOwnerReviewKey,
  collectOwnerDecisionFacts,
  computeArtifactContentHash,
  decisionArtifactIdFor,
  deriveOwnerDecisionCapability,
  resolveEffectiveRunnerDecision,
  findOwnerResolutionForCurrentEpoch,
  findAppliedVerdictOverrideResolution,
  planOwnerVerdictOverrideResume,
  markOwnerResolutionApplied,
  canonicalHumanReviewReasonCode,
  detectHardGateFailureFromArtifact,
  effectiveDecisionFor,
} from './internalization/owner-review.js';
export type {
  HumanReviewAttention,
  OwnerDecisionCapability,
  OwnerDecisionFactStore,
  OwnerDecisionFacts,
  DecisionArtifactRecord,
  DecisionArtifactFacts,
  ReviewKeyFacts,
  OwnerOverrideResumePlan,
} from './internalization/owner-review.js';
export {
  applyOwnerResolution,
  factStoreFromStateManager,
  sanitizeOwnerInstruction,
} from './internalization/owner-resolution-service.js';
export type {
  OwnerResolutionApplyDeps,
  OwnerResolutionRequest,
  OwnerResolutionOutcome,
  OwnerIdentityContext,
} from './internalization/owner-resolution-service.js';
export { reopenTaskForRevision, resolveRolloutRevisionTarget, buildRepairRevisionCauseId } from './internalization/revision-reopen.js';
export type { ReopenRevisionOptions, RolloutRevisionTarget } from './internalization/revision-reopen.js';

// ── RuntimeStateHandle (PRI-198) ────────────────────────────────────────────

export { createRuntimeStateHandle } from './runtime-state-handle.js';
export type { RuntimeStateHandle } from './runtime-state-handle.js';

// ── Activation Dispatcher (PRI-144) ──────────────────────────────────────

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
  ActivationDecisionRecord,
  ActivationDecisionSubject,
  ActivationDecisionKind,
  ActivationControlState,
  GlobalRuleCodePause,
  PromotionEvidenceSnapshot,
  PromotionFailedCheck,
  PromotionReadinessResult,
  OwnerPromotionActor,
  OwnerPromotionRequest,
  PromotionCommitInput,
  OwnerPromotionResult,
  RuleCodeOwnerDecisionServiceDeps,
  PromotionCheckId,
  PromotionReadinessCheck,
  PromotionReadinessEvaluationInput,
  PromotionReadinessReaderDeps,
  RuleCodeSafetySample,
  RuleCodeSafetyCircuitState,
  RuleCodeSafetyTripReason,
  HostLivenessContract,
  WriterInput,
  WriterResult,
  CanActivateResult,
  ChannelWriter,
  ApprovalStatus,
  ApprovalRecord,
  ApprovalEnqueueInput,
  ApprovalFilter,
  ApprovalDecisionResult,
  ApprovalQueueStore,
  ApprovalListFilter,
  ApprovalStats,
  ApprovalListResult,
  ArtifactLineageIdentity,
  ApprovalWithContext,
  ConfidenceLabel,
  BuildPromotionEvidenceSnapshotInput,
  PromotionEvidenceOwnerIdentity,
} from './activation/index.js';

export {
  LOW_RISK_CHANNELS,
  isArtifactRevisionOf,
  HIGH_RISK_CHANNEL_MAP,
  makeIdempotencyKey,
  isLowRiskChannel,
  getChannelRiskLevel,
  ActivationDispatcher,
  PromptWriter,
  DeferArchiveWriter,
  RuleHostWriter,
  extractEvidenceRefs,
  extractPrincipleId,
  MemoryActivationStateStore,
  MemoryArtifactReadModel,
  SqliteActivationStateStore,
  SqliteActivationSafetyStore,
  RuleCodeOwnerDecisionService,
  REQUIRED_PROMOTION_CHECK_IDS,
  evaluateRuleCodePromotionReadiness,
  PromotionReadinessReader,
  evaluateRuleCodeSafetyCircuit,
  initialRuleCodeSafetyCircuitState,
  collectOpenClawPromotionChecks,
  summarizeRuleCodeShadowEvents,
  AUTO_PROMOTION_CONFIDENCE_THRESHOLD,
  AUTO_PROMOTABLE_CHANNELS,
  ApprovalQueue,
  decideAutoPromotion,
  MemoryApprovalQueueStore,
  SqliteApprovalQueueStore,
  mapConfidenceToLabel,
  RUNTIME_V2_PRINCIPLE_BUDGET,
  isArtifactRecord,
  filterPromptActivations,
  resolvePrincipleFromArtifact,
  trimToBudget,
  renderPrinciplesToDirectives,
  createProductionGateDeps,
  ApprovalCompletionService,
  buildPromotionEvidenceSnapshot,
  computeArtifactDigest,
  normalizeOwnerIdentity,
} from './activation/index.js';

export type {
  ActivatedPrinciple,
  PromptActivationReaderResult,
  ApprovalCompletionInput,
  ApprovalCompletionResult,
} from './activation/index.js';

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
// Activation compatibility read model (2026-08-19) — upgrade preflight /
// operator scan over active code_tool_hook RuleCode.
export { ActivationCompatibilityReadModel } from './activation-compatibility-read-model.js';
export type { ActivationCompatibilityScanResult } from './activation-compatibility-read-model.js';

// ── Internalization Chain Integrity Read Model (PRI-97) ─────────────────────

export { InternalizationChainIntegrityReadModel, extractPIMetadata } from './internalization-chain-integrity-read-model.js';
export type { BrokenLink, ChainIntegrityResult, InternalizationChainIntegrityReadModelOptions, PIMetadataParseResult } from './internalization-chain-integrity-read-model.js';

export { InternalizationIntegrityRemediation } from './internalization-integrity-remediation.js';
export type { InternalizationIntegrityRemediationOptions } from './internalization-integrity-remediation.js';

// ── Mainline Contract (Runtime Mainline Convergence — single source of truth) ──
export { assertMainlineContract, EMPTY_CONTEXT_SENTINEL } from './mainline-contract.js';
export type {
  MainlineStage,
  StageStatus,
  StageVerdict,
  MainlineVerdict,
  ArtifactRefSnapshot,
  RuntimeReadinessSnapshot,
  DiagnosisTaskSnapshot,
  DiagnosticianArtifactSnapshot,
  CandidateSnapshot,
  DreamerTaskSnapshot,
  DreamerContextSnapshot,
  SuccessorSnapshot,
  OwnerReviewablePrincipleSnapshot,
  MainlineChainSnapshot,
  MainlineSnapshot,
} from './mainline-contract.js';

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
  buildGoldenTraceFromArtificer,
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
  BuildGoldenTraceFromArtificerInput,
  BuildGoldenTraceResult,
} from './golden-trace.js';
// ── GoldenTrace Replay Validator (PRI-115) ────────────────────────────────

export {
  replayGoldenTrace,
  diffParams,
  DEFAULT_REPLAY_VALIDATOR_CONFIG,
} from './golden-trace-replay-validator.js';

export type {
  ReplayValidatorCaseResult,
  ReplayValidatorResult,
  ReplayValidatorConfig,
  ReplayEvaluateFn,
} from './golden-trace-replay-validator.js';

export {
  replayValidateCode,
} from './golden-trace-replay-adapter.js';

// ── Evolution Types (migrated from openclaw-plugin) ────────────────────────

export {
  EvolutionTier,
  TIER_DEFINITIONS,
  getTierDefinition,
  getTierByPoints,
  TASK_DIFFICULTY_CONFIG,
  DEFAULT_EVOLUTION_CONFIG,
  isCompleteDetectorMetadata,
  EvolutionTierSchema,
  TierPermissionsSchema,
  TierDefinitionSchema,
  TaskDifficultySchema,
  TaskDifficultyConfigSchema,
  EvolutionEventTypeSchema,
  EvolutionEventSchema,
  EvolutionStatsSchema,
  RecentFailureHashEntrySchema,
  EvolutionScorecardSchema,
  EvolutionStorageSchema,
  EvolutionConfigSchema,
  ArchivedEventStatsSchema,
  GateDecisionSchema,
  ToolCallContextSchema,
  TierPromotionEventSchema,
  EvolutionPrincipleStatusSchema,
  PrincipleEvaluatorLevelSchema,
  EvaluabilitySchema,
  PrincipleDetectorSpecSchema,
  EvolutionPrincipleSuggestedRuleSchema,
  EvolutionPrincipleValueMetricsSnapshotSchema,
  EvolutionPrincipleSchema,
  EvolutionLoopEventTypeSchema,
  EvolutionPainDetectedDataSchema,
  CandidateCreatedDataSchema,
  PrinciplePromotedDataSchema,
  PrincipleDeprecatedDataSchema,
  PrincipleRolledBackDataSchema,
  CircuitBreakerOpenedDataSchema,
  LegacyImportDataSchema,
  EvolutionLoopEventSchema,
} from './evolution/evolution-types.js';

export type {
  TierPermissions,
  TierDefinition,
  TaskDifficulty,
  TaskDifficultyConfig,
  EvolutionEventType,
  EvolutionEvent,
  EvolutionScorecard,
  RecentFailureHashEntry,
  EvolutionStats,
  EvolutionStorage,
  EvolutionConfig,
  ArchivedEventStats,
  GateDecision,
  ToolCallContext,
  TierPromotionEvent,
  EvolutionPrincipleStatus,
  PrincipleEvaluatorLevel,
  Evaluability,
  PrincipleDetectorSpec,
  EvolutionPrinciple,
  EvolutionPrincipleSuggestedRule,
  EvolutionPrincipleValueMetricsSnapshot,
  EvolutionLoopEventType,
  EvolutionPainDetectedData,
  CandidateCreatedData,
  PrinciplePromotedData,
  PrincipleDeprecatedData,
  PrincipleRolledBackData,
  CircuitBreakerOpenedData,
  LegacyImportData,
  EvolutionLoopEvent,
} from './evolution/evolution-types.js';

export type {
  ReplayCodeInput,
  SandboxEvaluateLoader,
} from './golden-trace-replay-adapter.js';

// ── Refiner Sandbox Wrapper (PRI-172) ────────────────────────────────────

export {
  evaluateInRefinerSandbox,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from './internalization/refiner-sandbox-wrapper.js';

export type {
  RefinerSandboxErrorType,
  RefinerSandboxFailedCase,
  RefinerSandboxResult,
  RefinerSandboxOptions,
  RefinerSandboxDependencies,
} from './internalization/refiner-sandbox-wrapper.js';

// ── Refiner RuleHost Gate (PRI-173) ──────────────────────────────────────

export {
  evaluateRefinerRuleHostGate,
} from './internalization/refiner-rulehost-gate.js';

export type {
  RefinerRuleHostGateDecision,
  RefinerRuleHostGateInput,
  RefinerRuleHostGateResult,
  RefinerRuleHostGateDeps,
} from './internalization/refiner-rulehost-gate.js';

// ── Correction Cue Keyword Types (migrated from openclaw-plugin) ──────────

export {
  MAX_CORRECTION_KEYWORDS,
  CORRECTION_SEED_KEYWORDS,
  CorrectionKeywordSchema,
  CorrectionKeywordStoreSchema,
  CorrectionMatchResultSchema,
} from './correction/correction-types.js';

export type {
  CorrectionKeyword,
  CorrectionKeywordStore,
  CorrectionMatchResult,
} from './correction/correction-types.js';

// ── Queue, Hygiene, Runtime Summary, Event Types (migrated from openclaw-plugin) ──

export type {
  Brand,
  QueueItemId,
  WorkflowId,
  SessionKey,
} from './types/queue-types.js';

export {
  toQueueItemId,
  toWorkflowId,
  toSessionKey,
  isQueueItemId,
  isWorkflowId,
  isSessionKey,
} from './types/queue-types.js';

export type {
  PersistenceAction,
  HygieneStats,
} from './types/hygiene-types.js';

export {
  createEmptyHygieneStats,
} from './types/hygiene-types.js';

export type {
  RuntimeTruth,
  AnalyticsTruth,
  TrendMetrics,
} from './types/runtime-summary-types.js';

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
  ToolCallStats,
  ErrorStats,
  // PainStats export removed (PRI-451 Wave 1.5): no live reader.
  EmpathyEventStats,
  GfiStats,
  EventEvolutionStats,
  HookStats,
  DailyStats,
} from './types/event-types.js';

export {
  createEmptyDailyStats,
} from './types/event-types.js';

export type {
  EventLogEntry as DiscriminatedEventLogEntry,
} from './types/event-payload.js';

export {
  isToolCallEventEntry,
  isPainSignalEventEntry,
  isRulePromotionEventEntry,
  isGovernanceActionEventEntry,
  isHookExecutionEventEntry,
  isGateBlockEventEntry,
  isGateBypassEventEntry,
  isEvolutionTaskEventEntry,
  isEmpathyRollbackEventEntry,
} from './types/event-payload.js';

// ── Empathy and Correction Observers (Unified SDK Migration) ──
export {
  EmpathyObserverInputSchema,
  EmpathyObserverOutputV1Schema,
  EmpathyObserver,
} from './observer/empathy-observer.js';
export type {
  EmpathyObserverInput,
  EmpathyObserverOutputV1,
  EmpathyObserverDeps,
  EmpathyObserverOptions,
} from './observer/empathy-observer.js';

export {
  CorrectionObserverPayloadSchema,
  CorrectionObserverOutputV1Schema,
  CorrectionObserver,
} from './observer/correction-observer.js';
export type {
  CorrectionObserverPayload,
  CorrectionObserverOutputV1,
  CorrectionObserverDeps,
  CorrectionObserverOptions,
} from './observer/correction-observer.js';

export {
  AgentScheduler,
} from './observer/agent-scheduler.js';
export type {
  AgentTypeMap,
  AgentScheduleMode,
  ScheduledAgent,
} from './observer/agent-scheduler.js';

export { WorkflowFunnelLoader } from '../workflow-funnel-loader.js';

// ── Feedback Report Contract (PRI-285) ──────────────────────────────────────
//
// Pure logic only. No I/O, no fs, no process, no db, no network, no openclaw-plugin
// imports. Server (pd-console) wraps this contract and adds draft storage under
// <workspace>/.pd/feedback/drafts/. No automatic upload — agents and users must
// copy or open the generated URL themselves.
export {
  isFeedbackType,
  isUserSeverity,
  isFeedbackSource,
  isFeedbackFrequency,
  isFeedbackBlockingLevel,
  isFeedbackStatus,
  isFeedbackSubmittedVia,
  isRecord,
  isBoolean,
  normalizeFeedbackDraftInput,
  computeFeedbackFingerprint,
  normalizeFeedbackTitle,
  FEEDBACK_FINGERPRINT_DEFAULT_AREA,
  FEEDBACK_FINGERPRINT_TITLE_LIMIT,
  redactAbsolutePaths,
  redactTokenLikeValues,
  redactEnvLikeValues,
  redactStackTrace,
  redactSensitiveFields,
  redactTelemetryString,
  REDACTED_PATH,
  REDACTED_VALUE,
  NO_STACK,
  renderReportMarkdown,
  MAX_MARKDOWN_LENGTH,
  buildGitHubIssueDraftUrl,
  MAX_URL_BODY_LENGTH,
  GITHUB_REPO,
  buildPrivacyPreview,
  buildEmailText,
  DEFAULT_INCLUDED_SECTIONS,
  DEFAULT_EXCLUDED_CATEGORIES,
  createFeedbackReport,
  safeStringifyPreview,
} from './feedback/index.js';

// ── PD-Owned Config Contract (PRI-304) ──────────────────────────────────────
//
// Pure types, validation, defaults, effective config, redaction, and feature
// flag computation for `.pd/config.yaml`. No I/O — YAML loading lives in
// pd-cli / openclaw-plugin. ADR-0016: PD owns exactly one user config file.

export {
  PD_CONFIG_VERSION,
  VALID_FEATURE_CATEGORIES,
  VALID_PROFILE_TYPES,
  INTERNAL_AGENT_NAMES,
  VALID_DIAGNOSTICS_MODES,
  DANGEROUS_KEYS as PD_CONFIG_DANGEROUS_KEYS,
  validatePdConfig,
  DEFAULT_FEATURE_FLAGS as PD_DEFAULT_FEATURE_FLAGS,
  DEFAULT_RUNTIME_PROFILE_ID,
  DEFAULT_RUNTIME_PROFILE,
  DEFAULT_UI as PD_DEFAULT_UI,
  getDefaultInternalAgents,
  getDefaultPdConfig,
  computeEffectivePdConfig,
  redactPdConfig,
  redactConfigValue,
  MVP_CHANNEL_IDS,
  computeFeatureFlagsFromConfig,
  isFeatureEnabled,
  getEnabledFlagIds,
} from './config/index.js';

// Agent runtime binding — PRI-306
export {
  resolveAgentRuntimeBinding,
  checkAgentRuntimeReadiness,
  createAdapterConfigFromProfile,
} from './config/index.js';

export type {
  AgentRuntimeBindingOk,
  AgentRuntimeBindingErr,
  AgentRuntimeBindingResult,
  AgentRuntimeReadinessResult,
  PiAiAdapterConfigResult,
  OpenClawAdapterConfigResult,
  AdapterConfigResult,
} from './config/index.js';

export type {
  PdConfigVersion,
  FeatureCategory,
  FeatureFlagEntry,
  RuntimeProfileType,
  OpenClawRuntimeProfile,
  PdLocalRuntimeProfile,
  RuntimeProfile,
  InternalAgentName,
  InternalAgentBinding,
  InternalAgentsConfig,
  DiagnosticsMode,
  UiConfig,
  PdConfig,
  PdConfigValidationError,
  PdConfigValidationResultOk,
  PdConfigValidationResultErr,
  PdConfigValidationResult,
  EffectivePdConfig,
  RedactedRuntimeProfileSummary,
  RedactedAgentSummary,
  RedactedFeatureSummary,
  RedactedPdConfigSummary,
  EffectiveFeatureFlag,
  FeatureFlagsResult,
} from './config/index.js';
export type {
  FeedbackType,
  UserSeverity,
  FeedbackFrequency,
  FeedbackBlockingLevel,
  FeedbackStatus,
  FeedbackSubmittedVia,
  FeedbackSource,
  FeedbackContext,
  AgentDraft,
  FeedbackUserText,
  FeedbackDraftInput,
  NormalizedDraft,
  RecentEvent,
  CanaryStatus,
  DiagnosticSummary,
  ContextRef,
  PrivacyPreview,
  FeedbackReport,
  ValidationError,
  NormalizeResult,
  RedactResult,
  GithubUrlResult,
  CreateReportResult,
} from './feedback/index.js';

// Evidence triage — PEAT-B1 + B2
export type {
  SourceKind,
  TriageDecision,
  TriageResult,
  TriageInput,
  SourceDescriptor,
  RawObservation,
  TriggerOutcome,
  TriggerDecision,
  TriggerControllerInput,
  AdmissionDecisionEvent,
  DiagnosisTaskCreatedEvent,
  EvidenceOnlyRecordedEvent,
  SkippedRefusedEvent,
  AdmissionEvent,
} from './evidence-triage/index.js';
export {
  isSourceKind,
  SOURCE_DESCRIPTORS,
  getSourceDescriptor,
  evaluateTriage,
  RISKY_HIGH_SCORE_THRESHOLD,
  REPEATED_FAILURE_THRESHOLD,
  resolveSourceKind,
  buildToolFailureObservation,
  buildLlmDetectionObservation,
  buildEmpathyObservation,
  buildManualPainObservation,
  evaluateTriggerController,
  shouldCreateTask,
  isAdmittedOutcome,
  isSkippedOutcome,
  createAdmissionDecisionEvent,
  createDiagnosisTaskCreatedEvent,
  createEvidenceOnlyRecordedEvent,
  createSkippedRefusedEvent,
  serializeAdmissionEvent,
  validateEventPrivacy,
} from './evidence-triage/index.js';

// Pain diagnostic gate — PRI-446 (pure decision logic migrated from plugin)
export type {
  PainDiagnosticSource,
  PainDiagnosticGateReason,
  PainDiagnosticGateInput,
  PainDiagnosticGateDecision,
  CooldownCheckInput,
} from './pain-gate/index.js';
export {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_PAIN_TRIGGER,
  DEFAULT_HIGH_SEVERITY,
  DEFAULT_REPEATED_FAILURE,
  DEFAULT_SEMANTIC_PAIN_FLOOR,
  normalizedSource,
  buildEpisodeKey,
  evaluatePainDiagnosticGateDecision,
  isCooldownActive,
} from './pain-gate/index.js';

// Detection funnel — PRI-446 (pure logic migrated from plugin)
export type {
  DetectionResult,
  PainMatchResult,
  PainMatcher,
  TextHasher,
  ProtocolTokenGate,
  DetectionFunnelConfig,
} from './detection/index.js';
export { SimpleLRU, DetectionFunnelCore } from './detection/index.js';


// Intent Engineering MVP (PRI-465 / PRI-466 / PRI-467 / PRI-468) — pure logic:
// parser, hasher, validator, the bounded+escaped friction block builder, and
// the IntentDocReader port interface (core-owned, plugin-implemented).
export {
  INTENT_MAX_BYTES,
  INTENT_DOC_TEMPLATE,
  INTENT_DOC_TEMPLATE_ZH,
  INTENT_DOC_TEMPLATE_EN,
  INTENT_INJECT_MAX_CHARS,
  INTENT_TRUNCATION_MARKER,
  getIntentFilename,
  createIntentTemplate,
  parseIntentDocSections,
  assembleIntentDoc,
  computeIntentContentHash,
  validateIntentDocSections,
  buildIntentFrictionBlock,
  NullIntentDocReader,
  generateIntentPatchProposal,
  computeVersionDiff,
  formatVersionSummary,
} from './intent/index.js';
export type {
  IntentDocSections,
  IntentDocWarning,
  IntentDocWarningCode,
  IntentFrictionBlockInput,
  IntentDocReader,
  IntentDocReadResult,
  IntentDocReference,
  IntentDocReadReason,
  IntentDecisionRecord,
  IntentDecisionInput,
  IntentDecisionRecordResult,
  IntentDecisionSummary,
  IntentDecisionStore,
  IntentLang,
  IntentDocVersion,
  IntentDocVersionStore,
  FollowUpPatch,
  IntentPatchProposal,
} from './intent/index.js';

// PRI-470: IntentDecisionRecord durable SQLite store (SPEC §21.7).
export { SqliteIntentDecisionStore, SqliteIntentDocVersionStore } from './store/intent/index.js';

// Task 3: Dead letter store for pain signals that failed to be recorded.
export { SqliteDeadLetterStore } from './store/pain/sqlite-dead-letter-store.js';
export type { DeadLetterRow, DeadLetterOpResult } from './store/pain/sqlite-dead-letter-store.js';

// Task 11: PendingAgentDraftStore — durable store for agent-generated draft
// context attached to a failed peer-runner task. The feedback-report pipeline
// (Task 13) reads the unconsumed draft for a given taskId and merges it into
// the user-facing FeedbackReport so the maintainer sees the agent's
// perspective. See feedback/pending-agent-draft-store.ts for the full
// idempotency + fail-loud contract.
export { PendingAgentDraftStore } from './feedback/pending-agent-draft-store.js';
export type {
  AgentDraftPayload,
  PendingAgentDraftRow,
  PendingDraftOpResult,
} from './feedback/pending-agent-draft-store.js';

// Risk calculator — pure line-change estimation migrated from plugin (Stage 3)
export type { FileModification } from './risk/index.js';
export { estimateLineChanges } from './risk/index.js';

// Thinking models policy (BUILTIN_PATTERNS detection regexes) was retired
// 2026-08-19 with the Thinking Activity telemetry writer — its only remaining
// consumers were tests and dead re-exports. The Core Principle Registry
// (T-01..T-10) in core-principles/ and the THINKING_OS.md guidance templates
// are current product and remain.

export type {
  TrajectoryTurnReader,
  TrajectoryUserTurn,
  TrajectoryAssistantTurn,
} from './store/context/trajectory-turn-reader.js';

// SignalCollector — 统一信号采集层 (correction + empathy 上游融合)
export {
  scanKeywords,
  buildLlmPrompt,
  parseLlmClassification,
  resolveLlmClassificationPayload,
  SignalClassificationOutputV1Schema,
  collectSync,
  mapLlmResultToOutput,
  buildEvidence,
} from './signal-collector/index.js';
export type {
  KeywordCategory,
  TermSource,
  UnifiedKeyword,
  UnifiedKeywordStore,
  PendingTerm,
  PendingTermStore,
  SignalCollectorConfig,
  SignalStrength,
  DetectionSource,
  MatchedPrecision,
  SignalEvidence,
  SignalCollectorOutput,
  LlmClassificationResult,
  KeywordScanResult,
  ParseResult,
  PayloadResolveResult,
  ClassifierPayloadPath,
  SignalClassificationOutputV1,
} from './signal-collector/index.js';
