// Worktree build-readiness stamp (PRI-796 round-2 review).
//
// WHY THIS EXISTS
// L2 previously answered "is the build current?" from MTIME: newest-source-mtime
// vs artifact-mtime, and lockfile-mtime vs install-marker-mtime with a 2-second
// margin. Timestamps cannot carry that weight: a checkout/restore can rewrite
// sources without advancing mtime in a useful way, `touch` defeats the check
// outright, and the bounded source walk gave the WEAKEST verification to exactly
// the packages with the MOST files. Verdicts about "what is built" must come
// from CONTENT IDENTITY, not from clocks.
//
// THE STAMP
// One tiny worktree-local JSON record written ONLY after `npm install` and the
// canonical `npm run build` have both SUCCEEDED:
//
//   <git-dir-of-this-worktree>/pd-dev-build-state.json
//
// It lives inside the worktree's own git directory, so it is (a) worktree-local,
// (b) never committable, (c) pruned automatically with the worktree, and
// (d) clear of the `<workspace>/.pd/` runtime-state namespace (AGENTS.md §1.1).
//
// It records: gitHead, sha256(package-lock.json), sha256(root package.json) —
// the build authority — and the timestamp is informational only.
//
// WHAT READINESS THEN PROVES
//   stamp present AND HEAD unchanged AND lock content unchanged AND build
//   authority unchanged AND no uncommitted changes under the covered build
//   inputs  →  the artifacts on disk were emitted by THAT source state.
// Any mismatch → NOT_READY ("run npm run build" / "run npm install").
// A hand-touched artifact cannot fool it: mtime is not consulted at all.
//
// KNOWN SCOPE (round-3 review): dirt covers TRACKED *and* UNTRACKED (but not
// gitignored) files under the build inputs — `git status --porcelain` without
// -uno. An untracked-but-not-ignored file is a real addition the recorded
// build never saw, so it flips readiness. Gitignored trees (node_modules/,
// dist/, coverage/) are invisible here by design — dist is the build OUTPUT,
// and node_modules freshness is proven by the lock digest, not by dirt.
// The next real `git add` (or the file's effect on the build) re-covers it.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const BUILD_STAMP_FILENAME = 'pd-dev-build-state.json';
export const BUILD_STAMP_SCHEMA = 'pd-worktree-build-state/1';

function sha256File(file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  return createHash('sha256').update(raw).digest('hex');
}

function gitOut(args, cwd) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

/** The per-WORKTREE git dir (linked worktrees: <common>/worktrees/<name>). */
export function worktreeGitDir(root) {
  const out = gitOut(['rev-parse', '--absolute-git-dir'], root);
  return out === null || out === '' ? null : out;
}

export function buildStampPath(root) {
  const gitDir = worktreeGitDir(root);
  return gitDir === null ? null : path.join(gitDir, BUILD_STAMP_FILENAME);
}

/**
 * The CURRENT identity of everything a fresh build would consume (excluding
 * the untracked-output caveat above). `coveredDirs` scopes the dirt check to
 * the packages the root build authority actually compiles.
 */
export function computeBuildIdentity(root, { coveredDirs = [] } = {}) {
  return {
    gitHead: gitOut(['rev-parse', 'HEAD'], root),
    packageLockDigest: sha256File(path.join(root, 'package-lock.json')),
    buildAuthorityDigest: sha256File(path.join(root, 'package.json')),
    dirtyBuildInputs: dirtyBuildInputs(root, coveredDirs),
  };
}

/**
 * Tracked AND untracked (non-ignored) modifications under the covered build
 * inputs + the root manifest. Empty string = clean; null = git could not
 * answer (treated as NOT clean — fail closed, a broken probe must never mint
 * a READY). Round-3: -uno was dropped, so a brand-new untracked source file
 * — bytes the stamped build provably never compiled — invalidates the stamp.
 */
function dirtyBuildInputs(root, coveredDirs) {
  const pathspecs = ['package.json', ...coveredDirs.map((d) => path.relative(root, d).replaceAll('\\', '/'))];
  const r = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', ...pathspecs], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.replace(/\r?\n$/, '');
}

/**
 * Mint and write the stamp. Call ONLY immediately after a successful install
 * + canonical build. Returns {ok:false,...} when the identity cannot be
 * computed (not a git repo) — readiness then honestly reports NOT_READY.
 */
