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
}

/** Env vars that must never steer the spawned CLI's install identity. */
const STRIPPED_ENV_KEYS = ['PD_EXPERIMENT_ROOT', 'PD_WORKSPACE_DIR'] as const;

const BRIDGE_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

function cleanedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
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

function spawnCli(entry: string, args: readonly string[], spawnFn: typeof spawn = spawn): Promise<SpawnOutcome> {
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
    }, BRIDGE_TIMEOUT_MS);
    const settle = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    try {
      child = spawnFn(process.execPath, [entry, ...args], {
        env: cleanedEnv(),
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
  const outcome = await spawnCli(entry, [...args, '--json', '--pd-home', pdHome], probes.spawnFn);
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
  // cli-1: exactly one JSON document on stdout. `service status` prints the
  // unified status DOCUMENT (schemaVersion pd.service-status.v1 — success is
  // the document itself, `registered` lives under `scheduler`); every other
  // operation prints the op envelope with `ok`.
  const jsonLine = outcome.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('{'));
  if (jsonLine === undefined) {
    return {
      ok: false,
      detail: `service_host_cli_no_json:exit_${outcome.code ?? 'null'}`,
      nextAction: `pd service ${op} produced no machine-readable output (exit ${outcome.code ?? 'n/a'}${outcome.stderr.trim() !== '' ? `; ${outcome.stderr.trim().slice(0, 160)}` : ''}); inspect it manually.`,
    };
  }
  let parsed: { ok?: boolean; reason?: string; schemaVersion?: string; scheduler?: { registered?: boolean | null } };
  try {
    parsed = JSON.parse(jsonLine) as { ok?: boolean; reason?: string; schemaVersion?: string; scheduler?: { registered?: boolean | null } };
  } catch {
    return {
      ok: false,
      detail: 'service_host_cli_unparsable_json',
      nextAction: `pd service ${op} emitted unparsable JSON; run it manually to see the full output.`,
    };
  }
  if (op === 'status') {
    const registered = parsed.scheduler?.registered ?? null;
    if (outcome.code === 0 && parsed.schemaVersion === 'pd.service-status.v1') {
      return { ok: true, detail: 'ok', registered };
    }
    return {
      ok: false,
      detail: `service_host_status_failed:${parsed.reason ?? `exit_${outcome.code ?? 'null'}`}`,
      nextAction: 'pd service status did not succeed; the scheduler registration state is unknown — nothing was changed. Inspect it manually.',
      registered,
    };
  }
  if (outcome.code === 0 && parsed.ok === true) {
    return { ok: true, detail: 'ok' };
  }
  return {
    ok: false,
    detail: `service_host_cli_refused:${parsed.reason ?? `exit_${outcome.code ?? 'null'}`}`,
    nextAction: `pd service ${op} did not succeed (${parsed.reason ?? `exit ${outcome.code ?? 'n/a'}`}); nothing was silently skipped — retry it manually after fixing the cause.`,
  };
}

export interface SchedulerReconcileInput {
  readonly pdHome: string;
  /** Explicit operator consent (--register-service-host / --enable-service-host). */
  readonly registerServiceHost: boolean;
  /** --enable-service-host (implies registerServiceHost). */
  readonly enableServiceHost: boolean;
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
  /** Test injection for the spawn boundary. */
  readonly probes?: ServiceHostBridgeProbes;
}

/**
 * Post-install scheduler reconciliation (task §6). Runs AFTER the install
 * transaction committed, so every failure is a WARNING — a bridge failure
 * must never turn a committed install into a reported failure (ERR-197).
 *
 *  - consent given: register (default disabled), then optionally enable;
 *  - no consent: REFRESH-IF-REGISTERED only — an existing registration is
 *    re-installed idempotently (entry refresh, enabled state PRESERVED), and
 *    a machine with no registration gets NOTHING silently created.
 */
export async function reconcileServiceHostScheduler(input: SchedulerReconcileInput): Promise<void> {
  if (input.registerServiceHost) {
    const install = await runServiceHostCli(input.pdHome, ['service', 'install'], input.probes ?? {});
    if (!install.ok) {
      input.warn(`Service Host scheduler registration failed (${install.detail}). ${install.nextAction ?? ''}`.trim());
      return;
    }
    input.info?.('Service Host scheduler registered (disabled by default — enable with `pd service enable`).');
    if (input.enableServiceHost) {
      const enable = await runServiceHostCli(input.pdHome, ['service', 'enable'], input.probes ?? {});
      if (!enable.ok) {
        input.warn(`Service Host scheduler ENABLE failed (${enable.detail}) — the registration exists but stays DISABLED. ${enable.nextAction ?? ''}`.trim());
        return;
      }
      input.info?.('Service Host scheduler enabled — automatic managed runs are armed.');
    }
    return;
  }
  // Upgrade path: refresh only when a registration already exists.
  const status = await runServiceHostCli(input.pdHome, ['service', 'status'], input.probes ?? {});
  if (!status.ok) {
    input.warn(`Service Host scheduler state could not be verified after install (${status.detail}) — nothing was changed. ${status.nextAction ?? ''}`.trim());
    return;
  }
  if (status.registered === true) {
    const refresh = await runServiceHostCli(input.pdHome, ['service', 'install'], input.probes ?? {});
    if (!refresh.ok) {
      input.warn(`Service Host scheduler refresh failed (${refresh.detail}) — the last valid registration was KEPT. ${refresh.nextAction ?? ''}`.trim());
      return;
    }
    input.info?.('Service Host scheduler registration refreshed to the active release (enabled state preserved).');
  }
}
