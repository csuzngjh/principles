import fs from 'node:fs';
import path from 'node:path';
import { gitCommonDirAbsolute, listWorktrees, normalizeGitPath, runGit } from './git.mjs';
import { readLeaseState } from './workspace-lifecycle.mjs';
import { classifyReparsePoints, removeResidueTree, REMOVAL_REASONS } from './residue-delete.mjs';

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
 * Its exact Git admin directory is then resolved from the moved .git marker,
 * cross-checked against the admin directory's reverse gitdir pointer, and
 * removed with the same no-follow walker. No recursive Git deletion is used.
 *
 * The caller MUST hold the repository mutation lock for this entire operation.
 * MUTATION-GUARDED-HELPER: both callers invoke this function inside the same
 * withMutationLock() callback as the preflight and ownership checks.
 *
 * @param {{cwd: string, worktreePath: string, primaryPath: string,
 *          onProgress?: (p: object) => void,
 *          onQuarantined?: (quarantinePath: string) => void | Promise<void>,
 *          onTreeRemoved?: (worktreePath: string) => void | Promise<void>}} opts
 * @returns {Promise<{ok: boolean, reason?: string, reasonCode?: string,
 *          quarantinePath?: string, restoredPath?: string, removal?: object,
 *          notes: string[]}>}
 */

