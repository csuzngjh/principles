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
export { RUNTIME_V2_SCHEMA_VERSION, schemaRef } from './schema-version.js';
export { PDErrorCategorySchema } from './error-categories.js';
export { AgentCapabilityRequirementsSchema, AgentTimeoutPolicySchema, AgentRetryPolicySchema, AgentSpecSchema } from './agent-spec.js';
export { SchemaVersionRefSchema, RuntimeV2SchemaVersionSchema } from './schema-version.js';
export { RuntimeKindSchema, RuntimeCapabilitiesSchema, RuntimeHealthSchema, RunHandleSchema, RunExecutionStatusSchema, RunStatusSchema, ContextItemSchema, AgentSpecRefSchema, WorkflowRefSchema, TaskRefSchema, StartRunInputSchema, StructuredRunOutputSchema, RuntimeArtifactRefSchema } from './runtime-protocol.js';
export { PDTaskStatusSchema, TaskRecordSchema, DiagnosticianTaskRecordSchema } from './task-status.js';
export { RuntimeSelectionCriteriaSchema } from './runtime-selector.js';
export { HistoryQueryEntrySchema, TrajectoryLocateQuerySchema, TrajectoryCandidateSchema, TrajectoryLocateResultSchema, HistoryQueryResultSchema, DiagnosisTargetSchema, ContextPayloadSchema, DiagnosticianContextPayloadSchema } from './context-payload.js';
export { DiagnosticianViolatedPrincipleSchema, DiagnosticianEvidenceSchema, RecommendationKindSchema, DiagnosticianRecommendationSchema, DiagnosticianOutputV1Schema, DiagnosticianInvocationInputSchema } from './diagnostician-output.js';
export { PD_ERROR_CATEGORIES, PDRuntimeError } from './error-categories.js';
export type { PDErrorCategory } from './error-categories.js';
export { isPDErrorCategory } from './error-categories.js';
export { AGENT_IDS } from './agent-spec.js';
export type { AgentSpec, AgentCapabilityRequirements, AgentTimeoutPolicy, AgentRetryPolicy, WellKnownAgentId, } from './agent-spec.js';
export type { RuntimeKind, RuntimeCapabilities, RuntimeHealth, RunHandle, RunExecutionStatus, RunStatus, ContextItem, AgentSpecRef, WorkflowRef, TaskRef, StartRunInput, StructuredRunOutput, RuntimeArtifactRef, PDRuntimeAdapter, } from './runtime-protocol.js';
export type { RuntimeSelector, RuntimeSelectionCriteria, RuntimeSelectionResult, } from './runtime-selector.js';
export type { PDTaskStatus, TaskRecord, DiagnosticianTaskRecord, } from './task-status.js';
export type { HistoryQueryEntry, TrajectoryLocateQuery, TrajectoryCandidate, TrajectoryLocateResult, HistoryQueryResult, DiagnosisTarget, ContextPayload, DiagnosticianContextPayload, } from './context-payload.js';
export type { DiagnosticianOutputV1, DiagnosticianViolatedPrinciple, DiagnosticianEvidence, RecommendationKind, DiagnosticianRecommendation, DiagnosticianInvocationInput, } from './diagnostician-output.js';
export { SqliteTaskStore } from './store/sqlite-task-store.js';
export { SqliteRunStore } from './store/sqlite-run-store.js';
export { SqliteConnection } from './store/sqlite-connection.js';
export { SqliteTrajectoryLocator } from './store/sqlite-trajectory-locator.js';
export { SqliteHistoryQuery } from './store/sqlite-history-query.js';
export { SqliteContextAssembler } from './store/sqlite-context-assembler.js';
export { ResilientContextAssembler } from './store/resilient-context-assembler.js';
export { ResilientHistoryQuery } from './store/resilient-history-query.js';
export type { HistoryQuery, HistoryQueryCursorData, HistoryQueryOptions, } from './store/history-query.js';
export type { ContextAssembler } from './store/context-assembler.js';
export { DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE, DEFAULT_TIME_WINDOW_MS, } from './store/history-query.js';
export type { TaskStore, TaskStoreFilter, TaskStoreUpdatePatch, } from './store/task-store.js';
export type { RunStore, RunRecord, } from './store/run-store.js';
export type { TrajectoryLocator } from './store/trajectory-locator.js';
export { DefaultLeaseManager } from './store/lease-manager.js';
export type { LeaseManager, AcquireLeaseOptions } from './store/lease-manager.js';
export { DefaultRetryPolicy } from './store/retry-policy.js';
export type { RetryPolicy, RetryPolicyConfig } from './store/retry-policy.js';
export { DefaultRecoverySweep } from './store/recovery-sweep.js';
export type { RecoverySweep, RecoveryResult } from './store/recovery-sweep.js';
export { StoreEventEmitter, storeEmitter } from './store/event-emitter.js';
export type { TelemetryEvent } from '../telemetry-event.js';
export { RuntimeStateManager } from './store/runtime-state-manager.js';
export type { RuntimeStateManagerOptions } from './store/runtime-state-manager.js';
export { DiagnosticianRunner } from './runner/diagnostician-runner.js';
export { RunnerPhase } from './runner/runner-phase.js';
export { PassThroughValidator } from './runner/diagnostician-validator.js';
export { resolveRunnerOptions, DEFAULT_RUNNER_OPTIONS } from './runner/diagnostician-runner-options.js';
export type { RunnerResult, RunnerResultStatus } from './runner/runner-result.js';
export type { DiagnosticianRunnerOptions, ResolvedDiagnosticianRunnerOptions } from './runner/diagnostician-runner-options.js';
export type { DiagnosticianValidator, DiagnosticianValidationResult } from './runner/diagnostician-validator.js';
export { TestDoubleRuntimeAdapter } from './adapter/index.js';
export type { TestDoubleBehaviorOverrides } from './adapter/test-double-runtime-adapter.js';
export { run, status } from './cli/diagnose.js';
export type { DiagnoseRunOptions, DiagnoseStatusOptions, DiagnoseStatusResult } from './cli/diagnose.js';
export { EvolutionQueueItemMigrator } from './store/task-migration.js';
//# sourceMappingURL=index.d.ts.map