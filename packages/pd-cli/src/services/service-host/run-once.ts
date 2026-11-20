/**
 * The run-once coordinator (SPEC-PD-SERVICE-HOST-001 §8.2, TD §5).
 *
 * One bounded execution: resolve install identity, acquire the install
 * single-instance lock, verify the active release, read and parse the
 * install manifest (a read failure is NEVER a zero-Workspace result),
 * collect validated per-host claims, discover and validate Workspaces,
 * project each Workspace's owner state (read-only), persist the versioned
 * operational status, release the lock.
 *
 * Phase 1 admission boundary (SPEC §11): dry-run only, NO Worker is started,
 * NO consumer ownership changes, NO manifest write, no OS scheduler. The
 * only writes are the expected run metadata: the lock protocol's transient
 * lock file and the operational status file, both under the PD-owned
 * service directory of the resolved install root.
 */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  collectHostWorkspaceClaims,
  parseInstallManifest,
  type HostClaimOptions,
  type InstallManifest,
} from '@principles/install-layout';
import {
  resolveCoordinatorInstallIdentity,
  type InstallIdentity,
} from './install-identity.js';
import { discoverWorkspaces, type WorkspaceDiscoveryResult } from './workspace-discovery.js';
import {
  acquireServiceRunLock,
  holdsServiceRunLock,
  releaseServiceRunLock,
  serviceRunLockPath,
  type HolderLiveness,
  type ServiceRunLockHandle,
} from './locking/service-run-lock.js';
import {
  readActiveReleaseFacts,
  writeServiceRunStatus,
  type ActiveReleaseFacts,
  type HostRootReport,
  type ServiceRunStatus,
} from './status/service-run-status.js';

export { SERVICE_RUN_STATUS_SCHEMA_VERSION, serviceRunStatusPath } from './status/service-run-status.js';

export interface RunOnceOptions {
  /** Environment for identity resolution; defaults to process.env. Injected by tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * A caller-pinned trusted home (absolute path) for identity resolution —
   * same authority contract as `resolveCoordinatorInstallIdentity`. Never
   * derived from env.
   */
  readonly trustedHomeDir?: string;
  /** Injectable boundaries for tests; production uses the defaults. */
  readonly probes?: {
    /** Lock-holder liveness probe (default: `process.kill(pid, 0)`). */
    readonly processAlive?: (pid: number) => HolderLiveness;
    /**
     * Mid-run lock ownership re-check (default: `holdsServiceRunLock`).
     * Called before every protected status write.
     */
    readonly holdsLock?: (handle: ServiceRunLockHandle) => boolean;
  };
}

/** The three possible run results; every field is structured (rc-9). */
export type RunOnceResult =
  | {
      readonly ok: true;
      readonly outcome: 'completed';
      readonly runId: string;
      readonly identity: InstallIdentity;
      readonly activeRelease: ActiveReleaseFacts;
      readonly manifest: ServiceRunStatus['manifest'];
      readonly discovery: WorkspaceDiscoveryResult;
      /** Persisted status file path, or the structured write failure (rc-9). */
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
      /** Present when the truthful refusal status could NOT be persisted (rc-9). */
      readonly statusWrite?:
        | { readonly ok: true; readonly path: string }
        | { readonly ok: false; readonly reason: string; readonly nextAction: string };
    };

