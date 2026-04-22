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

// Error categories
export { PD_ERROR_CATEGORIES, PDRuntimeError } from './error-categories.js';
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

// Store
export { SqliteTaskStore } from './store/sqlite-task-store.js';
export { SqliteRunStore } from './store/sqlite-run-store.js';
export { SqliteConnection } from './store/sqlite-connection.js';
export type {
  TaskStore,
  TaskStoreFilter,
  TaskStoreUpdatePatch,
} from './store/task-store.js';
export type {
  RunStore,
  RunRecord,
} from './store/run-store.js';

// Lease & Recovery
export { DefaultLeaseManager } from './store/lease-manager.js';
export type { LeaseManager, AcquireLeaseOptions } from './store/lease-manager.js';
export { DefaultRetryPolicy } from './store/retry-policy.js';
export type { RetryPolicy, RetryPolicyConfig } from './store/retry-policy.js';
export { DefaultRecoverySweep } from './store/recovery-sweep.js';
export type { RecoverySweep, RecoveryResult } from './store/recovery-sweep.js';

// Event emitter
export { StoreEventEmitter, storeEmitter } from './store/event-emitter.js';
export type { TelemetryEvent } from '../telemetry-event.js';

// Runtime integration layer
export { RuntimeStateManager } from './store/runtime-state-manager.js';
export type { RuntimeStateManagerOptions } from './store/runtime-state-manager.js';

// Migration bridge
export { EvolutionQueueItemMigrator } from './store/task-migration.js';
