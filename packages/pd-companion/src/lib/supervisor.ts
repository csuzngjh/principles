/**
 * Console supervisor state machine (pure logic — no Electron, no child_process).
 *
 * The main-process glue drives this machine with real events:
 *   start() → spawn → onSpawnError | onLaunchResult → running
 *   running(managed) + CLI exit → onServerExit → restarting (backoff ×3)
 *   restarting exhausted → degraded(server_crash_loop)
 *
 * Failure paths always carry a DegradedReasonKey so the UI can show a
 * structured reason + next action (rc-9 — no silent degradation).
 */

export type DegradedReasonKey =
  | 'node_missing'
  | 'pd_not_installed'
  | 'workspace_missing'
  | 'server_crash_loop'
  | 'launch_failed';

export type SupervisorState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; mode: 'managed' | 'attached'; url: string; port: number; serverPid?: number; startedVersion?: string }
  | { kind: 'restarting'; attempt: number; reason: string }
  | { kind: 'degraded'; reason: DegradedReasonKey; detail?: string; nextAction?: string };

export const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000] as const;
/** Uptime after which a crash counts as a NEW failure episode (backoff resets). */
export const STABILITY_WINDOW_MS = 60_000;

export interface LaunchFailureInput {
  reason: string;
  nextAction?: string;
}

export function nextRestartDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), RESTART_DELAYS_MS.length) - 1;
  return RESTART_DELAYS_MS[index] ?? 4_000;
}

/** Map a pd-cli failure reason to a degraded reason key (rc-9). */
export function mapLaunchFailureReason(reason: string): DegradedReasonKey {
  if (reason.startsWith('workspace_missing')) return 'workspace_missing';
  if (reason === 'console_runtime_not_installed' || reason === 'console_server_entry_missing' || reason === 'console_web_ui_missing') {
    return 'pd_not_installed';
  }
  return 'launch_failed';
}

export class ConsoleSupervisor {
  private state: SupervisorState = { kind: 'idle' };
  private intentionalStop = false;
  private attempt = 0;
  private lastStartAt = 0;
  /**
   * True when THIS supervisor spawned the current server (result status
   * 'started'), regardless of whether the CLI reported a serverPid. Older
   * pd-cli builds do not emit serverPid, but the process is still ours and
   * must be reaped on quit (via the CLI process tree).
   */
  private ownsSpawn = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  getState(): SupervisorState {
    return this.state;
  }

  /** Whether the current server process was spawned by this supervisor. */
  ownsProcess(): boolean {
    return this.ownsSpawn;
  }

  /** Begin a launch attempt. Returns false when a start is not meaningful. */
  start(): boolean {
    if (this.state.kind === 'starting' || this.state.kind === 'running') return false;
    this.intentionalStop = false;
    this.attempt = 0;
    this.state = { kind: 'starting' };
    return true;
  }

  /** True while a spawn's result has not yet been observed. */
  private isAwaitingLaunchResult(): boolean {
    return this.state.kind === 'starting' || this.state.kind === 'restarting';
  }

  onLaunchStarted(launch: { url: string; port: number; serverPid?: number; startedVersion?: string }): void {
    if (!this.isAwaitingLaunchResult()) return;
    // NOTE: attempt is NOT reset here — quick-crash chains must accumulate.
    // The reset happens in onServerExit when uptime >= STABILITY_WINDOW_MS.
    this.lastStartAt = this.now();
    this.ownsSpawn = true; // fresh spawn — we own the process tree
    this.state = launch.serverPid === undefined
      ? { kind: 'running', mode: 'attached', url: launch.url, port: launch.port }
      : { kind: 'running', mode: 'managed', url: launch.url, port: launch.port, serverPid: launch.serverPid, startedVersion: launch.startedVersion };
  }

  onLaunchReused(url: string, port: number): void {
    if (!this.isAwaitingLaunchResult()) return;
    this.lastStartAt = this.now();
    this.ownsSpawn = false; // external instance — never kill it
    this.state = { kind: 'running', mode: 'attached', url, port };
  }

  onLaunchFailure(failure: LaunchFailureInput): void {
    if (!this.isAwaitingLaunchResult()) return;
    this.state = {
      kind: 'degraded',
      reason: mapLaunchFailureReason(failure.reason),
      detail: failure.reason,
      nextAction: failure.nextAction,
    };
  }

  onSpawnError(errorCode: string | undefined, message: string): void {
    if (!this.isAwaitingLaunchResult()) return;
    if (errorCode === 'ENOENT') {
      this.state = { kind: 'degraded', reason: 'node_missing', detail: message };
      return;
    }
    this.state = { kind: 'degraded', reason: 'launch_failed', detail: message };
  }

  /**
   * Server (or the CLI wrapper) process died unexpectedly.
   * Quick consecutive crashes accumulate (crash-loop guard); a crash after
   * the server ran stably for STABILITY_WINDOW_MS starts a new episode.
   * Returns the restart delay in ms when a restart should be scheduled,
   * undefined when no restart follows (intentional stop or crash loop).
   */
  onServerExit(exitCode: number | null): number | undefined {
    if (this.state.kind !== 'running' && this.state.kind !== 'restarting') return undefined;
    if (this.intentionalStop) {
      this.state = { kind: 'idle' };
      return undefined;
    }
    const uptime = this.now() - this.lastStartAt;
    if (uptime >= STABILITY_WINDOW_MS) this.attempt = 0;
    this.attempt += 1;
    if (this.attempt > MAX_RESTART_ATTEMPTS) {
      this.state = {
        kind: 'degraded',
        reason: 'server_crash_loop',
        detail: `server exited ${this.attempt - 1} times in a row, last code ${exitCode ?? 'null'}`,
      };
      return undefined;
    }
    this.state = { kind: 'restarting', attempt: this.attempt, reason: `server exited with code ${exitCode ?? 'null'}` };
    return nextRestartDelayMs(this.attempt);
  }

  /** Manual restart from the tray menu. */
  requestRestart(): boolean {
    if (this.state.kind === 'idle' || this.state.kind === 'degraded') {
      return this.start();
    }
    // running/restarting → caller should stop the server first; a plain
    // start() is refused to avoid double-spawn. Return false so the caller
    // routes through stopServer() + start().
    return false;
  }

  /** Mark current run as intentionally stopped (quit / manual restart). */
  markIntentionalStop(): void {
    this.intentionalStop = true;
  }

  /** Whether the tray "restart service" action is meaningful right now. */
  canRestart(): boolean {
    return this.state.kind !== 'idle' && this.state.kind !== 'starting';
  }

  /** Whether this supervisor owns the server process (can kill / auto-restart). */
  isManaged(): boolean {
    return this.state.kind === 'running' && this.state.mode === 'managed';
  }
}
