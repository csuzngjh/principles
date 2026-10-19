/**
 * Version-change handover for a Companion-owned managed Console (PRI-1012 P1).
 *
 * When the installed release changes (`~/.pd/active.json` flips at activation,
 * PRI-1016) while a managed Console is running,
 * the old process must be explicitly stopped and its exit CONFIRMED before the
 * new entry is spawned. Two field-verified hazards motivated this module:
 *
 *   1. Reading the ownership evidence AFTER the supervisor moved to
 *      `restarting` made the kill a silent no-op — the state no longer said
 *      `running`, so the old Console survived and `pd console open` kept
 *      answering `reused` while the UI claimed the upgrade was done.
 *   2. A `reused` launch result is produced by ANY healthy process on the
 *      port — during a hand-over that is the old Console, never proof that a
 *      new process runs the new version.
 *
 * A reused/external instance is never touched: no ownership, no kill.
 */

import type { SupervisorState } from './supervisor.js';

/** The processes a managed launch owns: the console server plus the CLI wrapper. */
export interface ManagedServerHandle {
  serverPid: number;
  cliPid?: number;
}

/** Process operations, injectable so tests can run real children or fakes. */
export interface ProcessOps {
  kill(pid: number): void;
  isAlive(pid: number): boolean;
}

export const realProcessOps: ProcessOps = {
  kill(pid) {
    try { process.kill(pid); } catch { /* already gone */ }
  },
  isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
};

/**
 * Snapshot the killable handle of the CURRENT server. Must be called while the
 * supervisor still reports `running` — afterwards the machine is in
 * `restarting` and this deliberately returns undefined. Returns undefined for
 * every state whose process this Companion must not kill: attached/reused
 * instances, non-running states, and managed runs without a reported server
 * PID (killing only the CLI wrapper could orphan an unknown server).
 */
export function ownedManagedHandle(state: SupervisorState, ownsProcess: boolean, cliPid?: number): ManagedServerHandle | undefined {
  if (state.kind !== 'running' || state.mode !== 'managed' || !ownsProcess) return undefined;
  if (state.serverPid === undefined) return undefined;
  return cliPid === undefined ? { serverPid: state.serverPid } : { serverPid: state.serverPid, cliPid };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kill the handle's processes and poll until every PID is gone. A kill that
 * throws (EPERM and friends) is swallowed and answered by the liveness poll —
 * a refused stop must resolve honestly, never hang the hand-over. Resolves
 * true once none of the PIDs is alive, false after `timeoutMs`, in which case
 * the caller abandons the old process and lets the retry ladder keep trying
 * to take over rather than blocking the upgrade forever.
 */
export async function killManagedServerAndWait(
  handle: ManagedServerHandle,
  ops: ProcessOps,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollMs = opts.pollMs ?? 100;
  const pids = handle.cliPid === undefined ? [handle.serverPid] : [handle.serverPid, handle.cliPid];
  for (const pid of pids) {
    try { ops.kill(pid); } catch { /* the liveness poll decides, not the kill call */ }
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pids.some((pid) => ops.isAlive(pid))) return true;
    if (Date.now() >= deadline) return false;
    await delay(pollMs);
  }
}

/** The decision for one launch result observed during (or outside) a hand-over. */
export type HandoverLaunchVerdict =
  | { action: 'accept' }
  | { action: 'accept_pending_new_version' }
  | { action: 'reject_version_mismatch'; expected: string; got: string | undefined }
  | { action: 'keep_waiting_stale_reused'; port: number }
  | { action: 'fail_terminal' };

/**
 * Decide whether a `pd console open` result may complete a version switch.
 *
 * This is the single authority for that decision (P4): outside a hand-over
 * every result is handled normally; during a hand-over a `reused` result is
 * the OLD process still holding the port and only keeps the wait going, a
 * `started` result completes the switch only when the install the new process
 * was launched from still reads the target release, and everything else is a
 * terminal failure that must clear the pending marker (rc-9 — the failure is
 * reported, not silently retried into a false success).
 *
 * Both identity arguments are `~/.pd/active.json` release ids (PRI-1016). A
 * component package version must never be passed here: it says which package
 * version is on disk, not which release the update chain activated.
 */
export function judgeVersionChangeLaunch(
  pendingTargetReleaseId: string | undefined,
  result: { status: 'started' | 'reused' | 'failed' | 'refused'; port: number },
  activeReleaseId: string | undefined,
): HandoverLaunchVerdict {
  if (pendingTargetReleaseId === undefined) {
    return result.status === 'started' || result.status === 'reused' ? { action: 'accept' } : { action: 'fail_terminal' };
  }
  if (result.status === 'reused') return { action: 'keep_waiting_stale_reused', port: result.port };
  if (result.status !== 'started') return { action: 'fail_terminal' };
  if (activeReleaseId !== pendingTargetReleaseId) {
    return { action: 'reject_version_mismatch', expected: pendingTargetReleaseId, got: activeReleaseId };
  }
  return { action: 'accept_pending_new_version' };
}
