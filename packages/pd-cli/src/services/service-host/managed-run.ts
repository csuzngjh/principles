/**
 * The Phase 3 managed-run coordinator (SPEC-PD-SERVICE-HOST-001 §11 Phase 3,
 * PRI-1281 task §4) — the OS scheduler's execution entry:
 *
 *   pd service run-once --json [--trigger scheduler] [--pd-home <dir>]
 *
 * Runs the trusted prefix (identity → install lock → active release →
 * manifest → validated claims → discovery), then admits workspaces by the
 * ownership projection INSTEAD of an explicit selection:
 *
 *   - `effectiveOwner=service_host` + `state=service_host_owned` + an
 *     `authorized` discovery verdict → ONE bounded real Worker cycle per
 *     bound host adapter;
 *   - `legacy_owned` (incl. no-record) → skipped: un-provisioned residue —
 *     there is NO legacy consumer anymore, nothing consumes this workspace
 *     until it is provisioned;
 *   - `handover_preparing` / `rollback_pending` → retired transition-state
 *     residue, NEVER executed;
 *   - conflicting owner projection / non-authorized verdict → refused-skip,
 *     fail-closed per workspace;
 *   - manifest or marker unreadable → the whole run refuses (fail-closed —
 *     inherited from the trusted prefix, marker validity is manifest-level).
 *
 * Zero service_host_owned workspaces is a LEGAL empty execution
 * (`no_service_host_owned_workspaces`): no Worker starts, nothing fails.
 * Overlapping triggers converge on the Phase 1 install-level single-instance
 * lock; task-level concurrency stays with the existing Durable Lease.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { collectHostWorkspaceClaims, type BindingReadDiagnostic, type HostClaimReaders } from '@principles/install-layout';
import { loadHostToolDeclarations } from '@principles/host-runtime';
import {
  resolveCoordinatorInstallIdentity,
  type InstallIdentity,
} from './install-identity.js';
import { discoverWorkspaces, type WorkspaceDiscoveryEntry, type WorkspaceDiscoveryResult } from './workspace-discovery.js';
import { projectWorkspaceOwnerAliases } from './owner-projection.js';
import {
  buildEmptyDiscovery,
  claimOptionsFor,
  defaultListDir,
  discoveryIncompleteRoots,
  hostRootReports,
  manifestSection,
  readManifest,
} from './coordinator-common.js';
import {
  mergeShadowProgress,
  readShadowProgress,
  type ShadowProgressEntry,
  type ShadowProgressVerdict,
} from './shadow-progress-store.js';
import {
  acquireServiceRunLock,
  holdsServiceRunLock,
  releaseServiceRunLock,
  serviceRunLockPath,
  type HolderLiveness,
  type ReleaseServiceRunLockResult,
  type ServiceRunLockHandle,
} from './locking/service-run-lock.js';
import {
  readActiveReleaseFacts,
  writeServiceRunStatus,
  type ActiveReleaseFacts,
  type HostRootReport,
  type ManagedExecutionRecord,
  type ServiceRunOutcome,
  type ServiceRunStatus,
  type ServiceRunTriggerSource,
} from './status/service-run-status.js';
import type { WorkerAdapter, WorkerHostKind, WorkspaceDescriptor , resolveActiveReleaseCliEntry } from './worker-adapter.js';
import { MANAGED_WORKER_HOST_KINDS } from './worker-adapter.js';
import type { WorkerProcessOptions, WorkerProcessResult } from './worker-process.js';
import { createCodexWorkerAdapter } from './worker-adapter-codex.js';
import { createWorkbuddyWorkerAdapter } from './worker-adapter-workbuddy.js';
import { createOpenClawWorkerAdapter } from './worker-adapter-openclaw.js';
import {
  carriedProgress,
  dispatchWorkspaceAdapters,
  workspaceStateFor,
} from './workspace-dispatch.js';

export const DEFAULT_MANAGED_WORKSPACE_TIMEOUT_MS = 45 * 60_000;
const MIN_MANAGED_WORKSPACE_TIMEOUT_MS = 1_000;

export interface ManagedRunProbes {
  readonly processAlive?: (pid: number) => HolderLiveness;
  readonly holdsLock?: (handle: ServiceRunLockHandle) => boolean;
  readonly releaseLock?: (handle: ServiceRunLockHandle) => ReleaseServiceRunLockResult;
  readonly listDir?: (dir: string) => 'readable' | 'missing' | 'not_directory' | 'unreadable';
  readonly claimReaders?: HostClaimReaders;
  readonly spawnWorkerProcess?: (options: WorkerProcessOptions) => Promise<WorkerProcessResult>;
  readonly resolveCliEntry?: typeof resolveActiveReleaseCliEntry;
  readonly now?: () => Date;
  readonly adapters?: Readonly<Partial<Record<WorkerHostKind, WorkerAdapter>>>;
}

export interface ManagedRunOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly trustedHomeDir?: string;
  /** How the run was triggered — manual CLI or OS scheduler (task §4). */
  readonly triggerSource: ServiceRunTriggerSource;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly probes?: ManagedRunProbes;
}

