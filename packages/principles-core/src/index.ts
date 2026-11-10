/**
 * @principles/core -- Universal Evolution SDK
 *
 * Runtime-v2 contracts, store primitives, and prompt-builder helpers for
 * Principles Disciple host integrations. The pre-runtime public modules
 * (pain-signal, pain-signal-adapter, telemetry-event, principle-injector)
 * were removed from the public surface in PRI-636. The PainSignal schema is
 * canonical under ./runtime/types (exported via the ./runtime subpath);
 * telemetry-event remains an internal module consumed via relative imports.
 *
 * @example
 * import { RuntimeStateManager, SqliteTaskStore } from '@principles/core';
 */

// Prompt builder primitives — pure functions extracted from openclaw-plugin prompt hook (PRI-75)
export {
  detectCorrectionCue,
  escapeXml,
  extractMessageContent,
  isMinimalTrigger,
  truncateInjectionToBudget,
  isValidModelFormat,
  resolveModelFromConfig,
} from './prompt-builder/index.js';
export type { SizeGuardOptions, CoreLogger, ModelConfigObject } from './prompt-builder/index.js';

// Prompt builder — empathy keyword matching (PRI-81 Phase A)
export {
  matchEmpathyKeywords,
  createDefaultKeywordStore,
  applyKeywordUpdates,
  shouldTriggerOptimization,
  getKeywordStoreSummary,
  EMPATHY_SEED_KEYWORDS,
  DEFAULT_EMPATHY_KEYWORD_CONFIG,
  scoreToSeverity,
  severityToPenalty,
  normalizeSeverity,
} from './prompt-builder/index.js';
export type {
  EmpathyKeywordStore,
  EmpathyKeywordEntry,
  EmpathyKeywordStats,
  EmpathyMatchResult,
  EmpathyKeywordUpdate,
  EmpathyOptimizationResult,
  SeedKeywordEntry,
  EmpathyKeywordConfig,
} from './prompt-builder/index.js';

// Prompt builder — focus compression (PRI-81 Phase B)
export {
  extractVersion,
  extractDate,
  extractSummary,
  parseWorkingMemorySection,
  workingMemoryToInjection,
  extractMilestones,
  validateCurrentFocus,
  mergeWorkingMemory,
  compressFocusContent,
  DEFAULT_FOCUS_COMPRESSION_OPTIONS,
} from './prompt-builder/index.js';
export type {
  FileArtifact,
  WorkingMemorySnapshot,
  FocusCompressionOptions,
  FocusCompressionResult,
} from './prompt-builder/index.js';

// TrajectoryStore — correction sample primitives (SAMPLES-01, SAMPLES-02)
export { listCorrectionSamples, reviewCorrectionSample, TrajectoryDbUnavailableError } from './trajectory-store.js';
export type { CorrectionSampleRecord, CorrectionSampleReviewStatus } from './trajectory-store.js';

// Runtime v2 Foundation Contracts (M1)
// Import via '@principles/core/runtime' for the full contract set,
// or import individual types and schemas from this barrel export.

// Versioning + error categories (PRI-1139: schemaRef()/RUNTIME_SCHEMA_VERSION
// and their schemas retired from the public barrel)
export {
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION,
  RuntimeContractSchemaVersionSchema,
  isRuntimeContractSchemaVersion,
  type RuntimeContractSchemaVersion,
  PDErrorCategorySchema,
  PD_ERROR_CATEGORIES,
  PDRuntimeError,
  isPDErrorCategory,
} from './runtime/index.js';

// Agent specification schemas
export {
  AGENT_IDS,
  AgentCapabilityRequirementsSchema,
  AgentTimeoutPolicySchema,
  AgentRetryPolicySchema,
  AgentSpecSchema,
} from './runtime/index.js';

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
} from './runtime/index.js';

// Task status schemas
export {
  PDTaskStatusSchema,
  TaskRecordSchema,
  DiagnosticianTaskRecordSchema,
} from './runtime/index.js';

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
} from './runtime/index.js';

