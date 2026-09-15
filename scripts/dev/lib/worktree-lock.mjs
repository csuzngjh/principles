// Git-native worktree lock helpers (PRI-796, SPEC §10.1 B / §10.3).
//
// Writer ownership has TWO halves, and both are needed:
//
//   1. the PD write lease (`.workspace-lease.json`, git-9) — a cooperative
//      signal that makes a concurrent session's write intent visible BEFORE it
//      touches files;
//   2. `git worktree lock` — Git's own mechanism, which makes Git itself REFUSE
//      `worktree move`, `worktree remove` and `worktree prune` on that tree.
//
// The lease alone cannot stop a `git worktree remove` run by a tool that never
// reads PD state. The Git lock alone carries no writer identity and expires
// never. Together they cover both failure directions.
//
// Release is idempotent so a repeated `dev:worktree:release` (or a release after
// a crash-recovery unlock) is a no-op rather than an error.
//
// STALE_LOCK (SPEC §10.3): lease expired or absent while the Git lock is still
// held. That is a REPORTED state, never auto-corrected — if a writer silently
// died mid-task the worktree may hold uncommitted work, and unlocking it is the
// first step of destroying it. The recovery command is printed instead.

import { runGit } from './git.mjs';

export const LOCK_REASON_MAX = 200;

/** Sanitize a lock reason: one line, bounded, no control characters. */
export function normalizeLockReason(reason) {
  return String(reason || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, LOCK_REASON_MAX);
}

/** Standard reason string for a writer claim — keeps the lock self-describing. */
export function writerLockReason(writer, task) {
  return normalizeLockReason('writer=' + writer + ' task=' + task);
}

/**
 * `git worktree lock` is NOT idempotent. Measured on git 2.40.0 (Windows):
 *
 *   lock --reason A   (unlocked)  -> exit 0
 *   lock --reason A   (locked A)  -> exit 128  "fatal: '<path>' is already locked"
 *   lock --reason B   (locked A)  -> exit 128  (the reason is NOT updatable)
 *
 * So a re-claim by the same writer cannot simply call lock again. Callers must
 * inspect the existing lock and decide: same owner -> already asserted (success),
 * different owner -> a real conflict. Never unlock-then-lock to "make it work":
 * that opens a window in which the slot is unprotected.
 */
export const ALREADY_LOCKED_RE = /is already locked/i;

export function isAlreadyLockedError(message) {
  return ALREADY_LOCKED_RE.test(String(message || ''));
}

/**
 * Lock a worktree. Returns {ok:true} / {ok:false, error, alreadyLocked}.
 */
export async function lockWorktree({ cwd, path: worktreePath, reason }) {
  const args = ['worktree', 'lock'];
  const normalized = normalizeLockReason(reason);
  if (normalized.length > 0) args.push('--reason', normalized);
  args.push(worktreePath);
  try {
    await runGit(args, { cwd });
    return { ok: true };
  } catch (err) {
    const error = String((err && err.message) || err);
    return { ok: false, error, alreadyLocked: isAlreadyLockedError(error) };
  }
}

/**
 * Unlock a worktree. Idempotent: an already-unlocked worktree is a success, so
 * `dev:worktree:release` can be re-run safely.
 */
export async function unlockWorktree({ cwd, path: worktreePath }) {
  try {
    await runGit(['worktree', 'unlock', worktreePath], { cwd });
    return { ok: true, unlocked: true };
  } catch (err) {
    const message = String((err && err.message) || err);
    if (/is not locked|not locked/i.test(message)) return { ok: true, unlocked: false };
    return { ok: false, error: message };
  }
}

/**
 * Lock state of one worktree as reported by `git worktree list --porcelain`.
 * @returns {{locked: boolean, reason: string|null, prunable: boolean}}
 */
export function lockStateOf(worktreeEntry) {
  return {
    locked: Boolean(worktreeEntry?.locked),
    reason: worktreeEntry?.lockReason || null,
    prunable: Boolean(worktreeEntry?.prunable),
  };
}

/**
 * SPEC §10.3 classification. A lock whose writer artifact is gone is reported so
 * a human can decide; it is never unlocked automatically.
 *
 * @returns {{state: 'none'|'locked'|'stale', detail: string, nextAction: string|null}}
 */
export function classifyLockAgainstLease({ locked, leasePhase: phase, leaseOwner, path: worktreePath }) {
  if (!locked) return { state: 'none', detail: '', nextAction: null };
  if (phase === 'active') {
    return {
      state: 'locked',
      detail: 'locked by an ACTIVE writer' + (leaseOwner ? ' (' + leaseOwner + ')' : ''),
      nextAction: null,
    };
  }
  return {
    state: 'stale',
    detail: 'STALE_LOCK — the Git worktree lock is held but its writer lease is ' + (phase === 'expired' ? 'expired' : 'absent'),
    nextAction:
      'Confirm the writer is gone (check the process, and whether the worktree holds uncommitted work), then release explicitly:\n' +
      '      git worktree unlock "' + worktreePath + '"\n' +
      '      rm "' + worktreePath + '/.workspace-lease.json"   # if a stale lease file remains',
  };
}
