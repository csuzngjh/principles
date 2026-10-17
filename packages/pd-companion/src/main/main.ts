/* eslint-disable @typescript-eslint/no-use-before-define -- supervision/tray/polling form a reference cycle; helpers declared in reading order, matching codebase convention (see rulehost-pipeline-runner.ts) */

/**
 * PD Companion — Electron main process (PRI-526).
 *
 * Thin glue around the pure-logic lib layer: tray + window + supervisor
 * wiring + notifications + autostart. The companion does NOT embed the
 * console server — it spawns `pd console open --json --no-browser --no-auth`
 * with the SYSTEM Node (better-sqlite3 ABI constraint) and supervises it.
 */

import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, safeStorage, ipcMain } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildConsoleOpenArgs,
  resolveInstalledRuntime,
  resolvePdCliEntry,
  resolvePluginPackageJson,
} from '../lib/locate.js';
import { getInstallLayoutPaths, type InstallManifestWarning } from '@principles/install-layout';
import {
  tryParseConsoleOpenOutput,
  parsePluginVersion,
  getAuthenticationMismatchCleanupPid,
  LaunchResultError,
  type ConsoleOpenResult,
} from '../lib/launch-result.js';
import { buildConsoleTokenStatus, isSameConsoleOrigin, type ConsoleTokenStatus } from '../lib/console-origin.js';
import { entryFileVerdict, errnoCode } from '../lib/entry-verdict.js';
import { ConsoleSupervisor, ENTRY_PENDING_REASON_PREFIX } from '../lib/supervisor.js';
import { judgeVersionChangeLaunch, killManagedServerAndWait, ownedManagedHandle, realProcessOps, type ManagedServerHandle } from '../lib/version-handover.js';
import { buildDegradedPageHtml, buildDegradedWorkspacesTrayView, buildSyncUnavailableTrayView, describeDegraded, describeWorkspaceWorkerDegraded, describeWorkspaceSyncUnavailable } from '../lib/degraded.js';
import {
  defaultCompanionState,
  markApprovalsNotified,
  markUpdateNotified,
  parseCompanionState,
  type CompanionState,
} from '../lib/state-store.js';
import {
  diffPendingApprovals,
  parseApprovalsResponse,
  parseUpdateCheckResponse,
  shouldNotifyUpdate,
} from '../lib/poller.js';
import { WorkspaceWorkerRegistry, type WorkerChild, type WorkspaceManifestSource } from '../lib/workspace-workers.js';
import { parseInstallManifest } from '@principles/install-layout';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_USER_MODEL_ID = 'party.principles.disciple.companion';
const POLL_INTERVAL_MS = 30_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LAUNCH_RESULT_TIMEOUT_MS = 30_000;
const CONSECUTIVE_POLL_FAILURES_BEFORE_RESTART = 3;

const supervisor = new ConsoleSupervisor();
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let cliChild: ChildProcess | undefined;
let state: CompanionState = defaultCompanionState();
let stateFilePath = '';
let logFilePath = '';
let extDir: string | undefined;
let installedPluginDir: string | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let updateTimer: ReturnType<typeof setInterval> | undefined;
let workspaceWorkerTimer: ReturnType<typeof setInterval> | undefined;
/** The single pending restart retry (see scheduleRestartRetry). */
let restartRetryTimer: ReturnType<typeof setTimeout> | undefined;
let quitting = false;
let baselineRecorded = false;
let consecutivePollFailures = 0;
let serverStartedVersion: string | undefined;
let currentPort: number | undefined;
/**
 * The version marker the update chain flipped to. Set while a version_change
 * restart is in flight; a freshly spawned Console is only accepted as the new
 * version when the version it actually runs equals this, so `reused` or a
 * stale old process can never be mistaken for a completed upgrade (PRI-1012 P1).
 * Cleared when the hand-over reaches any conclusion (accepted, mismatched,
 * failed) or when an Owner stop cancels it — never at spawn time, or every
 * retry of the chain would launch ungated.
 */
let pendingTargetVersion: string | undefined;
/**
 * CLI children whose exit is EXPECTED (a version-change hand-over stopped
 * them). Their exit event must not burn the crash-restart budget or schedule a
 * competing retry — the hand-over itself owns the respawn. Bounded: at most
 * one entry per hand-over, removed when the exit fires.
 */
const expectedExitChildren = new Set<ChildProcess>();

// ─── Logging (no tokens, no full URLs — ports and pids only) ────────────────

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  try {
    fs.appendFileSync(logFilePath, `${line}\n`, 'utf8');
  } catch {
    /* logging must never crash the app */
  }
}

// ─── State persistence ───────────────────────────────────────────────────────

function loadState(): void {
  try {
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    state = parseCompanionState(JSON.parse(raw) as unknown);
  } catch {
    state = defaultCompanionState();
  }
}

