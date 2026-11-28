/**
 * Coordinator install identity (SPEC-PD-SERVICE-HOST-001 §8.2 step 1, TD §5.2).
 *
 * The run-once coordinator must act on ONE explicit production install
 * identity, and TD §5.2 names every env variable that must NOT be able to
 * relocate it: `PD_EXPERIMENT_ROOT`, `HOME`/`USERPROFILE`,
 * `OPENCLAW_STATE_DIR`/`OPENCLAW_HOME`, `WORKBUDDY_CONFIG_DIR`,
 * `CODEX_HOME`.
 *
 * Two different questions get two different authorities:
 *
 * - WHO this install is (pdHome identity): derived ONLY from the OS account
 *   record — `os.userInfo().homedir`, which reads getpwuid /
 *   GetUserProfileDirectoryW and cannot be overridden by inherited env vars.
 *   `PD_EXPERIMENT_ROOT` is stripped before resolution and `HOME` /
 *   `USERPROFILE` are ignored for identity entirely; each fact is RECORDED
 *   in the returned environment view (rc-9), never silently dropped. When no
 *   trusted home can be determined (no OS record, non-absolute result) the
 *   coordinator REFUSES — it never falls back to an env-derived guess.
 * - WHICH host roots the same install serves (discovery context): the host
 *   overrides ARE honored, exactly like every other PD component resolves
 *   them. They decide where workspace claims are collected; they can never
 *   move `pdHome` itself (P1-2 contract).
 *
 * The registration-pinned identity (TD §5.2 "由注册时解析出的绝对路径决定")
 * arrives with `pd service install` in Phase 3; until then the OS record is
 * the single identity authority. `trustedHomeDir` exists so callers with an
 * already-verified home (tests, the future registration handoff) can pin the
 * same authority without going through the OS lookup again.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePdHome } from '@principles/install-layout';

/** The one identity-switching experiment variable (pd-home.ts). */
const PD_EXPERIMENT_ROOT = 'PD_EXPERIMENT_ROOT';

/**
 * Env variables that may steer host discovery but must never steer the
 * coordinator's own identity. Recorded so the status output shows exactly
 * which inherited inputs were consulted vs. ignored (rc-9).
 */
const IDENTITY_IGNORED_ENV_VARS = ['HOME', 'USERPROFILE'] as const;
const HOST_ROOT_ENV_VARS = [
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_HOME',
  'CODEX_HOME',
  'WORKBUDDY_CONFIG_DIR',
] as const;

export interface CoordinatorEnvView {
  /** Present-and-set state of PD_EXPERIMENT_ROOT in the INHERITED env. */
  readonly inheritedExperimentRoot: boolean;
  /** True when the coordinator resolved identity with the variable stripped. */
  readonly experimentRootStripped: boolean;
  /** Bounded, sanitized echo of the inherited value for auditability. Never trusted. */
  readonly inheritedExperimentRootValue?: string;
  /**
   * Identity-authority variables present in the inherited env that were
   * IGNORED for identity resolution ('HOME' / 'USERPROFILE'). Presence is
   * recorded; values are never echoed or consulted.
   */
  readonly ignoredIdentityEnvVars: readonly string[];
  /**
   * Host-root overrides present in the inherited env. In the default (Phase 1
   * dry-run) mode these DID steer workspace discovery (P1-2) but cannot move
   * pdHome. In `canonicalHostRootsOnly` mode they did NOT steer anything —
   * see `ignoredHostRootEnvVars`.
   */
  readonly inheritedHostRootEnvVars: readonly string[];
  /**
   * Host-root overrides that were present in the inherited env but did NOT
   * steer host-root resolution (always empty in the default mode; the present
   * list in `canonicalHostRootsOnly` mode). Recorded so a polluted run is
   * observable, never silent (rc-9).
   */
  readonly ignoredHostRootEnvVars: readonly string[];
}

export interface InstallIdentity {
  /** `<home>/.pd` — the install root this coordinator owns. */
  readonly pdHome: string;
  /** The OS-account user home the install derives from. */
  readonly homeDir: string;
  /**
   * Which authority decided the home: the OS account record
   * (`os.userInfo()`) or an explicitly pinned trusted home (`injected`).
   * Never an env var.
   */
  readonly homeSource: 'os.userInfo()' | 'injected';
  /** `<pdHome>/install.json` — the canonical install manifest. */
  readonly manifestPath: string;
  /** `<pdHome>/active.json` — the active release record. */
  readonly activeRecordPath: string;
  /**
   * The host roots this install serves, resolved through the shared
   * production precedence (P1-2): custom overrides honored for discovery,
   * defaults derived from the SAME trusted home as pdHome.
   */
  readonly hostRoots: {
    readonly openclawHome: string;
    readonly codexHome: string;
    readonly workbuddyConfigDir: string;
  };
  readonly mode: 'production';
  readonly environment: CoordinatorEnvView;
}

export interface ResolveInstallIdentityOptions {
  /**
   * A caller-pinned trusted home (absolute path). Only callers that already
   * hold an OS-verified home may set this — the env is never a substitute.
   * When omitted the OS account record is consulted.
   */
  readonly trustedHomeDir?: string;
  /**
   * Resolve host roots from the trusted home ONLY (canonical
   * `<home>/.openclaw` / `<home>/.codex` / `<home>/.workbuddy` defaults),
   * ignoring inherited `OPENCLAW_STATE_DIR` / `OPENCLAW_HOME` /
   * `CODEX_HOME` / `WORKBUDDY_CONFIG_DIR` overrides (recorded as
   * `ignoredHostRootEnvVars`). The managed coordinator sets this: a real
   * cycle must never be discovered from — nor pinned to — an experiment or
   * custom root an inherited env happened to name (TD §5.2). The dry-run
   * keeps the shared production precedence (env honored for discovery)
   * because it starts nothing.
   */
  readonly canonicalHostRootsOnly?: boolean;
}

