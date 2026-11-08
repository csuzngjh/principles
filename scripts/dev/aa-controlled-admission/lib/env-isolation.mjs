// PRI-1118 controlled-admission experiment — environment isolation.
//
// A host turn must never resolve its workspace, PD database, host state or
// config from an inherited production path. The child environment is built by
// REMOVING every host-overridable key first and then setting explicit values,
// so an ambient `PD_WORKSPACE_DIR=D:\.openclaw\workspace` (the incident that
// polluted the production store) cannot win.
//
// Every resolved path is checked against the arm's experiment root BEFORE any
// write or spawn. An escape is a hard refusal, not a warning.

import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Environment keys a parent process could use to redirect the host or the PD
 * plugin. All of them are stripped from the inherited environment; the caller
 * then sets the ones the arm actually needs.
 */
export const HOST_ENV_OVERRIDE_KEYS = Object.freeze([
  'PD_WORKSPACE_DIR',
  'OPENCLAW_WORKSPACE',
  // Documented host override (docs/help/environment.md). `plugins inspect` has
  // no `--cwd`, so without this the host would resolve its default agent
  // workspace from the production home and scan it for plugins.
  'OPENCLAW_WORKSPACE_DIR',
  'PD_STATE_DIR',
  'PD_AA_ADMISSION_FILE',
  'PD_AA_EXPERIMENT_ROOT',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_PROFILE',
  'OPENCLAW_HOME',
  'OPENCLAW_CONFIG',
  // PRI-1152 (verified at OpenClaw 4ffdd2047d1): plugin discovery, bundled
  // roots, dev source overlays, config includes and agent/credential stores
  // can each be redirected by the parent. Stripping more keys never weakens
  // isolation; callers that need a value set it explicitly.
  'OPENCLAW_BUNDLED_PLUGINS_DIR',
  'OPENCLAW_DISABLE_BUNDLED_PLUGINS',
  'OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS',
  'OPENCLAW_DEV_SOURCE_ROOT',
  'OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR',
  'OPENCLAW_PLUGIN_CATALOG_PATHS',
  'OPENCLAW_MPM_CATALOG_PATHS',
  'OPENCLAW_INCLUDE_ROOTS',
  'OPENCLAW_OAUTH_DIR',
  'OPENCLAW_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
  'OPENCLAW_PACKAGE_DIR',
  'OPENCLAW_RAW_STREAM_PATH',
  'OPENCLAW_GATEWAY_PORT',
  'OPENCLAW_GATEWAY_TOKEN',
  'OPENCLAW_GATEWAY_PASSWORD',
  'NODE_OPTIONS',
  'NODE_PATH',
]);

const STRIPPED = new Set(HOST_ENV_OVERRIDE_KEYS.map((key) => key.toUpperCase()));

export class EnvironmentEscapeError extends Error {
  constructor(violations, resolved = null) {
    super(`AA environment escape: ${violations.map((row) => `${row.id} -> ${row.path}`).join('; ')}`);
    this.name = 'EnvironmentEscapeError';
    this.code = 'aa_environment_escape';
    this.violations = violations;
    this.resolved = resolved;
  }
}

