// Writer claim/release — the shared implementation behind
// `dev:worktree:claim` and `dev:worktree:release` (PRI-796, SPEC §10).
//
// One worktree slot, one current writer. Taking a slot performs BOTH halves of
// ownership:
//
//   PD write lease      -> other PD sessions see the write intent (git-9)
//   git worktree lock   -> git itself refuses move/remove/prune on the tree
//
// Releasing does both in reverse, idempotently, so a repeated release or a
// release after a crash-recovery unlock is a no-op instead of an error.
//
// WHY THE WHOLE TRANSITION RUNS UNDER THE REPO MUTATION MUTEX (round-2 review)
// Both halves must change together. A claim that interleaved with a release —
// old releaser between `git worktree unlock` and its lease unlink, successor
// claimant in between — could end in the forbidden half state "git lock = B,
// lease = none". `withMutationLock` serialises every ownership transition on
// the repository, so claim and release can never interleave; the transition
// is only the git lock/unlock plus one lease write (tens of milliseconds),
// never a build or an install. Lease release additionally passes the lease's
// own claimId, so even an actor that bypassed the mutex cannot silently delete
// a successor-era lease (it gets `ownership-changed` instead).
//
// WHY THE TASK, NOT THE PID, IS THE IDENTITY (SPEC §10.1 A)
// A task can be handed from WorkBuddy to Codex between sessions. If ownership
// were keyed on the process that claimed it, every CLI invocation would look
// like a new owner and a legitimate renewal would be reported as a conflict.
// Ownership is therefore `<writer>:<task>`; pid and host ride along as debug
// metadata only.

import path from 'node:path';
import os from 'node:os';
import { getGitContext, gitCommonDirAbsolute, listWorktrees, normalizeGitPath } from './git.mjs';
import {
  DEFAULT_TTL_MS,
  acquireLease,
  composeWriterOwner,
  isValidWriter,
  leaseFilePath,
  leasePhase,
  readLease,
  releaseLease,
  WRITER_LABELS,
} from './workspace-lease.mjs';
import { lockWorktree, unlockWorktree, writerLockReason } from './worktree-lock.mjs';
import { taskIdentityFromBranch } from './worktree-root.mjs';
import { withMutationLock } from './git-mutation-lock.mjs';

export const PRIMARY_OVERRIDE_ENV = 'PD_DEV_WORKTREE_ALLOW_PRIMARY';

/**
 * Resolve the worktree slot a claim/release targets.
 * @param {{target?: string|null, cwd?: string}} opts
 */
export async function resolveSlot({ target = null, cwd = process.cwd() } = {}) {
  const base = target ? path.resolve(target) : path.resolve(cwd);
  const ctx = await getGitContext(base);
  const root = ctx.toplevel || ctx.cwd;
  return {
    root,
    gitCwd: base,
    // The repo mutation arena lives in the SHARED git dir — the exact place
    // the claim/release transition must be serialised against.
    commonDir: await gitCommonDirAbsolute(base),
    branch: ctx.branch,
    task: taskIdentityFromBranch(ctx.branch),
    isPrimary: ctx.isPrimary,
  };
}

/**
 * Claim a slot for `writer`.
 *
 * Ordering (lock-before-lease, under the repo mutation mutex): the GIT
 * worktree lock is taken FIRST — it is the only primitive Git serialises
 * atomically — and the lease is written only after it succeeds. A failed
 * lease therefore rolls back OUR fresh lock; a failed lock leaves no lease of
 * ours behind. Neither interleaves with a straggler release, because the
 * whole transition runs under `withMutationLock` (see header note).
 *
 * @returns {{ok: true, action: string, owner: string, lease: object, lock: object} |
 *           {ok: false, code: string, error: string, nextAction: string}}
 */
