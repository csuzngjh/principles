/**
 * Shared Service-Host admission gate for bounded host worker cycles.
 *
 * Consumption admission is binary by design: `service_host_owned` consumes;
 * every other readable ownership state pauses; an unreadable install manifest
 * degrades. The per-workspace mutex is held for the whole consuming cycle so
 * two bounded workers cannot overlap on one workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readWorkspaceBackgroundOwnership, resolvePdHome } from '@principles/install-layout';
import {
  acquireWorkspaceServiceRunLock,
  releaseServiceRunLock,
  type ServiceRunLockHandle,
} from '../services/service-host/locking/service-run-lock.js';

export type ServiceWorkerHostKind = 'codex' | 'workbuddy';

export interface ServiceWorkerGateResult {
  readonly workspaceDir: string;
  readonly mode: 'paused' | 'degraded';
  readonly reason: string;
  readonly nextAction: string;
}

export type ServiceWorkerGate =
  | { readonly admitted: true; readonly pdHome: string; readonly release: () => void }
  | { readonly admitted: false; readonly result: ServiceWorkerGateResult };

type PdHomeResolution =
  | { readonly ok: true; readonly pdHome: string }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

/** Coordinator-pinned PD home first, then the trusted resolvePdHome chain. */
export function resolveServiceWorkerPdHome(): PdHomeResolution {
  const pinnedPdHome = process.env.PD_SERVICE_PD_HOME;
  if (pinnedPdHome !== undefined && pinnedPdHome.trim().length > 0) {
    return { ok: true, pdHome: pinnedPdHome };
  }
  const home = resolvePdHome();
  if (!home.ok) {
    return {
      ok: false,
      reason: `pd_home_resolution_refused:${home.reason}`,
      nextAction: home.nextAction ?? 'Fix the PD home resolution (experiment root) before running the worker.',
    };
  }
  return { ok: true, pdHome: home.pdHome };
}

function ownershipNextAction(): string {
  return 'PD Service Host admission is binary: only service_host_owned workspaces are consumed. Run the PD installer/provisioning repair (npx create-principles-disciple) so this workspace is provisioned, or inspect the install with pd service status; the worker did not consume anything.';
}

export function readServiceWorkerOwnership(workspaceDir: string):
  | { readonly ok: true; readonly pdHome: string; readonly ownership: ReturnType<typeof readWorkspaceBackgroundOwnership> }
  | { readonly ok: false; readonly result: ServiceWorkerGateResult } {
  const home = resolveServiceWorkerPdHome();
  if (!home.ok) {
    return {
      ok: false,
      result: {
        workspaceDir,
        mode: 'degraded',
        reason: home.reason,
        nextAction: home.nextAction,
      },
    };
  }
  const ownership = readWorkspaceBackgroundOwnership({
    manifestPath: path.join(home.pdHome, 'install.json'),
    workspaceDir,
  });
  return { ok: true, pdHome: home.pdHome, ownership };
}

/** Evaluate ownership admission and hold the workspace mutex when it is available. */
export function admitServiceWorkerCycle(host: ServiceWorkerHostKind, workspaceDirInput: string): ServiceWorkerGate {
  const workspaceDir = path.resolve(workspaceDirInput);
  const ownershipRead = readServiceWorkerOwnership(workspaceDir);
  if (!ownershipRead.ok) return { admitted: false, result: ownershipRead.result };
  const { pdHome } = ownershipRead;

  // Mirror the OpenClaw worker: without an existing pdHome there is no install
  // manifest for the lock to arbitrate, and creating <pdHome>/service would be
  // a pure installer-tree side effect. The ownership read below reports the
  // missing manifest as degraded.
  const workspaceLock = fs.existsSync(pdHome)
    ? acquireWorkspaceServiceRunLock(pdHome, workspaceDir)
    : null;
  if (workspaceLock !== null && !workspaceLock.ok) {
    const held = workspaceLock.kind === 'held';
    return {
      admitted: false,
      result: {
        workspaceDir,
        mode: held ? 'paused' : 'degraded',
        reason: held ? `${host}_worker_run_in_progress` : `workspace_run_lock_unavailable:${workspaceLock.kind}`,
        nextAction: held
          ? 'Another worker cycle is still consuming this workspace; wait for it to finish (cycles are bounded) and retry.'
          : 'The workspace run mutex could not be verified; refusing to start a second consumer. Check the lock file under <pdHome>/service/workspace-runs/.',
      },
    };
  }

  const release = (): void => {
    if (workspaceLock !== null) releaseServiceRunLock(workspaceLock.handle satisfies ServiceRunLockHandle);
  };

  const { ownership } = ownershipRead;
  if (ownership.status === 'manifest_unreadable') {
    release();
    return {
      admitted: false,
      result: {
        workspaceDir,
        mode: 'degraded',
        reason: `${host}_owner_marker_unreadable:${ownership.reason}`,
        nextAction: ownership.nextAction,
      },
    };
  }
  if (ownership.status !== 'service_host_owned') {
    release();
    return {
      admitted: false,
      result: {
        workspaceDir,
        mode: 'paused',
        reason: `${host}_workspace_not_service_host_owned:${ownership.status}`,
        nextAction: ownershipNextAction(),
      },
    };
  }
  return { admitted: true, pdHome, release };
}
