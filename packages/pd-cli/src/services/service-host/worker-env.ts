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

/**
 * Runtime-launch steering variables (R1 review fix): these are read by the
 * Node runtime / its loaders BEFORE the Worker entry executes, so a name in
 * this set can never be re-admitted — not by the system allowlist, not by
 * the generic credential pattern, and NOT by a workspace-config-declared
 * `apiKeyEnv`. An admitted-workspace config can name its own credential
 * variables; it cannot use that channel to inject launch settings the
 * isolation boundary exists to keep out (`NODE_OPTIONS --require`, TLS
 * trust weakening, OpenSSL engine configs, native-library preload).
 * Exported so the config-name collector (worker-adapter.ts) refuses the
 * same names at collection time — one deny-list, two checkpoints.
 */
export const LAUNCH_CONTROL_ENV_VARS = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_REPL_HISTORY',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_NO_WARNINGS',
  'NODE_PENDING_DEPRECATION',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'NODE_DISABLE_COLORS',
  'NODE_REDIRECT_WARNINGS',
  'NODE_PRESERVE_SYMLINKS',
  'NODE_PRESERVE_SYMLINKS_MAIN',
  'NODE_COMPILE_CACHE',
  'NODE_COMPILE_CACHE_DIR',
  'NODE_USE_ENV_PROXY',
  'NODE_USE_LARGE_PAGES',
  'NODE_SNAPSHOT_SAVE',
  'NODE_SNAPSHOT_BLOB',
  'NODE_V8_COVERAGE',
  'UV_THREADPOOL_SIZE',
  'UV_USE_IO_URING',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
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
  /** The coordinator-scoped invocation id passed as PD_INVOCATION_ID (F13). */
  readonly invocationId?: string;
}

export interface WorkerEnvironment {
  readonly env: Record<string, string | undefined>;
  readonly report: WorkerEnvironmentReport;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/**
 * A credential variable name from the workspace's OWN effective runtime
 * config (`apiKeyEnv`, F4 review fix). Names are validated defensively:
 * env-var-shaped, bounded — and never mistaken for a pointer variable.
 */
function isCredentialName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name);
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
  /**
   * Credential variable NAMES the target workspace's effective runtime
   * config actually uses (`apiKeyEnv` values, F4 review fix). A name that
   * does not match the generic credential PATTERN still passes through so
   * custom-named env credentials keep working (the worker's
   * `resolveProviderApiKey` chain reads them by that exact name). Pointer
   * variables are rejected FIRST — the allowlist can never re-admit one.
   */
  credentialEnvAllowlist?: readonly string[];
  /** Coordinator-scoped invocation id, passed to the child (F13, TD §5.2). */
  invocationId?: string;
}): WorkerEnvironment {
  const platform = args.platform ?? process.platform;
  const caseInsensitive = platform === 'win32';
  const pointerSet = new Set<string>(POINTER_ENV_VARS.map((name) => (caseInsensitive ? name.toUpperCase() : name)));
  const launchControlSet = new Set<string>(LAUNCH_CONTROL_ENV_VARS.map((name) => (caseInsensitive ? name.toUpperCase() : name)));
  const systemNames = [
    ...SYSTEM_ALLOWLIST_COMMON,
    ...(platform === 'win32' ? SYSTEM_ALLOWLIST_WIN32 : SYSTEM_ALLOWLIST_POSIX),
    ...PROXY_ALLOWLIST,
  ];
  const allowSet = new Set<string>(systemNames.map((name) => (caseInsensitive ? name.toUpperCase() : name)));

  const configCredentialSet = new Set<string>(
    (args.credentialEnvAllowlist ?? []).filter((name) => {
      const key = caseInsensitive ? name.toUpperCase() : name;
      return isCredentialName(name) && !pointerSet.has(key) && !launchControlSet.has(key);
    }).map((name) => (caseInsensitive ? name.toUpperCase() : name)),
  );

  const isAllowed = (name: string): boolean => {
    const key = caseInsensitive ? name.toUpperCase() : name;
    if (pointerSet.has(key)) return false;
    // Launch-control denial outranks every admission channel — a declared
    // `apiKeyEnv` name can never steer the runtime launch (R1 review fix).
    if (launchControlSet.has(key)) return false;
    if (allowSet.has(key)) return true;
    if (configCredentialSet.has(key)) return true;
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
  // F13: the invocation id is coordinator-scoped run metadata, not identity —
  // pinned explicitly so the worker's liveness record can be correlated back
  // to THIS invocation (TD §5.2 显式传入 invocationId).
  let report: WorkerEnvironmentReport = {
    stripped: [...new Set(stripped)].sort(),
    pinnedFromTrustedIdentity: pinned,
    passedThrough: [...new Set(passedThrough)].sort(),
    invocationSource: 'service_host',
  };
  if (args.invocationId !== undefined && args.invocationId.length > 0) {
    env.PD_INVOCATION_ID = args.invocationId;
    report = { ...report, invocationId: args.invocationId };
  }
  return { env, report };
}