/** Strip the experiment-root switch, keeping every other variable intact. */
export function stripExperimentRoot(
  env: Readonly<Record<string, string | undefined>>,
): { env: Record<string, string | undefined>; view: CoordinatorEnvView } {
  const isSet = (name: string): boolean => {
    const value = env[name];
    return value !== undefined && value.trim().length > 0;
  };
  const ignoredIdentityEnvVars = IDENTITY_IGNORED_ENV_VARS.filter(isSet);
  const inheritedHostRootEnvVars = HOST_ROOT_ENV_VARS.filter(isSet);
  const base = {
    ignoredIdentityEnvVars,
    inheritedHostRootEnvVars,
    // Overridden by resolveCoordinatorInstallIdentity when host-root
    // resolution ignores the inherited overrides (canonicalHostRootsOnly).
    ignoredHostRootEnvVars: [] as readonly string[],
  };
  const raw = env[PD_EXPERIMENT_ROOT];
  if (raw === undefined) {
    return {
      env: { ...env },
      view: { inheritedExperimentRoot: false, experimentRootStripped: false, ...base },
    };
  }
  const next: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== PD_EXPERIMENT_ROOT) next[key] = value;
  }
  const bounded = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  return {
    env: next,
    view: {
      inheritedExperimentRoot: true,
      experimentRootStripped: true,
      ...(bounded.length > 0 ? { inheritedExperimentRootValue: bounded } : {}),
      ...base,
    },
  };
}

/**
 * The OS account record's home. `os.userInfo()` resolves via getpwuid /
 * GetUserProfileDirectoryW — it never consults `HOME` or `USERPROFILE`,
 * which is exactly why it is the only env-independent authority available
 * in-process.
 */
function resolveOsAccountHome(): { ok: true; homeDir: string } | { ok: false; detail: string } {
  try {
    const homeDir = os.userInfo().homedir;
    if (typeof homeDir !== 'string' || homeDir.length === 0) {
      return { ok: false, detail: 'os_user_home_unavailable' };
    }
    return { ok: true, homeDir };
  } catch {
    return { ok: false, detail: 'os_user_home_unavailable' };
  }
}

/**
 * Resolve the coordinator's install identity. The home comes ONLY from the
 * OS account record (or an explicitly pinned trusted home) — never from
 * `HOME`/`USERPROFILE` — and `PD_EXPERIMENT_ROOT` is stripped before
 * resolution. Every honored/ignored inherited input is recorded in the
 * environment view. Any inability to determine a trusted identity is a
 * structured refusal, never a downgrade to an env-derived or experimental
 * directory.
 */
export function resolveCoordinatorInstallIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: ResolveInstallIdentityOptions = {},
): { ok: true; identity: InstallIdentity } | { ok: false; reason: string; nextAction: string } {
  const { env: stripped, view } = stripExperimentRoot(env);
  const homeSource: InstallIdentity['homeSource'] =
    options.trustedHomeDir !== undefined ? 'injected' : 'os.userInfo()';
  let homeDir: string;
  if (options.trustedHomeDir !== undefined) {
    homeDir = options.trustedHomeDir;
  } else {
    const osHome = resolveOsAccountHome();
    if (!osHome.ok) {
      return {
        ok: false,
        reason: `install_identity_refused:${osHome.detail}`,
        nextAction:
          'Cannot determine the production install identity: the OS account record has no home directory. ' +
          'Run the coordinator as a real OS user with a valid home, or reinstall PD with `npx create-principles-disciple`.',
      };
    }
    ({ homeDir } = osHome);
  }
  if (!path.isAbsolute(homeDir)) {
    return {
      ok: false,
      reason: 'install_identity_refused:home_not_absolute',
      nextAction:
        'Cannot determine the production install identity: the trusted home is not an absolute path. ' +
        'Fix the OS account home directory, or reinstall PD with `npx create-principles-disciple`.',
    };
  }
  // canonicalHostRootsOnly: host-root resolution sees an EMPTY env — the
  // overrides resolve to the trusted-home defaults — while the inherited
  // presence is recorded as ignored (rc-9). HOME/USERPROFILE stay in
  // `stripped` (they are never consulted for host roots anyway).
  const ignoredHostRootEnvVars = options.canonicalHostRootsOnly === true
    ? view.inheritedHostRootEnvVars
    : [];
  const resolution = resolvePdHome({
    env: options.canonicalHostRootsOnly === true ? {} : stripped,
    homeDir,
  });
  if (!resolution.ok) {
    return {
      ok: false,
      reason: `install_identity_refused:${resolution.reason}`,
      nextAction: resolution.nextAction,
    };
  }
  return {
    ok: true,
    identity: {
      pdHome: resolution.pdHome,
      homeDir: resolution.homeDir,
      homeSource,
      manifestPath: path.join(resolution.pdHome, 'install.json'),
      activeRecordPath: path.join(resolution.pdHome, 'active.json'),
      hostRoots: {
        openclawHome: resolution.openclawHome,
        codexHome: resolution.codexHome,
        workbuddyConfigDir: resolution.workbuddyConfigDir,
      },
      mode: 'production',
      environment: { ...view, ignoredHostRootEnvVars },
    },
  };
}
