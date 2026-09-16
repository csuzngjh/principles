// Preflight checks and the shared failure taxonomy (PRI-796, SPEC §6.1 / §21).
//
// WHY THE TAXONOMY EXISTS
// Before PRI-796 every local problem — a missing Git-LFS install, a broken npm
// environment, a stale remote-tracking ref, a half-bootstrapped worktree — was
// reported as the same generic failure. Agents that repeatedly see "check
// failed" for environmental reasons learn to reach for `--no-verify`, which is
// exactly how a safety gate becomes decorative. Naming the cause keeps the gate
// credible: a TOOLCHAIN_MISSING is the operator's environment to fix, whereas a
// CHECK_FAILED is the change under review.
//
//   TOOLCHAIN_MISSING   a required external tool is not installed (git-lfs)
//   ENVIRONMENT_INVALID the local checkout/remote cannot support the operation
//                       (no origin, network/auth failure, unresolvable ref)
//   REF_INCONSISTENT    a fetch completed but the SHA it produced disagrees with
//                       the remote-tracking ref — refuse to proceed rather than
//                       build evidence on a ref we cannot explain
//   NOT_READY           the worktree exists but is not usable for development
//   CHECK_FAILED        the repository content itself violates a rule

import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git.mjs';

export const CODES = Object.freeze({
  TOOLCHAIN_MISSING: 'TOOLCHAIN_MISSING',
  ENVIRONMENT_INVALID: 'ENVIRONMENT_INVALID',
  REF_INCONSISTENT: 'REF_INCONSISTENT',
  NOT_READY: 'NOT_READY',
  CHECK_FAILED: 'CHECK_FAILED',
});

export const DEFAULT_REMOTE = 'origin';
export const DEFAULT_BASE_BRANCH = 'main';

// ---------------------------------------------------------------------------
// Git LFS
// ---------------------------------------------------------------------------

/**
 * Return the `.gitattributes` entries that route content through Git LFS.
 * Read-only; a repo with no LFS patterns needs no `git-lfs` binary.
 *
 * @returns {Array<{pattern: string, line: string}>}
 */
export function detectLfsPatterns(repoRoot) {
  const file = path.join(repoRoot, '.gitattributes');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const found = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!/filter\s*=\s*lfs/.test(trimmed)) continue;
    found.push({ pattern: trimmed.split(/\s+/)[0], line: trimmed });
  }
  return found;
}

/** Is a working `git-lfs` available? Never throws. */
export async function checkGitLfs(cwd) {
  const out = await runGit(['lfs', 'version'], { cwd, allowFailure: true });
  if (out === null) return { available: false, version: null };
  return { available: true, version: out.trim() };
}

/**
 * Fail BEFORE `git worktree add` rather than half-way through a smudge filter.
 * A partially-filtered checkout is the worst outcome: the files exist, the
 * content is wrong, and nothing reports it.
 *
 * `checkLfsFn` is injectable so the refusal path can be exercised deterministically
 * (hiding a real git-lfs install from a test process is not portable).
 *
 * @returns {{ok: true, lfs: {required: boolean, patterns: string[], version: string|null}} |
 *           {ok: false, code: string, error: string, nextAction: string}}
 */
export async function runToolchainPreflight({ repoRoot, cwd, checkLfsFn = checkGitLfs }) {
  const patterns = detectLfsPatterns(repoRoot);
  if (patterns.length === 0) {
    return { ok: true, lfs: { required: false, patterns: [], version: null } };
  }
  const lfs = await checkLfsFn(cwd);
  if (!lfs.available) {
    return {
      ok: false,
      code: CODES.TOOLCHAIN_MISSING,
      error:
        "this repository tracks content through Git LFS (" +
        patterns.map((p) => p.pattern).join(', ') +
        ') but `git lfs version` failed — the git-lfs toolchain is not installed or not on PATH.',
      nextAction: 'Install Git LFS (https://git-lfs.com), run `git lfs install`, then retry. Refusing to start a worktree that would check out unfiltered content.',
    };
  }
  return { ok: true, lfs: { required: true, patterns: patterns.map((p) => p.pattern), version: lfs.version } };
}

