/**
 * Service Host scheduler bridge (PRI-1281 Phase 3, task §6).
 *
 * The installer NEVER re-implements scheduler lifecycle logic — it invokes
 * the JUST-INSTALLED pd CLI (`<pdHome>/runtime/pd-cli/dist/index.js service
 * … --json --pd-home <pdHome>`), so `pd service install|enable|status|
 * uninstall` stays the single implementation (one source of truth).
 *
 * Contract:
 *  - the spawned CLI receives a CLEANED environment: PD_EXPERIMENT_ROOT and
 *    PD_WORKSPACE_DIR never reach it — the trusted pdHome is passed
 *    explicitly (task §6.3, never inferred from an untrusted HOME);
 *  - every failure is a structured warning for the caller to surface — the
 *    install/update transaction is ALREADY committed at this point, so a
 *    bridge failure must never turn a committed install into a reported
 *    failure (ERR-197);
 *  - no credentials are ever passed — arguments are paths and subcommand
 *    names only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ServiceHostBridgeOutcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly nextAction?: string;
  /** From `pd service status`: whether a registration exists (null = unreadable). */
  readonly registered?: boolean | null;
  /** From `pd service status`: the registered trigger interval (null = unreadable). */
  readonly triggerIntervalMs?: number | null;
  /** From `pd service status`: whether the OS reports the trigger enabled. */
  readonly enabled?: boolean | null;
}

/**
 * PRI-1278 Phase 5: the background-execution consent resolved by the caller.
 * The installer never creates a persistent OS trigger without one of these.
 */
export type ServiceHostSchedulerIntent =
  | 'enable'
  | 'register_only'
  | 'refresh_if_registered'
  | 'opt_out'
  | 'consent_required';

export type ServiceHostSchedulerState =
  | 'enabled'
  | 'registered_disabled'
  | 'refreshed'
  | 'not_registered'
  | 'consent_required'
  | 'opted_out'
  | 'failed';

export interface ServiceHostSchedulerOutcome {
  readonly state: ServiceHostSchedulerState;
  readonly registered: boolean | null;
  readonly enabled: boolean | null;
  readonly triggerIntervalMs?: number | null;
  readonly detail?: string;
  readonly nextAction: string;
  readonly warnings: readonly string[];
}

/** Env vars that must never steer the spawned CLI's install identity. */
const STRIPPED_ENV_KEYS = ['PD_EXPERIMENT_ROOT', 'PD_WORKSPACE_DIR'] as const;

const BRIDGE_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

function cleanedEnv(homeDir?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  // Worker commands do NOT accept --pd-home (only `pd service` does), so the
  // trusted install identity is supplied the way those commands resolve it:
  // through the user home. Setting BOTH names keeps Node's os.homedir()
  // consistent across platforms.
  if (homeDir !== undefined) {
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
  }
  return env;
}

interface SpawnOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: string;
  readonly timedOut?: boolean;
}

interface SpawnCliOptions {
  readonly spawnFn?: typeof spawn;
  readonly timeoutMs?: number;
  /** Trusted home for commands that resolve identity from HOME (worker probes). */
  readonly homeDir?: string;
}