export async function claimWriter({ slot, writer, ttlMs = DEFAULT_TTL_MS, now = Date.now(), env = process.env }) {
  if (!isValidWriter(writer)) {
    return {
      ok: false,
      code: 'ENVIRONMENT_INVALID',
      error: "unknown writer label '" + String(writer) + "'.",
      nextAction: 'Pass --writer with one of: ' + WRITER_LABELS.join(', '),
    };
  }
  if (slot.isPrimary && env[PRIMARY_OVERRIDE_ENV] !== '1') {
    return {
      ok: false,
      code: 'ENVIRONMENT_INVALID',
      error:
        'This is the PRIMARY checkout (' + slot.root + ') — the repository control plane. ' +
        'Claiming it as a task slot would defeat git-3.',
      nextAction:
        'Create a task worktree instead: npm run dev:worktree -- <task> <slug>. ' +
        'Human emergency override: ' + PRIMARY_OVERRIDE_ENV + '=1 (AI agents must never set this).',
    };
  }
  if (!slot.task) {
    return {
      ok: false,
      code: 'ENVIRONMENT_INVALID',
      error: "this checkout is on branch '" + slot.branch + "', which is not a task branch (ai/<task>).",
      nextAction: 'Claim only task worktrees. Create one with: npm run dev:worktree -- <task> <slug>',
    };
  }

  const owner = composeWriterOwner(writer, slot.task);
  const expectedReason = writerLockReason(writer, slot.task);

  try {
    return await withMutationLock(
      { commonDir: slot.commonDir, operation: 'writer-claim', target: slot.root },
      () => claimTransition({ slot, writer, owner, expectedReason, ttlMs, now })
    );
  } catch (err) {
    if (err && err.code === 'GIT_MUTATION_LOCKED') {
      return {
        ok: false,
        code: 'GIT_MUTATION_LOCKED',
        error: 'another writer transition or git-metadata mutation is running — claim refused:\n' + String(err.message),
        nextAction:
          'Retry the claim in a moment: the mutex window is only the git lock + one lease write. ' +
          'If you confirmed the named holder is gone, a human may remove ONLY that holder\'s owner record.',
      };
    }
    throw err;
  }
}

/** The claim itself — only ever run inside claimWriter's withMutationLock span. */
async function claimTransition({ slot, writer, owner, expectedReason, ttlMs, now }) {
  // PRI-796 (review): the GIT worktree lock is taken FIRST. It is the only
  // primitive here that Git serialises atomically. Previously both claimants
  // could read the same expired lease, both overwrite the lease file, and only
  // then discover at the lock step that one lost — the loser's rollback then
  // deleted the WINNER's lease unconditionally (git lock held, lease gone).
  // With lock-before-lease exactly one claimant ever reaches the lease write,
  // and a failed lock leaves no lease of ours to roll back.
  const lock = await lockWorktree({ cwd: slot.gitCwd, path: slot.root, reason: expectedReason });
  let reasserted = false;
  if (!lock.ok) {
    const existing = await currentLockReason(slot);
    // `git worktree lock` refuses an already-locked worktree (see
    // worktree-lock.mjs). For the SAME writer that is a renewal, not a
    // conflict — the re-assert is an idempotent no-op because the lock already
    // names exactly this writer/task.
    if (!(lock.alreadyLocked && existing === expectedReason)) {
      if (lock.alreadyLocked) {
        return {
          ok: false,
          code: 'CHECK_FAILED',
          error:
            'the worktree carries a FOREIGN git lock, so no lease was written:\n' +
            '    existing: ' + (existing || '(no reason recorded)') + '\n' +
            '    wanted:   ' + expectedReason,
          nextAction:
            'Another writer (or a previous session) holds this slot. Inspect it with `npm run dev:workspace:snapshot`; ' +
            'if its writer is gone, release deliberately: npm run dev:worktree:release -- "' + slot.root + '". ' +
            'This tool never unlocks a foreign claim.',
        };
      }
      return {
        ok: false,
        code: 'CHECK_FAILED',
        error: '`git worktree lock` failed, so no lease was written:\n' + lock.error,
        nextAction: 'Resolve the git error above and retry. Run `git worktree list` to check for a conflicting lock.',
      };
    }
    reasserted = true;
  }

  const lease = acquireLease(slot.root, {
    owner,
    branch: slot.branch,
    ttlMs,
    now,
    writer: {
      label: writer,
      task: slot.task,
      // Debug metadata only — never used to decide ownership (SPEC §10.1 A).
      pid: process.pid,
      host: os.hostname() || 'unknown-host',
      claimedVia: 'dev:worktree:claim',
    },
  });
  if (!lease.ok) {
    // We hold the git lock but the lease refuses — an ACTIVE foreign lease
    // under a free git lock (a half-migrated tree). Undo OUR lock so no
    // orphan claim remains; a REASSERTED lock predates this call and is ours,
    // so it stays.
    if (!reasserted) {
      try { await unlockWorktree({ cwd: slot.gitCwd, path: slot.root }); } catch { /* best effort — the conflict result below is the point */ }
    }
    return { ok: false, code: 'CHECK_FAILED', error: lease.error, nextAction: lease.nextAction, conflict: lease.conflict };
  }

  return {
    ok: true,
    action: reasserted ? 'renewed' : lease.action,
    owner,
    lease: lease.lease,
    lock: { locked: true, reason: expectedReason, ...(reasserted ? { reasserted: true } : {}) },
  };
}

