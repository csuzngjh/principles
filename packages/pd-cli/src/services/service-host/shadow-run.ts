/**
 * The Phase 2 shadow coordinator (SPEC §11 Phase 2 + Phase 2 准入边界, task §9).
 *
 * An EXPLICIT, MANUAL, BOUNDED shadow cycle — default-off, never scheduled:
 *
 *   pd service run-once --shadow --workspace <dir> [--host codex|workbuddy]
 *
 * Runs the SAME trusted prefix as the Phase 1 dry-run (identity → install
 * lock → active release → manifest → validated claims → discovery), then —
 * for each EXPLICITLY requested workspace only — admits the target
 * (authorized verdict + legacy-owned marker projection + adapter binding
 * evidence), and drives ONE bounded real Worker Cycle per bound host
 * through the unified Worker Adapter. A shadow cycle calls the REAL worker
 * (business tasks may advance); it is never presented as a zero-side-effect
 * dry-run, and it never:
 *
 *   - registers an OS scheduler (Phase 3);
 *   - modifies the owner marker / enters the §8.4 handover state machine;
 *   - stops Companion Worker supervision or OpenClaw AutoConsumer;
 *   - executes anything beyond legacy-owned, discovery-authorized,
 *     explicitly-selected workspaces.
 *
 * Concurrency with the still-owning legacy consumer is converged by the
 * EXISTING Durable Lease / fencing (same-task double acquisition is a
 * structured lease_conflict, not corruption). Each workspace failure is
 * isolated (FR-07): one timeout or crash never blocks the others.
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
  type ServiceRunStatus,
  type ShadowExecutionRecord,
} from './status/service-run-status.js';
import type {
  WorkerAdapter,
  WorkerHostKind,
  WorkspaceDescriptor,
  resolveActiveReleaseCliEntry,
} from './worker-adapter.js';
import { WORKER_HOST_KINDS } from './worker-adapter.js';
import {
  carriedProgress,
  dispatchWorkspaceAdapters,
  workspaceStateFor,
} from './workspace-dispatch.js';
import type { WorkerProcessOptions, WorkerProcessResult } from './worker-process.js';
import { createCodexWorkerAdapter } from './worker-adapter-codex.js';
import { createWorkbuddyWorkerAdapter } from './worker-adapter-workbuddy.js';

/**
 * Default per-workspace bound. The Codex worker's own stage deadlines sum to
 * ~40 minutes (catch-up 5 + reconcile 5 + diagnosis 15 + post-processing 5 +
 * downstream 10 + stage-2), so 45 minutes bounds one full cycle with margin
 * without letting a hung child outlive the coordinator.
 */
export const DEFAULT_SHADOW_WORKSPACE_TIMEOUT_MS = 45 * 60_000;
const MIN_SHADOW_WORKSPACE_TIMEOUT_MS = 1_000;

export interface ShadowRunProbes {
  readonly processAlive?: (pid: number) => HolderLiveness;
  readonly holdsLock?: (handle: ServiceRunLockHandle) => boolean;
  readonly releaseLock?: (handle: ServiceRunLockHandle) => ReleaseServiceRunLockResult;
  readonly listDir?: (dir: string) => 'readable' | 'missing' | 'not_directory' | 'unreadable';
  readonly claimReaders?: HostClaimReaders;
  /** Subprocess boundary injection forwarded to every adapter execution. */
  readonly spawnWorkerProcess?: (options: WorkerProcessOptions) => Promise<WorkerProcessResult>;
  /** CLI-entry resolution injection (integration tests; prod = active release). */
  readonly resolveCliEntry?: typeof resolveActiveReleaseCliEntry;
  readonly now?: () => Date;
  /** Adapter overrides (unit tests). */
  readonly adapters?: Readonly<Partial<Record<WorkerHostKind, WorkerAdapter>>>;
}

export interface ShadowRunOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly trustedHomeDir?: string;
  /** Explicit workspace selections — REQUIRED, never defaulted to "all discovered". */
  readonly workspaces: readonly string[];
  /** Restrict to one host adapter (default: every bound adapter runs). */
  readonly hostFilter?: WorkerHostKind;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly probes?: ShadowRunProbes;
}

