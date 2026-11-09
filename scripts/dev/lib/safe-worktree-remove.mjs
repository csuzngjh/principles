import fs from 'node:fs';
import path from 'node:path';
import { gitCommonDirAbsolute, listWorktrees, normalizeGitPath, runGit } from './git.mjs';
import { readLeaseState } from './workspace-lifecycle.mjs';
import { proveQuarantineQuiescent } from './quiescence.mjs';
import {
  classifyReparsePoints,
  readRegularFileNoFollow,
  removeResidueTree,
  REMOVAL_REASONS,
} from './residue-delete.mjs';

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
 * Prove that the admin directory named by a worktree's .git marker bytes
 * belongs to the worktree whose marker is at `expectedMarkerPath`: resolve the
 * marker's gitdir pointer, confine the result to a direct child of the
 * canonical `<commonDir>/worktrees` root, and require the admin's own reverse
 * pointer to name `expectedMarkerPath` exactly. Every read goes through the
 * one-fd no-follow snapshot primitive. Throws when any direction fails —
 * callers preserve state and refuse.
 *
 * Relative pointers (git >= 2.48 `--relative-paths` / `worktree.useRelativePaths`)
 * are resolved the way git resolves them:
 *  - the marker pointer is relative to the directory holding the marker. After
 *    a move that position is ambiguous: a marker git rewrote is relative to the
 *    NEW location, a marker nobody rewrote (git < 2.48, or the manual submodule
 *    move) is still relative to the ORIGINAL one — so callers pass every
 *    candidate base in `markerDirs`;
 *  - the reverse pointer is relative to the ADMIN directory, never to the
 *    process cwd (normalizeGitPath would silently use the cwd).
 * `expectedAdminDir`, when given, binds the proof to the admin directory that
 * was already proven before the move: no other directory is accepted, so
 * trying several marker bases cannot widen what is trusted.
 */