/** Read + parse the manifest with the five task-required verdicts. */
function readManifest(identity: InstallIdentity): {
  manifest: InstallManifest | undefined;
  verdict: ServiceRunStatus['manifest']['verdict'];
  reason?: string;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(identity.manifestPath, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
      ? String(Reflect.get(error, 'code'))
      : '';
    if (code === 'ENOENT') {
      return { manifest: undefined, verdict: 'missing', reason: 'install_manifest_missing' };
    }
    return {
      manifest: undefined,
      verdict: 'read_failed',
      reason: code !== '' ? `install_manifest_read_failed:${code}` : 'install_manifest_read_failed',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { manifest: undefined, verdict: 'unparsable', reason: `install_manifest_unparsable:${message.slice(0, 120)}` };
  }
  const result = parseInstallManifest(parsed);
  if (result.manifest === undefined) {
    const error = result.error ?? 'install_manifest_malformed';
    return {
      manifest: undefined,
      verdict: error.startsWith('install_manifest_unsupported_version') ? 'version_mismatch' : 'invalid',
      reason: error,
    };
  }
  return { manifest: result.manifest, verdict: 'ok' };
}

/** Empty discovery counts for refusal statuses. */
function zeroCounts(): WorkspaceDiscoveryResult['counts'] {
  return { authorized: 0, degraded: 0, unavailable: 0, conflicting: 0, invalid: 0, discovered: 0 };
}

/** Build the empty discovery result used by refusal statuses. */
function buildEmptyDiscovery(): WorkspaceDiscoveryResult {
  return { workspaces: [], discoveredTotal: 0, counts: zeroCounts() };
}

/**
 * Per-host root report (P1-2): for every host, which root the claims
 * collector consulted, whether it came from an env override, and whether it
 * was actually readable. An unreadable env-selected root is surfaced, never
 * silently folded into "no workspaces".
 */
function hostRootReports(
  identity: InstallIdentity,
  env: Readonly<Record<string, string | undefined>>,
): HostRootReport[] {
  const hasEnv = (name: string): boolean => {
    const value = env[name];
    return value !== undefined && value.trim().length > 0;
  };
  const roots: { host: HostRootReport['host']; root: string; source: HostRootReport['source'] }[] = [
    {
      host: 'openclaw',
      root: identity.hostRoots.openclawHome,
      source: hasEnv('OPENCLAW_STATE_DIR') || hasEnv('OPENCLAW_HOME') ? 'env' : 'default',
    },
    { host: 'codex', root: identity.hostRoots.codexHome, source: hasEnv('CODEX_HOME') ? 'env' : 'default' },
    {
      host: 'workbuddy',
      root: identity.hostRoots.workbuddyConfigDir,
      source: hasEnv('WORKBUDDY_CONFIG_DIR') ? 'env' : 'default',
    },
  ];
  return roots.map((entry) => {
    let status: HostRootReport['status'];
    try {
      status = fs.statSync(entry.root).isDirectory() ? 'readable' : 'not_directory';
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
          ? String(Reflect.get(error, 'code'))
          : '';
      status = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
    }
    return { ...entry, status };
  });
}

/** The operator-facing next action for a completed dry-run. */
function completedNextAction(discovery: WorkspaceDiscoveryResult, hostRoots: readonly HostRootReport[]): string {
  // An env-selected host root that could not be read is a finding of its
  // own (P1-2): workspaces under it were NOT silently absent — say so.
  const blocked = hostRoots.filter((r) => r.source === 'env' && (r.status === 'unreadable' || r.status === 'not_directory'));
  const rootNote = blocked.length > 0
    ? ` Host root(s) ${blocked.map((r) => `${r.host}=${r.root} (${r.status})`).join(', ')} were selected by env override but are not readable — workspaces under them were not discoverable; fix or unset the override.`
    : '';
  if (discovery.counts.authorized === 0 && discovery.discoveredTotal > 0) {
    const countsSummary = Object.entries(discovery.counts)
      .map(([verdict, count]) => `${verdict}=${count}`)
      .join(' ');
    return `No workspace is currently authorized (counts: ${countsSummary}); check the per-workspace reasons below.${rootNote}`;
  }
  if (discovery.counts.conflicting > 0 || discovery.counts.invalid > 0) {
    return `Fix the conflicting/invalid workspaces listed below before any future worker phase.${rootNote}`;
  }
  if (rootNote !== '') {
    return `Discovery dry-run complete.${rootNote} Phase 1 starts no worker.`;
  }
  return 'Discovery dry-run complete. Phase 1 starts no worker; the next phase (PRI-1280) introduces bounded real cycles behind handover gates.';
}

/** Assemble the versioned status document. */
function buildStatus(args: {
  identity: InstallIdentity;
  runId: string;
  startedAt: Date;
  completedAt: Date;
  outcome: ServiceRunStatus['outcome'];
  activeRelease: ActiveReleaseFacts;
  manifest: ServiceRunStatus['manifest'];
  discovery: WorkspaceDiscoveryResult;
  hostRoots: readonly HostRootReport[];
  nextAction: string;
}): ServiceRunStatus {
  return {
    schemaVersion: 'pd.service-run-status.v1',
    runId: args.runId,
    outcome: args.outcome,
    dryRun: true,
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
    },
    manifest: args.manifest,
    discovery: {
      discoveredTotal: args.discovery.discoveredTotal,
      counts: args.discovery.counts,
      hostRoots: args.hostRoots,
    },
    workspaces: args.discovery.workspaces,
    nextAction: args.nextAction,
  };
}