export function writeBuildStamp(root, { coveredDirs = [], now = Date.now() } = {}) {
  const file = buildStampPath(root);
  if (file === null) {
    return { ok: false, error: 'no git dir resolvable for ' + root + ' — cannot stamp build state' };
  }
  const identity = computeBuildIdentity(root, { coveredDirs });
  if (identity.gitHead === null) {
    return { ok: false, error: 'git rev-parse HEAD failed in ' + root + ' — cannot stamp build state' };
  }
  if (identity.dirtyBuildInputs !== '') {
    // A build just ran against THESE bytes; stamping a dirty tree is honest
    // only if we also record the dirt fingerprint so any later edit flips it.
    // We do not: the dirt must be committed or reverted before the stamp can
    // mean "READY". Refuse, and let the operator decide.
    return {
      ok: false,
      error: 'build inputs are dirty — commit or revert before stamping readiness:\n' + identity.dirtyBuildInputs,
    };
  }
  const stamp = {
    schema: BUILD_STAMP_SCHEMA,
    gitHead: identity.gitHead,
    packageLockDigest: identity.packageLockDigest,
    buildAuthorityDigest: identity.buildAuthorityDigest,
    builtAt: new Date(now).toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stamp, null, 2) + '\n', 'utf-8');
    return { ok: true, file, stamp };
  } catch (err) {
    return { ok: false, error: 'could not write ' + file + ': ' + String((err && err.message) || err) };
  }
}

export function readBuildStamp(root) {
  const file = buildStampPath(root);
  if (file === null) return { exists: false, reason: 'not a git worktree (no git dir)' };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, reason: 'no build stamp — run npm run dev:worktree:bootstrap' };
    return { exists: false, reason: 'build stamp unreadable: ' + String((err && err.message) || err) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exists: false, reason: 'build stamp is not valid JSON: ' + file };
  }
  if (
    typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
    parsed.schema !== BUILD_STAMP_SCHEMA ||
    typeof parsed.gitHead !== 'string'
  ) {
    return { exists: false, reason: 'build stamp has an unexpected schema — delete it and re-run bootstrap' };
  }
  return { exists: true, stamp: parsed, file };
}

/**
 * Verify the stamp against the CURRENT content identity of the tree.
 * @returns {{ok: boolean, mismatches: string[], detail: string, stamp: object|null, current: object|null}}
 */
export function verifyBuildStamp(root, { coveredDirs = [] } = {}) {
  const read = readBuildStamp(root);
  if (!read.exists) {
    return { ok: false, mismatches: ['stamp'], detail: read.reason, stamp: null, current: null };
  }
  const current = computeBuildIdentity(root, { coveredDirs });
  const mismatches = [];
  if (current.gitHead === null) mismatches.push('git-head (unresolvable)');
  else if (current.gitHead !== read.stamp.gitHead) mismatches.push('git-head');
  if ((current.packageLockDigest ?? null) !== (read.stamp.packageLockDigest ?? null)) mismatches.push('package-lock');
  if (current.buildAuthorityDigest !== read.stamp.buildAuthorityDigest) mismatches.push('build-authority');
  if (current.dirtyBuildInputs !== '') mismatches.push('dirty-build-inputs');

  const parts = [];
  if (mismatches.includes('git-head')) {
    parts.push('HEAD moved since the stamped build (' + short(read.stamp.gitHead) + ' → ' + short(current.gitHead) + ')');
  }
  if (mismatches.includes('package-lock')) {
    parts.push('package-lock.json content changed since the stamped install — run npm install');
  }
  if (mismatches.includes('build-authority')) {
    parts.push('root package.json (the build authority) changed since the stamped build — run npm run build');
  }
  if (mismatches.includes('dirty-build-inputs')) {
    parts.push('uncommitted changes touch build inputs:\n      ' + String(current.dirtyBuildInputs).split('\n').join('\n      '));
  }
  return {
    ok: mismatches.length === 0,
    mismatches,
    detail: mismatches.length === 0
      ? 'stamped build matches HEAD + lock + authority, tree clean'
      : parts.join('; '),
    stamp: read.stamp,
    current,
  };
}

function short(sha) {
  return typeof sha === 'string' ? sha.slice(0, 9) : String(sha);
}

/**
 * Round-3 review: a stamp also claims "the dependency tree matches THIS
 * lockfile", and only an actually-verified `npm install` earns that claim.
 * When `--skip-install` is used, the skip is attested ONLY if the existing
 * chain of evidence still holds: npm's install marker is present AND a prior
 * stamp recorded the EXACT current lock digest (a drifted or missing lock
 * means dependencies changed without anyone verifying). Anything else must
 * refuse to mint the stamp — a build that merely "passed" against a stale
 * node_modules is exactly the js-yaml TS2339 failure class this module
 * exists to prevent from re-appearing under a new name.
 */
export function installAttestedWithSkip({ markerPresent, stampResult }) {
  if (!markerPresent) return false;
  if (!stampResult || !stampResult.stamp) return false;
  return !stampResult.mismatches.includes('package-lock');
}
