/**
 * @principles/core -- Universal Evolution SDK
 *
 * Framework-agnostic pain signal capture and principle injection.
 *
 * @example
 * import { PainSignalSchema, validatePainSignal, deriveSeverity } from '@principles/core';
 * import type { PainSignal } from '@principles/core';
 * import type { PainSignalAdapter } from '@principles/core';
 * import type { PrincipleInjector, InjectionContext } from '@principles/core';
 * import { DefaultPrincipleInjector } from '@principles/core';
 */

// PainSignal schema and validation
export { PainSignalSchema, validatePainSignal, deriveSeverity, PainSeverity } from './pain-signal.js';
export type { PainSignal, PainSignalValidationResult } from './pain-signal.js';

// PainSignalAdapter interface
export { PainSignalAdapter } from './pain-signal-adapter.js';

// EvolutionHook interface
export { EvolutionHook, noOpEvolutionHook } from './evolution-hook.js';
export type { PrincipleCreatedEvent, PrinciplePromotedEvent } from './evolution-hook.js';

// TelemetryEvent schema
export { TelemetryEventSchema, validateTelemetryEvent } from './telemetry-event.js';
export type { TelemetryEvent, TelemetryEventValidationResult, TelemetryEventType } from './telemetry-event.js';

// StorageAdapter interface
export { StorageAdapter } from './storage-adapter.js';

// PrincipleInjector interface and DefaultPrincipleInjector
export { PrincipleInjector, DefaultPrincipleInjector, InjectionContext } from './principle-injector.js';

// Shared types
export type { InjectablePrinciple } from './types.js';
export type { HybridLedgerStore } from './types.js';

// WorkspaceResolver interface (D-01: interface in core, impl in openclaw-plugin)
export type { WorkspaceResolver } from './types/workspace-resolver.js';

// I/O utilities (D-03: atomicWriteFileSync for crash-safe writes)
export { atomicWriteFileSync } from './io.js';

// PainRecorder — pure function for pain signal recording (D-02)
export { recordPainSignal } from './pain-recorder.js';
export type { PainSignalInput } from './pain-recorder.js';

// PainFlagPathResolver — pure function for resolving pain flag paths (D-04)
export { resolvePainFlagPath } from './pain-flag-resolver.js';

// TrajectoryStore — correction sample primitives (SAMPLES-01, SAMPLES-02)
export { listCorrectionSamples, reviewCorrectionSample } from './trajectory-store.js';
export type { CorrectionSampleRecord, CorrectionSampleReviewStatus } from './trajectory-store.js';

// Runtime v2 Foundation Contracts (M1)
// Import via '@principles/core/runtime-v2' for the full contract set,
// or import individual types and schemas from this barrel export.

// Versioning + error categories
export {
  RUNTIME_V2_SCHEMA_VERSION,
  schemaRef,
  SchemaVersionRefSchema,
  RuntimeV2SchemaVersionSchema,
  PDErrorCategorySchema,
  PD_ERROR_CATEGORIES,
  PDRuntimeError,
  isPDErrorCategory,
} from './runtime-v2/index.js';

// Agent specification schemas
export {
  AGENT_IDS,
  AgentCapabilityRequirementsSchema,
  AgentTimeoutPolicySchema,
  AgentRetryPolicySchema,
  AgentSpecSchema,
} from './runtime-v2/index.js';

// Runtime protocol schemas
export {
  RuntimeKindSchema,
  RuntimeCapabilitiesSchema,
  RuntimeHealthSchema,
  RunHandleSchema,
  RunExecutionStatusSchema,
  RunStatusSchema,
  ContextItemSchema,
  AgentSpecRefSchema,
  WorkflowRefSchema,
  TaskRefSchema,
  StartRunInputSchema,
  StructuredRunOutputSchema,
  RuntimeArtifactRefSchema,
} from './runtime-v2/index.js';

// Task status schemas
export {
  PDTaskStatusSchema,
  TaskRecordSchema,
  DiagnosticianTaskRecordSchema,
} from './runtime-v2/index.js';

// Runtime selector schemas
export {
  RuntimeSelectionCriteriaSchema,
} from './runtime-v2/index.js';

// Context payload schemas (Phase 2)
export {
  HistoryQueryEntrySchema,
  TrajectoryLocateQuerySchema,
  TrajectoryCandidateSchema,
  TrajectoryLocateResultSchema,
  HistoryQueryResultSchema,
  DiagnosisTargetSchema,
  ContextPayloadSchema,
  DiagnosticianContextPayloadSchema,
} from './runtime-v2/index.js';

// Diagnostician output schemas (Phase 2)
export {
  DiagnosticianViolatedPrincipleSchema,
  DiagnosticianEvidenceSchema,
  RecommendationKindSchema,
  DiagnosticianRecommendationSchema,
  DiagnosticianOutputV1Schema,
  DiagnosticianInvocationInputSchema,
} from './runtime-v2/index.js';
export type {
  PDErrorCategory,
  AgentSpec,
  AgentCapabilityRequirements,
  AgentTimeoutPolicy,
  AgentRetryPolicy,
  WellKnownAgentId,
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
  RuntimeSelector,
  RuntimeSelectionCriteria,
  RuntimeSelectionResult,
  PDTaskStatus,
  TaskRecord,
  DiagnosticianTaskRecord,
  HistoryQueryEntry,
  TrajectoryLocateQuery,
  TrajectoryCandidate,
  TrajectoryLocateResult,
  HistoryQueryResult,
  DiagnosisTarget,
  ContextPayload,
  DiagnosticianContextPayload,
  DiagnosticianOutputV1,
  DiagnosticianViolatedPrinciple,
  DiagnosticianEvidence,
  RecommendationKind,
  DiagnosticianRecommendation,
  DiagnosticianInvocationInput,
} from './runtime-v2/index.js';
