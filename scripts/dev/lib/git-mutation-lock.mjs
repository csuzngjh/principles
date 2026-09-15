// Repo mutation mutex (PRI-796, AGENTS.md §23A git-12).
//
// WHY THIS EXISTS
// Every worktree of a repository shares one set of Git metadata: the common
// `.git` directory, `.git/worktrees/`, `refs/`, `packed-refs`, the reflog.
// `git worktree add/move/remove/repair/prune` all MUTATE that shared state, and
// they do it with read-modify-write sequences that are not safe against each
// other. The existing per-worktree write lease (git-9) is a filesystem-mutation
// guard scoped to ONE checkout, so it cannot serialise this layer at all.
//
// This module is deliberately NOT: a registry, an ownership database, task
// state, or a persistent truth. It is a short-lived cross-process critical
// section that protects shared Git metadata mutation and nothing else.
//
// SCOPE DISCIPLINE (do not widen):
//   hold it around `git worktree add|move|remove|repair|prune` + branch
//   deletion + the writer claim/release ownership transitions ONLY. Never hold
//   it across `npm install`, a build, or a test run — those take minutes and
//   would turn the mutex into a workstation-wide stall.
//
// SAFETY MODEL — RELEASE MAY NEVER TOUCH A SHARED PATHNAME (v2, round-2 review):
//   v1 kept one lock FILE at one fixed path, and release() did
//   `read token -> compare -> unlink(path)`. A check-then-delete on a shared
//   pathname can always be split by (human recovery + successor acquire), so a
//   straggler release could unlink the successor's lock. Re-reading or pinning
//   an inode does not fix that — it only moves the TOCTOU window. v2 therefore
//   makes the protocol TOKEN-PRIVATE:
//
//     * the lock is an ARENA directory; every claim is its own file named
//       after the holder's random token:  <arena>/owner-<token>.json
//     * mutual exclusion is a create-then-verify ELECTION: each claimant
//       creates its own owner file, then re-reads the arena and accepts the
//       oldest live claim (filesystem creation order) as the holder; younger
//       claims remove ONLY their own file and step back.
//       Two winners are impossible: both proceed only if each verify scan
//       missed the other's create. With X_w/X_v (create-visible / verify) and
//       Y_w/Y_v, each verify follows its own create, so the miss-pairing means
//       X_w < X_v < Y_w < Y_v < X_w — a cycle. One of the two therefore sees
//       the other's older claim and yields.
//     * release() deletes exactly one path: <arena>/owner-<own token>.json.
//       No other process can name or recreate that path, so an old holder's
//       late release is STRUCTURALLY incapable of deleting a successor's lock —
//       that is the invariant this whole module exists for.
//     * the arena directory itself is never removed by the protocol (an empty
//       arena simply means "free"), so even cleanup paths stay private.
//   * a crashed holder still blocks mutations until a HUMAN removes that
//     holder's owner file (fail closed, same policy as v1 — no auto-takeover);
//   * an owner file that cannot be parsed still blocks (fail closed).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const MUTATION_LOCK_FILENAME = 'pd-worktree-mutation.lock';
export const MUTATION_LOCK_SCHEMA = 'pd-worktree-mutation-lock/2';
const OWNER_PREFIX = 'owner-';
const OWNER_RE = /^owner-[0-9a-f]{32}\.json$/;

/** Absolute path of the mutex arena inside the shared git directory. */
export function mutationLockPath(commonDir) {
  return path.join(path.resolve(commonDir), MUTATION_LOCK_FILENAME);
}

function ownerFilePath(commonDir, token) {
  return path.join(mutationLockPath(commonDir), OWNER_PREFIX + token + '.json');
}

/**
 * Read every owner record in the arena.
 * @returns {{present: boolean, live: Array<{token: string, file: string, meta: object, order: number}>, malformed: string[]}}
 */
