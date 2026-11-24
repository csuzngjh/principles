/**
 * The unified read-only Service Host status contract (SPEC §7/§8, task §5) —
 * ONE document Companion/Console/the CLI all read. Every clause derives from
 * its OWN witness (ERR-182):
 *
 *   registered / enabled / triggerInterval / OS lastRun  ← the OS scheduler
 *   lastRun / lastOutcome / mode / triggerSource          ← <pdHome>/service/run-once-status.json
 *   lastProgressAt                                        ← the cross-run progress store
 *   workspace owner states                                ← a fresh read-only discovery
 *
 * The composition NEVER starts a Worker, NEVER writes business data, and
 * never lets one witness stand in for another (registered ≠ enabled ≠
 * running ≠ completed ≠ business_progress). A witness that cannot be read is
 * reported as degraded/unreadable — permission denial is never reported as
 * "not installed".
 */
import { collectHostWorkspaceClaims, type BindingReadDiagnostic, type HostClaimReaders } from '@principles/install-layout';
import type { InstallIdentity } from '../install-identity.js';
import { readManifest, claimOptionsFor, defaultListDir, hostRootReports, discoveryIncompleteRoots } from '../coordinator-common.js';
import { discoverWorkspaces, type WorkspaceDiscoveryEntry } from '../workspace-discovery.js';
import { readShadowProgress } from '../shadow-progress-store.js';
import {
  readActiveReleaseFacts,
  readServiceRunStatus,
  type ActiveReleaseFacts,
  type ServiceRunStatus,
} from '../status/service-run-status.js';
import { runSchedulerLifecycle, type SchedulerLifecycleOptions, type SchedulerLifecycleResult } from './index.js';

export const SERVICE_HOST_STATUS_SCHEMA_VERSION = 'pd.service-status.v1';

export interface ServiceHostStatusWorkspace {
  readonly canonicalDir: string;
  readonly discoveryVerdict: WorkspaceDiscoveryEntry['verdict'];
  readonly ownerState: string;
  readonly effectiveOwner: string;
  readonly hosts: readonly string[];
  /**
   * PRI-1278 Phase 5: a Service-Host-only install legitimately owns a
   * workspace with NO host binding. That is not an error — it is the honest
   * `waiting_for_host_binding` state, never a fabricated worker capability.
   */
  readonly hostBindingState: 'bound' | 'waiting_for_host_binding';
}

export interface ServiceHostStatusDocument {
  readonly schemaVersion: typeof SERVICE_HOST_STATUS_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly installation: {
    readonly pdHome: string;
    readonly homeDir: string;
    readonly homeSource: InstallIdentity['homeSource'];
    readonly mode: InstallIdentity['mode'];
    readonly activeRelease: ActiveReleaseFacts;
  };
  readonly platform: string;
  readonly scheduler: {
    /** The platform adapter ran and reported facts. false = unavailable/failed (reason present). */
    readonly available: boolean;
    readonly registered: boolean | null;
    readonly enabled: boolean | null;
    readonly taskName: string | null;
    /** What this install's registration invokes (trusted: verified against the OS state when registered). */
    readonly triggerConfiguration: {
      readonly intervalMs: number | null;
      readonly nodePath: string | null;
      readonly cliEntry: string | null;
    } | null;
    /** OS-level witness (distinct from the run-once status file). */
    readonly osLastRunAt: string | null;
    readonly osLastResult: string | null;
    /** OS loaded/running witness — independent from enabled (task §9). */
    readonly osActive: boolean | null;
    readonly reason?: string;
    readonly nextAction?: string;
  };
  /** The latest persisted run-once outcome (file witness). */
  readonly lastRun: {
    readonly runId: string;
    readonly outcome: ServiceRunStatus['outcome'];
    readonly mode: 'dry-run' | 'shadow' | 'managed' | 'unknown';
    readonly triggerSource: ServiceRunStatus['triggerSource'];
    /** 'scheduler'/'manual' is the run's SELF-DECLARED flag (task §11 review) —
     *  written by the run-once process itself, not verified OS evidence. */
    readonly triggerSourceCredibility: 'self-declared';
    readonly startedAt: string;
    readonly completedAt: string;
    readonly durationMs: number;
    readonly nextAction: string;
  } | null;
  readonly lastRunRead: 'ok' | 'missing' | 'unreadable' | 'corrupt';
  readonly lastRunReadDetail?: string;
  readonly lastProgressAt: string | null;
  readonly workspaces: readonly ServiceHostStatusWorkspace[];
  /** Every degraded/unreadable witness, each with its own reason (never folded away). */
  readonly degradedReasons: readonly string[];
  readonly nextAction: string;
}