export type ManagedRunResult =
  | {
      readonly ok: true;
      readonly outcome: 'completed';
      readonly runId: string;
      readonly identity: InstallIdentity;
      readonly activeRelease: ActiveReleaseFacts;
      readonly manifest: ServiceRunStatus['manifest'];
      readonly discovery: WorkspaceDiscoveryResult;
      readonly executions: readonly ManagedExecutionRecord[];
      readonly statusWrite:
        | { readonly ok: true; readonly path: string }
        | { readonly ok: false; readonly reason: string; readonly nextAction: string };
      readonly status: ServiceRunStatus;
    }
  | {
      readonly ok: true;
      readonly outcome: 'already_running';
      readonly runId: string;
      readonly identity: InstallIdentity;
      readonly holderBodyHash: string;
      readonly reason: string;
      readonly nextAction: string;
    }
  | {
      readonly ok: false;
      readonly outcome: 'refused';
      readonly runId: string;
      readonly reason: string;
      readonly nextAction: string;
      readonly statusWrite?:
        | { readonly ok: true; readonly path: string }
        | { readonly ok: false; readonly reason: string; readonly nextAction: string };
    };

/** Workspace identity key — same rule as shadow (§9.1.6 canonical identity). */
function workspaceIdentity(dir: string): string {
  const resolved = path.resolve(dir);
  let real: string | undefined;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    real = undefined;
  }
  const form = real ?? resolved;
  return process.platform === 'win32' ? form.toLowerCase() : form;
}

function declaredHostKinds(canonicalDir: string): WorkerHostKind[] {
  const loaded = loadHostToolDeclarations(canonicalDir);
  if (!loaded.ok) return [];
  const declared: WorkerHostKind[] = [];
  for (const declaration of loaded.declarations) {
    if (MANAGED_WORKER_HOST_KINDS.includes(declaration.hostKind as WorkerHostKind)) {
      declared.push(declaration.hostKind as WorkerHostKind);
    }
  }
  return declared;
}

function buildDescriptor(entry: WorkspaceDiscoveryEntry): WorkspaceDescriptor {
  return {
    canonicalDir: entry.canonicalDir,
    discoveryVerdict: entry.verdict,
    claimingHosts: entry.hosts,
    declaredHostKinds: declaredHostKinds(entry.canonicalDir),
  };
}

function readPreviousProgress(pdHome: string): { at: Map<string, string>; verdict: ShadowProgressVerdict } {
  const read = readShadowProgress(pdHome);
  if (!read.ok) {
    return { at: new Map(), verdict: read.verdict };
  }
  const at = new Map<string, string>();
  for (const [key, entry] of read.entries) {
    at.set(key, entry.lastProgressAt);
  }
  return { at, verdict: read.verdict };
}

