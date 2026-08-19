/**
 * Path containment primitives (CWE-22 boundary guards).
 *
 * Single source of truth for "is this filesystem target inside that root?"
 * across pd-cli security boundaries. All containment decisions compare
 * CANONICAL (fully resolved) paths via `path.relative`, never by string
 * prefix — a string `startsWith` on a possibly-relative root is wrong on
 * two counts: (1) a relative root never prefixes an absolute target, and
 * (2) `/work/foo` is a prefix of `/work/foobar` without being a boundary.
 *
 * ── Symlink policy ────────────────────────────────────────────────────────
 * The guarantee provided here is LEXICAL containment: `path.resolve` +
 * `path.relative`, without resolving symlinks. We deliberately do NOT
 * `realpath` the target before containment because:
 *   1. PD's IO roots are operator-supplied workspace directories; symlinks
 *      inside the workspace are created by the owner and treated as trusted
 *      content.
 *   2. On Windows, junction points (worktree junctions, `node_modules`
 *      junctions) resolve to a *different physical location* via `realpath`;
 *      realpath-based containment would reject legitimate local workflows
 *      (e.g. a worktree whose `node_modules` is junctioned to the main
 *      checkout).
 * If a future caller must constrain the physical read target (e.g. reading a
 * file whose path could be a symlink to an untrusted location), that caller
 * must realpath the target FIRST and then run containment on the resolved
 * path — do not weaken this module's contract.
 */

import * as path from 'node:path';

/**
 * Canonicalize a user/operator-supplied path once. Every derived filesystem
 * target must be compared against this canonical root.
 */
export function canonicalPath(p: string): string {
  return path.resolve(p);
}

/**
 * True when `candidate` is strictly inside `parent` (canonical comparison).
 *
 * - Both arguments are resolved against cwd first, so relative inputs work.
 * - `candidate === parent` returns false (strict containment). Callers that
 *   want to allow the root itself should check equality separately.
 * - Sibling-prefix attacks (`/work/foobar` vs parent `/work/foo`) cannot
 *   pass because `path.relative` yields a non-`..`-prefixed path only for
 *   real descendants.
 */
export function isPathInside(parent: string, candidate: string): boolean {
  const root = path.resolve(parent);
  const target = path.resolve(candidate);
  const rel = path.relative(root, target);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

/**
 * Throw unless `candidate` is strictly inside `parent`. `label` names the
 * candidate in the error message (e.g. "--workspace").
 */
export function assertPathInside(parent: string, candidate: string, label: string): void {
  if (!isPathInside(parent, candidate)) {
    throw new Error(`Invalid ${label}: "${candidate}" is outside "${parent}"`);
  }
}

/**
 * Validate an operator-supplied directory root before it is used as an IO
 * root: rejects empty values, residual parent-traversal segments, and
 * filesystem-root results. Returns the canonical root.
 *
 * No `path.isAbsolute` requirement: absolute-ness is platform-dependent (a
 * Windows-style path like `Z:\work` is not absolute on POSIX runners) and
 * relative paths resolve inside cwd, so they carry no traversal risk. The
 * guards that matter are: empty, parent traversal, and filesystem root.
 */
export function assertSafeDirectoryRoot(input: string, label: string): string {
  if (!input || input.trim().length === 0) {
    throw new Error(`Invalid ${label}: path is empty`);
  }
  // Un-normalized `..` segments that survive normalize() mean the input
  // escaped a parent boundary (e.g. "..\\..\\evil") — reject rather than
  // trust them. Foldable segments ("a/../b") canonicalize safely.
  if (path.normalize(input).split(/[\\/]/).includes('..')) {
    throw new Error(`Invalid ${label}: "${input}" contains parent traversal`);
  }
  const root = canonicalPath(input);
  if (root === path.parse(root).root) {
    throw new Error(`Invalid ${label}: "${input}" resolves to filesystem root`);
  }
  return root;
}
