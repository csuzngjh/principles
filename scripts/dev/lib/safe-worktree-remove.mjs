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
export function resolveAdminReversePointer(adminDir, reversePointer, { markerDir = null } = {}) {
  return path.isAbsolute(reversePointer)
    ? path.resolve(reversePointer)
    : path.resolve(markerDir || adminDir, reversePointer);
}

/**
 * Read a worktree's index and return the paths of initialized submodules:
 * entries recorded as gitlinks (mode 160000) whose checkout actually contains
 * a .git entry. Git refuses `git worktree move` for such worktrees outright
 * ("working trees containing submodules cannot be moved or removed"), so the
 * quarantine move must be performed as a manual rename plus an admin-gitdir
 * retarget for them. Unreadable index output is a hard refusal — submodule
 * presence cannot be proven either way (fail-closed).
 *
 * @returns {Promise<string[]>} submodule paths (relative to the worktree)
 */
async function findInitializedSubmodules(worktreePath, runGitCommand) {
  const stage = await runGitCommand(['ls-files', '--stage', '-z'], { cwd: worktreePath, allowFailure: true });
  if (stage === null) {
    throw new Error('could not enumerate the worktree index; submodule presence cannot be proven');
  }
  const submodules = [];
  for (const record of stage.split('\0').filter(Boolean)) {
    const meta = record.slice(0, record.indexOf('\t'));
    const subPath = record.slice(record.indexOf('\t') + 1);
    if (meta.split(' ')[0] !== '160000') continue;
    if (fs.existsSync(path.join(worktreePath, subPath, '.git'))) {
      submodules.push(subPath);
    }
  }
  return submodules;
}

/**
 * The manual quarantine move for worktrees Git refuses to move: an atomic
 * rename of the directory entry, then an equally atomic rewrite of the exact
 * admin directory's reverse gitdir pointer. Both directions are identity-
 * verified before the pointer rewrite: the admin directory must be a direct
 * child of the canonical `<commonDir>/worktrees` root, and its CURRENT
 * reverse pointer must name this worktree's original .git marker — proving
 * the metadata belongs to THIS worktree before this helper touches it.
 *
 * @returns {Promise<string>} the admin directory that was retargeted
 */
