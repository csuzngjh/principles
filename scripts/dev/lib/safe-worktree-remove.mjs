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
 * Open a marker without following a symlink/reparse point and prove that the
 * opened file is still the regular file named by the path. O_NONBLOCK prevents
 * a malicious FIFO from hanging the cleanup process on POSIX.
 */
function readRegularFileNoFollow(filePath) {
  const flags = fs.constants.O_RDONLY
    | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  const fd = fs.openSync(filePath, flags);
  try {
    const opened = fs.fstatSync(fd);
    const named = fs.lstatSync(filePath);
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink()
      || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new Error('marker changed or is not a regular file');
    }
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolve Git's reverse gitdir pointer, which may be relative to adminDir. */
export function resolveAdminReversePointer(adminDir, reversePointer) {
  return path.isAbsolute(reversePointer)
    ? path.resolve(reversePointer)
    : path.resolve(adminDir, reversePointer);
}

/**
 * Accept only worktree deletions that were produced by the caller's verified
 * reparse-point detach pass. Any other staged, unstaged or untracked change
 * remains a hard refusal.
 */
function statusContainsOnlyExpectedLinkDeletions(status, worktreePath, expectedDeletedPaths) {
  if (status === null) return false;
  const expected = new Set(expectedDeletedPaths.map((item) => normalizeGitPath(item)));
  if (status.length === 0) return true;
  const records = status.split('\0').filter(Boolean);
  for (const record of records) {
    // Porcelain-v1 -z records are "XY PATH\\0". The only mutation generated
    // by unlinking a tracked symlink is an unstaged deletion (" D").
    if (record.slice(0, 2) !== ' D') return false;
    const relativePath = record.slice(3);
    if (!expected.has(normalizeGitPath(path.resolve(worktreePath, relativePath)))) return false;
  }
  return true;
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
 *          onTreeRemoved?: (worktreePath: string) => void | Promise<void>,
 *          expectedDeletedPaths?: string[],
 *          runGitCommand?: typeof runGit}} opts
 * @returns {Promise<{ok: boolean, reason?: string, reasonCode?: string,
 *          quarantinePath?: string, restoredPath?: string, removal?: object,
 *          notes: string[]}>}
 */