function canonical(path) {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function comparable(path) {
  const value = canonical(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** True when both paths name the same location after realpath (case-insensitive on Windows). */
export function isSamePath(a, b) {
  return comparable(a) === comparable(b);
}

/** True when `child` is strictly inside `root` (equal paths are not inside). */
export function isInsideRoot(root, child) {
  const rootPath = comparable(root);
  const childPath = comparable(child);
  const prefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return childPath.startsWith(prefix) && childPath.length > prefix.length;
}

/**
 * Build the environment for one isolated host phase (P0 inspect or an arm
 * turn) and prove every resolved path stays inside `experimentRoot`.
 */
export function buildIsolatedHostEnv({
  baseEnv = process.env,
  experimentRoot,
  workspaceDir,
  stateDir,
  configPath,
  profile,
  admissionPath = null,
} = {}) {
  if (typeof experimentRoot !== 'string' || !isAbsolute(experimentRoot)) {
    throw new Error('env-isolation: experimentRoot must be an absolute path');
  }
  for (const [label, value] of [['workspaceDir', workspaceDir], ['stateDir', stateDir], ['configPath', configPath]]) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`env-isolation: ${label} must be an absolute path`);
  }
  if (typeof profile !== 'string' || !profile.trim()) throw new Error('env-isolation: profile is required');

  const root = resolve(experimentRoot);
  const env = { ...baseEnv };
  const removed = [];
  for (const key of Object.keys(env)) {
    if (STRIPPED.has(key.toUpperCase())) {
      removed.push(key);
      delete env[key];
    }
  }

  const workspace = resolve(workspaceDir);
  const state = resolve(stateDir);
  const config = resolve(configPath);
  const admission = admissionPath === null ? null : resolve(admissionPath);

  env.PD_WORKSPACE_DIR = workspace;
  env.OPENCLAW_WORKSPACE_DIR = workspace;
  env.OPENCLAW_STATE_DIR = state;
  env.OPENCLAW_CONFIG_PATH = config;
  env.OPENCLAW_PROFILE = profile;
  if (admission !== null) {
    env.PD_AA_ADMISSION_FILE = admission;
    env.PD_AA_EXPERIMENT_ROOT = root;
  }

  const resolved = {
    experimentRoot: canonical(root),
    workspaceDir: canonical(workspace),
    pdStateDbPath: join(canonical(workspace), '.pd', 'state.db'),
    pdStateDir: join(canonical(workspace), '.state'),
    hostStateDir: canonical(state),
    hostConfigPath: canonical(config),
    admissionFile: admission === null ? null : canonical(admission),
    env: {
      PD_WORKSPACE_DIR: env.PD_WORKSPACE_DIR,
      OPENCLAW_WORKSPACE_DIR: env.OPENCLAW_WORKSPACE_DIR,
      OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
      OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_PROFILE: env.OPENCLAW_PROFILE,
      PD_AA_ADMISSION_FILE: env.PD_AA_ADMISSION_FILE ?? null,
      PD_AA_EXPERIMENT_ROOT: env.PD_AA_EXPERIMENT_ROOT ?? null,
    },
  };

  const targets = [
    ['workspaceDir', resolved.workspaceDir],
    ['pd-state-db', resolved.pdStateDbPath],
    ['pd-state-dir', resolved.pdStateDir],
    ['host-state-dir', resolved.hostStateDir],
    ['host-config', resolved.hostConfigPath],
  ];
  if (resolved.admissionFile !== null) targets.push(['admission-file', resolved.admissionFile]);

  const violations = targets
    .filter(([, path]) => !isInsideRoot(root, path))
    .map(([id, path]) => ({ id, path, root }));
  if (admission !== null && env.PD_AA_EXPERIMENT_ROOT !== root) {
    violations.push({ id: 'admission-root-env', path: String(env.PD_AA_EXPERIMENT_ROOT), root });
  }
  if (violations.length > 0) throw new EnvironmentEscapeError(violations, resolved);

  return { env, resolved, removedFromParent: removed };
}

/**
 * Freeze-time guard: the plan's writable paths must all sit inside the run
 * directory this launcher is about to use. Called before any write or spawn.
 */
export function assertPlanInsideExperimentRoot({ runDir, plan } = {}) {
  if (typeof runDir !== 'string' || !isAbsolute(runDir)) {
    throw new Error('env-isolation: runDir must be an absolute path');
  }
  const root = resolve(runDir);
  const candidates = [
    ['workspaceDir', plan?.workspaceDir],
    ['controlWorkspaceDir', plan?.controlWorkspaceDir],
    ['stateRoot', plan?.stateRoot],
    ['configPath', plan?.configPath],
    ['manifestPath', plan?.manifestPath],
    ['admissionPath', plan?.admissionPath],
    ['fixtureFile', plan?.fixtureFile],
    ['workspaceTarget.stateDbPath', plan?.workspaceTarget?.stateDbPath],
  ];
  const violations = [];
  for (const [id, path] of candidates) {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      violations.push({ id, path: String(path), root, reason: 'missing or not absolute' });
    } else if (!isInsideRoot(root, path)) {
      violations.push({ id, path: resolve(path), root, reason: 'outside the experiment root' });
    }
  }
  if (violations.length > 0) throw new EnvironmentEscapeError(violations, { experimentRoot: canonical(root) });
  return { experimentRoot: canonical(root), checked: candidates.map(([id, path]) => ({ id, path: canonical(path), inside: true })) };
}

/**
 * The ONLY parent keys an allowlisted child inherits: what a Node host needs
 * to start and to find system binaries. Provider credentials, NODE_OPTIONS,
 * PD_* / OPENCLAW_* overrides and every home-derived location are absent by
 * construction rather than by an ever-growing denylist.
 */
export const INHERITED_OS_ENV_KEYS = Object.freeze([
  'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'LANG', 'LC_ALL', 'TZ',
]);

const INHERITED = new Set(INHERITED_OS_ENV_KEYS.map((key) => key.toUpperCase()));

/** Key names that look like a credential must never reach the child. */
export const CREDENTIAL_KEY_PATTERN = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|PRIVATE_?KEY|ACCESS_?KEY)/i;