function saveState(): boolean {
  try {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (err) {
    log('state_save_failed', { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// ─── Spawn argument hardening ────────────────────────────────────────────────

/** Only pass the stored workspace override when it is a safe existing directory. */
function validatedWorkspaceOverride(): string | undefined {
  const candidate = state.workspaceOverride;
  if (candidate === undefined) return undefined;
  if (!path.isAbsolute(candidate)) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(candidate)) return undefined;
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

// ─── Window ──────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    icon: iconPath(),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, '..', 'preload.cjs') },
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
    maybeFirstHideNotice();
  });
}

function iconPath(): string {
  return path.join(__dirname, '..', '..', 'assets', 'icon.png');
}

function showWindow(hash?: string): void {
  if (mainWindow === undefined) return;
  const s = supervisor.getState();
  if (s.kind === 'running' && hash !== undefined) {
    void mainWindow.loadURL(`${s.url}/${hash}`);
  }
  mainWindow.show();
  mainWindow.focus();
}

function showDegradedPage(reason: Parameters<typeof describeDegraded>[0], detail?: string, nextAction?: string): void {
  const info = describeDegraded(reason, detail, nextAction);
  const html = buildDegradedPageHtml(info);
  void mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  mainWindow?.show();
}

function maybeFirstHideNotice(): void {
  if (state.firstRunNoticeShown) return;
  state.firstRunNoticeShown = true;
  saveState();
  tray?.displayBalloon({
    title: 'PD Companion 仍在运行',
    content: '窗口已关闭，但 Companion 会驻留在系统托盘继续监听待审批通知。可在托盘菜单中退出或关闭开机自启。',
  });
  log('first_hide_notice_shown');
}

// ─── Process supervision ─────────────────────────────────────────────────────

/**
 * Reap the processes this app spawned: the console server PID when the CLI
 * reported one, plus the CLI wrapper itself. On Windows process.kill()
 * terminates unconditionally; for older pd-cli builds without serverPid the
 * server follows its dead CLI parent (broken stdio pipe) — verified in the
 * PRI-526 smoke run. Callers must only invoke this when
 * supervisor.ownsProcess() — a reused external console must never be killed.
 */
function killSpawnedTree(child: ChildProcess | undefined): void {
  const serverState = supervisor.getState();
  const serverPid = serverState.kind === 'running' && serverState.mode === 'managed' ? serverState.serverPid : undefined;
  if (serverPid !== undefined) {
    try { process.kill(serverPid); } catch { /* already gone */ }
  }
  const cliPid = child?.pid;
  if (cliPid !== undefined) {
    try { process.kill(cliPid); } catch { /* already gone */ }
  }
}

function stopServer(): void {
  // Cancelling a pending retry is part of stopping: an Owner-initiated restart
  // must not be joined later by the timer of the chain it replaced. An Owner
  // stop likewise cancels an in-flight version-change hand-over — the next
  // launch is the Owner's, not the update chain's.
  clearRestartRetry();
  pendingTargetVersion = undefined;
  supervisor.markIntentionalStop();
  if (supervisor.ownsProcess()) {
    killSpawnedTree(cliChild);
  }
}

/**
 * Kill the currently owned managed Console and wait for it to truly exit,
 * without touching the supervisor's `intentionalStop` flag — this path is a
 * version-change hand-over, not an Owner stop, so the restarting guard must
 * stay intact for the scheduled respawn. The killable handle must be
 * snapshotted (via `ownedManagedHandle`) BEFORE the caller moves the machine
 * to `restarting`: afterwards the ownership evidence no longer reads as
 * running, and a late snapshot made this kill a silent no-op (PRI-1012 P1).
 *
 * Returns whether the exit was CONFIRMED — neither the server PID nor the CLI
 * wrapper PID is alive any longer. False after `timeoutMs`: the old process
 * is then abandoned rather than blocking the upgrade forever, and the retry
 * ladder keeps trying to take the port. Never touches an `attached` external
 * Console.
 */
async function killManagedServerAndConfirm(handle: ManagedServerHandle, timeoutMs = 5_000): Promise<boolean> {
  return killManagedServerAndWait(handle, realProcessOps, { timeoutMs });
}

function readInstalledVersion(): string | undefined {
  if (installedPluginDir === undefined) return undefined;
  try {
    return parsePluginVersion(fs.readFileSync(resolvePluginPackageJson(installedPluginDir), 'utf8'));
  } catch {
    return undefined;
  }
}

function startSupervision(): void {
  const home = app.getPath('home');
  const paths = getInstallLayoutPaths(home);
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as unknown;
  } catch (err) {
    log('install_manifest_read_failed', { code: errnoCode(err) });
    manifest = undefined;
  }
  const outcome = resolveInstalledRuntime({
    homeDir: home,
    manifest,
    canonicalRuntimeExists: fs.existsSync(paths.runtimeDir),
    legacyExtensionExists: fs.existsSync(paths.openClawExtensionDir),
  });
  logManifestWarnings(outcome?.warnings);
  const runtime = outcome?.runtime;
  extDir = runtime?.root;
  installedPluginDir = runtime?.pluginRoot;
  if (extDir === undefined) {
    // Distinct failure causes reach the Owner distinctly (rc-9): a manifest
    // written by a newer PD reads as "update the Companion", structural
    // damage as "PD not installed" — never a blanket wrong message.
    const missing = outcome?.missing;
    supervisor.start();
    supervisor.onLaunchFailure({
      reason: missing?.reason ?? 'install_runtime_missing',
      nextAction: missing?.nextAction,
    });
    const s = supervisor.getState();
    if (s.kind === 'degraded') showDegradedPage(s.reason, s.detail, s.nextAction);
    log('pd_not_installed', { reason: missing?.reason ?? 'no_home' });
    rebuildTrayMenu();
    return;
  }
  if (runtime?.fallbackReason !== undefined) {
    log('install_layout_legacy_fallback', { reason: runtime.fallbackReason });
  }
  const coldStartEntry = entryFileVerdict(resolvePdCliEntry(extDir));
  if (!coldStartEntry.ok && coldStartEntry.transient && runtime?.fallbackReason === undefined) {
    // PRI-1012: during the update window the entry is simply not laid yet, and
    // a boot-time autostart lands exactly here. Let spawnCli() run its bounded
    // entry wait instead of degrading — the degraded copy for this reason tells
    // the Owner to re-run the installer, which §1.1 forbids against a healthy
    // install. A legacy-fallback layout is a different cause (this Companion
    // build cannot read the newer manifest) and keeps its own diagnosis below.
    if (!supervisor.start()) return;
    spawnCli();
    return;
  }
  if (!coldStartEntry.ok) {
    // Runtime resolved but the CLI entry is gone — a corrupt runtime is its
    // own cause, separate from a missing install or an incompatible manifest.
    // When the layout only resolved via legacy fallback BECAUSE the manifest
    // version is newer than this reader (the 2026-10-16 incident machine
    // shape), the Owner must see the update-the-Companion cause, not a
    // blanket "runtime not installed".
    const reason = runtime?.fallbackReason ?? 'console_runtime_not_installed';
    supervisor.start();
    supervisor.onLaunchFailure({ reason });
    const s = supervisor.getState();
    if (s.kind === 'degraded') showDegradedPage(s.reason, s.detail, s.nextAction);
    log('pd_runtime_unusable', { mode: runtime?.mode, reason, root: extDir, detail: coldStartEntry.detail });
    rebuildTrayMenu();
    return;
  }
  if (!supervisor.start()) return;
  spawnCli();
}

// ─── Workspace worker supervision (PRI-624 Slice C) ──────────────────────────
// The Companion schedules ONE `pd codex worker` child per canonical workspace
// listed in the install manifest. Lifecycle only — execution correctness is
// owned by the durable Runtime V2 task lease inside the worker.

const WORKSPACE_WORKER_SYNC_INTERVAL_MS = 60_000;
const WORKSPACE_WORKER_CYCLE_INTERVAL_MS = 120_000;
let workspaceWorkers: WorkspaceWorkerRegistry | undefined;
// WorkBuddy third host (SPEC workbuddy-host-adapter §5): the Companion
// schedules ONE `pd workbuddy worker` child for the WorkBuddy governance
// workspace, supervised by the same registry lifecycle. Execution
// correctness stays owned by the durable Runtime V2 task lease, so a
// workspace theoretically listed for both hosts can never double-execute a
// task — worst case is benign lease contention.
let workbuddyWorkspaceWorkers: WorkspaceWorkerRegistry | undefined;
let workbuddyWorkspaceWorkerTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Read the install manifest for one host's workspaces as an EXPLICIT outcome
 * (2026-10-16): a manifest that cannot be read or parsed is
 * { kind: 'unavailable' } — NEVER an empty workspace list. Conflating the two
 * mass-stopped every running worker as removed_from_manifest when the bundled
 * parser could not understand a newer manifest.
 */
function readManifestWorkspacesForHost(host: 'codex' | 'workbuddy'): WorkspaceManifestSource {
  const paths = getInstallLayoutPaths(app.getPath('home'));
  let raw: string;
  try {
    raw = fs.readFileSync(paths.manifest, 'utf8');
  } catch (err) {
    return { kind: 'unavailable', reason: `install_manifest_read_failed: ${errnoCode(err)}` };
  }
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(raw) as unknown;
  } catch (err) {
    return { kind: 'unavailable', reason: `install_manifest_unparsable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = parseInstallManifest(parsedManifest);
  if (result.manifest === undefined) {
    return { kind: 'unavailable', reason: `install_manifest_invalid: ${result.error ?? 'unknown'}` };
  }
  logManifestWarnings(result.warnings);
  if (!result.manifest.hosts.includes(host)) return { kind: 'ok', workspaces: [] };
  return {
    kind: 'ok',
    workspaces: (result.manifest.workspaces ?? []).filter((workspace) => {
      try {
        return fs.statSync(workspace).isDirectory();
      } catch {
        return false;
      }
    }),
  };
}

function manifestCodexWorkspacesSource(): WorkspaceManifestSource {
  return readManifestWorkspacesForHost('codex');
}

function manifestWorkbuddyWorkspacesSource(): WorkspaceManifestSource {
  return readManifestWorkspacesForHost('workbuddy');
}

/** Codex workspaces for liveness checks only (a read failure yields none — liveness is read-only). */
function manifestCodexWorkspaces(): string[] {
  const source = manifestCodexWorkspacesSource();
  return source.kind === 'ok' ? [...source.workspaces] : [];
}

/** Forward-compatibility warnings are structured events, deduped per signature so the 60s sync loop does not spam. */
const loggedManifestWarningSignatures = new Set<string>();
function logManifestWarnings(warnings: readonly InstallManifestWarning[] | undefined): void {
  if (warnings === undefined) return;
  for (const warning of warnings) {
    const signature = `${warning.code}:${warning.host}`;
    if (loggedManifestWarningSignatures.has(signature)) continue;
    loggedManifestWarningSignatures.add(signature);
    log('install_manifest_warning', { code: warning.code, host: warning.host });
  }
}

function spawnWorkspaceWorkerFor(workerCommand: 'codex' | 'workbuddy'): (canonicalWorkspaceDir: string) => WorkerChild {
  return (canonicalWorkspaceDir: string): WorkerChild => {
    // Same system-node discipline as the console server: better-sqlite3 is
    // built for the SYSTEM Node ABI, never Electron's bundled Node.
    const entry = extDir !== undefined ? resolvePdCliEntry(extDir) : undefined;
    if (entry === undefined || !entryFileVerdict(entry).ok) {
      throw new Error('pd-cli entry unavailable');
    }
    const child = spawn('node', [
      entry,
      workerCommand, 'worker',
      '--workspace', canonicalWorkspaceDir,
      '--interval', String(WORKSPACE_WORKER_CYCLE_INTERVAL_MS),
    ], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded stderr tail into the companion log — the worker's own
      // human-readable cycle reports go to stdout (companion does not consume
      // them; Slice D health surface adds the structured health API).
      log('workspace_worker_stderr', { workspace: canonicalWorkspaceDir, tail: chunk.toString('utf8').slice(-400) });
    });
    return child;
  };
}

function spawnWorkspaceWorker(canonicalWorkspaceDir: string): WorkerChild {
  return spawnWorkspaceWorkerFor('codex')(canonicalWorkspaceDir);
}

function startWorkspaceWorkerSupervision(): void {
  workspaceWorkers = new WorkspaceWorkerRegistry({
    spawnWorker: spawnWorkspaceWorker,
    // The degraded fact already exists in the registry (PRI-624); PRI-715 only
    // connects it to the Owner-visible surfaces — one-shot notification on the
    // degradation transition plus the persistent tray section (rebuilt below).
    log: (event, fields) => {
      log(event, fields ?? {});
      if (event === 'workspace_worker_degraded') {
        // rc-1/rc-2: log fields are untrusted runtime values — guard before use.
        const workspace = fields?.workspace;
        if (typeof workspace !== 'string' || workspace.length === 0) {
          log('workspace_worker_degraded_notify_skipped', { reason: 'workspace_field_invalid' });
          return;
        }
        notifyWorkspaceDegraded(workspace);
        rebuildTrayMenu();
      } else if (event === 'workspace_worker_stopped') {
        // Manifest removal of a (possibly degraded) workspace must retire its
        // tray section immediately — nothing else rebuilds the tray on removal
        // (review P1, PRI-715 §7F). The rebuild re-reads the registry, so the
        // ghost display dies with the entry.
        rebuildTrayMenu();
      } else if (event === 'workspace_worker_sync_unavailable_persistent') {
        // 2026-10-16: an unreadable manifest holds worker state and escalates
        // Owner-visibly instead of mass-stopping — one-shot per episode.
        notifyWorkspaceSyncUnavailable(fields ?? {});
        rebuildTrayMenu();
      } else if (event === 'workspace_worker_sync_recovered') {
        // RF-04: healed manifest → drop the stale tray warning immediately.
        // Pure display refresh; sync already reconciled the workers.
        rebuildTrayMenu();
      }
    },
  });
  workspaceWorkers.syncFromManifest(manifestCodexWorkspacesSource());
  workspaceWorkerTimer = setInterval(() => {
    if (quitting) return;
    workspaceWorkers?.syncFromManifest(manifestCodexWorkspacesSource());
    // SPEC-CODEX-PAIN-CLOSURE-001 CR-08 (§9.3): supervision also reads the
    // worker's persisted liveness facts — a spawned process with no recent
    // cycle evidence is NOT alive progress. Meaningful transitions only
    // (one-shot per workspace while stalled) so the Owner is not spammed
    // every sync tick.
    checkWorkspaceWorkerLiveness();
  }, WORKSPACE_WORKER_SYNC_INTERVAL_MS);
  workspaceWorkerTimer.unref();

  // WorkBuddy governance worker — same supervision, own registry and timer;
  // the worker command itself (pd workbuddy worker) owns the host.workbuddy
  // flag semantics, so an unenabled governance workspace just reports paused.
  workbuddyWorkspaceWorkers = new WorkspaceWorkerRegistry({
    spawnWorker: spawnWorkspaceWorkerFor('workbuddy'),
    log: (event, fields) => {
      log(event, fields ?? {});
      if (event === 'workspace_worker_degraded') {
        const workspace = fields?.workspace;
        if (typeof workspace !== 'string' || workspace.length === 0) {
          log('workspace_worker_degraded_notify_skipped', { reason: 'workspace_field_invalid' });
          return;
        }
        notifyWorkspaceDegraded(workspace);
        rebuildTrayMenu();
      } else if (event === 'workspace_worker_stopped') {
        rebuildTrayMenu();
      } else if (event === 'workspace_worker_sync_unavailable_persistent') {
        notifyWorkspaceSyncUnavailable(fields ?? {});
        rebuildTrayMenu();
      } else if (event === 'workspace_worker_sync_recovered') {
        rebuildTrayMenu();
      }
    },
  });
  workbuddyWorkspaceWorkers.syncFromManifest(manifestWorkbuddyWorkspacesSource());
  workbuddyWorkspaceWorkerTimer = setInterval(() => {
    if (quitting) return;
    workbuddyWorkspaceWorkers?.syncFromManifest(manifestWorkbuddyWorkspacesSource());
  }, WORKSPACE_WORKER_SYNC_INTERVAL_MS);
  workbuddyWorkspaceWorkerTimer.unref();
}

const livenessStallNotified = new Set<string>();

/**
 * CR-08/A20: a worker process being alive is not progress. When the persisted
 * liveness record shows no completed cycle within two poll windows (240s) and
 * no running stage within its deadline, surface one workspace_worker_stalled
 * event — readiness/registration alone never counts as liveness.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkWorkspaceWorkerLiveness(): void {
  for (const workspace of manifestCodexWorkspaces()) {
    let record: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(workspace, '.state', 'codex-worker-liveness.json'), 'utf8'));
      if (isPlainRecord(parsed)) record = parsed;
    } catch {
      continue;
    }
    if (Object.keys(record).length === 0) continue;
    const lastCompleted = typeof record.lastCycleCompletedAt === 'string' ? Date.parse(record.lastCycleCompletedAt) : NaN;
    const runningStage = typeof record.runningStage === 'string' ? record.runningStage : null;
    const stageDeadline = typeof record.stageDeadline === 'string' ? Date.parse(record.stageDeadline) : NaN;
    const withinStage = runningStage !== null && Number.isFinite(stageDeadline) && Date.now() <= stageDeadline;
    const stalled = (Number.isNaN(lastCompleted) || Date.now() - lastCompleted > WORKSPACE_WORKER_CYCLE_INTERVAL_MS * 2) && !withinStage;
    if (stalled && !livenessStallNotified.has(workspace)) {
      livenessStallNotified.add(workspace);
      log('workspace_worker_stalled', {
        workspace,
        lastCycleCompletedAt: Number.isFinite(lastCompleted) ? record.lastCycleCompletedAt : null,
        runningStage,
      });
    } else if (!stalled) {
      livenessStallNotified.delete(workspace);
    }
  }
}

/** Owner-facing surface for a permanently degraded workspace worker (PRI-715). */
function notifyWorkspaceDegraded(canonicalWorkspace: string): void {
  if (!Notification.isSupported()) {
    log('notification_unsupported', { event: 'workspace_worker_degraded', workspace: canonicalWorkspace });
    return;
  }
  const info = describeWorkspaceWorkerDegraded(canonicalWorkspace);
  const notification = new Notification({
    title: info.title,
    body: info.body,
    icon: nativeImage.createFromPath(iconPath()),
  });
  notification.on('click', () => showWindow());
  notification.show();
  log('notified_workspace_degraded', { workspace: canonicalWorkspace });
}

/**
 * Owner-facing surface for the persistent unreadable-manifest escalation
 * (2026-10-16): the notification itself is one-shot per episode because the
 * registry fires the persistent event exactly once; fields are untrusted log
 * payload and guarded before use (rc-1/rc-2).
 */
function notifyWorkspaceSyncUnavailable(fields: Record<string, unknown>): void {
  const reason = typeof fields.reason === 'string' && fields.reason.length > 0 ? fields.reason : 'unknown';
  const consecutive = typeof fields.consecutiveUnavailableReads === 'number' ? fields.consecutiveUnavailableReads : 0;
  if (!Notification.isSupported()) {
    log('notification_unsupported', { event: 'workspace_worker_sync_unavailable_persistent', reason });
    return;
  }
  const info = describeWorkspaceSyncUnavailable({ reason, consecutiveUnavailableReads: consecutive });
  const notification = new Notification({
    title: info.title,
    body: info.body,
    icon: nativeImage.createFromPath(iconPath()),
  });
  notification.on('click', () => showWindow());
  notification.show();
  log('notified_workspace_sync_unavailable', { reason, consecutiveUnavailableReads: consecutive });
}

function stopWorkspaceWorkerSupervision(): void {
  if (workspaceWorkerTimer !== undefined) clearInterval(workspaceWorkerTimer);
  workspaceWorkers?.stopAll();
  if (workbuddyWorkspaceWorkerTimer !== undefined) clearInterval(workbuddyWorkspaceWorkerTimer);
  workbuddyWorkspaceWorkers?.stopAll();
}

type RestartRetryReason = 'server_exit' | 'attached_server_lost' | 'version_change' | 'entry_wait';

/**
 * Four paths schedule a restart retry (crash ladder, attached-server-lost,
 * version change, pd-cli entry wait), and each fire is gated on `restarting`.
 * With independent timers two chains can be alive at once — a tray restart
 * during a long entry wait re-arms the machine while the old timer is still
 * due, and when the entry finally appears both spawn, so the second CLI returns
 * `reused`, the supervisor stops owning the process and quit leaks a child.
 * One handle makes "at most one retry pending" structural. A fire that the
 * state guard rejects is logged: a retry that silently never ran is exactly the
 * SILENT_NO_SPAWN shape seen in the field evidence.
 */
function scheduleRestartRetry(delayMs: number, why: RestartRetryReason): void {
  clearRestartRetry();
  restartRetryTimer = setTimeout(() => {
    restartRetryTimer = undefined;
    const s = supervisor.getState();
    if (quitting || s.kind !== 'restarting') {
      log('restart_retry_skipped', { why, quitting, state: s.kind });
      return;
    }
    log('restart_retry_fired', { why, attempt: s.attempt, reason: s.reason });
    spawnCli();
  }, delayMs);
}

function clearRestartRetry(): void {
  if (restartRetryTimer !== undefined) clearTimeout(restartRetryTimer);
  restartRetryTimer = undefined;
}

function spawnCli(): void {
  // NOTE: pendingTargetVersion is deliberately NOT cleared here — a version
  // hand-over re-enters this function through the retry ladder, and clearing
  // at the door would launch the new attempt ungated, letting a `reused` old
  // process pass as the upgraded one (PRI-1012 P1). The marker is cleared when
  // the hand-over reaches a conclusion (handleLaunchResult) or is cancelled
  // (stopServer).
  if (extDir === undefined) return;
  // spawn argv hardening: program is the literal 'node' (resolved via PATH by
  // the OS — never env-controlled); every path argument is validated above.
  // The workspace override comes from a local state file and only reaches
  // argv after validatedWorkspaceOverride() confirms it is a real directory.
  const entry = resolvePdCliEntry(extDir);
  const entryCheck = entryFileVerdict(entry);
  if (!entryCheck.ok) {
    // PRI-1012: the update chain flips the installed version marker before it
    // lays the component dirs, so a not-yet-present entry is a transient state
    // of a healthy install. Wait it out (bounded) and log what was decided,
    // instead of degrading on the first stat failure with no trace.
    if (!entryCheck.transient) {
      pendingTargetVersion = undefined;
      supervisor.onSpawnError(undefined, entryCheck.detail);
      log('pd_cli_entry_rejected', { entry, detail: entryCheck.detail, state: supervisor.getState().kind });
      reflectSupervisorState();
      return;
    }
    const delay = supervisor.onEntryMissing(entryCheck.detail);
    // fromVersion != targetVersion is this log's evidence that the version
    // marker flipped since the last successful launch — i.e. an update was in
    // flight — which is what separates the race from a broken install.
    log('pd_cli_entry_not_ready', {
      entry,
      detail: entryCheck.detail,
      state: supervisor.getState().kind,
      willRetryInMs: delay ?? 0,
      waitsLeft: supervisor.entryWaitsLeft(),
      fromVersion: serverStartedVersion,
      targetVersion: readInstalledVersion(),
    });
    reflectSupervisorState();
    if (delay !== undefined) scheduleRestartRetry(delay, 'entry_wait');
    return;
  }
  const tokenConfigured = Boolean(process.env.PD_CONSOLE_TOKEN?.trim());
  const args = [entry, ...buildConsoleOpenArgs({
    workspaceDir: validatedWorkspaceOverride(),
    tokenConfigured,
  })];
  baselineRecorded = false;
  consecutivePollFailures = 0;
  log('spawning_cli', { port: currentPort });

  let child: ChildProcess;
  try {
    child = spawn('node', args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    supervisor.onSpawnError(undefined, err instanceof Error ? err.message : String(err));
    return;
  }
  cliChild = child;

  let stdoutBuffer = '';
  let resultSeen = false;
  let stderrTail = '';
  const timeout = setTimeout(() => {
    if (!resultSeen) {
      log('launch_result_timeout');
      supervisor.onLaunchFailure({ reason: 'console_health_check_timeout', nextAction: '查看 Companion 日志与控制台输出，稍后从托盘重试。' });
      killSpawnedTree(child);
      reflectSupervisorState();
    }
  }, LAUNCH_RESULT_TIMEOUT_MS);

  child.on('error', (err: Error & { code?: string }) => {
    if (resultSeen) {
      log('cli_late_error', { code: err.code });
      return;
    }
    clearTimeout(timeout);
    supervisor.onSpawnError(err.code, err.message);
    log('cli_spawn_error', { code: err.code });
    reflectSupervisorState();
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    if (resultSeen) return;
    stdoutBuffer += chunk.toString('utf8');
    let parsed;
    try {
      parsed = tryParseConsoleOpenOutput(stdoutBuffer);
    } catch (err) {
      clearTimeout(timeout);
      const message = err instanceof LaunchResultError ? err.message : String(err);
      supervisor.onLaunchFailure({ reason: `console_output_invalid: ${message}` });
      killSpawnedTree(child);
      log('cli_output_invalid', {});
      reflectSupervisorState();
      return;
    }
    if (parsed === undefined) return;
    resultSeen = true;
    clearTimeout(timeout);
    handleLaunchResult(parsed);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });

  child.on('exit', (code) => {
    clearTimeout(timeout);
    // A version-change hand-over stopped this CLI on purpose: its exit is the
    // CONFIRMATION the hand-over waits for, not a crash. Counting it would
    // double-burn the crash budget and schedule a retry racing the hand-over's.
    if (expectedExitChildren.delete(child)) {
      log('cli_exit_expected_version_change', { code });
      return;
    }
    const s = supervisor.getState();
    if (!resultSeen) {
      supervisor.onLaunchFailure({
        reason: `console_cli_exited_before_result: code=${code ?? 'null'}`,
        nextAction: '查看 Companion 日志中的控制台输出，稍后从托盘重试。',
      });
      if (stderrTail.length > 0) log('cli_stderr_tail', { tail: stderrTail.slice(0, 800) });
      reflectSupervisorState();
      return;
    }
    if (s.kind === 'running' && s.mode === 'attached') {
      log('attached_cli_exited_expected', { code });
      return; // reused-mode CLI exits right after printing JSON — expected
    }
    const delay = supervisor.onServerExit(code);
    if (delay !== undefined) {
      log('server_exit_restart_scheduled', { code, delayMs: delay });
      scheduleRestartRetry(delay, 'server_exit');
    } else {
      log('server_exit_no_restart', { code });
      reflectSupervisorState();
    }
  });
}

function handleLaunchResult(parsed: ConsoleOpenResult): void {
  if (parsed.status === 'started' || parsed.status === 'reused') {
    const expectedMode = process.env.PD_CONSOLE_TOKEN?.trim() ? 'authenticated' : 'no_auth';
    if (parsed.authenticationMode !== expectedMode) {
      const cleanupPid = getAuthenticationMismatchCleanupPid(parsed, expectedMode);
      if (cleanupPid !== undefined) {
        try {
          process.kill(cleanupPid, 'SIGTERM');
        } catch (err) {
          log('console_authentication_mismatch_cleanup_failed', {
            serverPid: cleanupPid,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      supervisor.onLaunchFailure({
        reason: `console_authentication_mode_mismatch: expected=${expectedMode}, actual=${parsed.authenticationMode ?? 'unverified'}`,
        nextAction: '停止现有 Console 后从 Companion 重试；如仍失败，请检查 PD_CONSOLE_TOKEN 配置。',
      });
      pendingTargetVersion = undefined;
      log('console_authentication_mode_mismatch', {
        expectedMode,
        actualMode: parsed.authenticationMode ?? 'unverified',
      });
      reflectSupervisorState();
      return;
    }
  }
  if (parsed.status === 'started') {
    serverStartedVersion = readInstalledVersion();
    currentPort = parsed.port;
    // PRI-1012 P1: the hand-over completes only when the process that just
    // started was launched from the install the update chain flipped to. The
    // verdict helper is the single authority for that decision.
    const verdict = judgeVersionChangeLaunch(pendingTargetVersion, parsed, serverStartedVersion);
    if (verdict.action === 'reject_version_mismatch') {
      log('version_change_rejected', { expected: verdict.expected, got: verdict.got });
      pendingTargetVersion = undefined;
      supervisor.onLaunchFailure({
        reason: 'console_version_mismatch',
        nextAction: '从托盘菜单再点一次「重启控制台服务」；如反复失败请查看 Companion 日志。',
      });
      reflectSupervisorState();
      return;
    }
    pendingTargetVersion = undefined;
    supervisor.onLaunchStarted({ url: parsed.url, port: parsed.port, serverPid: parsed.serverPid, startedVersion: serverStartedVersion });
    const after = supervisor.getState();
    log('console_started', {
      port: parsed.port,
      serverPid: parsed.serverPid,
      version: serverStartedVersion,
      mode: after.kind === 'running' ? after.mode : 'unknown',
      ownsProcess: supervisor.ownsProcess(),
    });
    void mainWindow?.loadURL(parsed.url).catch((err: unknown) => log('window_load_failed', { message: err instanceof Error ? err.message : String(err) }));
    startPolling();
  } else if (parsed.status === 'reused') {
    // PRI-1012 P1: an external/old Console reused on the same port is NOT the
    // new version. During a version_change hand-over keep waiting for the new
    // process instead of claiming the upgrade is done.
    currentPort = parsed.port;
    const verdict = judgeVersionChangeLaunch(pendingTargetVersion, parsed, undefined);
    if (verdict.action === 'keep_waiting_stale_reused') {
      log('version_change_reused_stale', { expected: pendingTargetVersion, port: verdict.port });
      reflectSupervisorState();
      return;
    }
    serverStartedVersion = readInstalledVersion();
    supervisor.onLaunchReused(parsed.url, parsed.port);
    log('console_reused', { port: parsed.port, mode: 'attached' });
    void mainWindow?.loadURL(parsed.url).catch((err: unknown) => log('window_load_failed', { message: err instanceof Error ? err.message : String(err) }));
    startPolling();
  } else {
    pendingTargetVersion = undefined;
    supervisor.onLaunchFailure({ reason: parsed.reason ?? parsed.status, nextAction: parsed.nextAction });
    log('console_launch_failed', { status: parsed.status, reason: parsed.reason });
  }
  reflectSupervisorState();
}

function reflectSupervisorState(): void {
  const s = supervisor.getState();
  if (s.kind === 'degraded') {
    showDegradedPage(s.reason, s.detail, s.nextAction);
  }
  rebuildTrayMenu();
}

function restartFromTray(): boolean {
  stopServer();
  setTimeout(() => {
    if (quitting) return;
    if (!supervisor.start()) {
      log('console_restart_not_started', { state: supervisor.getState().kind });
      reflectSupervisorState();
      return;
    }
    spawnCli();
  }, 600);
  return true;
}

function restoreEncryptedConsoleToken(): void {
  if (state.encryptedConsoleToken === undefined || !safeStorage.isEncryptionAvailable()) return;
  try { process.env.PD_CONSOLE_TOKEN = safeStorage.decryptString(Buffer.from(state.encryptedConsoleToken, 'base64')); }
  catch { delete state.encryptedConsoleToken; saveState(); log('console_token_restore_failed'); }
}

interface ConsoleTokenConfigurationResult {
  persisted: boolean;
  restartRequested: boolean;
  reason?: 'invalid_input' | 'encryption_unavailable' | 'encryption_failed' | 'state_save_failed' | 'external_console_attached';
  nextAction?: string;
}

function configureConsoleToken(senderId: number, value: unknown): ConsoleTokenConfigurationResult {
  if (senderId !== mainWindow?.webContents.id || typeof value !== 'string' || value.trim().length === 0) {
    return { persisted: false, restartRequested: false, reason: 'invalid_input', nextAction: 'Enter a non-empty Console token.' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { persisted: false, restartRequested: false, reason: 'encryption_unavailable', nextAction: 'Enable the operating-system key store, then retry.' };
  }
  const token = value.trim();
  let encryptedToken: string;
  try {
    encryptedToken = safeStorage.encryptString(token).toString('base64');
  } catch {
    return { persisted: false, restartRequested: false, reason: 'encryption_failed', nextAction: 'Check the desktop key store, then retry.' };
  }
  const previousEncryptedToken = state.encryptedConsoleToken;
  const previousProcessToken = process.env.PD_CONSOLE_TOKEN;
  const current = supervisor.getState();
  state.encryptedConsoleToken = encryptedToken;
  if (!saveState()) {
    if (previousEncryptedToken === undefined) delete state.encryptedConsoleToken;
    else state.encryptedConsoleToken = previousEncryptedToken;
    if (previousProcessToken === undefined) delete process.env.PD_CONSOLE_TOKEN;
    else process.env.PD_CONSOLE_TOKEN = previousProcessToken;
    return { persisted: false, restartRequested: false, reason: 'state_save_failed', nextAction: 'Check Companion write permissions, then retry.' };
  }

  if (current.kind === 'running' && current.mode === 'attached') {
    return {
      persisted: true,
      restartRequested: false,
      reason: 'external_console_attached',
      nextAction: 'Stop the external Console process and restart it from Companion to apply token authentication.',
    };
  }
  process.env.PD_CONSOLE_TOKEN = token;
  return { persisted: true, restartRequested: restartFromTray() };
}

/**
 * Read endpoint for the login form's auto-restore: hands the current runtime
 * token (restored from the encrypted store at startup) to the renderer so a
 * fresh browser session can connect without the Owner re-pasting it. The
 * renderer never gains privilege the server process lacks — the console
 * server already holds this token in its own environment — but the read is
 * still origin-guarded so a foreign page loaded into the window cannot pull
 * the credential: the sender must be the main window AND match the exact
 * origin of the console the supervisor currently serves (a page from another
 * loopback port still carries the preload bridge but is denied). Denied
 * senders get "no credential" and the login form falls back to manual entry.
 */
function getConsoleToken(senderId: number, senderUrl: string): ConsoleTokenStatus {
  if (senderId !== mainWindow?.webContents.id) return { available: false };
  const s = supervisor.getState();
  if (s.kind !== 'running' || !isSameConsoleOrigin(senderUrl, s.url)) return { available: false };
  return buildConsoleTokenStatus(process.env.PD_CONSOLE_TOKEN);
}

interface ConsoleTokenClearResult {
  cleared: boolean;
  restartRequested: boolean;
  reason?: 'invalid_sender' | 'state_save_failed' | 'external_console_attached' | 'inherited_env_token';
  nextAction?: string;
}

/**
 * The runtime token's origin of truth for the clear path: the encrypted store
 * is Companion-owned and durably clearable; a token inherited from the OS
 * environment (PD_CONSOLE_TOKEN set before launch, no encrypted entry) is
 * owned by the launcher and re-appears on the next launch, so clearing it is
 * only a session-scoped effect that must be reported honestly.
 */
function inheritedEnvTokenActive(companionState: CompanionState, envToken: string | undefined): boolean {
  return companionState.encryptedConsoleToken === undefined && envToken !== undefined && envToken.trim().length > 0;
}

/**
 * Credential lifecycle completion (rollback to the pre-binding state): drop
 * the encrypted store entry and the runtime env, then restart the managed
 * console so it comes back in no-auth mode — the state a fresh install
 * starts from. Mirrors configureConsoleToken's rollback-on-failed-save and
 * attached-server semantics. Same exact-origin guard as the read endpoint:
 * the destructive call must come from the console page, not any other page
 * that shares the window's webContents.
 */
function clearConsoleToken(senderId: number, senderUrl: string): ConsoleTokenClearResult {
  if (senderId !== mainWindow?.webContents.id) {
    return { cleared: false, restartRequested: false, reason: 'invalid_sender', nextAction: 'Use the Console window opened by PD Companion.' };
  }
  const current = supervisor.getState();
  if (current.kind !== 'running' || !isSameConsoleOrigin(senderUrl, current.url)) {
    return { cleared: false, restartRequested: false, reason: 'invalid_sender', nextAction: 'Use the Console window opened by PD Companion.' };
  }
  const previousEncryptedToken = state.encryptedConsoleToken;
  const previousProcessToken = process.env.PD_CONSOLE_TOKEN;
  if (inheritedEnvTokenActive(state, previousProcessToken)) {
    return {
      cleared: false,
      restartRequested: false,
      reason: 'inherited_env_token',
      nextAction: 'The Console token comes from the PD_CONSOLE_TOKEN environment variable set outside PD (launcher/shell), so it will return on the next Companion launch. Unset it at its source to remove it durably.',
    };
  }
  if (previousEncryptedToken === undefined && previousProcessToken === undefined) {
    return { cleared: true, restartRequested: false };
  }
  delete state.encryptedConsoleToken;
  if (!saveState()) {
    if (previousEncryptedToken !== undefined) state.encryptedConsoleToken = previousEncryptedToken;
    return { cleared: false, restartRequested: false, reason: 'state_save_failed', nextAction: 'Check Companion write permissions, then retry.' };
  }
  delete process.env.PD_CONSOLE_TOKEN;
  if (current.kind === 'running' && current.mode === 'attached') {
    return {
      cleared: true,
      restartRequested: false,
      reason: 'external_console_attached',
      nextAction: 'The external Console still enforces its own token; restart it without PD_CONSOLE_TOKEN to return to no-auth mode.',
    };
  }
  return { cleared: true, restartRequested: restartFromTray() };
}

// ─── Polling: approvals + health + version watch + update check ─────────────

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const token = process.env.PD_CONSOLE_TOKEN?.trim();
    const res = await fetch(url, {
      signal: controller.signal,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    if (!res.ok) return undefined;
    return (await res.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function startPolling(): void {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = setInterval(() => void pollTick(), POLL_INTERVAL_MS);
  void pollTick();
  if (updateTimer === undefined) {
    updateTimer = setInterval(() => void updateCheckTick(), UPDATE_CHECK_INTERVAL_MS);
    setTimeout(() => void updateCheckTick(), 15_000);
  }
}

async function pollTick(): Promise<void> {
  const s = supervisor.getState();
  if (s.kind !== 'running' || currentPort === undefined) return;
  const base = `http://127.0.0.1:${currentPort}`;
  const body = await fetchJson(`${base}/api/v1/approvals?status=pending`);
  if (body === undefined) {
    consecutivePollFailures += 1;
    log('poll_failed', { consecutive: consecutivePollFailures });
    if (consecutivePollFailures >= CONSECUTIVE_POLL_FAILURES_BEFORE_RESTART && s.mode === 'attached') {
      // attached server is gone — take over with a fresh managed spawn
      const delay = supervisor.onServerExit(null);
      if (delay !== undefined) {
        log('attached_server_lost_restart', { delayMs: delay });
        scheduleRestartRetry(delay, 'attached_server_lost');
      }
    }
    return;
  }
  consecutivePollFailures = 0;
  const snapshot = parseApprovalsResponse(body);
  if (snapshot === undefined) {
    log('poll_response_invalid');
    return;
  }
  const known = new Set(state.notifiedApprovalIds);
  const diff = diffPendingApprovals({ hasBaseline: baselineRecorded, knownIds: known, snapshotIds: snapshot.approvalIds });
  if (diff.baselineIds !== undefined) {
    baselineRecorded = true;
    if (diff.baselineIds.length > 0) {
      state = markApprovalsNotified(state, diff.baselineIds);
      saveState();
      log('baseline_recorded', { count: diff.baselineIds.length });
    }
    return;
  }
  if (diff.notifyIds.length > 0) {
    state = markApprovalsNotified(state, diff.notifyIds);
    saveState();
    notifyApprovals(diff.notifyIds.length, snapshot.pendingCount);
  }
  watchInstalledVersion();
}

function watchInstalledVersion(): void {
  const s = supervisor.getState();
  if (s.kind !== 'running') return;
  const version = readInstalledVersion();
  if (version === undefined || serverStartedVersion === undefined || version === serverStartedVersion) return;
  if (s.mode === 'managed') {
    // npm-layer update applied from the console UI — stop the OLD server,
    // confirm it has exited, then respawn the NEW version. The disk version
    // marker alone is not proof a new process is running.
    log('version_change_restart', { from: serverStartedVersion, to: version });
    // Snapshot the OWNERSHIP evidence while the machine still says
    // `running` — after onServerExit(null) the state is `restarting`, and a
    // snapshot taken there returned no handle, silently skipped the kill and
    // left the old Console on the port (the PRI-1012 P1 defect).
    const handle = ownedManagedHandle(s, supervisor.ownsProcess(), cliChild?.pid);
    const oldChild = cliChild;
    const delay = supervisor.onServerExit(null);
    if (delay === undefined) return;
    pendingTargetVersion = version;
    const stopOld = handle === undefined
      ? Promise.resolve(false)
      : killManagedServerAndConfirm(handle).then((confirmed) => {
          log('version_change_old_server_stopped', { serverPid: handle.serverPid, confirmed });
          return confirmed;
        });
    void stopOld.then(() => {
      if (quitting) return;
      const now = supervisor.getState();
      // The state machine may have moved on (quit / crash-loop / manual stop);
      // only reschedule when we are still waiting to restart.
      if (now.kind !== 'restarting') return;
      scheduleRestartRetry(delay, 'version_change');
    });
    if (oldChild !== undefined) expectedExitChildren.add(oldChild);
  } else {
    log('version_change_attached_no_action', { from: serverStartedVersion, to: version });
  }
}

function notifyApprovals(newCount: number, pendingTotal: number): void {
  if (!Notification.isSupported()) {
    log('notification_unsupported');
    return;
  }
  const notification = new Notification({
    title: 'PD 有新的待审批项',
    body: `新增 ${newCount} 条待审批，当前共 ${pendingTotal} 条待处理。点击查看。`,
    icon: nativeImage.createFromPath(iconPath()),
  });
  notification.on('click', () => showWindow('#/focus'));
  notification.show();
  log('notified_approvals', { newCount, pendingTotal });
}

async function updateCheckTick(): Promise<void> {
  const s = supervisor.getState();
  if (s.kind !== 'running' || currentPort === undefined) return;
  const body = await fetchJson(`http://127.0.0.1:${currentPort}/api/update/check`);
  if (body === undefined) return;
  const info = parseUpdateCheckResponse(body);
  if (info === undefined) {
    log('update_check_response_invalid');
    return;
  }
  if (!shouldNotifyUpdate(state.notifiedUpdateVersions, info)) return;
  if (info.latestVersion === undefined) return;
  state = markUpdateNotified(state, info.latestVersion);
  saveState();
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: 'PD 有新版本可用',
    body: `新版本 v${info.latestVersion} 已发布。点击前往更新页。`,
    icon: nativeImage.createFromPath(iconPath()),
  });
  notification.on('click', () => showWindow('#/update'));
  notification.show();
  log('notified_update', { version: info.latestVersion });
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function rebuildTrayMenu(): void {
  if (tray === undefined) return;
  const s = supervisor.getState();
  // Pure reads of the existing degraded/unavailable state (PRI-715 +
  // 2026-10-16) — querying must never reset degradation, restart a worker or
  // touch the manifest.
  const degradedView = buildDegradedWorkspacesTrayView([
    ...(workspaceWorkers?.degradedWorkspaces() ?? []),
    ...(workbuddyWorkspaceWorkers?.degradedWorkspaces() ?? []),
  ]);
  const syncUnavailableView = buildSyncUnavailableTrayView(
    [
      workspaceWorkers?.syncUnavailable(),
      workbuddyWorkspaceWorkers?.syncUnavailable(),
    ].filter((episode): episode is NonNullable<typeof episode> => episode !== undefined),
  );
  const supervisorLabel =
    s.kind === 'running'
      ? s.mode === 'managed' ? `控制台运行中（端口 ${s.port}）` : `控制台已连接·外部实例（端口 ${s.port}）`
      : s.kind === 'restarting' && s.reason.startsWith(ENTRY_PENDING_REASON_PREFIX)
        // Waiting on the update chain to lay the files is not "starting" and not
        // a crash backoff — the Owner must be able to tell them apart (rc-9).
        ? '等待 PD 更新完成…'
        : s.kind === 'starting' || s.kind === 'restarting'
          ? '控制台启动中…'
          : '控制台未运行';
  const statusLabel = supervisorLabel + degradedView.statusSuffix + syncUnavailableView.statusSuffix;
  tray.setToolTip(`PD Companion — ${statusLabel}`);
  const autoStart = app.getLoginItemSettings().openAtLogin;
  const degradedSection: MenuItemConstructorOptions[] = [
    ...degradedView.menuLabels,
    ...syncUnavailableView.menuLabels,
  ].length > 0
    ? [
        { type: 'separator' },
        ...[...degradedView.menuLabels, ...syncUnavailableView.menuLabels].map((label) => ({ label, enabled: false })),
      ]
    : [];
  const template: MenuItemConstructorOptions[] = [
    { label: '打开控制台', click: () => showWindow() },
    { label: '重启控制台服务', enabled: supervisor.canRestart(), click: () => restartFromTray() },
    ...degradedSection,
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: autoStart,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
        log('autostart_toggled', { enabled: menuItem.checked });
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image);
  tray.on('double-click', () => showWindow());
  rebuildTrayMenu();
}

// ─── App lifecycle ───────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.setAppUserModelId(APP_USER_MODEL_ID);

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
    logFilePath = path.join(userData, 'logs', 'companion-main.log');
    stateFilePath = path.join(userData, 'companion-state.json');
     loadState();
     restoreEncryptedConsoleToken();
     ipcMain.handle('pd-companion:configure-console-token', (event, token: unknown) => configureConsoleToken(event.sender.id, token));
     ipcMain.handle('pd-companion:get-console-token', (event) => getConsoleToken(event.sender.id, event.senderFrame?.url ?? ''));
     ipcMain.handle('pd-companion:clear-console-token', (event) => clearConsoleToken(event.sender.id, event.senderFrame?.url ?? ''));

    // Locked decision #5: autostart defaults ON, announced on first run.
    if (!state.firstRunNoticeShown) {
      app.setLoginItemSettings({ openAtLogin: true });
      log('autostart_enabled_first_run');
    }

    createWindow();
    createTray();
    startSupervision();
    // Workspace workers need the installed pd-cli entry; when the runtime is
    // missing the console supervisor already surfaces the degraded state, and
    // spawning worker children would only produce a restart-error loop.
    if (extDir !== undefined && entryFileVerdict(resolvePdCliEntry(extDir)).ok) {
      startWorkspaceWorkerSupervision();
    }

    log('companion_started', { version: app.getVersion() });
  });

  app.on('before-quit', () => {
    quitting = true;
    stopServer();
    stopWorkspaceWorkerSupervision();
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (updateTimer !== undefined) clearInterval(updateTimer);
    saveState();
    log('companion_quit');
  });

  app.on('window-all-closed', () => {
    // resident companion: keep running in tray
  });
}