export type ServiceHostStatusResult =
  | { readonly ok: true; readonly status: ServiceHostStatusDocument }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

export interface ServiceHostStatusOptions extends SchedulerLifecycleOptions {
  readonly claimReaders?: HostClaimReaders;
}

/**
 * Project ONE discovery entry into the status contract. Exported so the
 * `waiting_for_host_binding` rule (PRI-1278 Phase 5) is testable without
 * touching the real OS scheduler.
 */
export function toServiceHostStatusWorkspace(entry: WorkspaceDiscoveryEntry): ServiceHostStatusWorkspace {
  return {
    canonicalDir: entry.canonicalDir,
    discoveryVerdict: entry.verdict,
    ownerState: entry.owner.state,
    effectiveOwner: entry.owner.effectiveOwner,
    hosts: [...entry.hosts],
    hostBindingState: entry.hosts.length > 0 ? 'bound' : 'waiting_for_host_binding',
  };
}

function lastRunModeOf(status: ServiceRunStatus): 'dry-run' | 'shadow' | 'managed' | 'unknown' {
  if (status.dryRun) return 'dry-run';
  if (status.managed !== undefined) return 'managed';
  if (status.shadow !== undefined) return 'shadow';
  return 'unknown';
}

/**
 * Compose the unified status document. Read-only: this path takes no lock,
 * starts no Worker and writes no business data.
 */
