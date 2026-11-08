import fs from 'node:fs';
import path from 'node:path';
import { listWorktrees, normalizeGitPath, runGit } from './git.mjs';
import { readLeaseState } from './workspace-lifecycle.mjs';
import { removeResidueTree, REMOVAL_REASONS } from './residue-delete.mjs';

/** Re-read both halves of writer ownership immediately before a path mutation. */
async function ownershipError(cwd, worktreePath, stage) {
  const lease = readLeaseState(worktreePath);
  if (lease.phase === 'active' || lease.phase === 'invalid') {
    return {
      reasonCode: REMOVAL_REASONS.OWNERSHIP_CHANGED,
      reason: 'worktree lease became ' + lease.phase + ' ' + stage + (lease.owner ? ' (' + lease.owner + ')' : ''),
    };
  }

  let entries;
  try {
    entries = await listWorktrees(cwd);
  } catch (err) {
    return {
      reasonCode: REMOVAL_REASONS.OWNERSHIP_CHANGED,
      reason: 'could not re-read Git worktree ownership ' + stage + ': ' + String((err && err.message) || err),
    };
  }
  const entry = entries.find((item) => normalizeGitPath(item.path, cwd) === normalizeGitPath(worktreePath, cwd));
  if (!entry) {
    return {
      reasonCode: REMOVAL_REASONS.OWNERSHIP_CHANGED,
      reason: 'worktree is no longer registered ' + stage,
    };
  }
  if (entry.locked) {
    return {
      reasonCode: REMOVAL_REASONS.OWNERSHIP_CHANGED,
      reason: 'worktree became Git-locked ' + stage + (entry.lockReason ? ' (' + entry.lockReason + ')' : ''),
    };
  }
  return null;
}

/**
 * Remove an already-authorized, porcelain-clean worktree without giving Git a
 * recursive delete over a directory that can acquire a junction after preflight.
 *
 * The worktree is first renamed (not recursively traversed) into a unique
 * quarantine sibling. A no-follow filesystem walk deletes that private tree.
 * Git is then asked to remove only the now-absent worktree's admin metadata.
 *
 * The caller MUST hold the repository mutation lock for this entire operation.
 * MUTATION-GUARDED-HELPER: both callers invoke this function inside the same
 * withMutationLock() callback as the preflight and ownership checks.
 *
 * @param {{cwd: string, worktreePath: string, primaryPath: string,
 *          onProgress?: (p: object) => void,
 *          onQuarantined?: (quarantinePath: string) => void | Promise<void>}} opts
 * @returns {Promise<{ok: boolean, reason?: string, reasonCode?: string,
 *          quarantinePath?: string, restoredPath?: string, removal?: object,
 *          notes: string[]}>}
 */

