/**
 * PD-SPEC-001 — unified repository-root resolution for all experiment scripts.
 *
 * Remediation Phase 2: the copied Phase 0 scripts computed the repo root with
 * hard-coded relative walk-ups that break as soon as the script moves (the
 * committed copies walked up one level short). Every script resolves through
 * this module now:
 *   - `git rev-parse --show-toplevel` is the ONLY source;
 *   - the result must contain a `.git` entry (dir/file for worktrees) or be a
 *     registered worktree (`.git` file pointing at a real gitdir);
 *   - no silent cwd fallback — resolution failure throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the repository root. `scriptUrl` (import.meta.url of the caller) is
 * only used for the error message context — resolution is cwd-independent
 * because git resolves from the script's directory upward.
 */
export function findRepoRoot(scriptUrl = null) {
  let cwd = null;
  if (scriptUrl) {
    cwd = path.dirname(fileURLToPath(scriptUrl));
  }
  let top;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd: cwd ?? undefined }).trim();
  } catch (err) {
    throw new Error(`findRepoRoot: 'git rev-parse --show-toplevel' failed${cwd ? ` (from ${cwd})` : ''} — ${String(err?.message ?? err).split('\n')[0]}`);
  }
  if (!top) throw new Error('findRepoRoot: empty toplevel');
  const dotGit = path.join(top, '.git');
  const stat = fs.existsSync(dotGit) ? fs.statSync(dotGit) : null;
  if (!stat || (stat.isDirectory() === false && !fs.readFileSync(dotGit, 'utf8').includes('gitdir:'))) {
    throw new Error(`findRepoRoot: '${top}' has no valid .git entry — not a repository or worktree root`);
  }
  return path.resolve(top);
}