async function moveWorktreeIntoQuarantineManually({ worktreePath, quarantinePath, markerPath, commonDir, submodules }) {
  const markerBefore = readRegularFileNoFollow(path.join(worktreePath, '.git'));
  fs.renameSync(worktreePath, quarantinePath);
  let submoduleRollbackEntries = [];
  let adminDir = null;
  try {
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
    const markerLine = markerBefore.split(/\r?\n/).find((line) => /^\s*gitdir:\s*/i.test(line));
    if (!markerLine) throw new Error('worktree .git marker has no gitdir pointer');
    const rawAdminGitDir = markerLine.replace(/^\s*gitdir:\s*/i, '').trim();
    const candidate = path.resolve(path.dirname(markerPath), rawAdminGitDir);
    const candidateStat = fs.lstatSync(candidate);
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
      throw new Error('worktree admin directory is not a real directory');
    }
    adminDir = fs.realpathSync.native(candidate);
    const canonicalRelative = path.relative(canonicalAdminRoot, adminDir);
    if (!canonicalRelative || canonicalRelative === '..' || canonicalRelative.startsWith('..' + path.sep)
      || path.isAbsolute(canonicalRelative) || canonicalRelative.includes(path.sep)) {
      throw new Error('resolved worktree admin directory is not a direct child of the canonical admin root');
    }
    const pointerFile = path.join(adminDir, 'gitdir');
    const current = readRegularFileNoFollow(pointerFile);
    // Git writes the pointer in slash form on Windows; compare separators the
    // way the rest of this module does.
    if (normalizeGitPath(current.trim()) !== normalizeGitPath(path.join(worktreePath, '.git'))) {
      throw new Error('admin reverse pointer does not name this worktree; refusing to retarget it');
    }
    // Atomic pointer rewrite: same-directory temp + rename over the target.
    // The pointer uses git's own slash form on Windows: `git worktree list`
    // resolves the worktree path from this file, and a backslash form would
    // make the quarantine entry unresolvable for the ownership re-check.
    const pointerValue = markerPath.split(path.sep).join('/') + '\n';
    const temp = path.join(adminDir, 'gitdir.pd-retarget-' + process.pid + '-' + Math.random().toString(36).slice(2));
    fs.writeFileSync(temp, pointerValue, 'utf-8');
    fs.renameSync(temp, pointerFile);
    if (normalizeGitPath(readRegularFileNoFollow(pointerFile).trim()) !== normalizeGitPath(markerPath)) {
      throw new Error('admin reverse pointer retarget did not stick');
    }
    // Keep the quarantined worktree SELF-CONSISTENT: re-anchor the submodule
    // admin entries that belong to this worktree so `git status` inside the
    // quarantine still works for the post-move writer-detection check.
    const { notes: submoduleNotes, rollbackEntries } = retargetSubmodulesForQuarantine({
      parentAdminDir: adminDir, commonDir, worktreePath, quarantinePath, submodules,
    });
    submoduleRollbackEntries = rollbackEntries;
    return { adminDir, submoduleNotes, submoduleRollbackEntries };
  } catch (err) {
    // Roll the whole manual move back before reporting the failure: the rename
    // is reversed first, then the reverse pointer is restored so Git keeps
    // listing the worktree at its ORIGINAL path.
    try {
      if (fs.existsSync(quarantinePath) && !fs.existsSync(worktreePath)) {
        fs.renameSync(quarantinePath, worktreePath);
        if (adminDir) {
          const pointerFile = path.join(adminDir, 'gitdir');
          const temp = path.join(adminDir, 'gitdir.pd-restore-' + process.pid + '-' + Math.random().toString(36).slice(2));
          fs.writeFileSync(temp, path.join(worktreePath, '.git').split(path.sep).join('/') + '\n', 'utf-8');
          fs.renameSync(temp, pointerFile);
        }
        // Revert any already-anchored submodule entries best-effort: the
        // retarget helper attaches them to the error when it throws midway.
        const pendingReverts = submoduleRollbackEntries.length > 0
          ? submoduleRollbackEntries
          : (err.submoduleRollbackEntries || []);
        for (const revert of [...pendingReverts].reverse()) {
          try {
            revert();
          } catch (revertError) {
            err.partialMoveNote = (err.partialMoveNote ? err.partialMoveNote + ' ' : '') +
              'submodule rollback entry failed: ' + String((revertError && revertError.message) || revertError);
          }
        }
      }
    } catch (rollbackError) {
      err.partialMoveNote = 'manual quarantine move could not be rolled back: ' +
        String((rollbackError && rollbackError.message) || rollbackError);
    }
    throw err;
  }
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
 * Atomic same-directory write: temp file + rename over the target.
 */
function writeAtomic(filePath, contents) {
  const temp = path.join(
    path.dirname(filePath),
    path.basename(filePath) + '.pd-retarget-' + process.pid + '-' + Math.random().toString(36).slice(2)
  );
  fs.writeFileSync(temp, contents, 'utf-8');
  fs.renameSync(temp, filePath);
}

/** True when `candidate` is `root` itself or lives underneath it (lexical). */
function isWithinRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/**
 * Re-anchor a worktree's initialized submodules for the quarantine rename.
 * Two admin layouts exist (probed on git 2.40, Windows):
 *  - PER-WORKTREE admin: `<parentAdminDir>/modules/<name>`, referenced by a
 *    RELATIVE pointer in the submodule marker that is only valid at the
 *    ORIGINAL worktree position, with the checkout location recorded as
 *    core.worktree in that admin's config;
 *  - SHARED admin: `<commonDir>/modules/<name>/worktrees/<id>` with a gitdir
 *    reverse pointer naming the submodule marker.
 * The working tree moved; every pointer naming the old position must be
 * re-anchored or `git status` inside the quarantine fails outright ("not a
 * git repository"), which would blind the post-move writer-detection check.
 * Only entries proven to belong to THIS worktree are touched; every rewritten
 * byte is captured so the rollback can restore the exact original state.
 *
 * @returns {{notes: string[], rollbackEntries: Array<Function>}}
 */
