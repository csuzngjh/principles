/**
 * OS Scheduler Adapter Contract — SPEC-PD-SERVICE-HOST-001 §11 Phase 3
 * (PRI-1281).
 *
 * The Service Host's OS-level trigger is an INSTALL-LEVEL object: exactly one
 * user-level scheduler registration per PD installation (NOT per workspace),
 * bound to the trusted install identity resolved by the coordinator. The
 * registration invokes the managed execution entry:
 *
 *   <nodePath> <cliEntry> service run-once --json --trigger scheduler
 *              --pd-home <canonical pdHome>
 *
 * Platform implementations (Windows Task Scheduler / macOS LaunchAgent /
 * Linux systemd --user) all expose the SAME five operations through this
 * contract — the CLI never keeps three parallel lifecycle logic sets.
 *
 * Security invariants (SPEC §10, task §8):
 *  - runs as the current OS user only; no elevation, no system-level service;
 *  - no credential ever lands in the registration (arguments carry paths and
 *    flags only);
 *  - absolute install entry, no PATH / cwd dependence;
 *  - a registration whose definition does not reference THIS install's cli
 *    entry is FOREIGN — never overwritten or deleted (fail-closed);
 *  - the scheduler registration identity is derived from the canonical pdHome
 *    so two PD installations of the same user can never collide.
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';

/** Platforms with a real Phase 3 scheduler adapter. */
export type SchedulerPlatform = 'win32' | 'darwin' | 'linux';

/**
 * Default trigger interval — aligned with the existing Codex / WorkBuddy CLI
 * worker default cadence (120,000 ms). This is a DEFAULT, not a performance
 * SLA; every trigger runs one bounded run-once (task §3.5).
 */
export const DEFAULT_SCHEDULER_INTERVAL_MS = 120_000;
/**
 * Floor against meaningless high-frequency triggering (task §3.5). 60s: the
 * Windows Task Scheduler repetition interval rejects anything below one
 * minute (HRESULT 0x80041318, verified on a real host) — the contract keeps
 * ONE cross-platform floor at the strictest platform minimum.
 */
export const MIN_SCHEDULER_INTERVAL_MS = 60_000;
export const MAX_SCHEDULER_INTERVAL_MS = 30 * 24 * 60 * 60_000;

export type IntervalValidation =
  | { readonly ok: true; readonly intervalMs: number }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

export function validateSchedulerIntervalMs(raw: number | undefined): IntervalValidation {
  if (raw === undefined) return { ok: true, intervalMs: DEFAULT_SCHEDULER_INTERVAL_MS };
  if (!Number.isSafeInteger(raw) || raw < MIN_SCHEDULER_INTERVAL_MS || raw > MAX_SCHEDULER_INTERVAL_MS) {
    return {
      ok: false,
      reason: `scheduler_interval_out_of_range:${String(raw).slice(0, 40)}`,
      nextAction: `--interval-ms must be an integer between ${MIN_SCHEDULER_INTERVAL_MS} (60s — the Windows Task Scheduler repetition floor) and ${MAX_SCHEDULER_INTERVAL_MS} (30 days). The default is ${DEFAULT_SCHEDULER_INTERVAL_MS} (120s, matching the existing CLI worker cadence).`,
    };
  }
  return { ok: true, intervalMs: raw };
}

/** The full install-bound registration definition an adapter registers. */
export interface SchedulerRegistration {
  /** Canonical, trusted PD home this registration belongs to (`<home>/.pd`). */
  readonly pdHome: string;
  /**
   * The trusted HOME root (`dirname(pdHome)`): the value the registered
   * command passes as `--pd-home` — the CLI treats that flag as the trusted
   * home DIRECTORY and derives `<home>/.pd` itself, so passing pdHome here
   * would resolve to `<home>/.pd/.pd`.
   */
  readonly homeDir: string;
  /** Absolute installed CLI entry (active release), resolved by the coordinator. */
  readonly cliEntry: string;
  /** Absolute node executable that runs the entry. */
  readonly nodePath: string;
  readonly intervalMs: number;
  /** Derived platform names — see {@link schedulerIdentityFor}. */
  readonly identity: SchedulerIdentity;
}

/** Platform-specific names derived 1:1 from the canonical pdHome. */
export interface SchedulerIdentity {
  /** 10-hex stable key of the canonical pdHome (sha256 prefix). */
  readonly installKey: string;
  /** Windows Task Scheduler task name (root folder). */
  readonly windowsTaskName: string;
  /** macOS LaunchAgent label and plist base name. */
  readonly macosLabel: string;
  /** Linux systemd --user unit base name (without .service/.timer). */
  readonly linuxUnitBase: string;
}