export async function composeServiceHostStatus(options: ServiceHostStatusOptions): Promise<ServiceHostStatusResult> {
  const lifecycle: SchedulerLifecycleResult = await runSchedulerLifecycle('status', options);
  // Capture the union's failure arm once — TypeScript cannot narrow
  // `lifecycle.identity === undefined` across the two variants.
  const schedulerFailure: { reason: string; nextAction: string } | null = lifecycle.ok
    ? null
    : { reason: lifecycle.reason, nextAction: lifecycle.nextAction };
  if (lifecycle.identity === undefined) {
    // Identity-level refusal — nothing else can be reported truthfully.
    return { ok: false, reason: lifecycle.ok ? 'status_unavailable' : schedulerFailure?.reason ?? 'status_unavailable', nextAction: schedulerFailure?.nextAction ?? 'Retry pd service status.' };
  }
  const identity: InstallIdentity = lifecycle.identity;

  const degradedReasons: string[] = [];

  // ── Scheduler witness (OS truth) ──
  const scheduler: ServiceHostStatusDocument['scheduler'] = lifecycle.ok
    ? {
        available: true,
        registered: lifecycle.facts.registered,
        enabled: lifecycle.facts.enabled,
        taskName: lifecycle.facts.taskName,
        triggerConfiguration: {
          intervalMs: lifecycle.facts.triggerIntervalMs ?? null,
          nodePath: lifecycle.registration.nodePath,
          cliEntry: lifecycle.registration.cliEntry,
        },
        osLastRunAt: lifecycle.facts.lastRunAt,
        osLastResult: lifecycle.facts.lastResult,
        osActive: lifecycle.facts.active ?? null,
      }
    : {
        available: false,
        registered: null,
        enabled: null,
        taskName: null,
        triggerConfiguration: null,
        osLastRunAt: null,
        osLastResult: null,
        osActive: null,
        ...(schedulerFailure !== null ? { reason: schedulerFailure.reason, nextAction: schedulerFailure.nextAction } : {}),
      };
  if (schedulerFailure !== null) {
    // The scheduler witness failed (unavailable/permission/query) — the rest
    // of the document stays truthful and the failure is explicit.
    degradedReasons.push(`scheduler:${schedulerFailure.reason}`);
  } else if (lifecycle.ok && lifecycle.facts.degradedReasons !== undefined) {
    // Per-witness unreadable reasons from the OS probes (task §9): a
    // partially-readable registration is degraded, not silently healthy.
    for (const reason of lifecycle.facts.degradedReasons) {
      degradedReasons.push(`scheduler:${reason}`);
    }
  }

  // ── Last-run witness (status file) ──
  const lastRunRead = readServiceRunStatus(identity.pdHome);
  const lastRunVerdict: ServiceHostStatusDocument['lastRunRead'] = lastRunRead.ok ? 'ok' : lastRunRead.verdict;
  const lastRunDetail: string | undefined = lastRunRead.ok ? undefined : lastRunRead.detail;
  const lastRun: ServiceHostStatusDocument['lastRun'] = lastRunRead.ok
    ? {
        runId: lastRunRead.status.runId,
        outcome: lastRunRead.status.outcome,
        mode: lastRunModeOf(lastRunRead.status),
        triggerSource: lastRunRead.status.triggerSource,
        triggerSourceCredibility: 'self-declared',
        startedAt: lastRunRead.status.startedAt,
        completedAt: lastRunRead.status.completedAt,
        durationMs: lastRunRead.status.durationMs,
        nextAction: lastRunRead.status.nextAction,
      }
    : null;
  if (lastRunVerdict === 'unreadable' || lastRunVerdict === 'corrupt') {
    degradedReasons.push(`last_run_status:${lastRunVerdict}:${lastRunDetail ?? 'unreadable'}`);
  }

  // ── Progress witness (cross-run store + this document's last managed run) ──
  let lastProgressAt: string | null = null;
  const progressRead = readShadowProgress(identity.pdHome);
  if (progressRead.ok) {
    for (const entry of progressRead.entries.values()) {
      if (entry.lastProgressAt !== null && (lastProgressAt === null || entry.lastProgressAt > lastProgressAt)) {
        ({ lastProgressAt } = entry);
      }
    }
  } else if (progressRead.verdict === 'corrupt' || progressRead.verdict === 'unreadable') {
    degradedReasons.push(`progress_store:${progressRead.verdict}`);
  }
  if (lastRunRead.ok && lastRunRead.status.managed !== undefined) {
    for (const record of lastRunRead.status.managed.executions) {
      if (record.lastProgressAt !== null && (lastProgressAt === null || record.lastProgressAt > lastProgressAt)) {
        ({ lastProgressAt } = record);
      }
    }
  }

  // ── Workspace owner-state witness (fresh read-only discovery) ──
  const activeRelease = readActiveReleaseFacts(identity.activeRecordPath);
  const manifestRead = readManifest(identity);
  let workspaces: ServiceHostStatusWorkspace[] = [];
  if (manifestRead.manifest !== undefined) {
    const readDiagnostics: BindingReadDiagnostic[] = [];
    const claimOptions = claimOptionsFor(identity, readDiagnostics, options.claimReaders);
    const claims = collectHostWorkspaceClaims(claimOptions);
    const discovery = discoverWorkspaces({ manifest: manifestRead.manifest, claims, claimOptions });
    workspaces = discovery.workspaces.map(toServiceHostStatusWorkspace);
    if (discoveryIncompleteRoots(hostRootReports(identity, defaultListDir)).length > 0) {
      degradedReasons.push('discovery:host_roots_incomplete');
    }
  } else if (manifestRead.verdict !== 'missing') {
    degradedReasons.push(`manifest:${manifestRead.verdict}`);
  }

  // ── nextAction: the most actionable witness gap wins ──
  let nextAction: string;
  if (schedulerFailure !== null) {
    ({ nextAction } = schedulerFailure);
  } else if (lifecycle.ok && lifecycle.facts.registered === null) {
    nextAction = 'The OS scheduler registration state could not be READ (see degradedReasons) — this is an unreadable witness, not "not installed". Fix the degraded scheduler source before trusting any other clause.';
  } else if (lifecycle.ok && lifecycle.facts.registered !== true) {
    nextAction = 'No OS scheduler registration exists for this install. Run pd service install (then pd service enable) to arm the automatic trigger.';
  } else if (lifecycle.ok && lifecycle.facts.enabled === null) {
    nextAction = 'The registration exists but its ENABLED state is unreadable (see degradedReasons). Automatic triggers may or may not be armed — fix the degraded witness before drawing a healthy conclusion.';
  } else if (lifecycle.ok && lifecycle.facts.enabled === false) {
    nextAction = 'The scheduler registration is installed but DISABLED — future automatic triggers are off by choice. Run pd service enable to arm them; nothing else is required.';
  } else if (lastRunVerdict === 'missing') {
    nextAction = 'The scheduler is registered but no run-once has completed yet. Wait for the next trigger (or run pd service run-once --json manually) and re-check.';
  } else if (degradedReasons.length > 0) {
    nextAction = `Status composed with degraded witnesses (${degradedReasons.join('; ')}). Each clause above reflects its own witness — fix the degraded sources for a fully healthy view.`;
  } else {
    nextAction = 'Service Host status is consistent: the scheduler is registered and enabled, and the latest run-once outcome is recorded above. registered/enabled/last-run/progress are independent facts — verify each against its own witness, not the others.';
  }

  return {
    ok: true,
    status: {
      schemaVersion: SERVICE_HOST_STATUS_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      installation: {
        pdHome: identity.pdHome,
        homeDir: identity.homeDir,
        homeSource: identity.homeSource,
        mode: identity.mode,
        activeRelease,
      },
      platform: process.platform,
      scheduler,
      lastRun,
      lastRunRead: lastRunVerdict,
      ...(lastRunDetail !== undefined ? { lastRunReadDetail: lastRunDetail } : {}),
      lastProgressAt,
      workspaces,
      degradedReasons,
      nextAction,
    },
  };
}