export async function removeWorktreeSafely({
  cwd, worktreePath, primaryPath, onProgress = null, onQuarantined = null, onTreeRemoved = null,
  expectedDeletedPaths = [], runGitCommand = runGit,
}) {
  const notes = [];
  // Never use the target worktree as the Git process cwd after it is moved.
  // The primary checkout is the stable control plane for all post-quarantine
  // ownership checks, rollback commands and metadata reads.
  const gitCwd = path.resolve(primaryPath || cwd);
  const beforeMoveError = await ownershipError(gitCwd, worktreePath, 'before quarantine move');
  if (beforeMoveError) return { ok: false, ...beforeMoveError, notes };
  // The earlier caller preflight can become stale even within the mutation
  // lock: non-cooperating writers may add a tracked or untracked file.
  const liveStatus = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreePath, allowFailure: true });
  if (!statusContainsOnlyExpectedLinkDeletions(liveStatus, worktreePath, expectedDeletedPaths)) {
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
    await runGitCommand(['worktree', 'move', worktreePath, quarantinePath], { cwd: gitCwd });
  } catch (err) {
    let restoredPath = null;
    let preservedQuarantine = null;
    let quarantineStat = null;
    try {
      quarantineStat = fs.lstatSync(quarantinePath);
    } catch {
      /* no partial directory rename occurred */
    }
    if (quarantineStat && quarantineStat.isDirectory() && !quarantineStat.isSymbolicLink()
      && !fs.existsSync(worktreePath)) {
      // Git may have renamed the directory but failed while updating its
      // administrative pointers. Only attempt rollback when Git itself still
      // recognizes the quarantine path as this registered worktree.
      try {
        const registered = await listWorktrees(gitCwd);
        const quarantineEntry = registered.find(
          (entry) => normalizeGitPath(entry.path, gitCwd) === normalizeGitPath(quarantinePath, gitCwd)
        );
        if (quarantineEntry && !quarantineEntry.locked) {
          await runGitCommand(['worktree', 'move', quarantinePath, worktreePath], { cwd: gitCwd });
          if (fs.existsSync(worktreePath) && !fs.existsSync(quarantinePath)) {
            restoredPath = worktreePath;
            fs.rmdirSync(quarantineParent);
          }
        }
      } catch (restoreError) {
        notes.push('partial quarantine move could not be safely rolled back: ' + String((restoreError && restoreError.message) || restoreError));
      }
      if (!restoredPath && fs.existsSync(quarantinePath)) {
        preservedQuarantine = quarantinePath;
        notes.push('preserved partially moved worktree for manual recovery at ' + quarantinePath);
      }
    } else {
      try {
        if (!quarantineStat) fs.rmdirSync(quarantineParent);
      } catch {
        /* retain the quarantine directory for inspection */
      }
    }
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED,
      reason: 'could not move the worktree into quarantine: ' + String((err && err.message) || err) +
        (preservedQuarantine ? '; worktree preserved at ' + preservedQuarantine : ''),
      ...(restoredPath ? { restoredPath } : {}),
      ...(preservedQuarantine ? { quarantinePath: preservedQuarantine } : {}),
      notes,
    };
  }

  const restore = async () => {
    if (!fs.existsSync(quarantinePath) || fs.existsSync(worktreePath)) return false;
    try {
      // Without the original marker bytes there is no safe rollback authority.
      // Never ask Git to move a quarantine whose .git entry failed no-follow
      // validation: Git may follow a substituted link and overwrite another
      // worktree's metadata.
      if (markerContents === null) {
        throw new Error('original .git marker was not captured; preserving quarantine');
      }
      // Exclusive creation is atomic: checking existsSync and then writing
      // would follow a Junction/symlink introduced in between and overwrite
      // a file outside this quarantine directory.
      let markerFd;
      try {
        markerFd = fs.openSync(markerPath, 'wx', 0o600);
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        // EEXIST is not proof that a safe marker already exists. In
        // particular, never let Git follow an attacker-supplied .git symlink
        // while moving the quarantine back into the registered worktree.
        const existingMarker = readRegularFileNoFollow(markerPath);
        if (existingMarker !== markerContents) {
          throw new Error('existing quarantine .git marker does not match the original marker; preserving quarantine');
        }
      }
      if (markerFd !== undefined) {
        try {
          fs.writeFileSync(markerFd, markerContents, 'utf-8');
        } finally {
          fs.closeSync(markerFd);
        }
      }
      await runGitCommand(['worktree', 'move', quarantinePath, worktreePath], { cwd: gitCwd });
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
    markerContents = readRegularFileNoFollow(markerPath);
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

  const afterMoveError = await ownershipError(gitCwd, quarantinePath, 'before no-follow deletion');
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
    const commonDir = await gitCommonDirAbsolute(gitCwd);
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
    // Open one stable file descriptor and compare its identity with the
    // directory entry after reading. A path-based lstat-then-read can follow a
    // symlink swapped into place in between those separate operations.
    let reversePointer;
    const pointerFd = fs.openSync(adminGitDir, 'r');
    try {
      const opened = fs.fstatSync(pointerFd);
      reversePointer = fs.readFileSync(pointerFd, 'utf-8').trim();
      const named = fs.lstatSync(adminGitDir);
      if (!opened.isFile() || !named.isFile() || named.isSymbolicLink()
        || opened.dev !== named.dev || opened.ino !== named.ino) {
        throw new Error('worktree admin reverse gitdir pointer changed or is not a regular file');
      }
    } finally {
      fs.closeSync(pointerFd);
    }
    const resolvedReversePointer = resolveAdminReversePointer(adminDir, reversePointer);
    if (normalizeGitPath(resolvedReversePointer) !== normalizeGitPath(markerPath)) {
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
      ...(adminDir ? { adminDirPath: adminDir, residueKind: 'git-admin-directory' } : {}),
      removal,
      notes,
    };
  }

  const remaining = await listWorktrees(gitCwd);
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
