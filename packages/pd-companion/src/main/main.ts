/* eslint-disable @typescript-eslint/no-use-before-define -- supervision/tray/polling form a reference cycle; helpers declared in reading order, matching codebase convention (see rulehost-pipeline-runner.ts) */

/**
 * PD Companion — Electron main process (PRI-526).
 *
 * Thin glue around the pure-logic lib layer: tray + window + supervisor
 * wiring + notifications + autostart. The companion does NOT embed the
 * console server — it spawns `pd console open --json --no-browser --no-auth`
 * with the SYSTEM Node (better-sqlite3 ABI constraint) and supervises it.
 */

import { app, BrowserWindow, Menu, Notification, Tray, nativeImage } from 'electron';
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
import { getInstallLayoutPaths } from '@principles/install-layout';
import { tryParseConsoleOpenOutput, parsePluginVersion, LaunchResultError } from '../lib/launch-result.js';
import { ConsoleSupervisor } from '../lib/supervisor.js';
import { buildDegradedPageHtml, describeDegraded } from '../lib/degraded.js';
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
import { WorkspaceWorkerRegistry, type WorkerChild } from '../lib/workspace-workers.js';
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
let quitting = false;
let baselineRecorded = false;
let consecutivePollFailures = 0;
let serverStartedVersion: string | undefined;
let currentPort: number | undefined;

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

function saveState(): void {
  try {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log('state_save_failed', { message: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Spawn argument hardening ────────────────────────────────────────────────

/** A path is argv-safe when absolute, control-char-free, and an existing file. */
function isSafeExistingFile(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(candidate)) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
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
  supervisor.markIntentionalStop();
  if (supervisor.ownsProcess()) {
    killSpawnedTree(cliChild);
  }
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
  } catch {
    manifest = undefined;
  }
  const runtime = resolveInstalledRuntime({
    homeDir: home,
    manifest,
    canonicalRuntimeExists: fs.existsSync(paths.runtimeDir),
    legacyExtensionExists: fs.existsSync(paths.openClawExtensionDir),
  });
  extDir = runtime?.root;
  installedPluginDir = runtime?.pluginRoot;
  if (extDir === undefined || !fs.existsSync(resolvePdCliEntry(extDir))) {
    supervisor.start();
    supervisor.onLaunchFailure({ reason: 'console_runtime_not_installed' });
    const s = supervisor.getState();
    if (s.kind === 'degraded') showDegradedPage(s.reason, s.detail, s.nextAction);
    log('pd_not_installed');
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

function manifestCodexWorkspaces(): string[] {
  const paths = getInstallLayoutPaths(app.getPath('home'));
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as unknown;
  } catch {
    return [];
  }
  const parsed = parseInstallManifest(manifest);
  if (parsed.manifest === undefined) return [];
  if (!parsed.manifest.hosts.includes('codex')) return [];
  return (parsed.manifest.workspaces ?? []).filter((workspace) => {
    try {
      return fs.statSync(workspace).isDirectory();
    } catch {
      return false;
    }
  });
}

function spawnWorkspaceWorker(canonicalWorkspaceDir: string): WorkerChild {
  // Same system-node discipline as the console server: better-sqlite3 is
  // built for the SYSTEM Node ABI, never Electron's bundled Node.
  const entry = extDir !== undefined ? resolvePdCliEntry(extDir) : undefined;
  if (entry === undefined || !isSafeExistingFile(entry)) {
    throw new Error('pd-cli entry unavailable');
  }
  const child = spawn('node', [
    entry,
    'codex', 'worker',
    '--workspace', canonicalWorkspaceDir,
    '--interval', String(WORKSPACE_WORKER_CYCLE_INTERVAL_MS),
    '--json',
  ], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (chunk: Buffer) => {
    // Bounded stderr tail into the companion log — the worker's own
    // structured output already lands in workspace state/log surfaces.
    log('workspace_worker_stderr', { workspace: canonicalWorkspaceDir, tail: chunk.toString('utf8').slice(-400) });
  });
  return child;
}

function startWorkspaceWorkerSupervision(): void {
  workspaceWorkers = new WorkspaceWorkerRegistry({
    spawnWorker: spawnWorkspaceWorker,
    log: (event, fields) => log(event, fields ?? {}),
  });
  workspaceWorkers.sync(manifestCodexWorkspaces());
  workspaceWorkerTimer = setInterval(() => {
    if (quitting) return;
    workspaceWorkers?.sync(manifestCodexWorkspaces());
  }, WORKSPACE_WORKER_SYNC_INTERVAL_MS);
  workspaceWorkerTimer.unref();
}

function stopWorkspaceWorkerSupervision(): void {
  if (workspaceWorkerTimer !== undefined) clearInterval(workspaceWorkerTimer);
  workspaceWorkers?.stopAll();
}

function spawnCli(): void {  if (extDir === undefined) return;
  // spawn argv hardening: program is the literal 'node' (resolved via PATH by
  // the OS — never env-controlled); every path argument is validated above.
  // The workspace override comes from a local state file and only reaches
  // argv after validatedWorkspaceOverride() confirms it is a real directory.
  const entry = resolvePdCliEntry(extDir);
  if (!isSafeExistingFile(entry)) {
    supervisor.onSpawnError(undefined, `pd-cli entry failed safety check: ${entry}`);
    reflectSupervisorState();
    return;
  }
  const args = [entry, ...buildConsoleOpenArgs({ workspaceDir: validatedWorkspaceOverride() })];
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
      setTimeout(() => {
        if (quitting) return;
        if (supervisor.getState().kind === 'restarting') spawnCli();
      }, delay);
    } else {
      log('server_exit_no_restart', { code });
      reflectSupervisorState();
    }
  });
}

