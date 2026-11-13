/**
 * Experiment-instance workspace isolation guard (P0-1, 2026-11-12 real-user
 * E2E acceptance).
 *
 * `PD_EXPERIMENT_ROOT` marks this process as an isolated experiment instance.
 * The host may still inherit a production pointer from the operator's shell
 * (`PD_WORKSPACE_DIR`, `OPENCLAW_WORKSPACE`, a `principles-disciple.json`
 * workspace). Because PD explicit sources outrank `ctx.workspaceDir`, that
 * pointer once redirected the experiment gateway to `D:\.openclaw\workspace`
 * and wrote production `state.db` / `trajectory.db`.
 *
 * A divergence warning is NOT enough: once the workspace is wrong, every writer
 * downstream (state DB, trajectory DB, internalization consumer) follows it.
 * In experiment mode a workspace outside the root is therefore a hard failure.
 * Production mode (no `PD_EXPERIMENT_ROOT`) is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';

export type ExperimentIsolationViolation = {
  reason: string;
  message: string;
  nextAction: string;
};

function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Canonical form for containment decisions: `realpath` resolves junctions and
 * symlinks (a link inside the root that points at production is an escape, not
 * a child), with the resolved path as fallback for targets that do not exist.
 * Windows paths are case-folded because NTFS is case-insensitive.
 */
export function canonicalForIsolation(candidate: string): string {
  const resolved = path.resolve(candidate);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  return isWindows() ? canonical.toLowerCase() : canonical;
}

export function experimentRootFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PD_EXPERIMENT_ROOT;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

/**
 * The PD workspace this experiment process DECLARED it belongs to.
 *
 * Containment alone is not identity: a profile that resolves to a DIFFERENT
 * workspace inside the same experiment root would silently fork the experiment
 * (two state DBs, two owner identities, evidence split across both). P0-1
 * round 3 therefore compares the resolved workspace with this declaration
 * whenever the operator made one.
 */
export function declaredExperimentWorkspace(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PD_WORKSPACE_DIR;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

export function experimentIsolationNextAction(): string {
  return (
    'Set PD_WORKSPACE_DIR to a directory inside PD_EXPERIMENT_ROOT (the experiment launcher does this), ' +
    'or unset PD_EXPERIMENT_ROOT to run the production instance.'
  );
}

/**
 * Returns `null` when the workspace is acceptable, else a structured violation.
 */
export function describeExperimentWorkspaceViolation(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ExperimentIsolationViolation | null {
  const root = experimentRootFromEnv(env);
  if (root === null) return null;

  if (!path.isAbsolute(root)) {
    return {
      reason: 'experiment_root_not_absolute',
      message: `PD_EXPERIMENT_ROOT must be an absolute path (got "${root}"), so workspace containment cannot be verified.`,
      nextAction: 'Set PD_EXPERIMENT_ROOT to the absolute experiment root, or unset it for a production run.',
    };
  }

  const relative = path.relative(canonicalForIsolation(root), canonicalForIsolation(workspaceDir));
  const inside =
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  if (!inside) {
    return {
      reason: 'workspace_outside_experiment_root',
      message:
        `Resolved workspace ${workspaceDir} is outside the experiment root ${root}. ` +
        'An inherited PD_WORKSPACE_DIR / OPENCLAW_WORKSPACE / principles-disciple.json workspace probably points at the production install.',
      nextAction: experimentIsolationNextAction(),
    };
  }

  // A dangling pointer in experiment mode is the same class of bug as a wrong
  // one: opening SQLite against it creates a state tree nobody declared.
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(workspaceDir).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return {
      reason: 'workspace_missing',
      message: `Resolved workspace ${workspaceDir} is inside the experiment root ${root} but is not an existing directory.`,
      nextAction: experimentIsolationNextAction(),
    };
  }

  // Inside the root is necessary, not sufficient: the workspace must be the one
  // this process declared. Without this, a mis-selected agent profile silently
  // forks the experiment instead of failing closed.
  const declared = declaredExperimentWorkspace(env);
  if (declared !== null) {
    if (!path.isAbsolute(declared)) {
      return {
        reason: 'declared_workspace_not_absolute',
        message: `PD_WORKSPACE_DIR must be absolute in experiment mode (got "${declared}"), so workspace identity cannot be verified.`,
        nextAction: 'Set PD_WORKSPACE_DIR to the absolute experiment workspace path.',
      };
    }
    if (canonicalForIsolation(declared) !== canonicalForIsolation(workspaceDir)) {
      return {
        reason: 'workspace_not_declared_experiment_workspace',
        message:
          `Resolved workspace ${workspaceDir} is inside the experiment root ${root} but is NOT the declared PD workspace ${declared}. ` +
          'A mis-selected agent profile or an inherited workspace pointer would split this experiment into two state trees.',
        nextAction:
          'Pin the agent/profile workspace to PD_WORKSPACE_DIR, or point PD_WORKSPACE_DIR at the workspace this experiment really uses.',
      };
    }
  }
  return null;
}

/**
 * Guard for non-workspace path inputs (`PD_STATE_DIR`, config paths). In
 * experiment mode they must stay inside the root; production is unchanged.
 */
export function assertExperimentPathInsideRoot(
  candidate: string,
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const root = experimentRootFromEnv(env);
  if (root === null) return;
  if (!path.isAbsolute(root)) {
    throw new Error(`[PD:${source}] PD_EXPERIMENT_ROOT must be an absolute path (got "${root}").`);
  }
  const relative = path.relative(canonicalForIsolation(root), canonicalForIsolation(candidate));
  const inside =
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  if (!inside) {
    throw new Error(
      `[PD:${source}] Experiment isolation refused path ${candidate}: it is outside the experiment root ${root}. ${experimentIsolationNextAction()}`,
    );
  }
}

/** Throwing form for paths whose contract is "throw or return a value". */
export function assertExperimentWorkspaceIsolation(workspaceDir: string, source: string): void {
  if (experimentRootFromEnv() === null) return;

  const violation = describeExperimentWorkspaceViolation(workspaceDir);
  if (violation) {
    throw new Error(
      `[PD:${source}] Experiment isolation refused workspace ${workspaceDir}: ${violation.message} ${violation.nextAction}`,
    );
  }

  // A dangling pointer in experiment mode is the same class of bug as a wrong
  // one: the state/trajectory DB would be created somewhere unexpected.
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(workspaceDir).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new Error(
      `[PD:${source}] Experiment isolation refused workspace ${workspaceDir}: it is not an existing directory. ${experimentIsolationNextAction()}`,
    );
  }
}