function spawnCli(entry: string, args: readonly string[], options: SpawnCliOptions = {}): Promise<SpawnOutcome> {
  const spawnFn = options.spawnFn ?? spawn;
  const timeoutMs = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;
  return new Promise<SpawnOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let child: ChildProcess;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // exit handler settles
      }
    }, timeoutMs);
    const settle = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    try {
      child = spawnFn(process.execPath, [entry, ...args], {
        env: cleanedEnv(options.homeDir),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle({ code: null, stdout: '', stderr: '', spawnError: message });
      return;
    }
    child.on('error', (error: Error & { code?: string }) => {
      settle({ code: null, stdout: '', stderr: '', spawnError: error.code ?? error.message });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_STDOUT_BYTES) {
        stdout += chunk.toString('utf8');
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_BYTES) {
        stderr += chunk.toString('utf8');
        stderrBytes += chunk.length;
      }
    });
    child.on('close', (code) => {
      settle({ code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}

/** Injectable spawn boundary (tests fake it; production spawns node). */
export interface ServiceHostBridgeProbes {
  readonly spawnFn?: typeof spawn;
}

export interface InstalledCliJsonResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly detail: string;
  readonly doc?: Record<string, unknown>;
  readonly stderr?: string;
}

/**
 * Run one bounded call against the JUST-INSTALLED pd CLI and return its single
 * JSON document. Used by the provisioning probes (worker readiness, first
 * managed cycle). Parsing rules are the same cli-1 contract as
 * `runServiceHostCli`: exactly one JSON object, never "log-mixed output =
 * absent state".
 */
export interface InstalledCliCallOptions {
  /** Test injection for the spawn boundary. */
  readonly probes?: ServiceHostBridgeProbes;
  /** Bounded call budget (the first managed cycle needs more than 120s). */
  readonly timeoutMs?: number;
  /**
   * `pd service …` accepts --pd-home; host WORKER commands do not. Worker
   * probes must set this false and pass `homeDir` instead — Commander rejects
   * an unregistered option, which used to make every readiness probe fail.
   */
  readonly includePdHome?: boolean;
  /** Trusted home for worker probes (identity via HOME/USERPROFILE). */
  readonly homeDir?: string;
}

export async function runInstalledCliJson(
  pdHome: string,
  args: readonly string[],
  options: InstalledCliCallOptions = {},
): Promise<InstalledCliJsonResult> {
  const entry = path.join(pdHome, 'runtime', 'pd-cli', 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    return { ok: false, code: null, detail: `service_host_cli_entry_missing:${entry}` };
  }
  const includePdHome = options.includePdHome !== false;
  const fullArgs = includePdHome ? [...args, '--pd-home', path.dirname(pdHome)] : [...args];
  const outcome = await spawnCli(entry, fullArgs, {
    ...(options.probes?.spawnFn !== undefined ? { spawnFn: options.probes.spawnFn } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  });
  if (outcome.timedOut === true) {
    return { ok: false, code: outcome.code, detail: `service_host_cli_timeout:${args.join(' ')}` };
  }
  if (outcome.spawnError !== undefined) {
    return { ok: false, code: outcome.code, detail: `service_host_cli_spawn_failed:${outcome.spawnError}` };
  }
  const stdoutDoc = outcome.stdout.trim();
  if (stdoutDoc === '') {
    return { ok: false, code: outcome.code, detail: `service_host_cli_no_json:exit_${outcome.code ?? 'null'}`, stderr: outcome.stderr };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutDoc);
  } catch {
    return { ok: false, code: outcome.code, detail: `service_host_cli_unparsable_json:exit_${outcome.code ?? 'null'}`, stderr: outcome.stderr };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: outcome.code, detail: 'service_host_cli_schema_violation:top_level', stderr: outcome.stderr };
  }
  return {
    ok: outcome.code === 0,
    code: outcome.code,
    detail: outcome.code === 0 ? 'ok' : `exit_${outcome.code ?? 'null'}`,
    doc: parsed as Record<string, unknown>,
    stderr: outcome.stderr,
  };
}

/** Run one `pd service <subcommand>` lifecycle call against the installed CLI. */
export async function runServiceHostCli(pdHome: string, args: readonly string[], probes: ServiceHostBridgeProbes = {}): Promise<ServiceHostBridgeOutcome> {
  // args = ['service', '<op>', ...] — the operation is the second token.
  const op = args[1] ?? '';
  const entry = path.join(pdHome, 'runtime', 'pd-cli', 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    return {
      ok: false,
      detail: `service_host_cli_entry_missing:${entry}`,
      nextAction: 'The pd CLI is not present in the runtime — nothing was registered; run `pd service install` manually after repairing the install.',
    };
  }
  // `--pd-home` carries the HOME ROOT — the CLI derives <home>/.pd itself,
  // so passing pdHome would resolve to <home>/.pd/.pd. For the canonical
  // layout getPdDir() IS <home>/.pd, hence dirname.
  const outcome = await spawnCli(entry, [...args, '--json', '--pd-home', path.dirname(pdHome)], { spawnFn: probes.spawnFn });
  if (outcome.timedOut === true) {
    return {
      ok: false,
      detail: 'service_host_cli_timeout',
      nextAction: `pd service ${op} call did not finish in ${BRIDGE_TIMEOUT_MS / 1000}s; retry it manually — every operation is idempotent.`,
    };
  }
  if (outcome.spawnError !== undefined) {
    return {
      ok: false,
      detail: `service_host_cli_spawn_failed:${outcome.spawnError}`,
      nextAction: 'The installed pd CLI could not be started; run the pd service command manually later (operations are idempotent).',
    };
  }
  // cli-1 (task §1 review): stdout must be EXACTLY ONE JSON document —
  // the whole trimmed stdout is parsed; a log line before/after the JSON,
  // a truncated document, or an empty stdout all fail closed and are never
  // interpreted as "scheduler not registered". Failure classes stay
  // distinct: process failure (exit/timeout/spawn) vs JSON-parse failure
  // vs schema violation.
  const stdoutDoc = outcome.stdout.trim();
  if (stdoutDoc === '') {
    return {
      ok: false,
      detail: `service_host_cli_no_json:exit_${outcome.code ?? 'null'}`,
      nextAction: `pd service ${op} produced no machine-readable output (exit ${outcome.code ?? 'n/a'}${outcome.stderr.trim() !== '' ? `; ${outcome.stderr.trim().slice(0, 160)}` : ''}); inspect it manually.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutDoc);
  } catch {
    return {
      ok: false,
      detail: `service_host_cli_unparsable_json:exit_${outcome.code ?? 'null'}`,
      nextAction: `pd service ${op} stdout was not a single JSON document (log-mixed or truncated output is refused, exit ${outcome.code ?? 'n/a'}); run it manually to see the full output.`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      detail: 'service_host_cli_schema_violation:top_level',
      nextAction: `pd service ${op} emitted JSON that is not an object; run it manually to see the full output.`,
    };
  }
  const doc = parsed as Record<string, unknown>;
  if (op === 'status') {
    const { scheduler } = doc;
    const registered =
      typeof scheduler === 'object' && scheduler !== null && Object.hasOwn(scheduler, 'registered') &&
      (typeof (scheduler as { registered?: unknown }).registered === 'boolean' || (scheduler as { registered?: unknown }).registered === null)
        ? (scheduler as { registered: boolean | null }).registered
        : null;
    const intervalMs =
      typeof scheduler === 'object' && scheduler !== null &&
      typeof (scheduler as { triggerConfiguration?: unknown }).triggerConfiguration === 'object' &&
      (scheduler as { triggerConfiguration: unknown }).triggerConfiguration !== null
        ? ((scheduler as { triggerConfiguration: { intervalMs?: unknown } }).triggerConfiguration.intervalMs ?? null) as number | null
        : null;
    const enabled =
      typeof scheduler === 'object' && scheduler !== null && Object.hasOwn(scheduler, 'enabled') &&
      (typeof (scheduler as { enabled?: unknown }).enabled === 'boolean' || (scheduler as { enabled?: unknown }).enabled === null)
        ? (scheduler as { enabled: boolean | null }).enabled
        : null;
    if (outcome.code === 0 && doc.schemaVersion === 'pd.service-status.v1') {
      return { ok: true, detail: 'ok', registered, enabled, triggerIntervalMs: typeof intervalMs === 'number' ? intervalMs : null };
    }
    const reason = typeof doc.reason === 'string' ? doc.reason : `exit_${outcome.code ?? 'null'}`;
    if (outcome.code === 0 && doc.schemaVersion !== 'pd.service-status.v1') {
      return {
        ok: false,
        detail: `service_host_cli_schema_violation:schema_version`,
        nextAction: `pd service status emitted a document with an unknown schemaVersion (${typeof doc.schemaVersion === 'string' ? doc.schemaVersion : 'missing'}); the scheduler state is unknown — nothing was changed. Inspect it manually.`,
        registered,
      };
    }
    return {
      ok: false,
      detail: `service_host_status_failed:${reason}`,
      nextAction: 'pd service status did not succeed; the scheduler registration state is unknown — nothing was changed. Inspect it manually.',
      registered,
    };
  }
  if (typeof doc.ok !== 'boolean') {
    return {
      ok: false,
      detail: 'service_host_cli_schema_violation:ok_field',
      nextAction: `pd service ${op} emitted a document without a boolean \`ok\` field; the operation state is unknown — inspect it manually.`,
    };
  }
  if (outcome.code === 0 && doc.ok === true) {
    return { ok: true, detail: 'ok' };
  }
  const reason = typeof doc.reason === 'string' ? doc.reason : `exit_${outcome.code ?? 'null'}`;
  return {
    ok: false,
    detail: `service_host_cli_refused:${reason}`,
    nextAction: `pd service ${op} did not succeed (${reason}); nothing was silently skipped — retry it manually after fixing the cause.`,
  };
}

/**
 * Cheap platform file probe: could a PD scheduler registration exist at all?
 * Used to SKIP the CLI status probe entirely on machines where nothing was
 * ever registered — a full CLI boot per install() otherwise accumulates into
 * minutes across install-heavy flows (CI observed at the 15m job timeout).
 * Name prefixes only (no install-key duplication — the key stays owned by
 * pd-cli's schedulerIdentityFor).
 */
export function maybeSchedulerRegistrationExists(homeDir: string): boolean {
  try {
    if (process.platform === 'win32') {
      // existsSync: a missing dir/file is a clean false — nothing was ever registered.
      return fs.existsSync(path.join(homeDir, '.pd', 'service', 'scheduler-registration-win.xml'));
    }
    if (process.platform === 'darwin') {
      const agents = path.join(homeDir, 'Library', 'LaunchAgents');
      return fs.readdirSync(agents).some((name) => name.startsWith('com.principles-disciple.service-host.') && name.endsWith('.plist'));
    }
    if (process.platform === 'linux') {
      const units = path.join(homeDir, '.config', 'systemd', 'user');
      return fs.readdirSync(units).some((name) => name.startsWith('pd-service-host-') && name.endsWith('.timer'));
    }
    return false;
  } catch (error) {
    // A MISSING directory proves "never registered" cleanly (the common
    // fresh-install case); anything else (permissions) keeps the honest
    // (slower) path: ask the CLI.
    const {code} = (error as Error & { code?: string });
    if (code === 'ENOENT') return false;
    return true;
  }
}

export interface SchedulerReconcileInput {
  readonly pdHome: string;
  /** PRI-1278 Phase 5: the resolved consent (what to do, and why). */
  readonly intent: ServiceHostSchedulerIntent;
  /** Provenance of the intent (used to refuse implicit upgrades). */
  readonly source?: 'explicit_flag' | 'interactive_consent' | 'recommended_default' | 'policy';
  /** The installer observed NO manifest before this run. */
  readonly freshInstall: boolean;
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
  /** Test injection for the spawn boundary. */
  readonly probes?: ServiceHostBridgeProbes;
}

async function readSchedulerStatus(input: SchedulerReconcileInput): Promise<ServiceHostBridgeOutcome> {
  return await runServiceHostCli(input.pdHome, ['service', 'status'], input.probes ?? {});
}

/**
 * Post-install scheduler reconciliation (task §6 / PRI-1278 Phase 5). Runs
 * AFTER the install transaction committed, so every failure is a WARNING — a
 * bridge failure must never turn a committed install into a reported failure
 * (ERR-197).
 *
 *  - 'enable': register then enable, then VERIFY through `pd service status`
 *    that the OS reports both facts (an unreadable verdict is degraded, never
 *    silently reported as success);
 *  - 'register_only': register installed_disabled;
 *  - 'refresh_if_registered': an existing registration is re-installed
 *    idempotently (entry refresh, enabled state PRESERVED); a machine with no
 *    registration gets NOTHING created;
 *  - 'opt_out' / 'consent_required': no OS mutation at all, with a structured
 *    reason — never silent.
 */
export async function reconcileServiceHostScheduler(input: SchedulerReconcileInput): Promise<ServiceHostSchedulerOutcome> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    input.warn(message);
  };

  if (input.intent === 'opt_out') {
    return {
      state: 'opted_out',
      registered: null,
      enabled: null,
      nextAction: 'Service Host scheduler was explicitly disabled for this install. To adopt the PD-owned background lifecycle later, re-run the installer with --enable-service-host (workspace ownership is initialized in that same run); workspace data and pending tasks are kept.',
      warnings,
    };
  }
  if (input.intent === 'consent_required') {
    return {
      state: 'consent_required',
      registered: null,
      enabled: null,
      nextAction: 'No OS scheduler trigger was registered: this non-interactive run did not include consent. Re-run with --enable-service-host (or --yes to accept the recommended defaults) so the installer registers, enables AND initializes workspace ownership; workspace data and pending tasks are kept.',
      warnings,
    };
  }
  if (input.intent === 'refresh_if_registered') {
    // Upgrade / preservation path: refresh only when a registration
    // plausibly exists. The file probe avoids a full CLI boot per install
    // on machines where nothing was ever registered.
    if (!maybeSchedulerRegistrationExists(path.dirname(input.pdHome))) {
      return {
        state: 'not_registered',
        registered: false,
        enabled: null,
        nextAction: 'No Service Host scheduler registration existed before this install and none was created (upgrade preserves the existing lifecycle). Enable it explicitly with `pd service enable` after `pd service install` if this installation should move to the PD-owned background lifecycle.',
        warnings,
      };
    }
    const status = await readSchedulerStatus(input);
    if (!status.ok) {
      warn(`Service Host scheduler state could not be verified after install (${status.detail}) — nothing was changed. ${status.nextAction ?? ''}`.trim());
      return {
        state: 'failed',
        registered: status.registered ?? null,
        enabled: status.enabled ?? null,
        detail: status.detail,
        nextAction: 'Inspect `pd service status --json` and repair the registration; the existing scheduler state was kept unchanged.',
        warnings,
      };
    }
    if (status.registered !== true) {
      return {
        state: 'not_registered',
        registered: status.registered ?? null,
        enabled: status.enabled ?? null,
        nextAction: 'No Service Host registration is present; nothing was created during this upgrade. Use `pd service install` + `pd service enable` to adopt the PD-owned background lifecycle.',
        warnings,
      };
    }
    if (status.triggerIntervalMs === undefined || status.triggerIntervalMs === null) {
      warn('Service Host scheduler refresh refused: the registered trigger interval could not be read from pd service status — the existing registration was KEPT unchanged. Re-run pd service status and repair the registration first.');
      return {
        state: 'failed',
        registered: status.registered,
        enabled: status.enabled ?? null,
        detail: 'trigger_interval_unreadable',
        nextAction: 'Repair the registration (`pd service status --json`) and re-run the installer, or re-register explicitly with `pd service install --interval-ms <ms>`.',
        warnings,
      };
    }
    const refresh = await runServiceHostCli(input.pdHome, ['service', 'install', '--interval-ms', String(status.triggerIntervalMs)], input.probes ?? {});
    if (!refresh.ok) {
      warn(`Service Host scheduler refresh failed (${refresh.detail}) — the last valid registration was KEPT. ${refresh.nextAction ?? ''}`.trim());
      return {
        state: 'failed',
        registered: true,
        enabled: status.enabled ?? null,
        triggerIntervalMs: status.triggerIntervalMs,
        detail: refresh.detail,
        nextAction: 'Re-run `pd service install` manually; the previous registration still exists and was not removed.',
        warnings,
      };
    }
    input.info?.(`Service Host scheduler registration refreshed to the active release (interval ${status.triggerIntervalMs}ms and enabled state preserved).`);
    return {
      state: 'refreshed',
      registered: true,
      enabled: status.enabled ?? null,
      triggerIntervalMs: status.triggerIntervalMs,
      nextAction: 'Registration refreshed to the active release; its enabled/disabled state was preserved.',
      warnings,
    };
  }

  // 'enable' or an explicit register on a fresh install.
  const install = await runServiceHostCli(input.pdHome, ['service', 'install'], input.probes ?? {});
  if (!install.ok) {
    warn(`Service Host scheduler registration failed (${install.detail}). ${install.nextAction ?? ''}`.trim());
    return {
      state: 'failed',
      registered: install.registered ?? null,
      enabled: null,
      detail: install.detail,
      nextAction: 'The Service Host scheduler was NOT registered, so workspace ownership will not be handed over. Fix the OS scheduler registration (`pd service install --json`) and re-run the installer.',
      warnings,
    };
  }
  if (input.intent === 'register_only') {
    input.info?.('Service Host scheduler registered (disabled by default — enable with `pd service enable`).');
    return {
      state: 'registered_disabled',
      registered: true,
      enabled: false,
      nextAction: 'The scheduler is registered but DISABLED. Re-run the installer with --enable-service-host after arming it so the new workspace is also initialized into Service Host ownership; enabling alone does not change ownership.',
      warnings,
    };
  }
  const enable = await runServiceHostCli(input.pdHome, ['service', 'enable'], input.probes ?? {});
  if (!enable.ok) {
    warn(`Service Host scheduler ENABLE failed (${enable.detail}) — the registration exists but stays DISABLED. ${enable.nextAction ?? ''}`.trim());
    return {
      state: 'registered_disabled',
      registered: true,
      enabled: false,
      detail: enable.detail,
      nextAction: 'The scheduler registration exists but could not be enabled, so workspace ownership will not be handed over. Fix the OS trigger (`pd service enable --json`) and re-run the installer.',
      warnings,
    };
  }
  // Verify through the OS-backed status document: "enable returned 0" is not
  // proof that the trigger is armed (cli-6 / AC-12 truthful health).
  const verified = await readSchedulerStatus(input);
  if (!verified.ok || verified.registered !== true) {
    warn(`Service Host scheduler enabled but the OS state could not be verified (${verified.detail}) — treat the trigger as UNCONFIRMED. ${verified.nextAction ?? ''}`.trim());
    return {
      state: 'failed',
      registered: verified.registered ?? null,
      enabled: verified.enabled ?? null,
      detail: verified.detail,
      nextAction: 'Run `pd service status --json` and confirm registered=true / enabled=true before relying on automatic runs; workspace ownership was NOT handed over.',
      warnings,
    };
  }
  if (verified.enabled !== true) {
    warn('Service Host scheduler enabled but `pd service status` does not report the trigger as enabled — workspace ownership was NOT handed over.');
    return {
      state: 'registered_disabled',
      registered: true,
      enabled: verified.enabled ?? null,
      triggerIntervalMs: verified.triggerIntervalMs ?? null,
      detail: 'enabled_unconfirmed',
      nextAction: 'Inspect `pd service status --json`; run `pd service enable` again if the OS reports the trigger disabled.',
      warnings,
    };
  }
  input.info?.('Service Host scheduler enabled — automatic managed runs are armed.');
  return {
    state: 'enabled',
    registered: true,
    enabled: true,
    triggerIntervalMs: verified.triggerIntervalMs ?? null,
    nextAction: 'Service Host scheduler is enabled and verified. One bounded cycle runs every configured interval while the user is logged in; disable any time with `pd service disable`.',
    warnings,
  };
}