function buildManagedStatus(args: {
  identity: InstallIdentity;
  runId: string;
  startedAt: Date;
  completedAt: Date;
  /** Persisted outcome — never hardcoded: refused persists 'refused', a
   *  crashed run persists 'failed', only a real completion persists
   *  'completed' (task §10 review). */
  outcome: ServiceRunOutcome;
  triggerSource: ServiceRunTriggerSource;
  activeRelease: ActiveReleaseFacts;
  manifest: ServiceRunStatus['manifest'];
  discovery: WorkspaceDiscoveryResult;
  hostRoots: readonly HostRootReport[];
  bindingDiagnostics: readonly BindingReadDiagnostic[];
  timeoutMs: number;
  executions: readonly ManagedExecutionRecord[];
  progressCarryVerdict: ShadowProgressVerdict;
  emptyReason?: 'no_service_host_owned_workspaces';
  nextAction: string;
}): ServiceRunStatus {
  return {
    schemaVersion: 'pd.service-run-status.v1',
    runId: args.runId,
    outcome: args.outcome,
    dryRun: false,
    triggerSource: args.triggerSource,
    startedAt: args.startedAt.toISOString(),
    completedAt: args.completedAt.toISOString(),
    durationMs: Math.max(0, args.completedAt.getTime() - args.startedAt.getTime()),
    installation: {
      pdHome: args.identity.pdHome,
      homeDir: args.identity.homeDir,
      homeSource: args.identity.homeSource,
      mode: args.identity.mode,
      activeRelease: args.activeRelease,
    },
    environmentIsolation: {
      pdExperimentRootStripped: args.identity.environment.experimentRootStripped,
      ignoredIdentityEnvVars: args.identity.environment.ignoredIdentityEnvVars,
      inheritedHostRootEnvVars: args.identity.environment.inheritedHostRootEnvVars,
      ...(args.identity.environment.ignoredHostRootEnvVars.length > 0
        ? { ignoredHostRootEnvVars: args.identity.environment.ignoredHostRootEnvVars }
        : {}),
    },
    manifest: args.manifest,
    discovery: {
      discoveredTotal: args.discovery.discoveredTotal,
      counts: args.discovery.counts,
      hostRoots: args.hostRoots,
      incomplete:
        discoveryIncompleteRoots(args.hostRoots).length > 0 || args.bindingDiagnostics.length > 0,
    },
    workspaces: args.discovery.workspaces,
    managed: {
      triggerSource: args.triggerSource,
      perWorkspaceTimeoutMs: args.timeoutMs,
      progressCarryVerdict: args.progressCarryVerdict,
      ...(args.emptyReason !== undefined ? { emptyReason: args.emptyReason } : {}),
      executions: args.executions,
    },
    nextAction: args.nextAction,
  };
}

function managedNextAction(executions: readonly ManagedExecutionRecord[], empty: boolean): string {
  if (empty) {
    return 'No workspace is currently owned by the Service Host (service_host_owned). This is a legal empty managed run — no Worker started and nothing was consumed. Provision workspaces with the PD installer; unprovisioned workspaces simply do not consume.';
  }
  // Compose EVERY outcome class: a waiting workspace must never hide another
  // workspace's failure (the exit code still reflects it, but the summary is
  // what the operator reads).
  const parts: string[] = [];
  const waiting = executions.filter((e) => e.workspaceState === 'waiting_for_host_binding');
  if (waiting.length > 0) {
    parts.push(`${waiting.length} workspace(s) are waiting for a host binding (Service-Host-only install) — the Service Host owns their background lifecycle, no adapter exists yet, and nothing was consumed. Install a host adapter and bind the workspace; no ownership change is needed again.`);
  }
  const notServiceHostOwned = executions.filter((e) => e.skipReason !== undefined && e.skipReason.startsWith('workspace_not_service_host_owned:'));
  if (notServiceHostOwned.length > 0) {
    parts.push(`Skipped ${notServiceHostOwned.length} workspace(s) that are not service_host_owned (including any retired transition-state residue — never consumed). Provision/repair them with the PD installer if Service Host management is intended.`);
  }
  const notAuthorized = executions.filter((e) => e.skipReason !== undefined && e.skipReason.startsWith('workspace_not_authorized'));
  if (notAuthorized.length > 0) {
    parts.push(`Refused ${notAuthorized.length} service_host_owned workspace(s) whose discovery verdict is not authorized (${notAuthorized.map((e) => e.skipReason).join('; ')}). Fix the workspace registration/on-disk state before the next cycle; other workspaces were unaffected.`);
  }
  const unhealthy = executions.filter((e) => e.admission === 'executed' && (e.workspaceState === 'failed' || e.workspaceState === 'degraded' || e.workspaceState === 'unavailable'));
  if (unhealthy.length > 0) {
    parts.push(`${unhealthy.length} unhealthy workspace execution(s); inspect each execution's reason and nextAction. Pending tasks are not lost — the next trigger retries from persisted task/lease state.`);
  }
  return parts.length > 0
    ? `Managed run completed. ${parts.join(' ')}`
    : 'Managed run complete. Only service_host_owned workspaces were consumed; every other ownership state was skipped without consumption.';
}