function completeRun(
  identity: InstallIdentity,
  context: {
    runId: string;
    startedAt: Date;
    staleTakenOver: boolean;
    handle: ServiceRunLockHandle;
    env: Readonly<Record<string, string | undefined>>;
    holdsLock: (handle: ServiceRunLockHandle) => boolean;
  },
): RunOnceResult {
  const hostRoots = hostRootReports(identity, context.env);

  /**
   * Mid-run ownership check (P1-4): before EVERY protected status write the
   * run must still hold the lock it acquired. If it was taken over, the run
   * stops — a holder that lost its lock may never write operational state
   * on behalf of the install it no longer owns.
   */
  const lockLost = (): RunOnceResult => ({
    ok: false,
    outcome: 'refused',
    runId: context.runId,
    reason: 'service_run_lock_lost',
    nextAction:
      'The install-level run lock was taken over mid-run, so the run stopped before writing status. ' +
      'Inspect the current holder and re-run; do not treat this run\'s discovery as authoritative.',
  });

  const manifestSection = (read: ReturnType<typeof readManifest>): ServiceRunStatus['manifest'] =>
    read.manifest === undefined
      ? {
          verdict: read.verdict,
          ...(read.reason !== undefined ? { reason: read.reason } : {}),
          hosts: [],
          unknownHosts: [],
          workspacesCount: 0,
        }
      : {
          verdict: 'ok',
          hosts: [...read.manifest.hosts, ...(read.manifest.unknownHosts ?? [])],
          unknownHosts: [...(read.manifest.unknownHosts ?? [])],
          workspacesCount: (read.manifest.workspaces ?? []).length,
        };

  const persistRefusal = (args: {
    reason: string;
    nextAction: string;
    activeRelease: ActiveReleaseFacts;
    manifest?: ServiceRunStatus['manifest'];
    discovery?: WorkspaceDiscoveryResult;
  }): RunOnceResult => {
    if (!context.holdsLock(context.handle)) return lockLost();
    const status = buildStatus({
      identity,
      runId: context.runId,
      startedAt: context.startedAt,
      completedAt: new Date(),
      outcome: 'refused',
      activeRelease: args.activeRelease,
      manifest: args.manifest ?? { verdict: 'ok', hosts: [], unknownHosts: [], workspacesCount: 0 },
      discovery: args.discovery ?? buildEmptyDiscovery(),
      hostRoots,
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

  // ── 3. Active release — verified against the authoritative schema (P1-3).
  //    A record that parses but is not the installer's record is a REFUSAL,
  //    never a completed run over a fake install.
  const activeRelease = readActiveReleaseFacts(identity.activeRecordPath);

  // ── 4. Manifest: read failures are NEVER a zero-Workspace result ──
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
    // Fail-closed: refuse the run (and persist a truthful status) — an
    // unreadable or malformed manifest must not be reported as an empty install.
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
  const manifest: InstallManifest = manifestRead.manifest;

  // ── 5. Validated per-host claims over ALL resolved host roots (P1-2).
  //    Custom roots (env overrides) reach the collector so workspaces under
  //    them are discoverable; they can never steer pdHome itself.
  const claimOptions: HostClaimOptions = {
    homeDir: identity.homeDir,
    codexHome: identity.hostRoots.codexHome,
    openclawHome: identity.hostRoots.openclawHome,
    workbuddyConfigDir: identity.hostRoots.workbuddyConfigDir,
    platform: process.platform,
  };
  const claims = collectHostWorkspaceClaims(claimOptions);

  // ── 6. Discovery + per-workspace owner projection ──
  const discovery = discoverWorkspaces({ manifest, claims, claimOptions });

  // ── 7. Persist status; lock release stays in the caller's finally ──
  if (!context.holdsLock(context.handle)) return lockLost();
  const status = buildStatus({
    identity,
    runId: context.runId,
    startedAt: context.startedAt,
    completedAt: new Date(),
    outcome: 'completed',
    activeRelease,
    manifest: manifestSection(manifestRead),
    discovery,
    hostRoots,
    nextAction: completedNextAction(discovery, hostRoots),
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
    statusWrite,
    status,
  };
}

/**
 * Execute one bounded run-once (dry-run). Never throws for expected
 * refusals — everything expected is a structured result; only a genuine bug
 * escapes as an exception.
 */
export function runServiceRunOnce(options: RunOnceOptions = {}): RunOnceResult {
  const runId = randomUUID();
  const startedAt = new Date();
  const env = options.env ?? process.env;

  // ── 1. Install identity (production-forced; env-derived homes refused) ──
  const identityResult = resolveCoordinatorInstallIdentity(env, {
    ...(options.trustedHomeDir !== undefined ? { trustedHomeDir: options.trustedHomeDir } : {}),
  });
  if (!identityResult.ok) {
    return { ok: false, outcome: 'refused', runId, reason: identityResult.reason, nextAction: identityResult.nextAction };
  }
  const { identity } = identityResult;

  // ── 2. Install-level single-instance lock ──
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
        ? [
            'Inspect the run lock by hand at',
            lockPathForMessage,
            '— a lock this old must stay verifiable before any coordinator may run.',
          ].join(' ')
        : 'Check the permissions of the PD service directory and retry.',
    };
  }
  const handle: ServiceRunLockHandle = lock.handle;
  try {
    return completeRun(identity, {
      runId,
      startedAt,
      staleTakenOver: lock.staleTakenOver,
      handle,
      env,
      holdsLock: options.probes?.holdsLock ?? holdsServiceRunLock,
    });
  } finally {
    releaseServiceRunLock(handle);
  }
}

