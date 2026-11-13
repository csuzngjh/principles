/**
 * Experiment workspace isolation (P0-1, 2026-11-12 real-user E2E acceptance).
 *
 * WHY this exists: the experiment launcher isolated OpenClaw's directories and
 * the console ports, but PD has its OWN workspace pointer chain
 * (`PD_WORKSPACE_DIR` → `OPENCLAW_WORKSPACE` → `principles-disciple.json` →
 * `<home>/.openclaw/workspace`). That chain is resolved inside the gateway
 * process, where a user-level `PD_WORKSPACE_DIR` inherited from the operator's
 * shell outranks every value the launcher sets. During the 2026-11-12
 * acceptance this made the experiment gateway resolve
 * `D:\.openclaw\workspace` and write production `state.db` / `trajectory.db`.
 *
 * The launcher therefore does three things, all here so they can be exercised
 * without spawning the console:
 *   1. OVERRIDE every inherited PD/OpenClaw path pointer for the child process;
 *   2. VERIFY the workspace is a real, canonical directory inside the
 *      experiment root and outside production state (junction / symlink / `..`
 *      traversal / Windows case aliasing included);
 *   3. VERIFY the child environment it is about to hand out actually points at
 *      that same workspace (PD resolver and OpenClaw context agreement).
 *
 * Any disagreement is a refusal with a structured reason — there is no
 * "warn and continue" mode.
 *
 * This module reuses the install-layout resolver (`resolvePdHome`) and its
 * containment predicate (`isPathWithinRoot`) instead of inventing a second
 * interpretation of "production" / "inside the root".
 */
import fs from 'node:fs';
import path from 'node:path';
import { isPathWithinRoot, resolvePdHome } from '../../packages/install-layout/dist/index.js';

/** Environment variables that name the workspace (all pinned for the child). */
export const WORKSPACE_POINTER_ENV_VARS = Object.freeze([
  'PD_WORKSPACE_DIR',
  'OPENCLAW_WORKSPACE',
  'OPENCLAW_WORKSPACE_DIR',
]);

/** Every PD/OpenClaw path variable the child must not inherit from production. */
export const INHERITED_PATH_ENV_VARS = Object.freeze([
  ...WORKSPACE_POINTER_ENV_VARS,
  'PD_STATE_DIR',
  'OPENCLAW_HOME',
]);

function refusal(reason, message, nextAction) {
  return { ok: false, reason, message, nextAction };
}

function isWindows() {
  return process.platform === 'win32';
}

/**
 * Canonical form used for every comparison. `realpath` resolves junctions and
 * symlinks; the resolved path is the fallback for targets that do not exist yet.
 * On Windows paths are compared case-insensitively (NTFS semantics) — the
 * canonical form is lowercased so a `D:\ROOT` / `d:\root` mix cannot bypass a
 * containment check.
 */
export function canonicalForIsolation(candidate) {
  const resolved = path.resolve(candidate);
  let canonical;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  return isWindows() ? canonical.toLowerCase() : canonical;
}