export async function removeWorktreeSafely({ cwd, worktreePath, primaryPath, onProgress = null, onQuarantined = null, onTreeRemoved = null }) {
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
      if (markerContents !== null) {
        // Exclusive creation is atomic: checking existsSync and then writing
        // would follow a Junction/symlink introduced in between and overwrite
        // a file outside this quarantine directory.
        let markerFd;
        try {
          markerFd = fs.openSync(markerPath, 'wx', 0o600);
        } catch (error) {
          if (error && error.code !== 'EEXIST') throw error;
        }
        if (markerFd !== undefined) {
          try {
            fs.writeFileSync(markerFd, markerContents, 'utf-8');
          } finally {
            fs.closeSync(markerFd);
          }
        }
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
    // Open one stable file descriptor and compare its identity with the
    // directory entry after reading. A path-based lstat-then-read can follow
    // a symlink swapped into place in between those separate operations.
    const markerFd = fs.openSync(markerPath, 'r');
    try {
      const opened = fs.fstatSync(markerFd);
      markerContents = fs.readFileSync(markerFd, 'utf-8');
      const named = fs.lstatSync(markerPath);
      if (!opened.isFile() || !named.isFile() || named.isSymbolicLink()
        || opened.dev !== named.dev || opened.ino !== named.ino) {
        throw new Error('worktree .git marker changed or is not a regular file');
      }
    } finally {
      fs.closeSync(markerFd);
    }
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

  if (onTreeRemoved) {
    // Test seam: model a non-cooperating process recreating the original path
    // after quarantine deletion but before branch cleanup is allowed to proceed.
    await onTreeRemoved(worktreePath);
  }

  // Remove ONLY the admin directory named by the moved .git marker. A
  // git worktree remove --force call, even against a path checked absent one
  // line earlier, would reopen a late-Junction race between that check and Git's
  // recursive delete. The reverse pointer proves this is the exact worktree
  // admin directory for our quarantine path, not another worktree's metadata.
  let adminDir;
  try {
    const markerLine = markerContents.split(/\r?\n/).find((line) => /^\s*gitdir:\s*/i.test(line));
    if (!markerLine) throw new Error('moved .git marker has no gitdir pointer');
    const rawAdminGitDir = markerLine.replace(/^\s*gitdir:\s*/i, '').trim();
    const commonDir = await gitCommonDirAbsolute(cwd);
    const commonStat = fs.lstatSync(commonDir);
    if (!commonStat.isDirectory() || commonStat.isSymbolicLink()) {
      throw new Error('repository Git common directory is not a real directory');
    }
    const canonicalCommonDir = fs.realpathSync.native(commonDir);
    const adminRoot = path.resolve(commonDir, 'worktrees');
    const adminRootStat = fs.lstatSync(adminRoot);
    if (!adminRootStat.isDirectory() || adminRootStat.isSymbolicLink()) {
      throw new Error('repository worktrees admin root is not a real directory (refusing to follow a junction/symlink)');
    }
    const canonicalAdminRoot = fs.realpathSync.native(adminRoot);
    const expectedAdminRoot = path.join(canonicalCommonDir, 'worktrees');
    if (normalizeGitPath(canonicalAdminRoot) !== normalizeGitPath(expectedAdminRoot)) {
      throw new Error('repository worktrees admin root resolves outside the canonical Git common directory');
    }
    const candidateAdminDir = path.resolve(path.dirname(markerPath), rawAdminGitDir);
    const relativeAdmin = path.relative(adminRoot, candidateAdminDir);
    if (!relativeAdmin || relativeAdmin === '..' || relativeAdmin.startsWith('..' + path.sep) || path.isAbsolute(relativeAdmin)) {
      throw new Error('gitdir pointer does not resolve to a child of the repository worktrees admin directory');
    }
    const candidateStat = fs.lstatSync(candidateAdminDir);
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
      throw new Error('worktree admin directory is not a real directory');
    }
    adminDir = fs.realpathSync.native(candidateAdminDir);
    const canonicalRelativeAdmin = path.relative(canonicalAdminRoot, adminDir);
    if (!canonicalRelativeAdmin || canonicalRelativeAdmin === '..' ||
      canonicalRelativeAdmin.startsWith('..' + path.sep) || path.isAbsolute(canonicalRelativeAdmin) ||
      canonicalRelativeAdmin.includes(path.sep)) {
      throw new Error('resolved worktree admin directory is not a direct child of the canonical admin root');
    }
    const adminGitDir = path.join(adminDir, 'gitdir');
    const adminGitDirStat = fs.lstatSync(adminGitDir);
    if (!adminGitDirStat.isFile() || adminGitDirStat.isSymbolicLink()) {
      throw new Error('worktree admin reverse gitdir pointer is not a regular file');
    }
    const reversePointer = fs.readFileSync(adminGitDir, 'utf-8').trim();
    if (normalizeGitPath(reversePointer) !== normalizeGitPath(markerPath)) {
      throw new Error('admin gitdir reverse pointer does not match the moved worktree marker');
    }
    const adminScan = classifyReparsePoints(adminDir);
    if (!adminScan.complete || adminScan.links > 0) {
      throw new Error('worktree admin directory contains unreadable entries or reparse points; refusing metadata deletion');
    }
    const metadataRemoval = removeResidueTree(adminDir, { primaryPath });
    if (!metadataRemoval.ok || fs.existsSync(adminDir)) {
      throw new Error(metadataRemoval.error || 'worktree admin directory remains after no-follow metadata removal');
    }
  } catch (err) {
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED_RESIDUE_SHELL,
      reason: 'filesystem tree is gone but its exact Git admin directory could not be safely removed: ' + String((err && err.message) || err),
      quarantinePath: adminDir || quarantinePath,
      removal,
      notes,
    };
  }

  const remaining = await listWorktrees(cwd);
  if (remaining.some((entry) => normalizeGitPath(entry.path, cwd) === normalizeGitPath(quarantinePath, cwd))) {
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED_RESIDUE_SHELL,
      reason: 'Git still lists the quarantine worktree after its admin directory was removed',
      quarantinePath: adminDir,
      removal,
      notes,
    };
  }

  try {
    fs.rmdirSync(quarantineParent);
  } catch (err) {
    notes.push('empty quarantine parent could not be removed: ' + String((err && err.message) || err));
  }

  // A non-cooperating writer can recreate the original pathname after the
  // atomic move. The worktree is no longer registered, so this is now an
  // unknown residue shell; callers MUST refuse branch deletion.
  if (fs.existsSync(worktreePath)) {
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED_RESIDUE_SHELL,
      reason: 'the original worktree path was recreated after quarantine removal; preserving it as an unknown residue shell and blocking branch deletion',
      removedPath: worktreePath,
      quarantinePath: worktreePath,
      removal,
      notes,
    };
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
