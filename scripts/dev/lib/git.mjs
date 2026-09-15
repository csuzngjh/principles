// Shared git plumbing for the task-worktree dev tools (create/check/cleanup).
//
// Subprocess shape: dynamic import + promisified execFile with argv arrays —
// no shell, no string-built command lines. Every git invocation below passes
// literal subcommands plus validated values as separate argv entries.

import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const { execFile } = await import('node:child_process');
const execFileAsync = promisify(execFile);

/**
 * Run a git subcommand and return stdout. Throws with stderr context on
 * failure unless `allowFailure` is set (then returns null).
 */
export async function runGit(args, { cwd, allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    if (allowFailure) return null;
    const stderr = err && typeof err.stderr === 'string' ? err.stderr.trim() : '';
    const detail = stderr || (err && err.message) || 'unknown error';
    throw new Error('git command failed: git ' + args.join(' ') + '\n' + detail);
  }
}

/**
 * Expand a path using the nearest EXISTING ancestor.
 *
 * `fs.realpathSync.native` only expands 8.3 short names (`ADMINI~1`) for paths
 * that exist. Comparing a path that does not exist yet — a worktree about to be
 * created, a pool root before the first task, `os.tmpdir()` against a git-reported
 * path — therefore silently compares a short name against a long one and reports
 * a difference that is not real. This is the ERR-090 recurrence class: normalize
 * BOTH sides, and make the normalization work for paths that do not exist yet.
 */
function expandExistingAncestor(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    // Fall through: walk up to the closest ancestor that does exist.
  }
  const parts = [];
  let current = target;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return target; // reached the volume root
    parts.unshift(path.basename(current));
    current = parent;
    try {
      return path.join(fs.realpathSync.native(current), ...parts);
    } catch {
      // Keep walking up.
    }
  }
}

/**
 * Normalize a git-reported path for comparison. Both sides of any path
 * comparison must go through this. Windows hazards handled here:
 *   - mixed '/' vs '\' separators across git subcommands;
 *   - 8.3 short names (mkdtemp/TEMP dirs report 'ADMINI~1', git reports
 *     'Administrator') — realpathSync.native expands to final paths, and the
 *     nearest-existing-ancestor walk covers paths that do not exist yet;
 *   - drive-letter and path case.
 * (ERR-090 recurrence class: normalize BOTH sides before comparing.)
 */
export function normalizeGitPath(p, cwd) {
  const base = cwd || process.cwd();
  const absolute = path.isAbsolute(p) ? p : path.resolve(base, p);
  const resolved = expandExistingAncestor(path.resolve(absolute));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when two git-reported paths refer to the same location. */
export function sameGitPath(a, b, cwd) {
  return normalizeGitPath(a, cwd) === normalizeGitPath(b, cwd);
}

/**
 * Parse `git worktree list --porcelain` output into records.
 * The FIRST non-bare record is the primary worktree (git guarantees the
 * main working tree is listed first).
 *
 * PRI-796: `locked` / `prunable` are captured as well — the Git-native lock is
 * the second half of writer ownership (git-9 lease + `git worktree lock`), and
 * cleanup must refuse a locked worktree instead of silently unlocking it.
 */
export function parseWorktreeList(output) {
  const worktrees = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      worktrees.push({ path: line.slice('worktree '.length).trim() });
    } else if (worktrees.length === 0) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      worktrees[worktrees.length - 1].head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      worktrees[worktrees.length - 1].branch = line.slice('branch '.length).trim();
    } else if (line === 'bare') {
      worktrees[worktrees.length - 1].bare = true;
    } else if (line === 'detached') {
      worktrees[worktrees.length - 1].detached = true;
    } else if (line === 'locked') {
      worktrees[worktrees.length - 1].locked = true;
    } else if (line.startsWith('locked ')) {
      worktrees[worktrees.length - 1].locked = true;
      worktrees[worktrees.length - 1].lockReason = line.slice('locked '.length).trim();
    } else if (line.startsWith('prunable')) {
      worktrees[worktrees.length - 1].prunable = true;
    }
  }
  return worktrees;
}

export async function listWorktrees(cwd) {
  const out = await runGit(['worktree', 'list', '--porcelain'], { cwd });
  return parseWorktreeList(out);
}