/**
 * Derive the install-unique scheduler identity from a canonical pdHome.
 * Windows path comparisons fold case so `D:\PD` and `d:\pd` cannot produce
 * two registrations for one install (or collide two installs).
 */
export function schedulerIdentityFor(pdHome: string): SchedulerIdentity {
  const normalized = process.platform === 'win32' ? path.resolve(pdHome).toLowerCase() : path.resolve(pdHome);
  const installKey = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 10);
  return {
    installKey,
    windowsTaskName: `PrinciplesDisciple-ServiceHost-${installKey}`,
    macosLabel: `com.principles-disciple.service-host.${installKey}`,
    linuxUnitBase: `pd-service-host-${installKey}`,
  };
}

/**
 * The exact managed-run invocation arguments registered with the OS. Kept in
 * ONE place so every platform registers the identical command line. NOTE:
 * `--pd-home` carries the trusted HOME root (registration.homeDir), matching
 * the CLI flag's semantics (the CLI derives `<home>/.pd` itself).
 */
export function schedulerInvocationArgs(registration: SchedulerRegistration): readonly string[] {
  return [
    registration.cliEntry,
    'service',
    'run-once',
    '--json',
    '--trigger', 'scheduler',
    '--pd-home', registration.homeDir,
  ];
}

/** What the OS truthfully reports about the registration. */
export interface SchedulerFacts {
  readonly platform: SchedulerPlatform;
  readonly taskName: string;
  /** A registration exists in the OS (any enabled state). null = unreadable. */
  readonly registered: boolean | null;
  /** Future automatic triggers will fire. null = unreadable. */
  readonly enabled: boolean | null;
  /** Configured trigger interval in ms, read from the OS artifact when parseable. */
  readonly triggerIntervalMs?: number | null;
  /** OS-level last trigger time (ISO) when the platform reports one. */
  readonly lastRunAt: string | null;
  /** OS-level last run result (platform vocabulary, raw). */
  readonly lastResult: string | null;
}

/** Structured operation result — success/failed/unavailable with reason + nextAction (rc-9). */
export type SchedulerOperationResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly facts: SchedulerFacts;
    }
  | {
      readonly ok: false;
      readonly kind: 'unavailable' | 'external_conflict' | 'command_failed' | 'unsafe_state';
      readonly reason: string;
      readonly nextAction: string;
      /** Best-effort facts at failure time (never fabricated). */
      readonly facts?: SchedulerFacts;
    };

/** Injectable command boundary (tests fake it; production spawns real tools). */
export interface SchedulerCommandRunner {
  /**
   * Run one platform command. Never resolves with a thrown error — spawn
   * failures surface as `{ code: null, spawnError }`. `extraEnv` merges into
   * the child environment (used to pass file paths to PowerShell scripts
   * without shell interpolation).
   */
  run(
    command: string,
    args: readonly string[],
    extraEnv?: Readonly<Record<string, string>>,
  ): Promise<SchedulerCommandResult>;
}

export interface SchedulerCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: string;
  readonly timedOut?: boolean;
  readonly durationMs?: number;
}

/** Injectable file boundary for plist/unit read/write (tests fake it). */
export interface SchedulerFileIo {
  readIfExists(file: string): { ok: true; content: string } | { ok: false; reason: 'missing' | 'unreadable'; detail?: string };
  writeAtomic(file: string, content: string): { ok: true } | { ok: false; reason: string };
  remove(file: string): { ok: true } | { ok: false; reason: string };
  exists(file: string): boolean;
  mkdirs(dir: string): { ok: true } | { ok: false; reason: string };
}

/** The five lifecycle operations every platform adapter must provide. */
export interface SchedulerAdapter {
  readonly platform: SchedulerPlatform;
  /** Create the user-level registration (default disabled). Idempotent for our own registration. */
  install(registration: SchedulerRegistration): Promise<SchedulerOperationResult>;
  /** Enable future automatic triggers. Idempotent. */
  enable(registration: SchedulerRegistration): Promise<SchedulerOperationResult>;
  /** Stop future automatic triggers; keep the registration. Idempotent. */
  disable(registration: SchedulerRegistration): Promise<SchedulerOperationResult>;
  /** Read the OS-reported registration state. Read-only. */
  status(registration: SchedulerRegistration): Promise<SchedulerOperationResult>;
  /** Remove our registration. Never touches foreign registrations. Idempotent. */
  uninstall(registration: SchedulerRegistration): Promise<SchedulerOperationResult>;
}