export type ShadowRunResult =
  | {
      readonly ok: true;
      readonly outcome: 'completed';
      readonly runId: string;
      readonly identity: InstallIdentity;
      readonly activeRelease: ActiveReleaseFacts;
      readonly manifest: ServiceRunStatus['manifest'];
      readonly discovery: WorkspaceDiscoveryResult;
      readonly executions: readonly ShadowExecutionRecord[];
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

/** Workspace identity for admission matching — the discovery identity rule (§9.1.6). */
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

/** Probe persisted host-tool declarations with the EXISTING validation authority (F2 review fix). */
function declaredHostKinds(canonicalDir: string): WorkerHostKind[] {
  // `loadHostToolDeclarations` is the host-runtime authority: content is
  // untrusted input, structurally validated (version/hostKind/mappings) —
  // a same-named file that does not parse as a valid declaration is NOT
  // binding evidence (CWE-345 fix). A workspace whose declaration store is
  // invalid keeps its claim-based evidence path; the declaration adds
  // nothing here.
  const loaded = loadHostToolDeclarations(canonicalDir);
  if (!loaded.ok) return [];
  const declared: WorkerHostKind[] = [];
  for (const declaration of loaded.declarations) {
    if (WORKER_HOST_KINDS.includes(declaration.hostKind as WorkerHostKind)) {
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

/**
 * Read the carried-forward progress projection (F6 review fix): a small
 * per-install store keyed by canonical workspace identity, MERGED across
 * runs — not the latest-run status file's execution list (which loses
 * A→B→A sequences and is replaced wholesale by dry-runs). A corrupt or
 * unreadable store degrades to "no previous progress" and is reported in
 * the persisted status (`progressCarryVerdict`), never silently.
 */
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

/** Assemble the versioned shadow status document (v1 + additive shadow section). */
function buildShadowStatus(args: {
  identity: InstallIdentity;
  runId: string;
  startedAt: Date;
  completedAt: Date;
  activeRelease: ActiveReleaseFacts;
  manifest: ServiceRunStatus['manifest'];
  discovery: WorkspaceDiscoveryResult;
  hostRoots: readonly HostRootReport[];
  bindingDiagnostics: readonly BindingReadDiagnostic[];
  requested: readonly string[];
  hostFilter?: WorkerHostKind;
  timeoutMs: number;
  executions: readonly ShadowExecutionRecord[];
  progressCarryVerdict: ShadowProgressVerdict;
  nextAction: string;
}): ServiceRunStatus {
  return {
    schemaVersion: 'pd.service-run-status.v1',
    runId: args.runId,
    outcome: 'completed',
    dryRun: false,
    triggerSource: 'manual',
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
    shadow: {
      requestedWorkspaces: args.requested,
      ...(args.hostFilter !== undefined ? { hostFilter: args.hostFilter } : {}),
      perWorkspaceTimeoutMs: args.timeoutMs,
      progressCarryVerdict: args.progressCarryVerdict,
      executions: args.executions,
    },
    nextAction: args.nextAction,
  };
}

function shadowNextAction(executions: readonly ShadowExecutionRecord[]): string {
  const admitted = executions.filter((e) => e.admission === 'admitted');
  const refused = executions.filter((e) => e.admission === 'refused');
  const bad = admitted.filter((e) => e.workspaceState === 'failed' || e.workspaceState === 'degraded' || e.workspaceState === 'unavailable');
  if (refused.length > 0) {
    const reasons = refused.map((e) => `${e.requestedDir} (${e.refusalReason ?? 'refused'})`).join('; ');
    return `Shadow run complete with refusals: ${reasons}. Fix the admission blockers (authorization / owner state / binding evidence) or re-check the requested paths; no worker ran for them.`;
  }
  if (bad.length > 0) {
    return `Shadow run complete with ${bad.length} non-healthy workspace execution(s); inspect each execution's reason and nextAction. The legacy consumer remains the unique automatic lifecycle owner; nothing was handed over.`;
  }
  return 'Shadow run complete. The legacy consumer remains the unique automatic lifecycle owner; no owner marker was modified and no scheduler was registered.';
}

async function completeShadowRun(identity: InstallIdentity, context: {
  runId: string;
  startedAt: Date;
  handle: ServiceRunLockHandle;
  env: Readonly<Record<string, string | undefined>>;
  options: ShadowRunOptions;
  holdsLock: (handle: ServiceRunLockHandle) => boolean;
  listDir: (dir: string) => 'readable' | 'missing' | 'not_directory' | 'unreadable';
  claimReaders?: HostClaimReaders;
  adapters: Readonly<Record<WorkerHostKind, WorkerAdapter>>;
}): Promise<ShadowRunResult> {
  const { options } = context;
  const timeoutMs = Math.max(MIN_SHADOW_WORKSPACE_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_SHADOW_WORKSPACE_TIMEOUT_MS);
  const hostRoots = hostRootReports(identity, context.listDir);

  const lockLost = (): ShadowRunResult => ({
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
  }): ShadowRunResult => {
    if (!context.holdsLock(context.handle)) return lockLost();
    const status = buildShadowStatus({
      identity,
      runId: context.runId,
      startedAt: context.startedAt,
      completedAt: new Date(),
      activeRelease: args.activeRelease,
      manifest: args.manifest ?? { verdict: 'ok', hosts: [], unknownHosts: [], workspacesCount: 0 },
      discovery: args.discovery ?? buildEmptyDiscovery(),
      hostRoots,
      bindingDiagnostics: [],
      requested: options.workspaces,
      ...(options.hostFilter !== undefined ? { hostFilter: options.hostFilter } : {}),
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
  if (manifestRead.manifest === undefined) {
    return persistRefusal({
      reason: manifestRead.reason ?? 'install_manifest_invalid',
      activeRelease,
      manifest: manifestSection(manifestRead),
      nextAction:
        manifestRead.verdict === 'missing'
          ? 'Run npx create-principles-disciple to install PD (no manifest exists for this user-level install).'
          : 'Repair the install manifest with the PD installer/updater before running the coordinator; the run refused instead of treating the install as empty.',
    });
  }

  const readDiagnostics: BindingReadDiagnostic[] = [];
  const claimOptions = claimOptionsFor(identity, readDiagnostics, context.claimReaders);
  const claims = collectHostWorkspaceClaims(claimOptions);
  const discovery = discoverWorkspaces({ manifest: manifestRead.manifest, claims, claimOptions });

  // ── Admission + execution (explicit selection only, task §9) ──
  const entriesByIdentity = new Map<string, WorkspaceDiscoveryEntry>();
  for (const entry of discovery.workspaces) {
    entriesByIdentity.set(workspaceIdentity(entry.canonicalDir), entry);
  }
  const previousProgress = readPreviousProgress(identity.pdHome);
  const executions: ShadowExecutionRecord[] = [];

  // R2 review fix: an interrupt must stop the QUEUE, not just the
  // in-flight worker — check before dispatching each workspace/adapter so a
  // cancelled run never starts a Worker only to terminate it. The function
  // indirection keeps repeated checks un-narrowed by TypeScript.
  const isAborted = (): boolean => options.signal?.aborted === true;
  // CR review fix: dedupe by canonical identity — the same workspace passed
  // via a symlink AND its real path must still get exactly ONE cycle.
  const dispatchedIdentities = new Set<string>();

  for (const requested of options.workspaces) {
    if (isAborted()) break;
    const requestedIdentity = workspaceIdentity(requested);
    const entry = entriesByIdentity.get(requestedIdentity);

    const refuse = (reason: string, refusalNextAction: string): void => {
      executions.push({
        requestedDir: requested,
        canonicalDir: entry?.canonicalDir ?? null,
        hostKind: null,
        admission: 'refused',
        refusalReason: reason,
        refusalNextAction,
        workspaceState: 'unavailable',
        lastProgressAt: previousProgress.at.get(requestedIdentity) ?? null,
        lastProgressSource: previousProgress.at.has(requestedIdentity) ? 'previous_run' : null,
      });
    };

    if (entry === undefined) {
      refuse(
        'workspace_not_in_authorized_discovery',
        'The requested path is not among the authorized discovery results (install manifest + validated claims). Register the workspace or fix the path; shadow never executes undiscovered workspaces.',
      );
      continue;
    }
    if (dispatchedIdentities.has(requestedIdentity)) {
      refuse(
        'duplicate_workspace_selection',
        'The same canonical workspace was selected more than once (e.g. via a symlink plus its real path). Select it once; shadow runs at most one cycle per bound host per workspace.',
      );
      continue;
    }
    if (entry.verdict !== 'authorized') {
      refuse(
        `workspace_not_authorized:${entry.verdict}${entry.reason !== undefined ? `:${entry.reason}` : ''}`,
        entry.nextAction ?? 'Fix the workspace registration/on-disk state; only authorized workspaces may run a shadow cycle.',
      );
      continue;
    }
    // Owner admission (§8.4 read-only projection): shadow runs ONLY on
    // legacy-owned workspaces — the old consumer stays the unique automatic
    // lifecycle owner and NO marker transition ever happens here.
    const owner = projectWorkspaceOwnerAliases(manifestRead.manifest, entry.sources.filter((s) => s.source === 'manifest').map((s) => s.path), process.platform);
    if (owner.effectiveOwner !== 'legacy' || owner.state !== 'legacy_owned') {
      refuse(
        `shadow_requires_legacy_owned_workspace:${owner.state}:${owner.effectiveOwner}`,
        'This workspace is not in the plain legacy-owned state (§8.4); Phase 2 shadow never touches handover/rollback/service-host-owned workspaces. Reconcile the backgroundExecutions record first.',
      );
      continue;
    }

    dispatchedIdentities.add(requestedIdentity);
    const descriptor = buildDescriptor(entry);
    const hostKinds = options.hostFilter !== undefined ? [options.hostFilter] : [...WORKER_HOST_KINDS];
    const previousAt = previousProgress.at.get(requestedIdentity);
    const hadPrevious = previousProgress.at.has(requestedIdentity);
    // Shared bounded dispatch (workspace-dispatch): one monotonic budget for
    // the WHOLE workspace, serial bound adapters, abort checks before every
    // dispatch — identical semantics in shadow and managed modes.
    const dispatch = await dispatchWorkspaceAdapters({
      workspaceDir: entry.canonicalDir,
      descriptor,
      hostKinds,
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
      if (outcome.kind === 'unsupported') continue; // not binding evidence for THIS host; other hosts may still run
      supportedAny = true;
      if (outcome.kind === 'budget_exhausted') {
        executions.push({
          requestedDir: requested,
          canonicalDir: entry.canonicalDir,
          hostKind,
          admission: 'admitted',
          workspaceState: 'failed',
          refusalReason: 'workspace_timeout_budget_exhausted',
          refusalNextAction: 'The per-workspace timeout budget was consumed by an earlier adapter cycle on this workspace; raise --timeout-ms or select hosts in separate runs.',
          lastProgressAt: previousAt ?? null,
          lastProgressSource: hadPrevious ? 'previous_run' : null,
        });
        continue;
      }
      if (outcome.kind === 'adapter_threw') {
        executions.push({
          requestedDir: requested,
          canonicalDir: entry.canonicalDir,
          hostKind,
          admission: 'admitted',
          workspaceState: 'failed',
          lastProgressAt: previousAt ?? null,
          lastProgressSource: hadPrevious ? 'previous_run' : null,
          refusalReason: `adapter_threw:${outcome.sanitizedMessage}`,
          refusalNextAction: 'The Worker Adapter threw before returning a structured result; inspect the adapter and workspace state, then re-run the shadow cycle.',
        });
        continue;
      }
      const carried = carriedProgress(outcome.result, previousAt);
      executions.push({
        requestedDir: requested,
        canonicalDir: entry.canonicalDir,
        hostKind,
        admission: 'admitted',
        workspaceState: workspaceStateFor(outcome.result.cycleOutcome),
        ...carried,
        execution: outcome.result,
      });
    }
    if (!supportedAny) {
      // The abort landed between the workspace gate and the first adapter
      // dispatch — skip this workspace entirely rather than recording a
      // refusal the workspace never earned.
      if (isAborted()) break;
      const supported = hostKinds.join('|');
      refuse(
        `no_adapter_supports_workspace:${supported}`,
        'No Worker Adapter accepted this workspace (no validated host binding — claim or host-tool declaration — for the selected host kind). host.* feature flags are not identity evidence.',
      );
    }
  }

  if (!context.holdsLock(context.handle)) return lockLost();

  // ── Progress projection merge (F6): this run's evidenced values overwrite
  // by key; every other workspace's entry survives (A→B→A / dry-run-in-between
  // keep their recorded progress). The merge runs while the install lock is
  // held; a write failure is surfaced in nextAction but does NOT fabricate
  // per-workspace values (rc-9).
  const progressUpdates = new Map<string, ShadowProgressEntry>();
  const nowIso = new Date().toISOString();
  for (const record of executions) {
    if (record.admission === 'admitted' && record.canonicalDir !== null
      && record.lastProgressAt !== null
      && (record.lastProgressSource === 'task_state_change' || record.lastProgressSource === 'cycle_evidence')) {
      progressUpdates.set(workspaceIdentity(record.canonicalDir), {
        lastProgressAt: record.lastProgressAt,
        source: record.lastProgressSource,
        updatedAt: nowIso,
      });
    }
  }
  const progressCarryVerdict: ShadowProgressVerdict = previousProgress.verdict;
  let progressWriteNote = '';
  if (progressUpdates.size > 0) {
    const merged = mergeShadowProgress(identity.pdHome, progressUpdates);
    if (!merged.ok) {
      progressWriteNote = ` Additionally, the cross-run progress projection could not be updated (${merged.reason}); the status below is still truthful for this run.`;
    }
  }

  const status = buildShadowStatus({
    identity,
    runId: context.runId,
    startedAt: context.startedAt,
    completedAt: new Date(),
    activeRelease,
    manifest: manifestSection(manifestRead),
    discovery,
    hostRoots,
    bindingDiagnostics: readDiagnostics,
    requested: options.workspaces,
    ...(options.hostFilter !== undefined ? { hostFilter: options.hostFilter } : {}),
    timeoutMs,
    executions,
    progressCarryVerdict,
    nextAction: `${shadowNextAction(executions)}${progressWriteNote}`,
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
 * Execute one bounded shadow run. Never throws for expected refusals —
 * everything expected is a structured result (rc-9).
 */
export async function runServiceShadowOnce(options: ShadowRunOptions): Promise<ShadowRunResult> {
  const runId = randomUUID();
  const startedAt = new Date();
  const env = options.env ?? process.env;

  // Explicit selection is REQUIRED — "run everything discovered" is not a
  // Phase 2 mode (task §9: default-off, explicit, bounded).
  const requested = options.workspaces.filter((dir) => dir.trim().length > 0);
  if (requested.length === 0) {
    return {
      ok: false,
      outcome: 'refused',
      runId,
      reason: 'shadow_requires_explicit_workspace',
      nextAction: 'Shadow mode requires one or more explicit --workspace <dir> selections; Phase 2 never runs all discovered workspaces by default.',
    };
  }

  // F1 review fix: shadow resolves host roots from the TRUSTED HOME only —
  // inherited OPENCLAW_STATE_DIR / CODEX_HOME / WORKBUDDY_CONFIG_DIR overrides
  // can never steer discovery NOR the child env pins toward an experiment or
  // foreign root (TD §5.2). The dry-run keeps the shared production
  // precedence; the ignored overrides are recorded in the env view.
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
        nextAction: 'Another run-once coordinator holds the install-level lock. Wait for it to finish; do not start a second instance.',
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
  };

  let result: ShadowRunResult;
  let runError: unknown;
  let runThrew = false;
  try {
    result = await completeShadowRun(identity, {
      runId,
      startedAt,
      handle,
      env,
      options: { ...options, workspaces: requested },
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
  const release = releaseLock(handle);
  const releaseFailed = release === 'failed_busy' || release === 'failed_unwritable';
  if (runThrew) {
    if (releaseFailed) {
      console.error(`pd service run-once (shadow): lock release also failed (${release}) after the run error`);
    }
    throw runError;
  }
  if (releaseFailed) {
    if (result.outcome === 'completed') {
      return {
        ok: false,
        outcome: 'refused',
        runId,
        reason: `service_run_lock_release_failed:${release === 'failed_busy' ? 'busy' : 'unwritable'}`,
        nextAction:
          'The shadow run finished but its run lock could not be released through the arbitration gate. ' +
          'The leftover lock carries a dead-holder PID once this process exits, so the next run recovers ' +
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