async function completeManagedRun(identity: InstallIdentity, context: {
  runId: string;
  startedAt: Date;
  handle: ServiceRunLockHandle;
  env: Readonly<Record<string, string | undefined>>;
  options: ManagedRunOptions;
  holdsLock: (handle: ServiceRunLockHandle) => boolean;
  listDir: (dir: string) => 'readable' | 'missing' | 'not_directory' | 'unreadable';
  claimReaders?: HostClaimReaders;
  adapters: Readonly<Record<WorkerHostKind, WorkerAdapter>>;
}): Promise<ManagedRunResult> {
  const { options } = context;
  const timeoutMs = Math.max(MIN_MANAGED_WORKSPACE_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_MANAGED_WORKSPACE_TIMEOUT_MS);
  const hostRoots = hostRootReports(identity, context.listDir);

  const lockLost = (): ManagedRunResult => ({
    ok: false,
    outcome: 'refused',
    runId: context.runId,
    reason: 'service_run_lock_lost',
    nextAction:
      'The install-level run lock was taken over mid-run, so the run stopped before writing status. ' +
      'Inspect the current holder and re-run; do not treat this run\'s results as authoritative.',
  });

  const persistRefusal = (args: {
    reason: string;
    nextAction: string;
    activeRelease: ActiveReleaseFacts;
    manifest?: ServiceRunStatus['manifest'];
    discovery?: WorkspaceDiscoveryResult;
  }): ManagedRunResult => {
    if (!context.holdsLock(context.handle)) return lockLost();
    const status = buildManagedStatus({
      identity,
      runId: context.runId,
      startedAt: context.startedAt,
      completedAt: new Date(),
      outcome: 'refused',
      triggerSource: options.triggerSource,
      activeRelease: args.activeRelease,
      manifest: args.manifest ?? { verdict: 'ok', hosts: [], unknownHosts: [], workspacesCount: 0 },
      discovery: args.discovery ?? buildEmptyDiscovery(),
      hostRoots,
      bindingDiagnostics: [],
      timeoutMs,
      executions: [],
      progressCarryVerdict: 'missing',
      nextAction: args.nextAction,
    });
    return {
      ok: false,
      outcome: 'refused',
      runId: context.runId,
      reason: args.reason,
      nextAction: status.nextAction,
      statusWrite: writeServiceRunStatus(identity.pdHome, status),
    };
  };

  // ── Trusted prefix: active release → manifest → claims → discovery ──
  const activeRelease = readActiveReleaseFacts(identity.activeRecordPath);
  const manifestRead = readManifest(identity);

  if (activeRelease.verdict !== 'ok') {
    return persistRefusal({
      reason: activeRelease.reason ?? 'active_release_invalid',
      activeRelease,
      manifest: manifestSection(manifestRead),
      nextAction:
        activeRelease.verdict === 'missing'
          ? 'Install or repair PD with npx create-principles-disciple — no active release record exists for this install.'
          : 'Repair the install with the PD installer/updater; the active release record could not be verified against the authoritative schema.',
    });
  }
  // Fail-closed (task §4): a manifest that cannot be read or parsed is NEVER
  // "zero workspaces" — the whole run refuses.
  if (manifestRead.manifest === undefined) {
    return persistRefusal({
      reason: manifestRead.reason ?? 'install_manifest_invalid',
      activeRelease,
      manifest: manifestSection(manifestRead),
      nextAction:
        manifestRead.verdict === 'missing'
          ? 'Run npx create-principles-disciple to install PD (no manifest exists for this user-level install).'
          : 'Repair the install manifest with the PD installer/updater before the next trigger; the run refused instead of treating the install as empty.',
    });
  }

  const readDiagnostics: BindingReadDiagnostic[] = [];
  const claimOptions = claimOptionsFor(identity, readDiagnostics, context.claimReaders);
  const claims = collectHostWorkspaceClaims(claimOptions);
  const discovery = discoverWorkspaces({ manifest: manifestRead.manifest, claims, claimOptions });

  // ── Ownership-based admission (task §4 matrix) + shared bounded dispatch ──
  const previousProgress = readPreviousProgress(identity.pdHome);
  const executions: ManagedExecutionRecord[] = [];
  const isAborted = (): boolean => options.signal?.aborted === true;
  let executedAny = false;

  for (const entry of discovery.workspaces) {
    if (isAborted()) break;
    // The ownership domain is the MANIFEST-registered set (§8.4: a marker
    // exists only for declared workspaces). Default-tree "discovered"
    // entries outside the manifest are not the scheduler's business — they
    // are not recorded as skips (that would be noise), they are simply not
    // candidates.
    if (!entry.sources.some((source) => source.source === 'manifest')) continue;
    const key = workspaceIdentity(entry.canonicalDir);
    const previousAt = previousProgress.at.get(key);
    const hadPrevious = previousProgress.at.has(key);
    // Alias-safe owner projection — the same authority shadow uses (§8.4).
    const owner = projectWorkspaceOwnerAliases(
      manifestRead.manifest,
      entry.sources.filter((s) => s.source === 'manifest').map((s) => s.path),
      process.platform,
    );

    const skip = (skipReason: string, skipNextAction?: string): void => {
      executions.push({
        canonicalDir: entry.canonicalDir,
        hostKind: null,
        admission: 'skipped',
        skipReason,
        ...(skipNextAction !== undefined ? { skipNextAction } : {}),
        workspaceState: 'unavailable',
        lastProgressAt: previousAt ?? null,
        lastProgressSource: hadPrevious ? 'previous_run' : null,
      });
    };

    const serviceHostOwned = owner.state === 'service_host_owned' && owner.effectiveOwner === 'service_host';
    if (owner.source === 'conflicting' || owner.effectiveOwner === 'conflict') {
      // Fail-closed per workspace: an ambiguous marker is never "legacy by
      // default" for an automated consumer.
      skip(
        `owner_projection_conflict:${owner.state}`,
        'The backgroundExecutions record for this workspace is ambiguous (alias conflict). Reconcile the install manifest before the next cycle; the scheduler refuses to guess ownership.',
      );
      continue;
    }
    if (serviceHostOwned) {
      if (entry.verdict !== 'authorized') {
        skip(
          `workspace_not_authorized:${entry.verdict}${entry.reason !== undefined ? `:${entry.reason}` : ''}`,
          entry.nextAction ?? 'Fix the workspace registration/on-disk state; the scheduler only executes authorized service_host_owned workspaces.',
        );
        continue;
      }
      const dispatch = await dispatchWorkspaceAdapters({
        workspaceDir: entry.canonicalDir,
        descriptor: buildDescriptor(entry),
        hostKinds: [...MANAGED_WORKER_HOST_KINDS],
        timeoutMs,
        adapters: context.adapters,
        activeRelease,
        identity,
        inheritedEnv: context.env,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        probes: {
          ...(context.options.probes?.spawnWorkerProcess !== undefined
            ? { spawnWorkerProcess: context.options.probes.spawnWorkerProcess }
            : {}),
          ...(context.options.probes?.resolveCliEntry !== undefined
            ? { resolveCliEntry: context.options.probes.resolveCliEntry }
            : {}),
          ...(context.options.probes?.now !== undefined ? { now: context.options.probes.now } : {}),
        },
        isAborted,
      });
      let supportedAny = false;
      for (const { hostKind, outcome } of dispatch.entries) {
        if (outcome.kind === 'unsupported') continue;
        supportedAny = true;
        executedAny = true;
        if (outcome.kind === 'budget_exhausted') {
          executions.push({
            canonicalDir: entry.canonicalDir,
            hostKind,
            admission: 'executed',
            skipReason: 'workspace_timeout_budget_exhausted',
            skipNextAction: 'The per-workspace timeout budget was consumed by an earlier adapter cycle on this workspace; the next trigger retries from persisted task/lease state.',
            workspaceState: 'failed',
            lastProgressAt: previousAt ?? null,
            lastProgressSource: hadPrevious ? 'previous_run' : null,
          });
          continue;
        }
        if (outcome.kind === 'adapter_threw') {
          executions.push({
            canonicalDir: entry.canonicalDir,
            hostKind,
            admission: 'executed',
            skipReason: `adapter_threw:${outcome.sanitizedMessage}`,
            skipNextAction: 'The Worker Adapter threw before returning a structured result; the next trigger retries from persisted task/lease state.',
            workspaceState: 'failed',
            lastProgressAt: previousAt ?? null,
            lastProgressSource: hadPrevious ? 'previous_run' : null,
          });
          continue;
        }
        const carried = carriedProgress(outcome.result, previousAt);
        executions.push({
          canonicalDir: entry.canonicalDir,
          hostKind,
          admission: 'executed',
          workspaceState: workspaceStateFor(outcome.result.cycleOutcome),
          ...carried,
          execution: outcome.result,
        });
      }
      if (!supportedAny) {
        if (isAborted()) break;
        executedAny = true; // the workspace WAS admitted; the adapter binding is the problem
        // PRI-1278 Phase 5: a Service-Host-only workspace has NO host binding
        // at all — that is a truthful WAITING state, not a failure. A
        // workspace that HAS claims but no adapter still supports it is a
        // real misconfiguration (`unavailable`).
        const waitingForBinding = entry.hosts.length === 0;
        executions.push({
          canonicalDir: entry.canonicalDir,
          hostKind: null,
          admission: 'executed',
          skipReason: `no_adapter_supports_workspace:${MANAGED_WORKER_HOST_KINDS.join('|')}`,
          skipNextAction: waitingForBinding
            ? 'This service_host_owned workspace has no host binding yet (Service-Host-only install). Install a host adapter and bind the workspace; the scheduler will dispatch it once a binding exists.'
            : 'This service_host_owned workspace has no validated host binding (claim or host-tool declaration) for any adapter. Register the host binding; the scheduler cannot execute it.',
          workspaceState: waitingForBinding ? 'waiting_for_host_binding' : 'unavailable',
          lastProgressAt: previousAt ?? null,
          lastProgressSource: hadPrevious ? 'previous_run' : null,
        });
      }
      continue;
    }
    // Binary admission: every readable non-service_host_owned state — legacy,
    // no-record projections and retired transition-state residue alike — is a
    // by-design non-execution. The provisioning authority (installer repair),
    // not an ownership-transition CLI, moves a workspace into consumption.
    skip(
      `workspace_not_service_host_owned:${owner.state}`,
      'This workspace is not provisioned for PD Service Host consumption. Run the PD installer/provisioning repair (npx create-principles-disciple) or inspect pd service status; no worker was started.',
    );
  }

  if (!context.holdsLock(context.handle)) return lockLost();

  // ── Cross-run progress projection (same store/contract as shadow) ──
  const progressUpdates = new Map<string, ShadowProgressEntry>();
  const nowIso = new Date().toISOString();
  for (const record of executions) {
    if (record.admission === 'executed'
      && record.lastProgressAt !== null
      && (record.lastProgressSource === 'task_state_change' || record.lastProgressSource === 'cycle_evidence')) {
      progressUpdates.set(workspaceIdentity(record.canonicalDir), {
        lastProgressAt: record.lastProgressAt,
        source: record.lastProgressSource,
        updatedAt: nowIso,
      });
    }
  }
  let progressWriteNote = '';
  if (progressUpdates.size > 0) {
    const merged = mergeShadowProgress(identity.pdHome, progressUpdates);
    if (!merged.ok) {
      progressWriteNote = ` Additionally, the cross-run progress projection could not be updated (${merged.reason}); the status below is still truthful for this run.`;
    }
  }

  const empty = !executedAny;
  const status = buildManagedStatus({
    identity,
    runId: context.runId,
    startedAt: context.startedAt,
    completedAt: new Date(),
    outcome: 'completed',
    triggerSource: options.triggerSource,
    activeRelease,
    manifest: manifestSection(manifestRead),
    discovery,
    hostRoots,
    bindingDiagnostics: readDiagnostics,
    timeoutMs,
    executions,
    progressCarryVerdict: previousProgress.verdict,
    ...(empty ? { emptyReason: 'no_service_host_owned_workspaces' as const } : {}),
    nextAction: `${managedNextAction(executions, empty)}${progressWriteNote}`,
  });
  const statusWrite = writeServiceRunStatus(identity.pdHome, status);
  return {
    ok: true,
    outcome: 'completed',
    runId: context.runId,
    identity,
    activeRelease,
    manifest: status.manifest,
    discovery,
    executions,
    statusWrite,
    status,
  };
}