// Diagnostician output schemas (V2 Only — PRI-1146)
export {
  DiagnosticianViolatedPrincipleSchema,
  DiagnosticianEvidenceSchema,
  RecommendationKindSchema,
  PrincipleAssociationSchema,
  DiagnosticianRecommendationV2Schema,
  DiagnosticianOutputV2Schema,
  DiagnosticianInvocationInputSchema,
  DIAGNOSTICIAN_ENVELOPE_KEYS,
  readDiagnosticianOutputFromEnvelope,
} from './runtime/index.js';
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
  DiagnosticianOutputV2,
  DiagnosticianRecommendationV2,
  DiagnosticianViolatedPrinciple,
  DiagnosticianEvidence,
  RecommendationKind,
  PrincipleAssociation,
  DiagnosticianInvocationInput,
} from './runtime/index.js';

// Runtime integration layer
export { RuntimeStateManager } from './runtime/index.js';
export type { RuntimeStateManagerOptions } from './runtime/index.js';

// Store exports (for pd-cli and openclaw-plugin direct usage)
export {
  SqliteTaskStore,
  SqliteRunStore,
  MalformedRunError,
  SqliteConnection,
  SqliteTrajectoryLocator,
  SqliteSourceTraceLocator,
  SqliteHistoryQuery,
  SqliteContextAssembler,
  ResilientContextAssembler,
  ResilientHistoryQuery,
  DEFAULT_HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  DEFAULT_TIME_WINDOW_MS,
} from './runtime/index.js';
export type {
  HistoryQuery,
  HistoryQueryCursorData,
  HistoryQueryOptions,
} from './runtime/index.js';
export type { ContextAssembler } from './runtime/store/context/context-assembler.js';
export type {
  TaskStore,
  TaskStoreFilter,
  TaskStoreUpdatePatch,
} from './runtime/store/task/task-store.js';
export type {
  RunStore,
  RunRecord,
} from './runtime/store/run/run-store.js';
export type { TrajectoryLocator } from './runtime/store/trajectory/trajectory-locator.js';

// Lease & Recovery
export { DefaultLeaseManager } from './runtime/index.js';
export type { LeaseManager, AcquireLeaseOptions } from './runtime/index.js';
export { DefaultRetryPolicy } from './runtime/index.js';
export type { RetryPolicy, RetryPolicyConfig } from './runtime/index.js';
export { DefaultRecoverySweep } from './runtime/index.js';
export type { RecoverySweep, RecoveryResult } from './runtime/index.js';

// Event emitter
export { StoreEventEmitter, storeEmitter } from './runtime/index.js';

// Workflow funnel loader
export { WorkflowFunnelLoader } from './workflow-funnel-loader.js';
export type {
  WorkflowStage,
  WorkflowFunnel,
  FunnelPolicy,
  WorkflowFunnelConfig,
} from './workflow-funnel-loader.js';

// PD Config — context injection types re-exported for openclaw-plugin consumers
export type { ContextInjectionConfig, ProjectFocusMode } from './runtime/config/index.js';
export { DEFAULT_CONTEXT_INJECTION } from './runtime/config/index.js';

// Host Adapter — Multi-platform host abstraction (ADR-0020 §2.2, §2.3)
// Pure types + type guards. No I/O. Import from '@principles/core/host' for
// the dedicated subpath, or from '@principles/core' for the barrel export.
// Two abstractions: HostAdapter (runtime hooks) + HostInstaller (install lifecycle).
export type {
  HostEventKind,
  HostEventContext,
  HostEvent,
  HostDecision,
  HostEventResult,
  HostAdapter,
  HostInstallContext,
  HostRuntimeProfileInput,
  HostUninstallContext,
  HostConfigAction,
  HostInstallResult,
  HostUninstallResult,
  HostDetectResult,
  HostDetectPath,
  HostInstaller,
} from './host/index.js';
export {
  HOST_EVENT_KINDS,
  isHostEventKind,
  isHostDecision,
  isHostEventContext,
  isHostEvent,
  isHostEventResult,
  isHostConfigAction,
  isHostInstallResult,
  isHostUninstallResult,
} from './host/index.js';