function retargetSubmodulesForQuarantine({ parentAdminDir, commonDir, worktreePath, quarantinePath, submodules }) {
  const notes = [];
  const rollbackEntries = [];
  if (!submodules || submodules.length === 0) return { notes, rollbackEntries };
  const modulesRoot = path.resolve(commonDir, 'modules');
  let canonicalModulesRoot = null;
  try {
    const modulesRootStat = fs.lstatSync(modulesRoot);
    if (modulesRootStat.isDirectory() && !modulesRootStat.isSymbolicLink()) {
      canonicalModulesRoot = fs.realpathSync.native(modulesRoot);
    }
  } catch {
    /* no shared modules area: every submodule must be per-worktree then */
  }
  for (const subPath of submodules) {
    try {
      const markerFile = path.join(quarantinePath, subPath, '.git');
      const markerBytes = readRegularFileNoFollow(markerFile);
      const markerLine = markerBytes.split(/\r?\n/).find((line) => /^\s*gitdir:\s*/i.test(line));
      if (!markerLine) throw new Error('submodule .git marker for ' + subPath + ' has no gitdir pointer');
      const rawPointer = markerLine.replace(/^\s*gitdir:\s*/i, '').trim();
      // A relative pointer is defined against the ORIGINAL marker position.
      const candidate = path.resolve(worktreePath, subPath, rawPointer);
      const candidateStat = fs.lstatSync(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        throw new Error('submodule admin directory for ' + subPath + ' is not a real directory');
      }
      const adminDir = fs.realpathSync.native(candidate);
      if (isWithinRoot(parentAdminDir, adminDir)) {
        // Per-worktree layout: the marker pointer and core.worktree are private
        // to this worktree (the whole admin subtree dies with it later).
        const configFile = path.join(adminDir, 'config');
        const configBytes = readRegularFileNoFollow(configFile);
        if (!/^(\s*)worktree\s*=/m.test(configBytes)) {
          throw new Error('per-worktree submodule config for ' + subPath + ' has no core.worktree entry');
        }
        const absAdmin = adminDir.split(path.sep).join('/');
        const absCheckout = path.join(quarantinePath, subPath).split(path.sep).join('/');
        writeAtomic(markerFile, 'gitdir: ' + absAdmin + '\n');
        writeAtomic(configFile, configBytes.replace(/^(\s*)worktree\s*=.*$/m, '$1worktree = ' + absCheckout));
        rollbackEntries.push(() => {
          writeAtomic(markerFile, markerBytes);
          writeAtomic(configFile, configBytes);
        });
        notes.push('re-anchored per-worktree submodule admin for ' + subPath);
      } else if (canonicalModulesRoot && isWithinRoot(canonicalModulesRoot, adminDir)) {
        // Shared layout: rewrite the admin entry's gitdir reverse pointer, but
        // only when it currently names THIS worktree's submodule marker.
        const pointerFile = path.join(adminDir, 'gitdir');
        const current = readRegularFileNoFollow(pointerFile);
        if (normalizeGitPath(current.trim()) !== normalizeGitPath(path.join(worktreePath, subPath, '.git'))) {
          throw new Error('shared submodule admin pointer for ' + subPath + ' does not name this worktree; refusing to retarget it');
        }
        const target = path.join(quarantinePath, subPath, '.git').split(path.sep).join('/') + '\n';
        writeAtomic(pointerFile, target);
        rollbackEntries.push(() => {
          writeAtomic(pointerFile, current);
        });
        notes.push('re-anchored shared submodule admin pointer for ' + subPath);
      } else {
        throw new Error('submodule admin directory for ' + subPath +
          ' resolves outside both this worktree admin dir and the repository modules area; refusing to quarantine');
      }
    } catch (err) {
      // Attach what was already re-anchored so the caller's rollback can
      // restore the exact original bytes before unwinding.
      err.submoduleRollbackEntries = rollbackEntries;
      throw err;
    }
  }
  return { notes, rollbackEntries };
}

/**
 * Complete a rollback move manually: rename the quarantine back to the
 * original path, then retarget the admin reverse pointer. Used when Git
 * refuses to move the worktree itself (submodule worktrees, or markers whose
 * relative gitdir pointer fails Git's own move-time validation) — never as a
 * blind rename. The admin directory is derived from the captured marker bytes
 * anchored at the ORIGINAL worktree path (the position a relative pointer is
 * defined against), then proven to be OURS via its own reverse pointer, which
 * must name the quarantined marker exactly.
 */
