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