/**
 * PRI-712: assess whether a global `git worktree prune` is safe to run right
 * now. Prune drops the admin metadata of worktrees whose directory git
 * believes is gone — but on Windows a directory held by another process's
 * file locks (EPERM storms are routine in this repo) can be transiently
 * UNREADABLE rather than absent, and git then misclassifies it as missing.
 * That silently destroyed a live agent's worktree metadata (PRI-710
 * incident, 2026-09-08) while the worktree held uncommitted work.
 *
 * The prune hazard is READABILITY, not dirtiness: prune keys on directory
 * existence, so a readable-but-dirty worktree is never its target, while an
 * unreadable one can be misclassified as gone. The guard therefore blocks
 * only when an existing-dir worktree cannot be probed by git (one settle
 * re-probe filters transient EPERM failures). Dirtiness stays the REMOVE
 * path's protection — every removal here probes `status --porcelain` and
 * refuses on unknown work (git-4).
 *
 * Returns:
 *   safe    — true when prune may run (every existing-dir worktree probed
 *             readable; only missing/unreadable-proof dirs would be dropped).
 *   blocked — entries { path, reason: 'unreadable' }.
 *   checked — paths of existing-dir worktrees that probed readable.
 */
const PRUNE_PROBE_SETTLE_MS = 300;

export async function assessWorktreePruneSafety(cwd) {
  const worktrees = await listWorktrees(cwd);
  const blocked = [];
  const checked = [];
  for (const wt of worktrees) {
    if (wt.bare) continue;
    if (!fs.existsSync(wt.path)) continue; // dir provably gone — prune's job
    let probe = await runGit(['status', '--porcelain'], { cwd: wt.path, allowFailure: true });
    if (probe === null) {
      // Transient EPERM filter: one settle re-probe before declaring block.
      await new Promise((resolve) => setTimeout(resolve, PRUNE_PROBE_SETTLE_MS));
      probe = await runGit(['status', '--porcelain'], { cwd: wt.path, allowFailure: true });
    }
    if (probe === null) {
      blocked.push({ path: wt.path, reason: 'unreadable' });
    } else {
      checked.push(wt.path);
    }
  }
  return { safe: blocked.length === 0, blocked, checked };
}

/**
 * The primary checkout: the first non-bare worktree. It owns the repository
 * .git directory and acts as the control plane (AGENTS.md §23A) — AI writers
 * must not implement there.
 */
export async function findPrimaryWorktree(cwd) {
  const list = await listWorktrees(cwd);
  const primary = list.find((w) => !w.bare);
  if (!primary) {
    throw new Error('No non-bare worktree found — cannot identify the primary checkout.');
  }
  return primary;
}

/**
 * Resolve the git context of `cwd`: absolute git dir, common dir, current
 * branch ('HEAD' when detached), and whether this checkout is the primary
 * worktree (git dir == common dir).
 */
/**
 * Absolute path of the SHARED git directory (the common dir).
 *
 * `git rev-parse --git-common-dir` answers with a cwd-RELATIVE path when run
 * from a subdirectory (`../.git`), so it must never be used as a filesystem
 * path directly — that is the bug class that makes a lock file land somewhere
 * surprising. `--path-format=absolute` (git >= 2.31) answers absolutely; the
 * fallback resolves against the worktree toplevel for older clients.
 *
 * PRI-796: the repo mutation mutex lives here, so this must be exact.
 */
export async function gitCommonDirAbsolute(cwd) {
  const base = path.resolve(cwd || process.cwd());
  const absolute = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: base,
    allowFailure: true,
  });
  if (absolute !== null && absolute.trim().length > 0) return absolute.trim();
  const relative = (await runGit(['rev-parse', '--git-common-dir'], { cwd: base })).trim();
  if (path.isAbsolute(relative)) return relative;
  const toplevel = (await runGit(['rev-parse', '--show-toplevel'], { cwd: base })).trim();
  return path.resolve(toplevel, relative);
}

export async function getGitContext(cwd) {
  const base = path.resolve(cwd || process.cwd());
  const gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], { cwd: base })).trim();
  const commonDir = (await runGit(['rev-parse', '--git-common-dir'], { cwd: base })).trim();
  const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: base })).trim();
  // Worktree root (null in a bare repo). Worktree-local tool state — e.g. the
  // workspace write lease — must resolve here, not to cwd, so subdir runs work.
  const toplevel = (await runGit(['rev-parse', '--show-toplevel'], { cwd: base, allowFailure: true }))?.trim() || null;
  return {
    cwd: base,
    gitDir,
    commonDir,
    branch,
    toplevel,
    detached: branch === 'HEAD' || branch === '',
    isPrimary: sameGitPath(gitDir, commonDir, base),
  };
}