async function manualMoveBack({ worktreePath, quarantinePath, markerPath, markerContents, gitCwd, submoduleRollbackEntries = [] }) {
  const markerLine = markerContents.split(/\r?\n/).find((line) => /^\s*gitdir:\s*/i.test(line));
  if (!markerLine) throw new Error('captured .git marker has no gitdir pointer');
  const rawAdminGitDir = markerLine.replace(/^\s*gitdir:\s*/i, '').trim();
  // Absolute pointers resolve to themselves; relative pointers anchor at the
  // ORIGINAL worktree position, which is the only base that makes them valid.
  const candidate = path.resolve(worktreePath, rawAdminGitDir);
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
  if (normalizeGitPath(canonicalAdminRoot) !== normalizeGitPath(path.join(canonicalCommonDir, 'worktrees'))) {
    throw new Error('repository worktrees admin root resolves outside the canonical Git common directory');
  }
  const candidateStat = fs.lstatSync(candidate);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
    throw new Error('worktree admin directory is not a real directory');
  }
  const adminDir = fs.realpathSync.native(candidate);
  const canonicalRelative = path.relative(canonicalAdminRoot, adminDir);
  if (!canonicalRelative || canonicalRelative === '..' || canonicalRelative.startsWith('..' + path.sep)
    || path.isAbsolute(canonicalRelative) || canonicalRelative.includes(path.sep)) {
    throw new Error('resolved worktree admin directory is not a direct child of the canonical admin root');
  }
  const pointerFile = path.join(adminDir, 'gitdir');
  const current = readRegularFileNoFollow(pointerFile);
  if (normalizeGitPath(current.trim()) !== normalizeGitPath(markerPath)) {
    throw new Error('admin reverse pointer does not name the quarantined marker; refusing to complete the rollback');
  }
  fs.renameSync(quarantinePath, worktreePath);
  const temp = path.join(adminDir, 'gitdir.pd-restore-' + process.pid + '-' + Math.random().toString(36).slice(2));
  fs.writeFileSync(temp, path.join(worktreePath, '.git').split(path.sep).join('/') + '\n', 'utf-8');
  fs.renameSync(temp, pointerFile);
  // Revert every submodule re-anchor with the captured original bytes, so a
  // restored worktree keeps working submodules. A failed revert is reported
  // but does not undo the restore itself.
  const submoduleNotes = [];
  for (const revert of [...submoduleRollbackEntries].reverse()) {
    try {
      revert();
    } catch (err) {
      submoduleNotes.push('submodule rollback entry failed: ' + String((err && err.message) || err));
    }
  }
  return submoduleNotes;
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
  // Git refuses to move worktrees that contain initialized submodules, so such
  // worktrees take the manual rename + admin-retarget path. The choice also
  // decides which mechanism every rollback uses.
  let movedManually = false;
  let initializedSubmodules = [];
  let submoduleRollbackEntries = [];
  try {
    initializedSubmodules = await findInitializedSubmodules(worktreePath, runGitCommand);
    movedManually = initializedSubmodules.length > 0;
  } catch (err) {
    try {
      fs.rmdirSync(quarantineParent);
    } catch {
      /* retain for inspection */
    }
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED,
      reason: 'could not prove the worktree is submodule-free before quarantine: ' + String((err && err.message) || err),
      notes,
    };
  }

  try {
    if (movedManually) {
      // Manual quarantine move: atomic rename + verified parent and submodule
      // admin retargets. The helper rolls itself back (rename back + pointer
      // restore) when a retarget fails, and rethrows.
      const moved = await moveWorktreeIntoQuarantineManually({
        worktreePath, quarantinePath, markerPath,
        submodules: initializedSubmodules,
        commonDir: await gitCommonDirAbsolute(gitCwd),
      });
      submoduleRollbackEntries = moved.submoduleRollbackEntries;
      notes.push(...moved.submoduleNotes);
      notes.push(
        'worktree contains initialized submodule checkout(s) that Git refuses to move: quarantined via a verified manual rename; ' +
        'the shared submodule admin area was never touched'
      );
    } else {
      // git worktree move is a rename of the directory entry, not a recursive
      // delete. It isolates the tree from writers still using the original path.
      await runGitCommand(['worktree', 'move', worktreePath, quarantinePath], { cwd: gitCwd });
    }
  } catch (err) {
    if (movedManually && err && err.partialMoveNote) {
      notes.push(String(err.partialMoveNote));
    }
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
          if (movedManually) {
            fs.renameSync(quarantinePath, worktreePath);
            if (fs.existsSync(worktreePath) && !fs.existsSync(quarantinePath)) {
              restoredPath = worktreePath;
              fs.rmdirSync(quarantineParent);
            }
          } else {
            await runGitCommand(['worktree', 'move', quarantinePath, worktreePath], { cwd: gitCwd });
            if (fs.existsSync(worktreePath) && !fs.existsSync(quarantinePath)) {
              restoredPath = worktreePath;
              fs.rmdirSync(quarantineParent);
            }
          }
        }
      } catch (restoreError) {
        notes.push('rollback move reported failure: ' + String((restoreError && restoreError.message) || restoreError));
      }
      // Trust the DISK, not the error: a rollback move can commit its rename
      // and only then report failure. Verify the actual outcome before
      // claiming either a restore or a preserved quarantine.
      if (!restoredPath && fs.existsSync(worktreePath) && !fs.existsSync(quarantinePath)) {
        restoredPath = worktreePath;
        try {
          fs.rmdirSync(quarantineParent);
        } catch {
          /* retained for inspection */
        }
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
      try {
        if (movedManually) {
          // Git refuses to move submodule worktrees at all.
          const reverted = await manualMoveBack({ worktreePath, quarantinePath, markerPath, markerContents, gitCwd, submoduleRollbackEntries });
          notes.push(...reverted);
        } else {
          await runGitCommand(['worktree', 'move', quarantinePath, worktreePath], { cwd: gitCwd });
        }
      } catch (moveError) {
        // Git validates the marker content during move and refuses relative
        // gitdir pointers ("is not a .git file"). Complete the rollback
        // manually — derive the admin dir from the captured marker anchored
        // at the original path and prove it via its own reverse pointer.
        const reverted = await manualMoveBack({ worktreePath, quarantinePath, markerPath, markerContents, gitCwd, submoduleRollbackEntries });
        notes.push(...reverted);
      }
      fs.rmdirSync(quarantineParent);
      return true;
    } catch (restoreError) {
      // A restore failure must be observable: the caller reports the
      // quarantine for manual recovery instead of a silent false.
      notes.push('rollback did not complete: ' + String((restoreError && restoreError.message) || restoreError));
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
    // This runs BEFORE the post-move status check so the rollback authority
    // (the marker bytes) is already captured when that check refuses.
    markerContents = readRegularFileNoFollow(markerPath);
    if (!/^\s*gitdir:/m.test(markerContents)) {
      throw new Error('worktree .git marker does not contain a gitdir pointer');
    }
    // A RELATIVE gitdir pointer is only resolvable from the ORIGINAL worktree
    // position. The quarantine adds a path segment, so after the move the
    // pointer can no longer prove which admin directory is ours — and git
    // itself cannot resolve a status inside the quarantine. Refuse and
    // restore BEFORE the tree is deleted, never resolve against a guess.
    const earlyMarkerLine = markerContents.split(/\r?\n/).find((line) => /^\s*gitdir:\s*/i.test(line));
    if (earlyMarkerLine && !path.isAbsolute(earlyMarkerLine.replace(/^\s*gitdir:\s*/i, '').trim())) {
      throw new Error('worktree .git marker uses a relative gitdir pointer, which cannot be proven after the quarantine move');
    }
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

  // Second status check, INSIDE the quarantine. A writer that does not use
  // the mutation lock can create or modify files between the pre-move status
  // check and the rename; the rename does not stop an open handle from
  // committing bytes. Any change that appears now — a tracked modification or
  // an untracked file beyond the caller-approved link deletions — proves a
  // live writer: restore the worktree intact and refuse the deletion. A
  // single pre-move check alone must never be treated as "the tree is quiet".
  const quarantineStatus = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: quarantinePath, allowFailure: true }
  );
  const expectedDeletedInQuarantine = expectedDeletedPaths.map(
    (item) => path.resolve(quarantinePath, path.relative(worktreePath, item))
  );
  if (!statusContainsOnlyExpectedLinkDeletions(quarantineStatus, quarantinePath, expectedDeletedInQuarantine)) {
    const restored = await restore();
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.OWNERSHIP_CHANGED,
      reason: 'a non-cooperating writer modified the worktree after the quarantine move; ' +
        (restored ? 'worktree restored intact at ' + worktreePath : 'quarantine preserved at ' + quarantinePath),
      ...(restored ? { restoredPath: worktreePath } : { quarantinePath }),
      notes,
    };
  }

  try {
    // Keep the marker contents in memory for rollback. The no-follow walker
    // can now remove the entire tree, and Git will only unregister absent metadata.
    fs.unlinkSync(markerPath);
  } catch (err) {
    const restored = await restore();
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED,
      reason: 'could not detach the worktree gitdir marker before safe deletion: ' + String((err && err.message) || err),
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