// ---------------------------------------------------------------------------
// Remote-tracking ref freshness
// ---------------------------------------------------------------------------

/**
 * The freshness POLICY, separated from the I/O that feeds it.
 *
 * Pure so the invariant can be exercised deterministically: a fetch result that
 * disagrees with the remote-tracking ref must stop the caller, because every
 * later claim ("based on the latest origin/main") would be unverifiable.
 *
 * @returns {{ok: true} | {ok: false, code: string, error: string, nextAction: string, detail: object}}
 */
export function evaluateRefConsistency({ fetchSha, refSha, remoteRef }) {
  if (!fetchSha || !refSha) {
    return {
      ok: false,
      code: CODES.ENVIRONMENT_INVALID,
      error: 'fetch completed but ' + (fetchSha ? remoteRef : 'FETCH_HEAD') + ' did not resolve.',
      nextAction: 'Inspect the ref manually: git rev-parse FETCH_HEAD ' + remoteRef,
      detail: { fetchSha, refSha, remoteRef },
    };
  }
  if (fetchSha !== refSha) {
    return {
      ok: false,
      code: CODES.REF_INCONSISTENT,
      error:
        'the fetch result and the remote-tracking ref disagree — refusing to derive a base from an inconsistent ref.\n' +
        '    FETCH_HEAD         ' + fetchSha + '\n' +
        '    ' + remoteRef + '  ' + refSha,
      nextAction:
        'A concurrent process may be rewriting this ref. Re-run; if it persists, inspect ' +
        remoteRef + ' and the remote state before proceeding.',
      detail: { fetchSha, refSha, remoteRef },
    };
  }
  return { ok: true };
}

/**
 * Refresh a remote-tracking ref and PROVE that this fetch produced it (SPEC §6.1 C).
 *
 * The naive check — compare `git rev-parse <ref>` with `git ls-remote` — flags a
 * remote that legitimately moved forward as corruption. Fetching one explicit
 * refspec writes both `FETCH_HEAD` and the remote-tracking ref in the same
 * operation, so a disagreement between them can only mean the ref was rewritten
 * underneath us and anything derived from it would be fabricated evidence.
 *
 * @returns {{ok: true, sha: string, freshness: 'fetched'|'offline-cached', remoteRef: string} |
 *           {ok: false, code: string, error: string, nextAction: string, detail?: object}}
 */
export async function assertRefFreshness({
  cwd,
  branch = DEFAULT_BASE_BRANCH,
  remote = DEFAULT_REMOTE,
  offline = false,
} = {}) {
  const remoteRef = 'refs/remotes/' + remote + '/' + branch;

  if (offline) {
    const sha = (await runGit(['rev-parse', '--verify', remoteRef + '^{commit}'], { cwd, allowFailure: true }))?.trim();
    if (!sha) {
      return {
        ok: false,
        code: CODES.ENVIRONMENT_INVALID,
        error: 'offline mode: cached ref ' + remoteRef + ' does not resolve to a commit.',
        nextAction: 'Drop --offline (refresh from ' + remote + ') or fetch once while the network is available.',
      };
    }
    return { ok: true, sha, freshness: 'offline-cached', remoteRef };
  }

  const fetchOut = await runGit(
    ['fetch', remote, '--prune', 'refs/heads/' + branch + ':' + remoteRef],
    { cwd, allowFailure: true }
  );
  if (fetchOut === null) {
    return {
      ok: false,
      code: CODES.ENVIRONMENT_INVALID,
      error: 'git fetch ' + remote + ' failed — cannot establish a trustworthy base.',
      nextAction:
        'Fix network/credentials (or the remote configuration) and retry. ' +
        'Pass --offline only if you consciously accept the cached ' + remoteRef + '.',
    };
  }

  const fetchSha = (await runGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { cwd, allowFailure: true }))?.trim() || null;
  const refSha = (await runGit(['rev-parse', '--verify', remoteRef + '^{commit}'], { cwd, allowFailure: true }))?.trim() || null;

  const verdict = evaluateRefConsistency({ fetchSha, refSha, remoteRef });
  if (!verdict.ok) return verdict;

  return { ok: true, sha: refSha, freshness: 'fetched', remoteRef };
}
