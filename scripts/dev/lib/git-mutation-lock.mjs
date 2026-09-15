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
//   deletion ONLY. Never hold it across `npm install`, a build, or a test run —
//   those take minutes and would turn the mutex into a workstation-wide stall.
//
// SAFETY MODEL (SECURITY/simplicity trade-off, chosen deliberately):
//   * created with flag 'wx' (O_EXCL) so exactly one process wins;
//   * an existing lock is NEVER overwritten and NEVER auto-deleted — a crashed
//     holder blocks mutations until a HUMAN removes the file. Leaving the disk
//     unmutated is strictly better than guessing that a holder is gone;
//   * a lock file that cannot be parsed still blocks (fail closed);
//   * release only unlinks a lock this process still owns — token compare AND
//     (where the platform exposes file identity) an inode pin taken at create
//     time — so a slow holder can neither delete a successor's lock nor a
//     replacement written after a human recovery removed its own (PRI-796).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const MUTATION_LOCK_FILENAME = 'pd-worktree-mutation.lock';
export const MUTATION_LOCK_SCHEMA = 'pd-worktree-mutation-lock/1';

/** Absolute path of the mutex inside the shared git directory. */
export function mutationLockPath(commonDir) {
  return path.join(path.resolve(commonDir), MUTATION_LOCK_FILENAME);
}

/**
 * Read the lock file.
 * @returns {{exists: false} | {exists: true, valid: false, error: string} |
 *           {exists: true, valid: true, lock: object}}
 */
export function readMutationLock(commonDir) {
  const file = mutationLockPath(commonDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false };
    return { exists: true, valid: false, error: String((err && err.message) || err) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exists: true, valid: false, error: 'lock file is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { exists: true, valid: false, error: 'lock file is not a JSON object' };
  }
  if (parsed.schema !== MUTATION_LOCK_SCHEMA) {
    return { exists: true, valid: false, error: "unexpected schema '" + String(parsed.schema) + "'" };
  }
  return { exists: true, valid: true, lock: parsed };
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

function recoveryHint(commonDir) {
  const file = mutationLockPath(commonDir);
  return (
    'Another process is mutating shared Git metadata. Wait for it to finish and retry. ' +
    'If you have confirmed that holder is gone (crashed shell, killed agent — check pid/host above), ' +
    'a HUMAN may remove the lock explicitly:\n' +
    '      rm "' + file + '"'
  );
}

/**
 * Take the mutex. Fails loud when it is already held.
 * @returns {{ok: true, release: () => {released: boolean, reason?: string}} |
 *           {ok: false, error: string, holder: string, nextAction: string, code: string}}
 */
export function acquireMutationLock({ commonDir, operation, target, env = process.env, now = Date.now() }) {
  const file = mutationLockPath(commonDir);
  const token = crypto.randomBytes(16).toString('hex');
  const record = {
    schema: MUTATION_LOCK_SCHEMA,
    pid: process.pid,
    host: os.hostname() || 'unknown-host',
    operation: String(operation || 'unknown'),
    target: target ? String(target) : null,
    createdAt: new Date(now).toISOString(),
    // Internal-only: lets release() prove it still owns the lock. A successor
    // that replaced the file is never unlinked by a straggler.
    token,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const existing = readMutationLock(commonDir);
      return {
        ok: false,
        code: 'GIT_MUTATION_LOCKED',
        error: 'shared Git metadata is already locked by another process:\n' + describeHolder(existing),
        holder: describeHolder(existing),
        nextAction: recoveryHint(commonDir),
      };
    }
    return {
      ok: false,
      code: 'ENVIRONMENT_INVALID',
      error: 'could not create the repo mutation lock at ' + file + ': ' + String((err && err.message) || err),
      holder: '(none)',
      nextAction: 'Verify the git common directory is writable, then retry.',
    };
  }

  // PRI-796 (review): pin the identity of the file WE created. A token compare
  // alone leaves a check-then-unlink window: a human recovery may remove the
  // stale lock and a successor may create a NEW lock at the same path before a
  // slow holder unlinks — blind unlink would then delete the successor's lock
  // and two Git metadata mutations could run concurrently. Recording the inode
  // (file index on NTFS) at creation lets release prove it is deleting the
  // exact file object it created, not merely a same-named path.
  let ownIno = null;
  let pinFd = null;
  try {
    pinFd = fs.openSync(file, 'r');
    ownIno = fs.fstatSync(pinFd).ino;
  } catch {
    ownIno = null; // inode pinning unavailable on this platform/fs — release
                  // falls back to the token-only guard and reports honestly
  } finally {
    if (pinFd !== null) {
      try { fs.closeSync(pinFd); } catch { /* best effort */ }
    }
  }

  let released = false;
  const release = () => {
    if (released) return { released: false, reason: 'already released' };
    released = true;
    const current = readMutationLock(commonDir);
    if (!current.exists) return { released: false, reason: 'lock already gone' };
    if (!current.valid || current.lock.token !== token) {
      return { released: false, reason: 'lock is no longer owned by this process — left in place' };
    }
    if (ownIno !== null) {
      // Same-content file recreated at the path after a human removal would
      // carry a new inode — prove file-object identity before unlinking.
      let probeFd = null;
      let nowIno = null;
      try {
        probeFd = fs.openSync(file, 'r');
        nowIno = fs.fstatSync(probeFd).ino;
      } catch {
        return { released: false, reason: 'lock already gone' };
      } finally {
        if (probeFd !== null) {
          try { fs.closeSync(probeFd); } catch { /* best effort */ }
        }
      }
      if (nowIno !== ownIno) {
        return { released: false, reason: 'lock file was replaced by another owner since acquire — left in place' };
      }
    }
    try {
      fs.unlinkSync(file);
      return { released: true };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { released: false, reason: 'lock already gone' };
      throw err;
    }
  };
  return { ok: true, release, file, record };
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
