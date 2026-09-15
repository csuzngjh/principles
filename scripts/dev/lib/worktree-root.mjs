// Centralized worktree-root resolution (PRI-796, AGENTS.md §23A git-10).
//
// Before this module every task worktree landed as a SIBLING of the primary
// checkout (`<parent>/<repo>-<task>-<slug>`), which scattered the Windows
// multi-AI workstation into `D:\Code\principles-*` with no grouping, no
// uniform naming, and no way to tell a task slot from an arbitrary directory.
//
// The policy now: all task worktrees live in ONE pool, derived from the
// primary checkout — never from a hardcoded drive:
//
//   primary            D:\Code\principles
//   parent(primary)    D:\Code
//   pool root          D:\Code\_worktrees\principles
//   task worktree      D:\Code\_worktrees\principles\PRI-790-signal-confirmations
//
// `PD_WORKTREE_ROOT` overrides the pool root for advanced setups. It is
// CONFIGURATION, not state — nothing here is persisted, and git remains the
// only ownership registry (P4 One Source of Truth).
//
// Directory names deliberately do NOT repeat the repo name (`principles-`) or
// the branch namespace (`ai-`): the pool path already encodes the repository,
// and `git-11` keeps directory == task identity so `Task -> Branch -> Worktree`
// stays a single stable mapping across AI IDEs (SPEC D4).

import path from 'node:path';
import crypto from 'node:crypto';

export const WORKTREE_ROOT_ENV = 'PD_WORKTREE_ROOT';
export const POOL_DIRNAME = '_worktrees';
export const TASK_BRANCH_PREFIX = 'ai/';
export const ADHOC_TASK = 'adhoc';

// Same constraints the create CLI already enforced; kept here so the resolver
// and the CLI cannot drift apart.
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Resolve the pool root for a given primary checkout.
 *
 * Precedence: explicit `env[PD_WORKTREE_ROOT]` > derived `<parent>/_worktrees/<repo>`.
 * The override is resolved to an absolute path so callers never depend on cwd.
 *
 * @param {{primaryPath: string, env?: Record<string, string|undefined>}} opts
 * @returns {{root: string, source: 'env'|'derived', primaryPath: string}}
 */
export function resolveWorktreeRoot({ primaryPath, env = process.env } = {}) {
  if (!primaryPath) throw new Error('resolveWorktreeRoot requires primaryPath');
  const primary = path.resolve(primaryPath);
  const override = env[WORKTREE_ROOT_ENV];
  if (typeof override === 'string' && override.trim().length > 0) {
    return { root: path.resolve(override.trim()), source: 'env', primaryPath: primary };
  }
  return {
    root: path.join(path.dirname(primary), POOL_DIRNAME, path.basename(primary)),
    source: 'derived',
    primaryPath: primary,
  };
}

/** UTC `YYYYMMDD` — the adhoc date stamp. Injectable for tests. */
export function utcDateStamp(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 6 lowercase hex characters. SPEC §5.2 requires a random suffix so two agents
 * creating adhoc tasks on the same day cannot collide on the directory name.
 * Never derived from an IDE session id (that would make the identity depend on
 * which AI happened to be running — SPEC D4).
 */
export function shortRandom(bytes = 3) {
  return crypto.randomBytes(bytes).toString('hex').slice(0, 6);
}

/**
 * Compute the stable task identity shared by the branch and the directory, so
 * `Task -> Branch -> Worktree` cannot drift (SPEC D4).
 *
 *   normal   task=PRI-790 slug=signal-confirmations  -> PRI-790-signal-confirmations
 *   adhoc    slug=ref-investigation                  -> adhoc-20260914-ref-investigation-a31f8c
 *
 * The random suffix comes AFTER the slug so the human-readable part stays
 * readable and stable across the day; it exists only to stop two agents creating
 * the same adhoc task on the same date from colliding.
 *
 * @returns {{identity: string, branch: string, dirName: string, taskPart: string}}
 */
export function resolveTaskIdentity({ task, slug, now = Date.now(), random } = {}) {
  // Wording is preserved from the pre-PRI-796 CLI so operator-facing messages do
  // not change silently when they moved into this module.
  if (!TASK_ID_RE.test(String(task || ''))) {
    throw new Error("Invalid task id '" + task + "' (allowed: letters, digits, '.', '_', '-').");
  }
  if (!SLUG_RE.test(String(slug || ''))) {
    throw new Error("Invalid slug '" + slug + "' (allowed: lowercase letters, digits, '-').");
  }
  let identity;
  let taskPart;
  if (task === ADHOC_TASK) {
    const suffix = random || shortRandom();
    if (!/^[0-9a-f]{6}$/.test(suffix)) {
      throw new Error("invalid adhoc suffix '" + suffix + "' (expected 6 lowercase hex characters)");
    }
    taskPart = ADHOC_TASK + '-' + utcDateStamp(now);
    identity = taskPart + '-' + slug + '-' + suffix;
  } else {
    taskPart = task;
    identity = taskPart + '-' + slug;
  }
  return { identity, branch: TASK_BRANCH_PREFIX + identity, dirName: identity, taskPart };
}

/**
 * Absolute worktree path for a task identity inside the resolved pool root.
 * Pure — the caller decides when to create directories.
 */
export function worktreePathFor({ root, dirName }) {
  return path.join(path.resolve(root), dirName);
}

/**
 * Inverse mapping: the task identity a task branch encodes.
 * `ai/PRI-790-signal-confirmations` -> `PRI-790-signal-confirmations`.
 * Returns null for a branch outside the task namespace (e.g. `main`), which is
 * how the claim tool refuses to treat the control plane as a task slot.
 */
export function taskIdentityFromBranch(branch) {
  if (typeof branch !== 'string' || !branch.startsWith(TASK_BRANCH_PREFIX)) return null;
  const identity = branch.slice(TASK_BRANCH_PREFIX.length).trim();
  return identity.length > 0 ? identity : null;
}