/** Live lock reason for the slot, or null when it is not locked. */
async function currentLockReason(slot) {
  try {
    const listed = await listWorktrees(slot.gitCwd);
    const entry = listed.find((w) => normalizeGitPath(w.path, slot.gitCwd) === normalizeGitPath(slot.root, slot.gitCwd));
    return entry && entry.locked ? entry.lockReason || '' : null;
  } catch {
    return null;
  }
}

/**
 * Release a slot. Idempotent: releasing an unclaimed slot succeeds and reports
 * that nothing needed to change.
 *
 * Callers must have resolved the slot through resolveSlot(), which requires a
 * resolvable git worktree — deliberately. For a broken worktree shell the lease
 * file is the ONLY surviving record of which task branch the directory belonged
 * to, so there is no safe way to "release" it, and the CLI refuses rather than
 * destroying that evidence.
 */
export async function releaseWriter({ slot, cwd = slot?.gitCwd }) {
  try {
    return await withMutationLock(
      { commonDir: slot.commonDir, operation: 'writer-release', target: slot.root },
      () => releaseTransition({ slot, cwd })
    );
  } catch (err) {
    if (err && err.code === 'GIT_MUTATION_LOCKED') {
      return {
        ok: false,
        code: 'GIT_MUTATION_LOCKED',
        error: 'another writer transition or git-metadata mutation is running — release refused:\n' + String(err.message),
        nextAction: 'Retry the release in a moment: the mutex window is only a git unlock + one lease unlink.',
      };
    }
    throw err;
  }
}

/** The release itself — only ever run inside releaseWriter's withMutationLock span. */
async function releaseTransition({ slot, cwd }) {
  // Read the CURRENT lease inside the transition: the claimId we release
  // against is the one that exists now, so a successor-era lease (a different
  // claimId) can never be unlinked by this call, even by a stray actor.
  const lease = readLease(slot.root);
  const phase = lease.exists && lease.valid ? leasePhase(lease.lease) : lease.exists ? 'invalid' : 'none';
  const previousOwner = lease.exists && lease.valid ? lease.lease.owner : null;
  const expectedClaimId = lease.exists && lease.valid ? lease.lease.claimId : undefined;

  const unlock = await unlockWorktree({ cwd: cwd || slot.root, path: slot.root });
  if (!unlock.ok) {
    return {
      ok: false,
      code: 'CHECK_FAILED',
      error: 'git worktree unlock failed: ' + unlock.error,
      nextAction: 'Inspect with `git worktree list`, then retry or unlock manually: git worktree unlock "' + slot.root + '"',
    };
  }

  const released = releaseLease(slot.root, { expectedClaimId });
  return {
    ok: true,
    owner: previousOwner,
    leaseStateBefore: phase,
    leaseRemoved: released.removed,
    ...(released.reason ? { leaseRelease: released.reason } : {}),
    gitUnlocked: unlock.unlocked,
    leaseFile: leaseFilePath(slot.root),
  };
}