function scanClaims(commonDir) {
  const arena = mutationLockPath(commonDir);
  let names;
  try {
    names = fs.readdirSync(arena);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { present: false, live: [], malformed: [] };
    return { present: true, live: [], malformed: ['arena directory is unreadable: ' + String((err && err.message) || err)] };
  }
  const live = [];
  const malformed = [];
  for (const name of names) {
    if (!OWNER_RE.test(name)) continue; // stray/unknown entries are not claims
    const file = path.join(arena, name);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      malformed.push(name);
      continue;
    }
    if (
      typeof meta !== 'object' || meta === null || Array.isArray(meta) ||
      meta.schema !== MUTATION_LOCK_SCHEMA ||
      'owner-' + meta.token + '.json' !== name
    ) {
      malformed.push(name);
      continue;
    }
    let order = 0;
    try {
      order = fs.statSync(file).mtimeMs;
    } catch {
      malformed.push(name); // vanished or unreadable mid-scan — fail closed
      continue;
    }
    live.push({ token: meta.token, file, meta, order });
  }
  // Filesystem creation order is the election key; the token is a STRICT
  // total-order tiebreak when two claims share a mtime tick (coarse
  // FAT-style volumes or same-clock writes). A comparator that returned 0 for
  // unequal tokens would let readdir order decide the winner — and two
  // processes may legitimately see different readdir orders. Round-3 review:
  // the tiebreak MUST be a total order.
  live.sort((a, b) => (a.order - b.order) || (a.token === b.token ? 0 : a.token < b.token ? -1 : 1));
  return { present: true, live, malformed };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A peer claimant that has created its owner entry but not finished the JSON
// write is transiently unreadable — the same PRI-728 window the lease reader
// retries. Bounded, short; a genuinely corrupt record stays corrupt and keeps
// blocking (fail closed).
const SCAN_RETRY_ATTEMPTS = 3;
const SCAN_RETRY_DELAY_MS = 5;

function scanClaimsStable(commonDir, delayFn) {
  let scan = scanClaims(commonDir);
  for (let i = 0; i < SCAN_RETRY_ATTEMPTS && scan.malformed.length > 0; i++) {
    delayFn();
    scan = scanClaims(commonDir);
  }
  return scan;
}

/**
 * Read the current holder state.
 * @returns {{exists: false} | {exists: true, valid: false, error: string} |
 *           {exists: true, valid: true, lock: object}}
 */
export function readMutationLock(commonDir, { readRetryDelayFn = () => sleepSync(SCAN_RETRY_DELAY_MS) } = {}) {
  const scan = scanClaimsStable(commonDir, readRetryDelayFn);
  if (!scan.present || scan.live.length === 0) {
    if (scan.malformed.length > 0) {
      return { exists: true, valid: false, error: 'unreadable owner record(s): ' + scan.malformed.join(', ') };
    }
    return { exists: false };
  }
  if (scan.malformed.length > 0) {
    // A corrupt record next to a live claim still blocks: we cannot tell what
    // it was, and guessing is how a live holder's protection disappears.
    return { exists: true, valid: false, error: 'unreadable owner record(s): ' + scan.malformed.join(', ') };
  }
  return { exists: true, valid: true, lock: scan.live[0].meta };
}

/** Human-readable description of whoever holds the mutex. */
export function describeHolder(state) {
  if (!state.exists) return '(no lock)';
  if (!state.valid) return 'unreadable lock file: ' + state.error;
  const l = state.lock;
  return [
    '    operation: ' + (l.operation || '(unset)'),
    '    pid:       ' + (l.pid || '(unset)'),
    '    host:      ' + (l.host || '(unset)'),
    '    target:    ' + (l.target || '(unset)'),
    '    createdAt: ' + (l.createdAt || '(unset)'),
  ].join('\n');
}

function recoveryHint(commonDir, scan) {
  const arena = mutationLockPath(commonDir);
  const files = scan
    ? scan.live.map((c) => arena + path.sep + OWNER_PREFIX + c.token + '.json')
    : [];
  const list = files.length > 0 ? '\n' + files.map((f) => '      ' + f).join('\n') : '      ' + arena;
  return (
    'Another process is mutating shared Git metadata. Wait for it to finish and retry. ' +
    'If you have confirmed that holder is gone (crashed shell, killed agent — check pid/host above), ' +
    'a HUMAN may remove ONLY that holder\'s record:' + list
  );
}

/**
 * Take the mutex. Fails loud when it is already held.
 * @returns {{ok: true, release: () => {released: boolean, reason?: string}} |
 *           {ok: false, error: string, holder: string, nextAction: string, code: string}}
 */