export function resolveAdminDirFromMarkerBytes({ markerBytes, markerDirs, commonDir, expectedMarkerPath, expectedAdminDir = null }) {
  const markerLine = markerBytes.split(/\r?\n/).find((line) => /^\s*gitdir:\s*/i.test(line));
  if (!markerLine) throw new Error('worktree .git marker has no gitdir pointer');
  const rawAdminGitDir = markerLine.replace(/^\s*gitdir:\s*/i, '').trim();
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
  const candidates = path.isAbsolute(rawAdminGitDir)
    ? [path.resolve(rawAdminGitDir)]
    : markerDirs.map((markerDir) => path.resolve(markerDir, rawAdminGitDir));
  let lastError = new Error('worktree .git marker names no candidate admin directory');
  for (const candidate of candidates) {
    try {
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
      if (expectedAdminDir !== null && normalizeGitPath(adminDir) !== normalizeGitPath(expectedAdminDir)) {
        throw new Error('marker names a different admin directory than the one proven before the move');
      }
      const reversePointer = readRegularFileNoFollow(path.join(adminDir, 'gitdir')).trim();
      const resolvedReversePointer = resolveAdminReversePointer(adminDir, reversePointer);
      if (normalizeGitPath(resolvedReversePointer) !== normalizeGitPath(expectedMarkerPath)) {
        throw new Error('admin reverse pointer does not name the expected worktree marker');
      }
      return adminDir;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * The manual quarantine move for worktrees Git refuses to move (initialized
 * submodules): an atomic rename of the directory entry, an atomic rewrite of
 * the reverse pointer of the admin directory PROVEN before the move, then the
 * submodule re-anchoring. It deliberately does not roll itself back: on any
 * failure it throws (with the submodule rollback entries attached) and the
 * caller runs the single verified rollback, which re-derives the state from
 * disk instead of guessing which step failed.
 *
 * @returns {{notes: string[], rollbackEntries: Array<Function>}}
 */
function moveWorktreeIntoQuarantineManually({ worktreePath, quarantinePath, markerPath, linkage, submodules }) {
  fs.renameSync(worktreePath, quarantinePath);
  const pointerFile = path.join(linkage.adminDir, 'gitdir');
  // git's own slash form on Windows: `git worktree list` resolves the worktree
  // path from this file, and a backslash form would make the quarantine entry
  // unresolvable for the ownership re-check.
  writeAtomic(pointerFile, markerPath.split(path.sep).join('/') + '\n');
  const written = resolveAdminReversePointer(linkage.adminDir, readRegularFileNoFollow(pointerFile).trim());
  if (normalizeGitPath(written) !== normalizeGitPath(markerPath)) {
    throw new Error('admin reverse pointer retarget did not stick');
  }
  // Keep the quarantined worktree SELF-CONSISTENT: re-anchor the submodule
  // admin entries that belong to this worktree so `git status` inside the
  // quarantine still works for the post-move writer-detection check.
  return retargetSubmodulesForQuarantine({
    parentAdminDir: linkage.adminDir,
    commonDir: linkage.commonDir,
    worktreePath,
    quarantinePath,
    submodules,
  });
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
 * Atomic same-directory write: exclusive temp file + rename over the target.
 * The rename replaces the target ENTRY (a swapped-in symlink/FIFO is replaced,
 * never followed); a target that is a directory or junction makes it fail,
 * and the temp file is removed so a failure leaves nothing behind.
 */
function writeAtomic(filePath, contents) {
  const temp = path.join(
    path.dirname(filePath),
    path.basename(filePath) + '.pd-retarget-' + process.pid + '-' + Math.random().toString(36).slice(2)
  );
  fs.writeFileSync(temp, contents, { encoding: 'utf-8', flag: 'wx' });
  try {
    fs.renameSync(temp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* the original failure is the useful signal */
    }
    throw err;
  }
}

/** True when `candidate` is `root` itself or lives underneath it (lexical). */
function isWithinRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/**
 * Render a value for a git-config `key = value` line. `$`-tokens in the
 * replacement string are neutralised by using a replace callback, and values
 * containing characters git config treats specially inside/outside quotes
 * (`#`, `;` comment starters, `"` and `\` escapes) are double-quoted with
 * backslash escaping so the path parses as one value (CodeRabbit round 5).
 */
function gitConfigValue(value) {
  if (!/[#;"\\]/.test(value)) return value;
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
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
        writeAtomic(configFile, configBytes.replace(/^(\s*)worktree\s*=.*$/m, (_line, indent) =>
          indent + 'worktree = ' + gitConfigValue(absCheckout)
        ));
        // Rollback writes target the RESTORED worktree position: the rename
        // back has already happened by the time rollback entries run, and the
        // old quarantine path no longer exists then.
        rollbackEntries.push(() => {
          writeAtomic(path.join(worktreePath, subPath, '.git'), markerBytes);
          writeAtomic(configFile, configBytes);
        });
        notes.push('re-anchored per-worktree submodule admin for ' + subPath);
      } else if (canonicalModulesRoot && isWithinRoot(canonicalModulesRoot, adminDir)) {
        // Shared layout: rewrite the admin entry's gitdir reverse pointer, but
        // only when it currently names THIS worktree's submodule marker.
        const pointerFile = path.join(adminDir, 'gitdir');
        const current = readRegularFileNoFollow(pointerFile);
        // A relative reverse pointer is relative to the admin directory.
        if (normalizeGitPath(resolveAdminReversePointer(adminDir, current.trim())) !==
          normalizeGitPath(path.join(worktreePath, subPath, '.git'))) {
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

/** Exact identity of a directory entry (bigint: NTFS file ids exceed 2^53). */
function exactIdentity(target) {
  const stat = fs.lstatSync(target, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, isRealDirectory: stat.isDirectory() && !stat.isSymbolicLink() };
}

/**
 * Where is the tree, and does Git's admin linkage agree? Derived from disk
 * alone — never from which rollback step threw. The tree is located by the
 * exact identity recorded before the move (a directory recreated at either
 * path by someone else is not mistaken for it), and a location only counts
 * as consistent when the admin reverse pointer names that location's marker.
 *
 *   RESTORE_COMPLETED     tree at the original path, admin pointer names it
 *   QUARANTINE_PRESERVED  tree in quarantine, admin pointer names it
 *   RESTORE_FAILED        tree and admin pointer disagree; recoveryPath is
 *                         where the tree actually is (when found) and
 *                         `git worktree repair <recoveryPath>` relinks it
 */
function assessWorktreeLocation({ worktreePath, quarantinePath, linkage }) {
  const holdsTree = (candidate) => {
    try {
      const found = exactIdentity(candidate);
      return found.isRealDirectory && found.dev === linkage.treeIdentity.dev && found.ino === linkage.treeIdentity.ino;
    } catch {
      return false;
    }
  };
  let pointerTarget = null;
  try {
    pointerTarget = resolveAdminReversePointer(
      linkage.adminDir,
      readRegularFileNoFollow(path.join(linkage.adminDir, 'gitdir')).trim(),
    );
  } catch {
    /* unreadable or missing pointer: no location can be consistent */
  }
  const pointerNames = (dir) =>
    pointerTarget !== null && normalizeGitPath(pointerTarget) === normalizeGitPath(path.join(dir, '.git'));
  const atQuarantine = holdsTree(quarantinePath);
  const atOriginal = !atQuarantine && holdsTree(worktreePath);
  if (atQuarantine && pointerNames(quarantinePath)) {
    return { restoreState: 'QUARANTINE_PRESERVED', quarantinePath };
  }
  if (atOriginal && pointerNames(worktreePath)) {
    return { restoreState: 'RESTORE_COMPLETED', restoredPath: worktreePath };
  }
  const recoveryPath = atOriginal ? worktreePath : atQuarantine ? quarantinePath : null;
  return {
    restoreState: 'RESTORE_FAILED',
    ...(recoveryPath ? { recoveryPath } : {}),
    adminDirPath: linkage.adminDir,
    adminPointerNames: pointerTarget,
  };
}

/**
 * Return a quarantined tree to its original location WITHOUT asking Git to
 * move it: Git never reads the quarantine marker during a rollback, so a
 * marker swapped for a symlink cannot be followed. Each step is compensated so
 * the admin pointer is never left naming a location the tree is not at (a
 * pointer naming a vanished path is exactly what `git worktree prune` deletes):
 *
 *   1. precondition: the tree is in quarantine (exact identity) and the admin
 *      pointer names the quarantine or the original path — anything else is
 *      not provably ours and is left untouched;
 *   2. quarantine/.git := original marker bytes (atomic replace);
 *   3. rename quarantine -> original      (fail: put the quarantine marker back);
 *   4. admin gitdir := original pointer bytes, unless it already names the
 *      original path (fail: rename the tree back into the quarantine and put
 *      the quarantine marker back);
 *   5. submodule re-anchors reverted.
 *
 * The result is always assessWorktreeLocation() after the attempt.
 */
function rollbackToOriginal({ worktreePath, quarantinePath, quarantineParent, linkage, quarantineMarkerBytes, submoduleRollbackEntries, notes }) {
  const message = (err) => String((err && err.message) || err);
  const assess = () => assessWorktreeLocation({ worktreePath, quarantinePath, linkage });
  const before = assess();
  if (before.restoreState === 'RESTORE_COMPLETED') return before;
  let pointerTarget = null;
  try {
    pointerTarget = resolveAdminReversePointer(
      linkage.adminDir,
      readRegularFileNoFollow(path.join(linkage.adminDir, 'gitdir')).trim(),
    );
  } catch (err) {
    notes.push('rollback refused: the admin reverse pointer is unreadable: ' + message(err));
    return before;
  }
  const quarantineMarker = path.join(quarantinePath, '.git');
  const pointerNamesOriginal = normalizeGitPath(pointerTarget) === normalizeGitPath(path.join(worktreePath, '.git'));
  const pointerNamesQuarantine = normalizeGitPath(pointerTarget) === normalizeGitPath(quarantineMarker);
  const treeInQuarantine = before.restoreState === 'QUARANTINE_PRESERVED' ||
    (before.restoreState === 'RESTORE_FAILED' && before.recoveryPath === quarantinePath);
  if (!treeInQuarantine || !(pointerNamesOriginal || pointerNamesQuarantine)) {
    notes.push('rollback refused: the tree and its admin pointer are not in a provably-owned quarantine state');
    return before;
  }
  // Never move the tree onto something someone else created at the original
  // path: a POSIX rename silently REPLACES an empty directory. The tree stays
  // intact in the quarantine instead (reported as preserved).
  let originalPathOccupied = true;
  try {
    fs.lstatSync(worktreePath);
  } catch (err) {
    originalPathOccupied = !(err && err.code === 'ENOENT');
  }
  if (originalPathOccupied) {
    notes.push('rollback refused: something now occupies the original path ' + worktreePath + '; the tree stays in quarantine');
    return before;
  }
  const restoreQuarantineMarker = () => {
    if (quarantineMarkerBytes === null) return;
    try {
      writeAtomic(quarantineMarker, quarantineMarkerBytes);
    } catch (err) {
      notes.push('could not put the quarantine .git marker back: ' + message(err));
    }
  };
  try {
    writeAtomic(quarantineMarker, linkage.originalMarkerBytes);
  } catch (err) {
    notes.push('rollback could not restore the original .git marker inside the quarantine: ' + message(err));
    return assess();
  }
  try {
    fs.renameSync(quarantinePath, worktreePath);
  } catch (err) {
    notes.push('rollback could not move the quarantine back to ' + worktreePath + ': ' + message(err));
    restoreQuarantineMarker();
    return assess();
  }
  if (!pointerNamesOriginal) {
    try {
      writeAtomic(path.join(linkage.adminDir, 'gitdir'), linkage.originalPointerBytes);
    } catch (err) {
      notes.push('rollback could not restore the admin reverse pointer (' + message(err) +
        '); moving the tree back into the quarantine so the pointer is never left naming a missing path');
      try {
        fs.renameSync(worktreePath, quarantinePath);
        restoreQuarantineMarker();
      } catch (compensationError) {
        notes.push('compensation failed: ' + message(compensationError) + ' — the tree is at ' + worktreePath +
          ' while the admin pointer still names the quarantine; run git worktree repair on it before any git worktree prune');
      }
      return assess();
    }
  }
  for (const revert of [...submoduleRollbackEntries].reverse()) {
    try {
      revert();
    } catch (err) {
      notes.push('submodule rollback entry failed: ' + message(err));
    }
  }
  try {
    fs.rmdirSync(quarantineParent);
  } catch {
    /* an emptied private parent left behind is harmless */
  }
  return assess();
}

/** One human-readable clause for every restore outcome. */
function describeRestoreOutcome(outcome) {
  if (outcome.restoreState === 'RESTORE_COMPLETED') return 'worktree restored intact at ' + outcome.restoredPath;
  if (outcome.restoreState === 'QUARANTINE_PRESERVED') return 'worktree preserved in quarantine at ' + outcome.quarantinePath;
  return 'RESTORE FAILED: the tree is ' + (outcome.recoveryPath ? 'at ' + outcome.recoveryPath : 'at no expected location') +
    ' but its Git admin metadata (' + outcome.adminDirPath + ') does not name it';
}

/**
 * Remove an already-authorized, porcelain-clean worktree without giving Git a
 * recursive delete over a directory that can acquire a junction after preflight.
 *
 * The Git admin linkage is proven first and its original bytes kept. The
 * worktree is then renamed (not recursively traversed) into a unique
 * quarantine sibling, re-checked (second status), and deleted by a no-follow
 * filesystem walk ONLY after a quiescence proof shows no process still holds
 * anything inside it. Its exact admin directory — bound to the pre-move proof
 * — is removed with the same no-follow walker. No recursive Git deletion is
 * used, and any refusal after the move runs one git-free, compensated rollback.
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
 *          restoreState?: 'RESTORE_COMPLETED'|'QUARANTINE_PRESERVED'|'RESTORE_FAILED',
 *          restoredPath?: string, quarantinePath?: string, recoveryPath?: string,
 *          adminDirPath?: string, quiescence?: object, removal?: object,
 *          notes: string[]}>} on refusal, `restoreState` says where the intact
 *          tree is: restoredPath (original path), quarantinePath (preserved), or
 *          recoveryPath (RESTORE_FAILED — relink with `git worktree repair`).
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
  // core.fsmonitor is forced off so this check can never start a long-lived
  // monitor daemon that holds handles inside the tree.
  const liveStatus = await runGit(
    ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: worktreePath, allowFailure: true },
  );
  if (!statusContainsOnlyExpectedLinkDeletions(liveStatus, worktreePath, expectedDeletedPaths)) {
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.OWNERSHIP_CHANGED,
      reason: 'worktree became dirty or unreadable immediately before quarantine move; unknown work preserved',
      notes,
    };
  }

  // Prove the Git admin linkage BEFORE anything moves and keep the exact
  // original marker and pointer bytes: they are the only rollback authority,
  // and the tree's exact identity is how a rollback later finds it. A
  // worktree whose linkage cannot be proven is refused with nothing mutated.
  let linkage;
  try {
    const commonDir = await gitCommonDirAbsolute(gitCwd);
    const originalMarkerPath = path.join(worktreePath, '.git');
    const originalMarkerBytes = readRegularFileNoFollow(originalMarkerPath);
    const adminDir = resolveAdminDirFromMarkerBytes({
      markerBytes: originalMarkerBytes,
      markerDirs: [worktreePath],
      commonDir,
      expectedMarkerPath: originalMarkerPath,
    });
    const treeIdentity = exactIdentity(worktreePath);
    if (!treeIdentity.isRealDirectory) throw new Error('the worktree path is not a real directory');
    linkage = {
      commonDir,
      adminDir,
      originalMarkerBytes,
      originalPointerBytes: readRegularFileNoFollow(path.join(adminDir, 'gitdir')),
      treeIdentity,
    };
  } catch (err) {
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.OWNERSHIP_CHANGED,
      reason: 'could not prove the worktree Git admin linkage before quarantine; nothing was moved: ' +
        String((err && err.message) || err),
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
  // Marker bytes read inside the quarantine after the move — used only to put
  // the quarantine back exactly as it was when a rollback step must be undone.
  let markerContents = null;
  // Git refuses to move worktrees that contain initialized submodules, so such
  // worktrees take the manual rename + admin-retarget path.
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

  // ONE rollback for every failure after this point — never `git worktree
  // move`, compensated step by step, outcome re-derived from disk.
  const restore = () => rollbackToOriginal({
    worktreePath, quarantinePath, quarantineParent, linkage,
    quarantineMarkerBytes: markerContents, submoduleRollbackEntries, notes,
  });
  const refuse = (reasonCode, reason, extra = {}) => {
    const outcome = restore();
    return { ok: false, reasonCode, reason: reason + '; ' + describeRestoreOutcome(outcome), ...extra, ...outcome, notes };
  };

  try {
    if (movedManually) {
      // Manual quarantine move: atomic rename + verified parent and submodule
      // admin retargets. It does not roll itself back — the catch below runs
      // the single verified rollback.
      const moved = moveWorktreeIntoQuarantineManually({
        worktreePath, quarantinePath, markerPath, linkage, submodules: initializedSubmodules,
      });
      submoduleRollbackEntries = moved.rollbackEntries;
      notes.push(...moved.notes);
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
    if (err && Array.isArray(err.submoduleRollbackEntries)) {
      submoduleRollbackEntries = err.submoduleRollbackEntries;
    }
    // Disk truth decides: the move may have failed before renaming anything
    // (nothing to undo) or after the rename committed (undo it).
    const outcome = restore();
    if (outcome.restoreState === 'RESTORE_COMPLETED') {
      try {
        fs.rmdirSync(quarantineParent);
      } catch {
        /* already removed by the rollback, or not empty: retained for inspection */
      }
    }
    return {
      ok: false,
      reasonCode: REMOVAL_REASONS.REMOVAL_FAILED,
      reason: 'could not move the worktree into quarantine: ' + String((err && err.message) || err) + '; ' +
        describeRestoreOutcome(outcome),
      ...outcome,
      notes,
    };
  }

  if (onQuarantined) {
    // Test seam: simulate a non-cooperating writer creating a late junction.
    // Production callers never provide this callback.
    try {
      await onQuarantined(quarantinePath);
    } catch (err) {
      return refuse(REMOVAL_REASONS.REMOVAL_FAILED, 'quarantine test hook failed: ' + String((err && err.message) || err));
    }
  }

  if (fs.existsSync(worktreePath) || !fs.existsSync(quarantinePath)) {
    return refuse(REMOVAL_REASONS.OWNERSHIP_CHANGED, 'worktree path changed unexpectedly during quarantine move');
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
    // Prove the admin directory named by the marker IS the one proven before
    // the move, BEFORE git (and this cleanup) reads anything else from it:
    // confined to the canonical admin root, cross-checked against the admin's
    // own reverse pointer, and bound to the pre-move proof. A marker git
    // rewrote during the move is relative to the quarantine; one nobody
    // rewrote is still relative to the original position — both bases are
    // tried. A substituted marker can no longer redirect `git status` at
    // another worktree (CodeRabbit round 5).
    resolveAdminDirFromMarkerBytes({
      markerBytes: markerContents,
      markerDirs: [quarantinePath, worktreePath],
      commonDir: linkage.commonDir,
      expectedMarkerPath: markerPath,
      expectedAdminDir: linkage.adminDir,
    });
  } catch (err) {
    return refuse(
      REMOVAL_REASONS.REMOVAL_FAILED,
      'could not isolate the worktree gitdir marker before safe deletion: ' + String((err && err.message) || err),
    );
  }

  // Second status check, INSIDE the quarantine. A writer that does not use
  // the mutation lock can create or modify files between the pre-move status
  // check and the rename; the rename does not stop an open handle from
  // committing bytes. Any change that appears now — a tracked modification or
  // an untracked file beyond the caller-approved link deletions — proves a
  // live writer: restore the worktree intact and refuse the deletion. A
  // single pre-move check alone must never be treated as "the tree is quiet".
  const quarantineStatus = await runGit(
    ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: quarantinePath, allowFailure: true }
  );
  const expectedDeletedInQuarantine = expectedDeletedPaths.map(
    (item) => path.resolve(quarantinePath, path.relative(worktreePath, item))
  );
  if (!statusContainsOnlyExpectedLinkDeletions(quarantineStatus, quarantinePath, expectedDeletedInQuarantine)) {
    const expectedInQuarantine = new Set(expectedDeletedInQuarantine.map((item) => normalizeGitPath(item)));
    let refusalReason = null;
    let toleratedUntrackedLinks = 0;
    if (quarantineStatus === null) {
      // Git itself failed inside the quarantine (a swapped marker, a broken
      // admin pointer): nothing can be classified, refuse outright.
      refusalReason = 'git could not report the quarantine status after the move';
    } else {
      // Separate DATA from LINKS. Only an UNTRACKED reparse point dropped by a
      // late writer may be tolerated: unlinking it removes only the link and
      // the no-follow walk never follows one, so no data is at risk. A TRACKED
      // path that changed after the move carries uncommitted target values
      // (or content) and still refuses with a full restore (CodeRabbit round 5).
      for (const record of quarantineStatus.split('\0').filter(Boolean)) {
        const statusCode = record.slice(0, 2);
        const resolved = path.resolve(quarantinePath, record.slice(3));
        if (statusCode === ' D' && expectedInQuarantine.has(normalizeGitPath(resolved))) continue;
        if (statusCode === '??') {
          let isLink = false;
          try {
            isLink = fs.lstatSync(resolved).isSymbolicLink();
          } catch {
            isLink = false;
          }
          if (isLink) {
            toleratedUntrackedLinks += 1;
            continue;
          }
        }
        refusalReason = 'a non-cooperating writer modified the worktree after the quarantine move';
        break;
      }
    }
    if (refusalReason !== null) {
      return refuse(REMOVAL_REASONS.OWNERSHIP_CHANGED, refusalReason);
    }
    if (toleratedUntrackedLinks > 0) {
      notes.push(
        'quarantine received ' + toleratedUntrackedLinks + ' untracked reparse point(s) after the move: ' +
        'the no-follow walk detaches links without following them, so no data is at risk'
      );
    }
  }

  try {
    // Keep the marker contents in memory for rollback. The no-follow walker
    // can now remove the entire tree, and Git will only unregister absent metadata.
    fs.unlinkSync(markerPath);
  } catch (err) {
    return refuse(
      REMOVAL_REASONS.REMOVAL_FAILED,
      'could not detach the worktree gitdir marker before safe deletion: ' + String((err && err.message) || err),
    );
  }

  const afterMoveError = await ownershipError(gitCwd, quarantinePath, 'before no-follow deletion');
  if (afterMoveError) {
    return refuse(afterMoveError.reasonCode, afterMoveError.reason);
  }

  // Nothing may still hold anything inside the quarantine. A handle opened
  // before the move survives the rename and keeps writing; deleting the tree
  // would send those writes into unlinked files and lose them silently. A
  // second `git status` cannot see a writer that has not written yet, so this
  // is a positive proof taken immediately before the deletion — and when it
  // cannot be given, NOTHING is deleted.
  const quiescence = proveQuarantineQuiescent({ quarantinePath, quarantineParent });
  if (!quiescence.proven) {
    const reason = 'refusing to delete: it cannot be proven that no process still holds a handle inside the ' +
      'quarantine (' + quiescence.mechanism + '): ' + quiescence.reason;
    if (quiescence.displacedTo) {
      // The probe moved the private parent and could not move it back: the
      // tree is intact under the probe name. Its .git marker was already
      // detached for the deletion, and `git worktree repair` needs it to find
      // the admin directory — put it back (the probe path has the same depth
      // as the quarantine, so a relative pointer resolves identically).
      const recoveryPath = path.join(quiescence.displacedTo, 'worktree');
      let relinkable = true;
      try {
        writeAtomic(path.join(recoveryPath, '.git'), markerContents !== null ? markerContents : linkage.originalMarkerBytes);
      } catch (err) {
        relinkable = false;
        notes.push('could not restore the .git marker in the displaced tree (' + String((err && err.message) || err) +
          '); it must be recreated with the original contents before git worktree repair can relink it');
      }
      return {
        ok: false,
        reasonCode: REMOVAL_REASONS.QUIESCENCE_UNPROVEN,
        reason: reason + '; the tree is intact at ' + recoveryPath +
          (relinkable ? '' : ' but its .git marker could not be restored'),
        restoreState: 'RESTORE_FAILED',
        recoveryPath,
        adminDirPath: linkage.adminDir,
        quiescence,
        notes,
      };
    }
    return refuse(REMOVAL_REASONS.QUIESCENCE_UNPROVEN, reason, { quiescence });
  }
  if (quiescence.uninspectedProcesses > 0) {
    const named = (quiescence.uninspectedDetail || [])
      .slice(0, 5)
      .map((item) => item.command + ' (pid ' + item.pid + ', ' + item.credentials + ')')
      .join('; ');
    notes.push(
      'quiescence proven (' + quiescence.mechanism + ') against every process this user can inspect; ' +
      quiescence.uninspectedProcesses + ' process(es) are outside that boundary (other users, non-dumpable, ' +
      'or same-user with elevated credentials' + (named ? ': ' + named : '') + ')'
    );
  }

  const removal = removeResidueTree(quarantinePath, {
    primaryPath,
    onProgress: onProgress || undefined,
  });

  if (fs.existsSync(quarantinePath)) {
    return refuse(
      REMOVAL_REASONS.REMOVAL_FAILED,
      'the no-follow deletion did not finish: ' + (removal.error || 'quarantine directory remains'),
      { removal },
    );
  }

  if (onTreeRemoved) {
    // Test seam: model a non-cooperating process recreating the original path
    // after quarantine deletion but before branch cleanup is allowed to proceed.
    await onTreeRemoved(worktreePath);
  }

  // Remove ONLY the admin directory proven before the move. The shared helper
  // re-proves BOTH pointer directions at this exact moment (the marker's
  // gitdir pointer from either marker base, the admin's reverse pointer naming
  // the quarantine marker back) and binds them to the pre-move proof before
  // the no-follow removal — never Git's recursive deletion.
  let adminDir;
  try {
    adminDir = resolveAdminDirFromMarkerBytes({
      markerBytes: markerContents,
      markerDirs: [quarantinePath, worktreePath],
      commonDir: linkage.commonDir,
      expectedMarkerPath: markerPath,
      expectedAdminDir: linkage.adminDir,
    });
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
