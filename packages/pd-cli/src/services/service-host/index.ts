/**
 * @principles/service-host — the PD Service Host coordinator package
 * (SPEC-PD-SERVICE-HOST-001 / ADR-0020 §11.6 narrow scope).
 *
 * Phase 1 public surface: the read-only run-once coordinator and its
 * building blocks. No Worker Adapter, no OS scheduler, no handover —
 * Phase 2+ extends this package within the same boundary (TD §11).
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
  SERVICE_RUN_LOCK_STALE_MS,
  acquireServiceRunLock,
  holdsServiceRunLock,
  releaseServiceRunLock,
  serviceRunLockPath,
  type AcquireServiceRunLockResult,
  type ReleaseServiceRunLockResult,
  type ServiceRunLockHandle,
} from './locking/service-run-lock.js';
export {
  SERVICE_RUN_STATUS_SCHEMA_VERSION,
  readActiveReleaseFacts,
  serviceRunStatusPath,
  writeServiceRunStatus,
  type ActiveReleaseFacts,
  type ServiceRunStatus,
} from './status/service-run-status.js';
export {
  runServiceRunOnce,
  type RunOnceOptions,
  type RunOnceResult,
} from './run-once.js';