function handleLaunchResult(parsed: { status: string; url: string; port: number; serverPid?: number; reason?: string; nextAction?: string }): void {
  if (parsed.status === 'started') {
    serverStartedVersion = readInstalledVersion();
    currentPort = parsed.port;
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
    currentPort = parsed.port;
    serverStartedVersion = readInstalledVersion();
    supervisor.onLaunchReused(parsed.url, parsed.port);
    log('console_reused', { port: parsed.port, mode: 'attached' });
    void mainWindow?.loadURL(parsed.url).catch((err: unknown) => log('window_load_failed', { message: err instanceof Error ? err.message : String(err) }));
    startPolling();
  } else {
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

function restartFromTray(): void {
  stopServer();
  setTimeout(() => {
    if (quitting) return;
    supervisor.start();
    spawnCli();
  }, 600);
}

// ─── Polling: approvals + health + version watch + update check ─────────────

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
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
        setTimeout(() => {
          if (!quitting && supervisor.getState().kind === 'restarting') spawnCli();
        }, delay);
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
    // npm-layer update applied from the console UI — restart server to run it
    log('version_change_restart', { from: serverStartedVersion, to: version });
    const delay = supervisor.onServerExit(null);
    if (delay !== undefined) {
      setTimeout(() => {
        if (!quitting && supervisor.getState().kind === 'restarting') spawnCli();
      }, delay);
    }
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
  const statusLabel =
    s.kind === 'running'
      ? s.mode === 'managed' ? `控制台运行中（端口 ${s.port}）` : `控制台已连接·外部实例（端口 ${s.port}）`
      : s.kind === 'starting' || s.kind === 'restarting'
        ? '控制台启动中…'
        : '控制台未运行';
  tray.setToolTip(`PD Companion — ${statusLabel}`);
  const autoStart = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开控制台', click: () => showWindow() },
      { label: '重启控制台服务', enabled: supervisor.canRestart(), click: () => restartFromTray() },
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
    ]),
  );
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
    if (extDir !== undefined && isSafeExistingFile(resolvePdCliEntry(extDir))) {
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
