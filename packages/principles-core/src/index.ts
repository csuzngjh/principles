/**
 * @principles/core -- Universal Evolution SDK
 *
 * Runtime-v2 contracts, store primitives, and prompt-builder helpers for
 * Principles Disciple host integrations. The pre-runtime-v2 public modules
 * (pain-signal, pain-signal-adapter, telemetry-event, principle-injector)
 * were removed from the public surface in PRI-636. The PainSignal schema is
 * canonical under ./runtime-v2/types (exported via the ./runtime-v2 subpath);
 * telemetry-event remains an internal module consumed via relative imports.
 *
 * @example
 * import { RuntimeStateManager, SqliteTaskStore } from '@principles/core';
 */

// Prompt builder primitives — pure functions extracted from openclaw-plugin prompt hook (PRI-75)
export {
  buildAttitudeDirective,
  detectCorrectionCue,
  escapeXml,
  extractMessageContent,
  isMinimalTrigger,
  truncateInjectionToBudget,
  isValidModelFormat,
  resolveModelFromConfig,
} from './prompt-builder/index.js';
export type { PromptInjectionPart, SizeGuardOptions, CoreLogger, ModelConfigObject } from './prompt-builder/index.js';

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

// Runtime integration layer
export { RuntimeStateManager } from './runtime-v2/index.js';
export type { RuntimeStateManagerOptions } from './runtime-v2/index.js';

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
} from './runtime-v2/index.js';
export type {
  HistoryQuery,
  HistoryQueryCursorData,
  HistoryQueryOptions,
} from './runtime-v2/index.js';
export type { ContextAssembler } from './runtime-v2/store/context/context-assembler.js';
export type {
  TaskStore,
  TaskStoreFilter,
  TaskStoreUpdatePatch,
} from './runtime-v2/store/task/task-store.js';
export type {
  RunStore,
  RunRecord,
} from './runtime-v2/store/run/run-store.js';
export type { TrajectoryLocator } from './runtime-v2/store/trajectory/trajectory-locator.js';

// Lease & Recovery
export { DefaultLeaseManager } from './runtime-v2/index.js';
export type { LeaseManager, AcquireLeaseOptions } from './runtime-v2/index.js';
export { DefaultRetryPolicy } from './runtime-v2/index.js';
export type { RetryPolicy, RetryPolicyConfig } from './runtime-v2/index.js';
export { DefaultRecoverySweep } from './runtime-v2/index.js';
export type { RecoverySweep, RecoveryResult } from './runtime-v2/index.js';

// Event emitter
export { StoreEventEmitter, storeEmitter } from './runtime-v2/index.js';

// Workflow funnel loader
export { WorkflowFunnelLoader } from './workflow-funnel-loader.js';
export type {
  WorkflowStage,
  WorkflowFunnel,
  FunnelPolicy,
  WorkflowFunnelConfig,
} from './workflow-funnel-loader.js';

// PD Config — context injection types re-exported for openclaw-plugin consumers
export type { ContextInjectionConfig, EvolutionContextConfig, ProjectFocusMode } from './runtime-v2/config/index.js';
export { DEFAULT_CONTEXT_INJECTION } from './runtime-v2/config/index.js';

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
