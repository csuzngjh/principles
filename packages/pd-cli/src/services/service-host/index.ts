/**
 * @principles/service-host — the PD Service Host coordinator package
 * (SPEC-PD-SERVICE-HOST-001 / ADR-0020 §11.6 narrow scope).
 *
 * Phase 1 public surface: the read-only run-once coordinator and its
 * building blocks. Phase 2 adds the unified Worker Adapter contract and the
 * explicit, bounded shadow coordinator (PRI-1280). Phase 3 adds the managed
 * run (the OS scheduler entry), the Scheduler Adapter Contract with the
 * three user-level platform adapters, and the unified read-only status
 * contract (PRI-1281). No owner-marker writes, no handover — later phases
 * extend this package within the same boundary (TD §11).
 */
export {
  resolveCoordinatorInstallIdentity,
  stripExperimentRoot,
  type CoordinatorEnvView,
  type InstallIdentity,
} from './install-identity.js';
export {
  WORKSPACE_DISCOVERY_VERDICTS,
  discoverWorkspaces,
  type DiscoverWorkspacesInput,
  type DiscoveryProbes,
  type WorkspaceDiscoveryEntry,
  type WorkspaceDiscoveryResult,
  type WorkspaceDiscoveryVerdict,
  type WorkspaceSourceRef,
} from './workspace-discovery.js';
export { projectWorkspaceOwner, type OwnerProjection } from './owner-projection.js';
export {
  buildEmptyDiscovery,
  claimOptionsFor,
  defaultListDir,
  discoveryIncompleteRoots,
  hostRootReports,
  manifestSection,
  readManifest,
} from './coordinator-common.js';
export {
  SERVICE_RUN_LOCK_STALE_MS,
  acquireServiceRunLock,
  holdsServiceRunLock,
  releaseServiceRunLock,
  serviceRunLockPath,
  type AcquireServiceRunLockResult,
  type LockBodyRead,
  type ReleaseServiceRunLockResult,
  type ServiceRunLockHandle,
} from './locking/service-run-lock.js';
export {
  SERVICE_RUN_STATUS_SCHEMA_VERSION,
  readActiveReleaseFacts,
  readServiceRunStatus,
  serviceRunStatusPath,
  writeServiceRunStatus,
  type ActiveReleaseFacts,
  type ManagedExecutionRecord,
  type ManagedRunStatusSection,
  type ServiceRunStatus,
  type ServiceRunStatusRead,
  type ServiceRunTriggerSource,
  type ShadowExecutionRecord,
  type ShadowRunStatusSection,
} from './status/service-run-status.js';
export {
  runServiceRunOnce,
  type RunOnceOptions,
  type RunOnceResult,
} from './run-once.js';
// ── Phase 2 (PRI-1280): Worker Adapter contract + shadow coordinator ──
export {
  WORKER_ADAPTER_CONTRACT_VERSION,
  WORKER_HOST_KINDS,
  resolveActiveReleaseCliEntry,
  type AdapterCycleHealth,
  type AdapterCycleOutcome,
  type AdapterCycleResult,
  type AdapterSupport,
  type BusinessProgressEvidence,
  type CliWorkerHostConfig,
  type WorkerAdapter,
  type WorkerAdapterExecuteInput,
  type WorkerAdapterProbes,
  type WorkerHostKind,
  type WorkspaceDescriptor,
} from './worker-adapter.js';
export { createCodexWorkerAdapter } from './worker-adapter-codex.js';
export { createWorkbuddyWorkerAdapter } from './worker-adapter-workbuddy.js';
export {
  buildWorkerEnvironment,
  type WorkerEnvironment,
  type WorkerEnvironmentReport,
} from './worker-env.js';
export {
  runWorkerProcess,
  type WorkerProcessOptions,
  type WorkerProcessResult,
} from './worker-process.js';
export {
  diffTaskProgress,
  readTaskProgressSnapshot,
  type TaskProgressEvidence,
  type TaskProgressRead,
  type TaskProgressSnapshot,
} from './progress-evidence.js';
export {
  DEFAULT_SHADOW_WORKSPACE_TIMEOUT_MS,
  runServiceShadowOnce,
  type ShadowRunOptions,
  type ShadowRunProbes,
  type ShadowRunResult,
} from './shadow-run.js';
// ── Phase 3 (PRI-1281): shared dispatch core + managed run + OS scheduler ──
export {
  carriedProgress,
  dispatchWorkspaceAdapters,
  workspaceStateFor,
  type AdapterDispatchEntry,
  type AdapterDispatchOutcome,
  type DispatchWorkspaceAdaptersArgs,
  type WorkspaceDispatchResult,
} from './workspace-dispatch.js';
export {
  DEFAULT_MANAGED_WORKSPACE_TIMEOUT_MS,
  runServiceManagedOnce,
  type ManagedRunOptions,
  type ManagedRunProbes,
  type ManagedRunResult,
} from './managed-run.js';
export {
  DEFAULT_SCHEDULER_INTERVAL_MS,
  buildWindowsTaskXml,
  buildMacosLaunchAgentPlist,
  buildLinuxServiceUnit,
  buildLinuxTimerUnit,
  createLinuxSchedulerAdapter,
  createMacosSchedulerAdapter,
  createSpawnSchedulerRunner,
  createWindowsSchedulerAdapter,
  nodeSchedulerFileIo,
  runSchedulerLifecycle,
  schedulerIdentityFor,
  schedulerInvocationArgs,
  validateSchedulerIntervalMs,
  parseWindowsIntervalMs,
  parseMacosStartIntervalMs,
  parseLinuxTimerIntervalMs,
  type MacosSchedulerDeps,
  type LinuxSchedulerDeps,
  type SchedulerAdapter,
  type SchedulerAdapterResolution,
  type SchedulerCommandResult,
  type SchedulerCommandRunner,
  type SchedulerFileIo,
  type SchedulerFacts,
  type SchedulerIdentity,
  type SchedulerLifecycleOperation,
  type SchedulerLifecycleOptions,
  type SchedulerLifecycleResult,
  type SchedulerOperationResult,
  type SchedulerPlatform,
  type SchedulerRegistration,
  type WindowsSchedulerDeps,
} from './scheduler/index.js';
export {
  SERVICE_HOST_STATUS_SCHEMA_VERSION,
  composeServiceHostStatus,
  type ServiceHostStatusDocument,
  type ServiceHostStatusOptions,
  type ServiceHostStatusResult,
  type ServiceHostStatusWorkspace,
} from './scheduler/service-status.js';