/**
 * Build a host environment from an allowlist (PRI-1152). Unlike
 * buildIsolatedHostEnv (which inherits everything except known overrides),
 * this keeps only INHERITED_OS_ENV_KEYS and then sets every location a host
 * or the PD plugin derives from the user profile — HOME/USERPROFILE (Node's
 * os.homedir on Windows), APPDATA, LOCALAPPDATA, TEMP/TMP, XDG_* and
 * OPENCLAW_HOME — to directories inside `experimentRoot`.
 *
 * The plugin writes `~/.openclaw/openclaw.json`, `~/.openclaw/cron/jobs.json`
 * and `~/.pd/**` through os.homedir(); OpenClaw resolves OPENCLAW_HOME, then
 * HOME, then USERPROFILE. Redirecting only OPENCLAW_* would leave those writes
 * on the production profile, so all of them are redirected together and every
 * derived path is proven inside the root before anything runs.
 */
export function buildAllowlistedHostEnv({
  baseEnv = process.env,
  experimentRoot,
  homeDir,
  tempDir,
  workspaceDir,
  stateDir,
  configPath,
  extra = {},
} = {}) {
  if (typeof experimentRoot !== 'string' || !isAbsolute(experimentRoot)) {
    throw new Error('env-isolation: experimentRoot must be an absolute path');
  }
  for (const [label, value] of [['homeDir', homeDir], ['tempDir', tempDir], ['workspaceDir', workspaceDir], ['stateDir', stateDir], ['configPath', configPath]]) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`env-isolation: ${label} must be an absolute path`);
  }
  const root = resolve(experimentRoot);
  const home = resolve(homeDir);
  const temp = resolve(tempDir);
  const workspace = resolve(workspaceDir);
  const state = resolve(stateDir);
  const config = resolve(configPath);

  const env = {};
  const inheritedFromParent = [];
  const removedFromParent = [];
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (INHERITED.has(key.toUpperCase()) && typeof value === 'string') {
      env[key] = value;
      inheritedFromParent.push(key);
    } else {
      removedFromParent.push(key);
    }
  }

  const explicitPaths = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_WORKSPACE_DIR: workspace,
    PD_WORKSPACE_DIR: workspace,
  };
  Object.assign(env, explicitPaths);
  if (process.platform === 'win32') {
    const parsedHome = home.match(/^([A-Za-z]:)(.*)$/);
    if (parsedHome) {
      env.HOMEDRIVE = parsedHome[1];
      env.HOMEPATH = parsedHome[2] || '\\';
    }
  }
  // Non-path switches: no anonymous telemetry export and no MCP launcher log
  // under the (redirected) profile even if a later code path reaches them.
  env.PD_TELEMETRY_DISABLED = '1';
  env.PD_MCP_LOG = '0';
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== 'string') throw new Error(`env-isolation: extra.${key} must be a string`);
    env[key] = value;
  }

  const resolved = {
    experimentRoot: canonical(root),
    homeDir: canonical(home),
    tempDir: canonical(temp),
    workspaceDir: canonical(workspace),
    pdStateDbPath: join(canonical(workspace), '.pd', 'state.db'),
    pdConfigPath: join(canonical(workspace), '.pd', 'config.yaml'),
    pdEventLogsDir: join(canonical(workspace), '.state', 'logs'),
    hostStateDir: canonical(state),
    hostConfigPath: canonical(config),
    hostGlobalExtensionsDir: join(canonical(state), 'extensions'),
    hostWorkspaceExtensionsDir: join(canonical(workspace), '.openclaw', 'extensions'),
    hostProjectSettingsPath: join(canonical(workspace), '.openclaw', 'settings.json'),
    hostTranscriptsDir: join(canonical(state), 'agents'),
    pluginProfileConfigPath: join(canonical(home), '.openclaw', 'openclaw.json'),
    pluginCronStorePath: join(canonical(home), '.openclaw', 'cron', 'jobs.json'),
    pdProfileDir: join(canonical(home), '.pd'),
    nodeCompileCacheDir: join(canonical(temp), 'node-compile-cache'),
    env: Object.fromEntries(Object.keys(explicitPaths).map((key) => [key, env[key]])),
  };

  const violations = [];
  for (const [key, value] of Object.entries(explicitPaths)) {
    if (!isInsideRoot(root, value)) violations.push({ id: `env:${key}`, path: value, root });
  }
  for (const id of ['pdStateDbPath', 'pdConfigPath', 'pdEventLogsDir', 'hostGlobalExtensionsDir', 'hostWorkspaceExtensionsDir',
    'hostProjectSettingsPath', 'hostTranscriptsDir', 'pluginProfileConfigPath', 'pluginCronStorePath', 'pdProfileDir', 'nodeCompileCacheDir']) {
    if (!isInsideRoot(root, resolved[id])) violations.push({ id, path: resolved[id], root });
  }
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) violations.push({ id: `credential-key:${key}`, path: '(value withheld)', root });
  }
  if (violations.length > 0) throw new EnvironmentEscapeError(violations, resolved);

  return { env, resolved, inheritedFromParent, removedFromParent };
}