export function realWorkspacePath(candidate) {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function samePath(a, b) {
  return canonicalForIsolation(a) === canonicalForIsolation(b);
}

/**
 * The production control-plane directories PD must never write into:
 * `~/.pd`, `~/.pd-console`, `~/.openclaw` (which also contains the default
 * `~/.openclaw/workspace`) and `~/.codex`. Derived with an empty env on
 * purpose — an inherited `OPENCLAW_STATE_DIR` describes where PRODUCTION state
 * is and must not be used to widen or shrink what counts as production.
 */
export function productionStateDirs() {
  const production = resolvePdHome({ env: {} });
  if (!production.ok) return [];
  return [
    ['~/.pd', production.pdHome],
    ['~/.pd-console', production.consoleConfigDir],
    ['~/.openclaw', production.openclawHome],
    ['~/.codex', production.codexHome],
  ].map(([label, dir]) => [label, canonicalForIsolation(dir)]);
}

/** Absolute workspace pointers inherited from the parent process. */
export function inheritedWorkspacePointers(env = process.env) {
  const pointers = [];
  for (const name of WORKSPACE_POINTER_ENV_VARS) {
    const value = env[name]?.trim();
    if (value && path.isAbsolute(value)) {
      pointers.push({ name, path: canonicalForIsolation(value) });
    }
  }
  return pointers;
}

/**
 * Resolve the workspace an experiment instance may use.
 *
 * `requestedWorkspace` defaults to `<root>/workspace`. The result is either
 * `{ok: true, workspace, overriddenPointers}` or a refusal with a readable
 * reason — there is no degraded mode: an ambiguous workspace means governance
 * state could be written into the production install.
 */
export function resolveExperimentWorkspace({ experimentRoot, requestedWorkspace, env = process.env }) {
  const rootReal = realWorkspacePath(experimentRoot);
  const root = canonicalForIsolation(rootReal);
  // Keep the caller's spelling for the value we hand out; all containment
  // decisions use the case-folded canonical form.
  const workspace = realWorkspacePath(requestedWorkspace ?? path.join(rootReal, 'workspace'));

  if (!isPathWithinRoot(root, canonicalForIsolation(workspace))) {
    return refusal(
      'experiment_workspace_outside_experiment_root',
      `Workspace resolves outside the experiment root: ${workspace} is not inside ${rootReal}.`,
      'Pass --workspace inside the experiment root, or start without --workspace to use <root>/workspace.',
    );
  }

  const inheritedPointers = inheritedWorkspacePointers(env);
  const productionDirs = [
    ...productionStateDirs().map(([label, dir]) => ({ label, dir, inherited: false })),
    ...inheritedPointers.map((pointer) => ({ label: pointer.name, dir: pointer.path, inherited: true })),
  ];
  for (const { label, dir, inherited } of productionDirs) {
    if (!isPathWithinRoot(dir, canonicalForIsolation(workspace))) continue;
    return refusal(
      'experiment_workspace_overlaps_production_state',
      `Workspace ${workspace} is inside the production path ${label} (${dir}).`,
      inherited
        ? `Unset the inherited ${label} (it points at the production install), and choose an experiment root outside production state.`
        : `Choose an experiment root outside ${label}, and unset any inherited PD_WORKSPACE_DIR / OPENCLAW_WORKSPACE that points at production.`,
    );
  }

  const workspaceCanonical = canonicalForIsolation(workspace);
  const overriddenPointers = inheritedPointers.filter((pointer) => pointer.path !== workspaceCanonical);
  return { ok: true, workspace, overriddenPointers };
}

/**
 * Second stage: the workspace must be a readable real directory, and re-running
 * `realpath` AFTER creation must still land inside the root. A pre-existing
 * junction at the workspace path is exactly the escape this catches.
 */
export function verifyExperimentWorkspaceDirectory({ experimentRoot, workspace }) {
  const root = canonicalForIsolation(experimentRoot);
  let stats;
  try {
    stats = fs.lstatSync(workspace);
  } catch {
    return refusal(
      'experiment_workspace_missing',
      `Workspace does not exist after creation: ${workspace}.`,
      'Check the experiment root permissions and retry.',
    );
  }
  if (!stats.isDirectory()) {
    return refusal(
      'experiment_workspace_not_directory',
      `Workspace is not a directory: ${workspace}.`,
      'Pass --workspace pointing at a directory inside the experiment root.',
    );
  }
  const real = realWorkspacePath(workspace);
  if (!isPathWithinRoot(root, canonicalForIsolation(real))) {
    return refusal(
      'experiment_workspace_escapes_root',
      `Workspace ${workspace} resolves to ${real}, outside the experiment root ${root} (junction or symlink).`,
      'Remove the link, or pass --workspace pointing at a real directory inside the experiment root.',
    );
  }
  return { ok: true, workspace: real };
}

/**
 * Fourth stage (P0-1b): OpenClaw's own profile may declare per-agent
 * workspaces (`agents.defaults.workspace`, `agents.<id>.workspace`). The
 * plugin services resolve THOSE, not the environment variables, so a profile
 * that still points at the production workspace would write production state
 * even when every environment pointer is pinned. Refuse before starting.
 */
export function verifyExperimentProfileWorkspaces({ experimentRoot, openclawHome }) {
  const root = canonicalForIsolation(experimentRoot);
  const profilePath = path.join(openclawHome, 'openclaw.json');
  if (!fs.existsSync(profilePath)) return { ok: true };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (error) {
    return refusal(
      'experiment_profile_unreadable',
      `OpenClaw profile cannot be parsed: ${profilePath} (${error instanceof Error ? error.message : String(error)}).`,
      'Fix or regenerate the experiment OpenClaw profile before starting; it decides where PD services write.',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refusal('experiment_profile_invalid', `OpenClaw profile is not an object: ${profilePath}.`, 'Regenerate the experiment OpenClaw profile.');
  }

  const declared = [];
  const agents = parsed.agents;
  if (agents !== null && typeof agents === 'object' && !Array.isArray(agents)) {
    const defaults = agents.defaults;
    if (defaults !== null && typeof defaults === 'object' && !Array.isArray(defaults) && typeof defaults.workspace === 'string') {
      declared.push({ label: 'agents.defaults.workspace', workspace: defaults.workspace });
    }
    for (const [agentId, agent] of Object.entries(agents)) {
      if (agentId === 'defaults') continue;
      if (agent !== null && typeof agent === 'object' && !Array.isArray(agent) && typeof agent.workspace === 'string') {
        declared.push({ label: `agents.${agentId}.workspace`, workspace: agent.workspace });
      }
    }
  }

  for (const { label, workspace } of declared) {
    if (!path.isAbsolute(workspace)) {
      return refusal(
        'experiment_profile_workspace_not_absolute',
        `OpenClaw profile ${label} is not an absolute path: ${workspace}.`,
        `Point ${label} at an absolute directory inside ${root}.`,
      );
    }
    if (!isPathWithinRoot(root, canonicalForIsolation(workspace))) {
      return refusal(
        'experiment_profile_workspace_outside_root',
        `OpenClaw profile ${label}=${workspace} resolves outside the experiment root ${root}.`,
        `Point ${label} at the experiment workspace before starting; PD services follow the profile, not the launcher environment.`,
      );
    }
  }

  return { ok: true, declared };
}

/**
 * Third stage: the environment handed to the child must agree with the
 * validated workspace. This is where "PD resolver result" and "OpenClaw context
 * workspace" are checked: every pointer variable must canonicalize to the same
 * directory, and the state/config/cache vars must stay inside the root.
 */
export function verifyExperimentChildEnvironment({ experimentRoot, workspace, childEnv }) {
  const root = canonicalForIsolation(experimentRoot);

  for (const name of WORKSPACE_POINTER_ENV_VARS) {
    const value = childEnv[name];
    if (typeof value !== 'string' || value.trim() === '') {
      return refusal(
        'experiment_child_env_missing_workspace_pointer',
        `Child environment is missing ${name}; PD would fall back to a production default.`,
        'This is a launcher bug: pin every workspace pointer to the experiment workspace.',
      );
    }
    if (!samePath(value, workspace)) {
      return refusal(
        'experiment_child_env_inconsistent',
        `Child environment ${name}=${value} does not resolve to the experiment workspace ${workspace}.`,
        'This is a launcher bug: all workspace pointers must resolve to one directory.',
      );
    }
  }

  for (const name of ['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'XDG_CACHE_HOME', 'PD_MCP_LOG_DIR', 'PD_EXPERIMENT_ROOT']) {
    const value = childEnv[name];
    if (typeof value !== 'string' || value.trim() === '') {
      return refusal(
        'experiment_child_env_missing_path',
        `Child environment is missing ${name}; the experiment would not be isolated.`,
        'This is a launcher bug: pin every experiment path variable.',
      );
    }
    if (!isPathWithinRoot(root, canonicalForIsolation(value))) {
      return refusal(
        'experiment_child_env_outside_root',
        `Child environment ${name}=${value} resolves outside the experiment root ${root}.`,
        'This is a launcher bug: every experiment path variable must stay inside the root.',
      );
    }
  }

  const declaredWorkspace = readDeclaredPdWorkspace(childEnv);
  if (declaredWorkspace !== null && !samePath(declaredWorkspace, workspace)) {
    return refusal(
      'experiment_pd_config_points_elsewhere',
      `PD config declares workspace ${declaredWorkspace}, which is not the experiment workspace ${workspace}.`,
      `Fix or remove ${path.join(childEnv.OPENCLAW_STATE_DIR, 'principles-disciple.json')} before starting the experiment.`,
    );
  }

  return { ok: true };
}

/**
 * The PD config file (`principles-disciple.json`) is the third link of PD's
 * workspace chain. In the experiment it lives next to the pinned OpenClaw
 * state, never in the production home. Absent file => nothing to disagree with.
 */
export function readDeclaredPdWorkspace(childEnv) {
  const candidates = [];
  if (typeof childEnv.OPENCLAW_STATE_DIR === 'string' && path.isAbsolute(childEnv.OPENCLAW_STATE_DIR)) {
    candidates.push(path.join(childEnv.OPENCLAW_STATE_DIR, 'principles-disciple.json'));
  }
  if (typeof childEnv.PD_WORKSPACE_DIR === 'string' && path.isAbsolute(childEnv.PD_WORKSPACE_DIR)) {
    candidates.push(path.join(childEnv.PD_WORKSPACE_DIR, '.openclaw', 'principles-disciple.json'));
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const declared = typeof parsed?.workspace === 'string' ? parsed.workspace.trim() : '';
      if (!declared) continue;
      return path.isAbsolute(declared) ? declared : path.resolve(path.dirname(candidate), declared);
    } catch {
      return null;
    }
  }
  return null;
}
