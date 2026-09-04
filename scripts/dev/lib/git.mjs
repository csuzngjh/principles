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
 * Normalize a git-reported path for comparison. Both sides of any path
 * comparison must go through this. Windows hazards handled here:
 *   - mixed '/' vs '\' separators across git subcommands;
 *   - 8.3 short names (mkdtemp/TEMP dirs report 'ADMINI~1', git reports
 *     'Administrator') — realpathSync.native expands to final paths;
 *   - drive-letter and path case.
 * (ERR-090 recurrence class: normalize BOTH sides before comparing.)
 */
export function normalizeGitPath(p, cwd) {
  const base = cwd || process.cwd();
  const absolute = path.isAbsolute(p) ? p : path.resolve(base, p);
  let resolved = path.resolve(absolute);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Path does not exist (yet) — the resolved form is the best comparable.
  }
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
    }
  }
  return worktrees;
}

export async function listWorktrees(cwd) {
  const out = await runGit(['worktree', 'list', '--porcelain'], { cwd });
  return parseWorktreeList(out);
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
