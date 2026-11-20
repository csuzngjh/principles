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
  releaseServiceRunLock,
  serviceRunLockPath,
  type ServiceRunLockHandle,
} from './locking/service-run-lock.js';
import {
  readActiveReleaseFacts,
  writeServiceRunStatus,
  type ActiveReleaseFacts,
  type ServiceRunStatus,
} from './status/service-run-status.js';

export { SERVICE_RUN_STATUS_SCHEMA_VERSION, serviceRunStatusPath } from './status/service-run-status.js';

export interface RunOnceOptions {
  /** Environment for identity resolution; defaults to process.env. Injected by tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
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

/** The operator-facing next action for a completed dry-run. */
function completedNextAction(discovery: WorkspaceDiscoveryResult): string {
  if (discovery.counts.authorized === 0 && discovery.discoveredTotal > 0) {
    const countsSummary = Object.entries(discovery.counts)
      .map(([verdict, count]) => `${verdict}=${count}`)
      .join(' ');
    return `No workspace is currently authorized (counts: ${countsSummary}); check the per-workspace reasons below.`;
  }
  if (discovery.counts.conflicting > 0 || discovery.counts.invalid > 0) {
    return 'Fix the conflicting/invalid workspaces listed below before any future worker phase.';
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
    },
    manifest: args.manifest,
    discovery: {
      discoveredTotal: args.discovery.discoveredTotal,
      counts: args.discovery.counts,
    },
    workspaces: args.discovery.workspaces,
    nextAction: args.nextAction,
  };
}

function completeRun(
  identity: InstallIdentity,
  context: { runId: string; startedAt: Date; staleTakenOver: boolean },
): RunOnceResult {
  // ── 3. Active release (observational verification) ──
  const activeRelease = readActiveReleaseFacts(identity.activeRecordPath);

  // ── 4. Manifest: read failures are NEVER a zero-Workspace result ──
  const manifestRead = readManifest(identity);
  if (manifestRead.manifest === undefined) {
    // Fail-closed: refuse the run (and persist a truthful status) — an
    // unreadable or malformed manifest must not be reported as an empty install.
    const status = buildStatus({
      identity,
      runId: context.runId,
      startedAt: context.startedAt,
      completedAt: new Date(),
      outcome: 'refused',
      activeRelease,
      manifest: {
        verdict: manifestRead.verdict,
        ...(manifestRead.reason !== undefined ? { reason: manifestRead.reason } : {}),
        hosts: [],
        unknownHosts: [],
        workspacesCount: 0,
      },
      discovery: buildEmptyDiscovery(),
      nextAction:
        manifestRead.verdict === 'missing'
          ? 'Run npx create-principles-disciple to install PD (no manifest exists for this user-level install).'
          : 'Repair the install manifest with the PD installer/updater before running the coordinator; the run refused instead of treating the install as empty.',
    });
    return {
      ok: false,
      outcome: 'refused',
      runId: context.runId,
      reason: manifestRead.reason ?? 'install_manifest_invalid',
      nextAction: status.nextAction,
      statusWrite: writeServiceRunStatus(identity.pdHome, status),
    };
  }
  const manifest: InstallManifest = manifestRead.manifest;

  // ── 5. Validated per-host claims (source B, the existing fail-closed collector) ──
  const claimOptions: HostClaimOptions = {
    homeDir: identity.homeDir,
    platform: process.platform,
  };
  const claims = collectHostWorkspaceClaims(claimOptions);

  // ── 6. Discovery + per-workspace owner projection ──
  const discovery = discoverWorkspaces({ manifest, claims, claimOptions });

  // ── 7. Persist status; lock release stays in the caller's finally ──
  const status = buildStatus({
    identity,
    runId: context.runId,
    startedAt: context.startedAt,
    completedAt: new Date(),
    outcome: 'completed',
    activeRelease,
    manifest: {
      verdict: 'ok',
      hosts: [...manifest.hosts, ...(manifest.unknownHosts ?? [])],
      unknownHosts: [...(manifest.unknownHosts ?? [])],
      workspacesCount: (manifest.workspaces ?? []).length,
    },
    discovery,
    nextAction: completedNextAction(discovery),
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

  // ── 1. Install identity (production-forced; the experiment switch stripped) ──
  const identityResult = resolveCoordinatorInstallIdentity(options.env ?? process.env);
  if (!identityResult.ok) {
    return { ok: false, outcome: 'refused', runId, reason: identityResult.reason, nextAction: identityResult.nextAction };
  }
  const { identity } = identityResult;

  // ── 2. Install-level single-instance lock ──
  const lock = acquireServiceRunLock(identity.pdHome);
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
    return completeRun(identity, { runId, startedAt, staleTakenOver: lock.staleTakenOver });
  } finally {
    releaseServiceRunLock(handle);
  }
}