/**
 * Execute one managed run (the scheduler entry). Never throws for expected
 * refusals — everything expected is a structured result (rc-9).
 */
export async function runServiceManagedOnce(options: ManagedRunOptions): Promise<ManagedRunResult> {
  const runId = randomUUID();
  const startedAt = new Date();
  const env = options.env ?? process.env;

  // The managed run is the SCHEDULER entry: host roots resolve from the
  // trusted home only — inherited OPENCLAW_STATE_DIR / CODEX_HOME /
  // WORKBUDDY_CONFIG_DIR / PD_EXPERIMENT_ROOT never steer discovery (F1/TD §5.2).
  const identityResult = resolveCoordinatorInstallIdentity(env, {
    ...(options.trustedHomeDir !== undefined ? { trustedHomeDir: options.trustedHomeDir } : {}),
    canonicalHostRootsOnly: true,
  });
  if (!identityResult.ok) {
    return { ok: false, outcome: 'refused', runId, reason: identityResult.reason, nextAction: identityResult.nextAction };
  }
  const { identity } = identityResult;

  const lock = acquireServiceRunLock(identity.pdHome, {
    probes: {
      ...(options.probes?.processAlive !== undefined ? { processAlive: options.probes.processAlive } : {}),
    },
  });
  if (!lock.ok) {
    if (lock.kind === 'held') {
      return {
        ok: true,
        outcome: 'already_running',
        runId,
        identity,
        holderBodyHash: lock.holderBodyHash,
        reason: 'service_run_lock_held',
        nextAction: 'Another run-once coordinator holds the install-level lock. This is the overlap convergence working as designed; no second coordinator started.',
      };
    }
    const lockPathForMessage = serviceRunLockPath(identity.pdHome);
    return {
      ok: false,
      outcome: 'refused',
      runId,
      reason: lock.kind === 'corrupt'
        ? `service_run_lock_corrupt:${lock.detail}`
        : `service_run_lock_unwritable:${lock.detail}`,
      nextAction: lock.kind === 'corrupt'
        ? ['Inspect the run lock by hand at', lockPathForMessage, '— a lock this old must stay verifiable before any coordinator may run.'].join(' ')
        : 'Check the permissions of the PD service directory and retry.',
    };
  }
  const handle: ServiceRunLockHandle = lock.handle;
  const releaseLock = options.probes?.releaseLock ?? releaseServiceRunLock;
  const adapters: Record<WorkerHostKind, WorkerAdapter> = {
    codex: options.probes?.adapters?.codex ?? createCodexWorkerAdapter(),
    workbuddy: options.probes?.adapters?.workbuddy ?? createWorkbuddyWorkerAdapter(),
    openclaw: options.probes?.adapters?.openclaw ?? createOpenClawWorkerAdapter(),
  };

  let result: ManagedRunResult;
  let runError: unknown;
  let runThrew = false;
  try {
    result = await completeManagedRun(identity, {
      runId,
      startedAt,
      handle,
      env,
      options,
      holdsLock: options.probes?.holdsLock ?? holdsServiceRunLock,
      listDir: options.probes?.listDir ?? defaultListDir,
      ...(options.probes?.claimReaders !== undefined ? { claimReaders: options.probes.claimReaders } : {}),
      adapters,
    });
  } catch (error) {
    runThrew = true;
    runError = error;
    result = { ok: false, outcome: 'refused', runId, reason: 'internal_error', nextAction: '' };
  }
  if (runThrew) {
    // A crashed run persists 'failed' — the status file must not keep the
    // PREVIOUS run's record standing in for a run that never completed
    // (task §10 review). The lock must still be ours at write time, so
    // persist BEFORE release: holdsServiceRunLock after releaseLock is
    // always false and the failure would never reach the status file.
    try {
      const stillHolds = (options.probes?.holdsLock ?? holdsServiceRunLock)(handle);
      if (stillHolds) {
        const activeRelease = readActiveReleaseFacts(identity.activeRecordPath);
        const manifestRead = readManifest(identity);
        writeServiceRunStatus(identity.pdHome, buildManagedStatus({
          identity,
          runId,
          startedAt,
          completedAt: new Date(),
          outcome: 'failed',
          triggerSource: options.triggerSource,
          activeRelease,
          manifest: manifestSection(manifestRead),
          discovery: buildEmptyDiscovery(),
          hostRoots: hostRootReports(identity, options.probes?.listDir ?? defaultListDir),
          bindingDiagnostics: [],
          timeoutMs: Math.max(MIN_MANAGED_WORKSPACE_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_MANAGED_WORKSPACE_TIMEOUT_MS),
          executions: [],
          progressCarryVerdict: 'missing',
          nextAction: 'The managed run terminated with an internal error before completion — the failure itself is recorded as outcome=failed. Inspect the error and the service directory before the next trigger.',
        }));
      }
    } catch {
      // Persisting the failure must never mask the original error.
    }
    const crashedRelease = releaseLock(handle);
    if (crashedRelease === 'failed_busy' || crashedRelease === 'failed_unwritable') {
      console.error(`pd service run-once (managed): lock release also failed (${crashedRelease}) after the run error`);
    }
    throw runError;
  }
  const release = releaseLock(handle);
  const releaseFailed = release === 'failed_busy' || release === 'failed_unwritable';
  if (releaseFailed) {
    if (result.outcome === 'completed') {
      return {
        ok: false,
        outcome: 'refused',
        runId,
        reason: `service_run_lock_release_failed:${release === 'failed_busy' ? 'busy' : 'unwritable'}`,
        nextAction:
          'The managed run finished but its run lock could not be released through the arbitration gate. ' +
          'The leftover lock carries a dead-holder PID once this process exits, so the next trigger recovers ' +
          'on PID evidence — inspect the service directory and the gate database before re-running.',
        statusWrite: result.statusWrite,
      };
    }
    return {
      ...result,
      nextAction: `${result.nextAction} (Additionally, the run lock release failed: ${release}.)`,
    };
  }
  return result;
}