export async function removeWorktreeSafely({ cwd, worktreePath, primaryPath, onProgress = null, onQuarantined = null }) {
  const notes = [];
  const beforeMoveError = await ownershipError(cwd, worktreePath, 'before quarantine move');
  if (beforeMoveError) return { ok: false, ...beforeMoveError, notes };
  // The earlier caller preflight can become stale even within the mutation
  // lock: non-cooperating writers may add a tracked or untracked file.
  const liveStatus = await runGit(['status', '--porcelain'], { cwd: worktreePath, allowFailure: true });
  if (liveStatus === null || liveStatus.trim().length > 0) {
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.OWNERSHIP_CHANGED,
      reason: 'worktree became dirty or unreadable immediately before quarantine move; unknown work preserved',
      notes,
    };
  }

  let quarantineParent;
  try {
    quarantineParent = fs.mkdtempSync(path.join(path.dirname(worktreePath), '.pd-worktree-cleanup-'));
  } catch (err) {
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED,
      reason: 'could not create a private quarantine sibling: ' + String((err && err.message) || err),
      notes,
    };
  }
  const quarantinePath = path.join(quarantineParent, 'worktree');
  const markerPath = path.join(quarantinePath, '.git');
  let markerContents = null;

  try {
    // git worktree move is a rename of the directory entry, not a recursive
    // delete. It isolates the tree from writers still using the original path.
    await runGit(['worktree', 'move', worktreePath, quarantinePath], { cwd });
  } catch (err) {
    try {
      if (!fs.existsSync(quarantinePath)) fs.rmdirSync(quarantineParent);
    } catch {
      /* retain the quarantine directory for inspection */
    }
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED,
      reason: 'could not move the worktree into quarantine: ' + String((err && err.message) || err),
      notes,
    };
  }

  const restore = async () => {
    if (!fs.existsSync(quarantinePath) || fs.existsSync(worktreePath)) return false;
    try {
      if (markerContents !== null && !fs.existsSync(markerPath)) {
        fs.writeFileSync(markerPath, markerContents, 'utf-8');
      }
      await runGit(['worktree', 'move', quarantinePath, worktreePath], { cwd });
      fs.rmdirSync(quarantineParent);
      return true;
    } catch {
      return false;
    }
  };

  if (onQuarantined) {
    // Test seam: simulate a non-cooperating writer creating a late junction.
    // Production callers never provide this callback.
    try {
      await onQuarantined(quarantinePath);
    } catch (err) {
      const restored = await restore();
      return { ok: false, reasonCode: REMOVAL_REASONS.REMOVAL_FAILED,
        reason: 'quarantine test hook failed: ' + String((err && err.message) || err),
        ...(restored ? { restoredPath: worktreePath } : { quarantinePath }), notes };
    }
  }

  if (fs.existsSync(worktreePath) || !fs.existsSync(quarantinePath)) {
    const restored = await restore();
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.OWNERSHIP_CHANGED,
      reason: 'worktree path changed unexpectedly during quarantine move',
      ...(restored ? { restoredPath: worktreePath } : { quarantinePath }),
      notes,
    };
  }

  try {
    const markerStat = fs.lstatSync(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
      throw new Error('worktree .git marker is not a regular file');
    }
    markerContents = fs.readFileSync(markerPath, 'utf-8');
    if (!/^\s*gitdir:/m.test(markerContents)) {
      throw new Error('worktree .git marker does not contain a gitdir pointer');
    }
    // Keep the marker contents in memory for rollback. The no-follow walker
    // can now remove the entire tree, and Git will only unregister absent metadata.
    fs.unlinkSync(markerPath);
  } catch (err) {
    const restored = await restore();
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED,
      reason: 'could not isolate the worktree gitdir marker before safe deletion: ' + String((err && err.message) || err),
      ...(restored ? { restoredPath: worktreePath } : { quarantinePath }),
      notes,
    };
  }

  const afterMoveError = await ownershipError(cwd, quarantinePath, 'before no-follow deletion');
  if (afterMoveError) {
    const restored = await restore();
    return {
      ok: false,
      ...afterMoveError,
      ...(restored ? { restoredPath: worktreePath } : { quarantinePath }),
      notes,
    };
  }

  const removal = removeResidueTree(quarantinePath, {
    primaryPath,
    onProgress: onProgress || undefined,
  });

  if (fs.existsSync(quarantinePath)) {
    const restored = await restore();
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED,
      reason: 'the no-follow deletion did not finish: ' + (removal.error || 'quarantine directory remains'),
      ...(restored ? { restoredPath: worktreePath } : { quarantinePath }),
      removal,
      notes,
    };
  }

  // The no-follow walk has removed the entire filesystem tree. --force here is
  // ONLY for clearing Git's now-stale admin record; the path is verified absent,
  // so Git has no directory it could recurse through.
  try {
    if (fs.existsSync(quarantinePath)) {
      throw new Error('quarantine path reappeared before Git metadata removal');
    }
    await runGit(['worktree', 'remove', '--force', quarantinePath], { cwd });
  } catch (err) {
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED_RESIDUE_SHELL,
      reason: 'filesystem tree is gone but Git could not unregister its quarantine worktree: ' + String((err && err.message) || err),
      quarantinePath,
      removal,
      notes,
    };
  }

  const remaining = await listWorktrees(cwd);
  if (remaining.some((entry) => normalizeGitPath(entry.path, cwd) === normalizeGitPath(quarantinePath, cwd))) {
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED_RESIDUE_SHELL,
      reason: 'Git still lists the quarantine worktree after metadata removal',
      quarantinePath,
      removal,
      notes,
    };
  }

  try {
    fs.rmdirSync(quarantineParent);
  } catch (err) {
    notes.push('empty quarantine parent could not be removed: ' + String((err && err.message) || err));
  }

  if (!removal.ok) {
    return {
      ok: false,
      reasonCode: removal.brokenTargets && removal.brokenTargets.length > 0
        ? REMOVAL_REASONS.EXTERNAL_TARGET_LOST
        : REMOVAL_REASONS.REMOVAL_FAILED,
      reason: removal.error || 'no-follow deletion reported an integrity anomaly',
      removedPath: worktreePath,
      removal,
      notes,
    };
  }

  return { ok: true, removedPath: worktreePath, removal, notes };
}