export function acquireMutationLock({
  commonDir,
  operation,
  target,
  now = Date.now(),
  readRetryDelayFn = () => sleepSync(SCAN_RETRY_DELAY_MS),
} = {}) {
  const arena = mutationLockPath(commonDir);
  try {
    fs.mkdirSync(arena, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: 'ENVIRONMENT_INVALID',
      error: 'could not create the repo mutation arena at ' + arena + ': ' + String((err && err.message) || err),
      holder: '(none)',
      nextAction: 'Verify the git common directory is writable, then retry.',
    };
  }

  // Fast path, before polluting the arena with our own record: if a live or
  // corrupt claim is already visible, refuse outright.
  const pre = scanClaimsStable(commonDir, readRetryDelayFn);
  if (pre.live.length > 0 || pre.malformed.length > 0) {
    const state = pre.live.length > 0
      ? { exists: true, valid: true, lock: pre.live[0].meta }
      : { exists: true, valid: false, error: 'unreadable owner record(s): ' + pre.malformed.join(', ') };
    return {
      ok: false,
      code: 'GIT_MUTATION_LOCKED',
      error: 'shared Git metadata is already locked by another process:\n' + describeHolder(state),
      holder: describeHolder(state),
      nextAction: recoveryHint(commonDir, pre),
    };
  }

  // Each claim is its own file, named with a random 128-bit token: nobody can
  // guess it, nobody else can create it, and only we ever remove it.
  let token = crypto.randomBytes(16).toString('hex');
  let ownerFile = ownerFilePath(commonDir, token);
  const record = {
    schema: MUTATION_LOCK_SCHEMA,
    pid: process.pid,
    host: os.hostname() || 'unknown-host',
    operation: String(operation || 'unknown'),
    target: target ? String(target) : null,
    createdAt: new Date(now).toISOString(),
    token,
  };
  let wrote = false;
  for (let attempt = 0; attempt < 3 && !wrote; attempt++) {
    try {
      fs.writeFileSync(ownerFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      wrote = true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // A 128-bit collision is not reality; this is a re-run over a stale
        // path. Take a fresh token before trying again.
        token = crypto.randomBytes(16).toString('hex');
        ownerFile = ownerFilePath(commonDir, token);
        continue;
      }
      return {
        ok: false,
        code: 'ENVIRONMENT_INVALID',
        error: 'could not create the mutation lock record at ' + ownerFile + ': ' + String((err && err.message) || err),
        holder: '(none)',
        nextAction: 'Verify the git common directory is writable, then retry.',
      };
    }
  }
  if (!wrote) {
    return {
      ok: false,
      code: 'ENVIRONMENT_INVALID',
      error: 'could not create a unique mutation lock record in ' + arena,
      holder: '(unknown)',
      nextAction: 'Check for a process repeatedly recreating the same owner file in ' + arena + ', then retry.',
    };
  }

  // Create-then-verify election. After our record is visible, the arena's
  // oldest live claim is the holder: if that is not us, a concurrent
  // claimant's record predates ours and we remove ONLY our own file.
  const post = scanClaimsStable(commonDir, readRetryDelayFn);
  const winner = post.live.length > 0 ? post.live[0] : null;
  const lostToMalformed = winner === null && post.malformed.length > 0;
  if (lostToMalformed || (winner && winner.token !== token)) {
    try { fs.unlinkSync(ownerFile); } catch { /* our own record; ENOENT is fine */ }
    const state = winner
      ? { exists: true, valid: true, lock: winner.meta }
      : { exists: true, valid: false, error: 'unreadable owner record(s): ' + post.malformed.join(', ') };
    return {
      ok: false,
      code: 'GIT_MUTATION_LOCKED',
      error: (winner ? 'shared Git metadata is already locked by another process:\n' : 'the mutation arena holds an unreadable record:\n')
        + describeHolder(state),
      holder: describeHolder(state),
      nextAction: winner
        ? recoveryHint(commonDir, post)
        : 'A HUMAN should inspect/remove the unreadable record(s) under ' + arena + ', then retry.',
    };
  }

  let released = false;
  const release = () => {
    if (released) return { released: false, reason: 'already released' };
    released = true;
    // The ONLY destructive act a release performs: unlink our own record.
    // The path is derived from our private token — a successor's lock is a
    // different file that this code cannot name. Nothing here ever removes
    // a shared pathname, so no interleaving of checks could delete one.
    try {
      fs.unlinkSync(ownerFile);
      return { released: true };
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return {
          released: false,
          reason: 'lock record already gone — a human recovery removed it; any successor claim is untouched',
        };
      }
      throw err;
    }
  };
  return { ok: true, release, file: ownerFile, record };
}

/**
 * Run `fn` while holding the mutex. The lock is acquired around the callback
 * only — callers must keep `fn` to the git mutation itself.
 *
 * Throws the acquire error when the mutex is held (fail loud, never queue —
 * a queue would need a daemon, which SPEC §26 forbids).
 */
export async function withMutationLock(opts, fn) {
  const lock = acquireMutationLock(opts);
  if (!lock.ok) {
    const err = new Error(lock.error);
    err.code = lock.code;
    err.nextAction = lock.nextAction;
    err.holder = lock.holder;
    throw err;
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
