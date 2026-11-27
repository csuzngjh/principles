/**
 * Worker consumption gate + per-cycle run mutex wiring for the Codex and
 * WorkBuddy workspace workers (PRI-1278 Phase 5 consumer-safety substrate).
 *
 * The same `pd <host> worker` command serves all three drivers — manual,
 * Companion (continuous resident loop) and the Service Host (spawned
 * `--once` child) — so this is the one layer that can enforce the §8.4
 * consumption rules for every driver at once:
 *
 *   - Ownership gate: legacy drivers (manual/companion) consume only while
 *     the workspace is `legacy_owned`; once a handover begins
 *     (`handover_preparing` / `rollback_pending`) or completes
 *     (`service_host_owned`) the legacy consumer must never touch the task
 *     store again. The Service-Host driver consumes `legacy_owned` (the
 *     shadow validation path is designed to converge with the still-owning
 *     legacy consumer through durable-lease fencing) and `service_host_owned`,
 *     but never a mid-transition state. An unreadable owner marker fails
 *     closed (degraded) for every driver.
 *   - Per-workspace run mutex: acquired around EACH individual cycle, never
 *     for the process lifetime — a drained Companion worker must hold no
 *     lock between cycles so handover/rollback can prove quiescence through
 *     holder-PID liveness (OpenClaw worker precedent, PRI-1282).
 *
 * This module reuses the existing service-run lock and the install-layout
 * ownership projection; it is NOT a second lease, lock or state machine.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { readWorkspaceBackgroundOwnership, resolvePdHome } from '@principles/install-layout';
import {
  acquireWorkspaceServiceRunLock,
  releaseServiceRunLock,
  type ServiceRunLockHandle,
} from './locking/service-run-lock.js';

export type WorkerConsumptionDriver = 'companion' | 'service_host' | 'manual';

export type WorkerConsumptionVerdict =
  | { readonly kind: 'consume' }
  | { readonly kind: 'paused'; readonly reason: string; readonly nextAction: string }
  | { readonly kind: 'degraded'; readonly reason: string; readonly nextAction: string };

export interface WorkerConsumptionGateOptions {
  readonly hostKind: 'codex' | 'workbuddy';
  readonly workspaceDir: string;
  readonly driver: WorkerConsumptionDriver;
  readonly manifestPath: string;
  /** Test seam: ownership projection override (default: real manifest read). */
  readonly ownership?: () => ReturnType<typeof readWorkspaceBackgroundOwnership>;
}

/**
 * Evaluate the driver × ownership-state matrix WITHOUT consuming anything.
 * Pure read + verdict — callers decide how to report a refusal.
 */
export function evaluateWorkerConsumptionGate(options: WorkerConsumptionGateOptions): WorkerConsumptionVerdict {
  const ownership = options.ownership !== undefined
    ? options.ownership()
    : readWorkspaceBackgroundOwnership({ manifestPath: options.manifestPath, workspaceDir: options.workspaceDir });
  if (ownership.status === 'manifest_unreadable') {
    return {
      kind: 'degraded',
      reason: `${options.hostKind}_owner_marker_unreadable:${ownership.reason}`,
      nextAction: ownership.nextAction,
    };
  }
  if (options.driver !== 'service_host') {
    if (ownership.status === 'legacy_owned') return { kind: 'consume' };
    return {
      kind: 'paused',
      reason: `legacy_consumption_blocked:${ownership.status}`,
      nextAction: 'This workspace is in or past the Service Host handover — the legacy consumer must not run governance cycles on it. Complete or roll back the handover (`pd service handover` / `pd service rollback`); do not restart the legacy worker for this workspace.',
    };
  }
  if (ownership.status === 'legacy_owned' || ownership.status === 'service_host_owned') return { kind: 'consume' };
  return {
    kind: 'paused',
    reason: `service_host_consumption_blocked:${ownership.status}`,
    nextAction: 'The workspace ownership is mid-transition; the Service Host may only consume it after the handover CAS completes. Retry once the handover or rollback finishes.',
  };
}

export interface WorkerConsumptionCycle {
  readonly verdict: WorkerConsumptionVerdict;
  /** Present only when the verdict is `consume` and the mutex was taken. */
  readonly lockHandle: ServiceRunLockHandle | null;
  readonly pdHome: string | null;
}

export interface BeginWorkerConsumptionOptions {
  readonly hostKind: 'codex' | 'workbuddy';
  readonly workspaceDir: string;
  readonly driver: WorkerConsumptionDriver;
  /** Test seams. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly ownership?: () => ReturnType<typeof readWorkspaceBackgroundOwnership>;
  readonly acquireLock?: typeof acquireWorkspaceServiceRunLock;
  readonly pdHomeExists?: (pdHome: string) => boolean;
}

/**
 * Resolve the PD home (coordinator-pinned env first, then the trusted
 * resolution chain — the OpenClaw worker precedent), evaluate the gate and,
 * only when consumption is legitimate, take the per-workspace run mutex for
 * this one cycle. When no PD home exists yet there is no install manifest,
 * hence no service_host_owned marker and nothing the lock could arbitrate —
 * the cycle runs unlocked and the gate's own legacy_owned/no-record default
 * applies (same OpenClaw reasoning; acquiring would mkdir <pdHome>/service/
 * as a pure side effect, which is reserved for the installer).
 */
export function beginWorkerConsumptionCycle(options: BeginWorkerConsumptionOptions): WorkerConsumptionCycle {
  const env = options.env ?? process.env;
  const pinned = env.PD_SERVICE_PD_HOME;
  const home = pinned !== undefined && pinned.trim().length > 0
    ? { ok: true as const, pdHome: pinned }
    : resolvePdHome({ env });
  if (!home.ok) {
    return {
      verdict: {
        kind: 'degraded',
        reason: `pd_home_resolution_refused:${home.reason}`,
        nextAction: home.nextAction,
      },
      lockHandle: null,
      pdHome: null,
    };
  }
  const { pdHome } = home;
  const manifestPath = path.join(pdHome, 'install.json');
  const verdict = evaluateWorkerConsumptionGate({
    hostKind: options.hostKind,
    workspaceDir: options.workspaceDir,
    driver: options.driver,
    manifestPath,
    ...(options.ownership !== undefined ? { ownership: options.ownership } : {}),
  });
  if (verdict.kind !== 'consume') return { verdict, lockHandle: null, pdHome };

  const exists = options.pdHomeExists ?? ((dir: string) => fs.existsSync(dir));
  if (!exists(pdHome)) return { verdict, lockHandle: null, pdHome };

  const acquire = options.acquireLock ?? acquireWorkspaceServiceRunLock;
  const lock = acquire(pdHome, options.workspaceDir);
  if (!lock.ok) {
    const held = lock.kind === 'held';
    return {
      verdict: {
        kind: held ? 'paused' : 'degraded',
        reason: held ? `${options.hostKind}_worker_run_in_progress` : `workspace_run_lock_unavailable:${lock.kind}`,
        nextAction: held
          ? 'Another worker cycle is still consuming this workspace; wait for it to finish (cycles are bounded) and retry.'
          : 'The workspace run mutex could not be verified; refusing to start a second consumer. Check the lock file under <pdHome>/service/workspace-runs/.',
      },
      lockHandle: null,
      pdHome,
    };
  }
  return { verdict, lockHandle: lock.handle, pdHome };
}

/** Release the per-cycle mutex. Never throws — a release failure is logged by the lock module itself. */
export function endWorkerConsumptionCycle(cycle: WorkerConsumptionCycle): void {
  if (cycle.lockHandle !== null) releaseServiceRunLock(cycle.lockHandle);
}
