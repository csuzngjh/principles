/**
 * Worker-subprocess environment construction (TD §5.2, SPEC §10.4).
 *
 * The Service Host NEVER inherits-then-patches the parent environment for a
 * Worker child: the child env is BUILT from an explicit allowlist, with
 * identity-bearing variables pinned from the trusted `InstallIdentity` and
 * every workspace/host pointer explicitly dropped. A polluted parent
 * environment therefore cannot redirect the production Workspace, the PD
 * home, or the host roots (AC-11 / task §7 pollution matrix).
 *
 * Three variable classes:
 *
 *  1. NEVER PASSED (dropped even when set): `PD_EXPERIMENT_ROOT`,
 *     `PD_WORKSPACE_DIR`, `OPENCLAW_STATE_DIR` / `OPENCLAW_HOME`,
 *     `PD_COMPANION_WORKER_IPC` (Companion-private IPC), `PD_INVOCATION_SOURCE`
 *     (pinned to `service_host` below), and `HOME` / `USERPROFILE` /
 *     `CODEX_HOME` / `WORKBUDDY_CONFIG_DIR` (pinned from trusted identity).
 *  2. ALLOWLISTED passthrough: OS basics the Node runtime itself needs
 *     (`PATH`, `SYSTEMROOT`, …) and credential variables. Credentials ride
 *     the Worker's existing `getEnvVar` resolution chain — they are secrets
 *     for providers, never workspace pointers — so they match a name PATTERN
 *     (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, …), not a hand-maintained list of
 *     provider names. Values are passed through, never logged.
 *  3. PINNED from trusted identity: `HOME`/`USERPROFILE` (the OS account
 *     home the coordinator resolved), `CODEX_HOME` (codex worker) or
 *     `WORKBUDDY_CONFIG_DIR` (workbuddy worker) — the canonical trusted host
 *     roots — and `PD_INVOCATION_SOURCE=service_host` (the Phase 2 driver
 *     identity; without it `pd <host> worker --status` stall attribution
 *     would misreport service-driven cycles).
 */
import type { InstallIdentity } from './install-identity.js';
import type { WorkerHostKind } from './worker-adapter.js';

/** Every variable that can steer identity/workspace/host-root resolution. */
const POINTER_ENV_VARS = [
  'PD_EXPERIMENT_ROOT',
  'PD_WORKSPACE_DIR',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_HOME',
  'PD_COMPANION_WORKER_IPC',
  'PD_INVOCATION_SOURCE',
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'WORKBUDDY_CONFIG_DIR',
] as const;

/** OS basics allowed through verbatim (values are not secrets). */
const SYSTEM_ALLOWLIST_COMMON = ['PATH'] as const;
const SYSTEM_ALLOWLIST_WIN32 = [
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'TEMP',
  'TMP',
  'PROGRAMDATA',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
] as const;
const SYSTEM_ALLOWLIST_POSIX = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_COLLATE',
  'LC_MONETARY',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
] as const;

/** Proxy variables (outbound provider calls may require them). */
const PROXY_ALLOWLIST = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const;

/**
 * Credential-name pattern (case-insensitive on the UPPER-cased name):
 * `<prefix>_API_KEY`, `<prefix>_TOKEN`, `*_SECRET`, `*_PASSWORD`,
 * `*_PASSPHRASE`, `*_CREDENTIAL(S)`, `*_KEY(_…)`, e.g. OPENAI_API_KEY,
 * ANTHROPIC_API_KEY, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN.
 * Matched names pass through; matching is on the NAME only — no value is
 * inspected, recorded or logged.
 */
const CREDENTIAL_NAME_RE = /^(?:[A-Z0-9][A-Z0-9_]*_)?(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?)(?:_[A-Z0-9_]+)?$/;

export interface WorkerEnvironmentReport {
  /** Pointer/identity variables that WERE set in the inherited env and were dropped. */
  readonly stripped: readonly string[];
  /** Variables pinned from the trusted install identity (names only). */
  readonly pinnedFromTrustedIdentity: readonly string[];
  /** Allowlist names actually passed through (names only, never values). */
  readonly passedThrough: readonly string[];
  /** Always 'service_host' — the Phase 2 driver identity. */
  readonly invocationSource: 'service_host';
}

export interface WorkerEnvironment {
  readonly env: Record<string, string | undefined>;
  readonly report: WorkerEnvironmentReport;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Build the Worker child environment from the allowlist. Pure: same inputs →
 * same outputs; the only trusted inputs are `identity` (resolved by the
 * coordinator's own identity authority) and the explicit `hostKind`.
 */
export function buildWorkerEnvironment(args: {
  identity: InstallIdentity;
  hostKind: WorkerHostKind;
  inheritedEnv: Readonly<Record<string, string | undefined>>;
  platform?: string;
}): WorkerEnvironment {
  const platform = args.platform ?? process.platform;
  const caseInsensitive = platform === 'win32';
  const pointerSet = new Set<string>(POINTER_ENV_VARS.map((name) => (caseInsensitive ? name.toUpperCase() : name)));
  const systemNames = [
    ...SYSTEM_ALLOWLIST_COMMON,
    ...(platform === 'win32' ? SYSTEM_ALLOWLIST_WIN32 : SYSTEM_ALLOWLIST_POSIX),
    ...PROXY_ALLOWLIST,
  ];
  const allowSet = new Set<string>(systemNames.map((name) => (caseInsensitive ? name.toUpperCase() : name)));

  const isAllowed = (name: string): boolean => {
    const key = caseInsensitive ? name.toUpperCase() : name;
    if (pointerSet.has(key)) return false;
    if (allowSet.has(key)) return true;
    return CREDENTIAL_NAME_RE.test(key);
  };

  const env: Record<string, string | undefined> = {};
  const stripped: string[] = [];
  const passedThrough: string[] = [];
  for (const [rawName, value] of Object.entries(args.inheritedEnv)) {
    if (!isSet(value)) continue;
    const key = caseInsensitive ? rawName.toUpperCase() : rawName;
    if (pointerSet.has(key)) {
      stripped.push(key);
      continue;
    }
    if (isAllowed(rawName)) {
      env[rawName] = value;
      passedThrough.push(key);
    }
    // Everything else is silently dropped by design: the child gets exactly
    // what the allowlist admits, nothing inherited wholesale.
  }

  // Identity/host-root pins from the TRUSTED coordinator identity — never the
  // inherited values (a forged CODEX_HOME / HOME cannot survive this boundary).
  env.PD_INVOCATION_SOURCE = 'service_host';
  env.HOME = args.identity.homeDir;
  env.USERPROFILE = args.identity.homeDir;
  if (args.hostKind === 'codex') {
    env.CODEX_HOME = args.identity.hostRoots.codexHome;
  } else {
    env.WORKBUDDY_CONFIG_DIR = args.identity.hostRoots.workbuddyConfigDir;
  }

  const pinned = ['PD_INVOCATION_SOURCE', 'HOME', 'USERPROFILE', args.hostKind === 'codex' ? 'CODEX_HOME' : 'WORKBUDDY_CONFIG_DIR'];
  return {
    env,
    report: {
      stripped: [...new Set(stripped)].sort(),
      pinnedFromTrustedIdentity: pinned,
      passedThrough: [...new Set(passedThrough)].sort(),
      invocationSource: 'service_host',
    },
  };
}
