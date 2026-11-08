// Controlled residue deletion (PRI-796, SPEC §16/§17).
//
// This is the ONLY code in the repository allowed to delete a directory tree
// that git cannot account for, and it exists for exactly one caller: an explicit
// Owner/agent decision to remove an UNKNOWN residue shell after `--ack-unknown`.
//
// WHY NOT fs.rmSync(recursive)
//   Two requirements rule it out:
//     1. JUNCTION SAFETY. On Windows a directory junction is a reparse point.
//        Verified on this platform (Node 22, git-bash):
//          lstatSync(junction).isSymbolicLink() === true
//          lstatSync(junction).isDirectory()    === false
//          unlinkSync(junction)                 -> removes ONLY the link
//        The walk below therefore decides with `lstat`, never `stat`, and always
//        detaches a link with unlink — so a residue directory containing
//        `node_modules -> <primary>/...` cannot reach into the control plane.
//        After detaching, the link's external target is re-checked: if it
//        disappeared, something followed the link and the run fails loud.
//     2. OBSERVABILITY. Deleting 50k+ files on Windows takes minutes. SPEC §17
//        forbids a silent black box, and forbids adding a daemon to fix it — so
//        progress is emitted inline from the walk (no extra process, no watcher).
//
// The walk is post-order: children first, then the directory itself. A symlink is
// NEVER recursed into, so its target tree is out of scope by construction.
//
// The scan is NOT only for residue deletion. ERR-098's recurrence
// (OCC-20261106T025529Z-g9kvsgn43c) showed `git worktree remove` recurses
// through junctions too, so `classifyReparsePoints` + `detachExternalLinks`
// below are the shared pre-flight that every worktree removal runs first: a link
// pointing OUTSIDE the tree being removed must be detached before git is handed
// that tree, or the removal must not happen at all.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;
export const DEFAULT_PROGRESS_EVERY_FILES = 5_000;

/**
 * Resolve a link's raw readlink target the way the OS does: a relative target
 * is anchored at the LINK'S OWN directory, never at the process cwd. One
 * resolver for both the pre-flight scan and the deletion walk (round-3
 * review: fixing only one of the two call sites left the walk mis-reporting
 * existence — and mis-classifying brokenTargets — for every relative link).
 * @returns {string|null} absolute candidate, or null when there is no target.
 */
export function resolveLinkTarget(linkPath, target) {
  if (typeof target !== 'string' || target.length === 0) return null;
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
}

/**
 * Pre-flight: enumerate the tree without following reparse points.
 * Returns the counts (for progress), every link found (for the safety report),
 * and EVERY directory that could not be read. An unreadable directory is an
 * UNKNOWN, not an empty directory: hiding it would let a recursive deleter walk
 * into a junction we never saw (ERR-098, git-14).
 *
 * @returns {{links: Array<{path: string, target: string, targetExists: boolean}>,
 *            files: number, dirs: number,
 *            unreadable: Array<{path: string, error: string}>}}
 */
export function scanReparsePoints(root) {
  const links = [];
  const unreadable = [];
  let files = 0;
  let dirs = 0;
  const stack = [root];

  const recordLink = (linkPath) => {
    let target = null;
    try {
      target = fs.readlinkSync(linkPath);
    } catch {
      target = null;
    }
    const resolvedTarget = resolveLinkTarget(linkPath, target);
    links.push({ path: linkPath, target, targetExists: resolvedTarget !== null && fs.existsSync(resolvedTarget) });
  };

  while (stack.length > 0) {
    const dir = stack.pop();
    let handle;
    try {
      handle = fs.opendirSync(dir);
    } catch (err) {
      let stat = null;
      try {
        stat = fs.lstatSync(dir);
      } catch {
        unreadable.push({ path: dir, error: String((err && err.message) || err) });
        continue;
      }
      if (stat.isSymbolicLink()) {
        recordLink(dir);
      } else {
        unreadable.push({ path: dir, error: String((err && err.message) || err) });
      }
      continue;
    }

    let dirStat;
    try {
      // opendir may follow a junction if it is swapped in after the parent
      // enumeration. lstat AFTER opening proves the handle still names a real
      // directory before we read a single entry from it.
      dirStat = fs.lstatSync(dir);
    } catch (err) {
      handle.closeSync();
      unreadable.push({ path: dir, error: String((err && err.message) || err) });
      continue;
    }
    if (dirStat.isSymbolicLink()) {
      handle.closeSync();
      recordLink(dir);
      continue;
    }
    if (!dirStat.isDirectory()) {
      handle.closeSync();
      unreadable.push({ path: dir, error: 'path is no longer a directory' });
      continue;
    }

    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        const full = path.join(dir, entry.name);
        let childStat;
        try {
          childStat = fs.lstatSync(full);
        } catch (err) {
          unreadable.push({ path: full, error: String((err && err.message) || err) });
          continue;
        }
        if (childStat.isSymbolicLink()) {
          recordLink(full);
        } else if (childStat.isDirectory()) {
          dirs += 1;
          stack.push(full);
        } else {
          files += 1;
        }
      }
    } catch (err) {
      unreadable.push({ path: dir, error: String((err && err.message) || err) });
    } finally {
      handle.closeSync();
    }
  }
  return { links, files, dirs, unreadable };
}

/**
 * Is `candidate` inside `root`?
 *
 * `caseSensitive` defaults to the platform rule (Windows: case-insensitive).
 * Callers that already canonicalised both paths through realpath MUST pass
 * `caseSensitive: true`: Windows supports per-directory case sensitivity (WSL),
 * where `Tree` and `tree` are two different directories, and folding the case
 * would call an outside target "inside" (CodeRabbit review, PRI-1143).
 *
 * A trailing backslash is stripped ONLY on Windows. On POSIX a backslash is a
 * legitimate filename character: `/tmp/tree\` is NOT `/tmp/tree`.
 */
export function isPathInsideRoot(root, candidate, { caseSensitive = process.platform !== 'win32' } = {}) {
  const normalize = (p) => {
    const resolved = path.resolve(p);
    let out = resolved;
    if (process.platform === 'win32' && out.length > 3 && /[\\/]$/.test(out)) out = out.slice(0, -1);
    return caseSensitive ? out : out.toLowerCase();
  };
  const r = normalize(root);
  const c = normalize(candidate);
  if (c === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(prefix);
}

/** Resolve a path the filesystem's way. null = direction cannot be proven. */
export function canonicalPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

// A `..` component cannot be normalised lexically when a link precedes it. On
// POSIX a backslash is an ordinary FILENAME character, so only `/` separates
// components there; on Windows both separators count.
const NON_LEXICAL_TARGET = process.platform === 'win32' ? /(^|[\\/])\.\.([\\/]|$)/ : /(^|\/)\.\.(\/|$)/;

/**
 * One recorded filesystem identity: what `lstat` said about a path at scan
 * time. `dev`/`ino` are the OS-level identity of the EXACT object named by the
 * path (a directory entry or a link itself — never its target, because lstat
 * does not follow reparse points).
 * @typedef {{path: string, dev: number, ino: number, kind: 'directory'|'link'}} IdentityEntry
 */

/**
 * Record the identity of every directory from `root` (inclusive) down to the
 * parent of `linkPath`, plus the link entry itself. The chain is what a path
 * resolution of `linkPath` walks, so re-verifying it immediately before an
 * unlink proves no ancestor directory was replaced by a junction/symlink (or
 * another directory) since the scan — without such a check, a swapped parent
 * would redirect `fs.unlinkSync(link.path)` at an object OUTSIDE the tree.
 *
 * @param {string} root absolute scan root (a real directory, already verified)
 * @param {string} linkPath absolute path of the link inside root
 * @returns {IdentityEntry[]} root→parent directories, then the link itself
 */
function captureIdentityChain(root, linkPath) {
  const chain = [];
  const rootResolved = path.resolve(root);
  const linkResolved = path.resolve(linkPath);
  const relative = path.relative(rootResolved, linkResolved);
  const segments = relative.split(path.sep).filter(Boolean);
  // Every directory on the way: root, root/a, root/a/b, ... parent(link).
  let current = rootResolved;
  const dirSegments = segments.slice(0, -1);
  for (let i = 0; i <= dirSegments.length; i += 1) {
    if (i > 0) current = path.join(current, dirSegments[i - 1]);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('ancestor ' + current + ' is not a real directory');
    }
    chain.push({ path: current, dev: stat.dev, ino: stat.ino, kind: 'directory' });
  }
  const linkStat = fs.lstatSync(linkResolved);
  chain.push({ path: linkResolved, dev: linkStat.dev, ino: linkStat.ino, kind: 'link' });
  return chain;
}

/**
 * Prove the recorded chain still names the same objects right before a
 * path-based unlink. Any disappearance, identity change or type change (a
 * directory swapped for a link, a link replaced by a real file) fails closed:
 * the caller refuses that link instead of unlinking through a redirected path.
 *
 * @param {IdentityEntry[]} chain value returned by captureIdentityChain()
 * @returns {string|null} null when the chain is intact, else the failure reason
 */
function verifyIdentityChain(chain) {
  for (const entry of chain) {
    let stat;
    try {
      stat = fs.lstatSync(entry.path);
    } catch (err) {
      return entry.path + ' disappeared since the scan: ' + String((err && err.code) || err);
    }
    if (entry.kind === 'directory' && (stat.isSymbolicLink() || !stat.isDirectory())) {
      return entry.path + ' is no longer a real directory (replaced since the scan)';
    }
    if (entry.kind === 'link' && !stat.isSymbolicLink()) {
      return entry.path + ' is no longer a reparse point (replaced since the scan)';
    }
    if (stat.dev !== entry.dev || stat.ino !== entry.ino) {
      return entry.path + ' changed identity since the scan (dev/ino mismatch)';
    }
  }
  return null;
}

/** Machine-readable refusal reasons shared by both cleanup entry points. */
export const REMOVAL_REASONS = Object.freeze({
  EXTERNAL_LINKS_PRESENT: 'EXTERNAL_LINKS_PRESENT',
  EXTERNAL_TARGET_LOST: 'EXTERNAL_TARGET_LOST',
  SCAN_INCOMPLETE: 'SCAN_INCOMPLETE',
  OWNERSHIP_CHANGED: 'OWNERSHIP_CHANGED',
  MUTATION_LOCK_UNAVAILABLE: 'MUTATION_LOCK_UNAVAILABLE',
  REMOVAL_FAILED: 'REMOVAL_FAILED',
  REMOVAL_FAILED_RESIDUE_SHELL: 'REMOVAL_FAILED_RESIDUE_SHELL',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
});

/**
 * Pre-flight for anything about to hand a tree to a recursive deleter —
 * including `git worktree remove`, which is NOT junction-safe on Windows.
 *
 * `external` = every link not safe for recursive traversal: outside,
 * unresolvable or non-lexical targets, plus self/ancestor cycles. Cycle links
 * have `unsafeReason: 'cycle'` and a proven target inside this tree; callers
 * can unlink those links safely without requiring an external-target override.
 * `internal` = targets proven inside `root` and non-cyclic.
 *
 * `complete` is false when any directory could not be enumerated or `root`
 * itself could not be resolved. `safe` is true only when the scan is complete
 * and no unsafe link remains.
 *
 * @returns {{external: Array<object>, internal: Array<object>, links: number,
 *            files: number, dirs: number, unreadable: Array<object>,
 *            complete: boolean, safe: boolean}}
 */
export function classifyReparsePoints(root) {
  // The tree root itself must be a REAL directory. If it was replaced by a
  // junction pointing elsewhere, every "inside" comparison below would be
  // measured against the WRONG tree and git could delete the target's files.
  let rootStat = null;
  try { rootStat = fs.lstatSync(root); } catch { /* reported below */ }
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return {
      external: [], internal: [], links: 0, files: 0, dirs: 0,
      unreadable: [{ path: root, error: 'root is not a readable real directory (or is itself a reparse point)' }],
      complete: false, safe: false,
    };
  }
  const scan = scanReparsePoints(root);
  const canonicalRoot = canonicalPath(root);
  const external = [];
  const internal = [];
  for (const link of scan.links) {
    const lexical = resolveLinkTarget(link.path, link.target);
    const nonLexical = typeof link.target === 'string' && NON_LEXICAL_TARGET.test(link.target);
    const canonicalTarget = lexical !== null && !nonLexical ? canonicalPath(lexical) : null;
    // The probe target is what the OS ACTUALLY reaches when it resolves the
    // link (realpath resolves every intermediate link). Classification stays
    // strict — for a non-lexical target the direction remains UNKNOWN — but
    // existence probes and caller fingerprints must name the real object, not
    // a lexically normalised path that can name a different one (CodeRabbit,
    // PRI-1143 round 3).
    const probeTarget = lexical !== null ? canonicalPath(lexical) : null;
    // Both sides come from realpath, so compare case-SENSITIVELY.
    const inside =
      canonicalRoot !== null &&
      canonicalTarget !== null &&
      isPathInsideRoot(canonicalRoot, canonicalTarget, { caseSensitive: true });
    // Canonicalise the link's own parent too: on a case-sensitive Windows
    // directory, comparing a raw lexical link path would invent a false cycle.
    const canonicalParent = canonicalPath(path.dirname(link.path));
    const canonicalLink = canonicalParent ? path.join(canonicalParent, path.basename(link.path)) : link.path;
    const cycle = inside && isPathInsideRoot(canonicalTarget, canonicalLink, { caseSensitive: true });
    const unsafeReason = nonLexical
      ? 'non-lexical'
      : canonicalTarget === null
        ? 'unresolved'
        : cycle
          ? 'cycle'
          : inside
            ? null
            : 'outside';
    let ancestorIdentity = null;
    try {
      ancestorIdentity = captureIdentityChain(root, link.path);
    } catch (err) {
      // The chain broke between the walk and this recording pass; the next
      // verify would refuse anyway — record the failure so the scan is
      // incomplete and the caller fails closed.
      scan.unreadable.push({ path: link.path, error: 'could not record ancestor identity: ' + String((err && err.message) || err) });
    }
    const row = {
      path: link.path,
      target: link.target,
      resolvedTarget: lexical,
      canonicalTarget,
      probeTarget,
      ancestorIdentity,
      targetExists: link.targetExists,
      // Cycles are unsafe for recursive traversal even when their targets
      // are inside the tree; callers may detach verified cycles without recursing.
      inside: inside && !cycle,
      unsafeReason: inside && !cycle ? null : unsafeReason,
    };
    (inside && !cycle ? internal : external).push(row);
  }
  const complete = scan.unreadable.length === 0 && canonicalRoot !== null;
  return {
    external,
    internal,
    links: scan.links.length,
    files: scan.files,
    dirs: scan.dirs,
    unreadable: scan.unreadable,
    complete,
    safe: complete && external.length === 0,
  };
}

/**
 * Detach every unsafe reparse point in `root` and prove the targets survived.
 * Removing a link removes ONLY the link. A scan that could not be completed is
 * never partially detached: an unknown tree is left completely untouched.
 *
 * @returns {{detached: Array<object>, brokenTargets: Array<object>,
 *            remainingExternal: Array<object>, failedToDetach: Array<object>,
 *            unreadable: Array<object>, complete: boolean, ok: boolean}}
 */
export function detachExternalLinks(root) {
  const before = classifyReparsePoints(root);
  if (!before.complete) {
    return {
      detached: [],
      brokenTargets: [],
      failedToDetach: [],
      remainingExternal: before.external,
      unreadable: before.unreadable,
      complete: false,
      ok: false,
    };
  }
  const detached = [];
  const brokenTargets = [];
  for (const link of before.external) {
    // A path-based unlink follows the WHOLE ancestor chain. If any directory
    // on that chain was replaced by a junction since the scan, unlinking would
    // reach an object OUTSIDE this tree. Verify every recorded identity first
    // and refuse the link when anything changed (fail-closed, git-14).
    const identityFailure = link.ancestorIdentity ? verifyIdentityChain(link.ancestorIdentity) : 'ancestor identity was not recorded for this link';
    if (identityFailure) {
      detached.push({
        path: link.path,
        target: link.target,
        targetExistedBefore: null,
        targetStillExists: null,
        error: 'refused to unlink: ' + identityFailure,
      });
      continue;
    }
    // Existence is probed against the object the OS actually reaches, not the
    // lexical fallback a non-lexical target would produce.
    const probe = link.canonicalTarget || link.probeTarget;
    const existedBefore = probe !== null ? fs.existsSync(probe) : null;
    let error = null;
    try {
      fs.unlinkSync(link.path);
    } catch (err) {
      error = String((err && err.message) || err);
    }
    const stillExists = probe !== null ? fs.existsSync(probe) : null;
    detached.push({
      path: link.path,
      target: link.target,
      targetExistedBefore: existedBefore,
      targetStillExists: stillExists,
      error,
    });
    if (existedBefore === true && stillExists === false) {
      brokenTargets.push({ path: link.path, target: link.target });
    }
  }
  const after = classifyReparsePoints(root);
  const remainingExternalPaths = new Set(after.external.map((link) => path.resolve(link.path)));
  const failed = detached.flatMap((item) => {
    if (item.error !== null) return [item];
    if (remainingExternalPaths.has(path.resolve(item.path))) {
      return [{ ...item, error: 'link remained after unlink' }];
    }
    return [];
  });
  return {
    detached,
    brokenTargets,
    failedToDetach: failed,
    remainingExternal: after.external,
    unreadable: after.unreadable,
    complete: after.complete,
    ok: brokenTargets.length === 0 && failed.length === 0 && after.complete && after.external.length === 0,
  };
}

/**
 * Detach reparse points PROVEN to stay inside the tree before handing it to a
 * recursive deleter. git must not be allowed to traverse ANY link: verified on
 * Windows, `git worktree remove` returns exit 0 while leaving a directory
 * junction (and therefore its parent directory) behind — a NO_GIT_MARKER
 * residue shell whose dirtiness is unprovable. Unlinking is safe here: the
 * target is inside the tree and dies with it anyway.
 *
 * @returns {{detached: Array<object>, failedToDetach: Array<object>,
 *            remainingLinks: number, complete: boolean, ok: boolean}}
 */
export function detachInternalLinks(root) {
  const before = classifyReparsePoints(root);
  if (!before.complete) {
    return { detached: [], failedToDetach: [], remainingLinks: before.links, complete: false, ok: false };
  }
  const detached = [];
  const failedToDetach = [];
  // A verified ancestor cycle is inside this tree but cannot be traversed.
  // It is safe to unlink the link itself: its target remains part of the tree
  // and will be removed with the tree. Unresolvable cycles remain fail-closed.
  const safeToDetach = [
    ...before.internal,
    ...before.external.filter((link) => link.unsafeReason === 'cycle'),
  ];
  for (const link of safeToDetach) {
    // Same fail-closed rule as the external pass: never unlink through an
    // ancestor chain that changed since the scan.
    const identityFailure = link.ancestorIdentity ? verifyIdentityChain(link.ancestorIdentity) : 'ancestor identity was not recorded for this link';
    if (identityFailure) {
      failedToDetach.push({ path: link.path, error: 'refused to unlink: ' + identityFailure });
      continue;
    }
    try {
      fs.unlinkSync(link.path);
      detached.push({ path: link.path, target: link.target, unsafeReason: link.unsafeReason || null });
    } catch (err) {
      failedToDetach.push({ path: link.path, error: String((err && err.message) || err) });
    }
  }
  const after = classifyReparsePoints(root);
  const remainingPaths = new Set([...after.external, ...after.internal].map((link) => path.resolve(link.path)));
  const stillPresent = detached
    .filter((item) => remainingPaths.has(path.resolve(item.path)))
    .map((item) => ({ ...item, error: 'link remained after unlink' }));
  const failed = [...failedToDetach, ...stillPresent];
  return {
    detached,
    failedToDetach: failed,
    remainingLinks: after.links,
    complete: after.complete,
    ok: failed.length === 0 && after.complete && after.links === 0,
  };
}

/** Refuse the paths that must never be deleted, whatever the caller asks. */
export function assertDeletableRoot(root, { primaryPath = null } = {}) {
  const resolved = path.resolve(root);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    return { ok: false, error: 'refusing to delete a filesystem root: ' + resolved };
  }
  if (primaryPath && path.resolve(primaryPath) === resolved) {
    return { ok: false, error: 'refusing to delete the primary checkout: ' + resolved };
  }
  let lst;
  try {
    lst = fs.lstatSync(resolved);
  } catch (err) {
    return { ok: false, error: 'cannot stat ' + resolved + ': ' + String((err && err.message) || err) };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, error: 'refusing to delete a reparse point (junction/symlink) as a tree: ' + resolved };
  }
  if (!lst.isDirectory()) {
    return { ok: false, error: 'not a directory: ' + resolved };
  }
  return { ok: true, resolved };
}

/**
 * Remove a tree, detaching reparse points instead of following them, emitting
 * progress inline.
 *
 * @param {string} root
 * @param {{primaryPath?: string|null, onProgress?: (p: object) => void,
 *          progressIntervalMs?: number, progressEveryFiles?: number,
 *          now?: () => number}} [opts]
 * @returns {{ok: boolean, removedFiles: number, removedLinks: number,
 *            dirs: number, elapsedMs: number, detachedLinks: Array<object>,
 *            brokenTargets: Array<object>, error?: string}}
 */
export function removeResidueTree(root, opts = {}) {
  const {
    primaryPath = null,
    onProgress = null,
    progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
    progressEveryFiles = DEFAULT_PROGRESS_EVERY_FILES,
    now = () => Date.now(),
  } = opts;

  const guard = assertDeletableRoot(root, { primaryPath });
  if (!guard.ok) {
    return { ok: false, removedFiles: 0, removedLinks: 0, dirs: 0, elapsedMs: 0, detachedLinks: [], brokenTargets: [], error: guard.error };
  }

  const started = now();
  const rootIdentityStat = fs.lstatSync(guard.resolved);
  const rootIdentity = { dev: rootIdentityStat.dev, ino: rootIdentityStat.ino };
  const preflight = scanReparsePoints(guard.resolved);
  if (preflight.unreadable.length > 0) {
    return {
      ok: false, removedFiles: 0, removedLinks: 0, dirs: 0, elapsedMs: 0, detachedLinks: [], brokenTargets: [],
      error: 'preflight incomplete: ' + preflight.unreadable.length + ' unreadable directory/directories (first: ' +
        preflight.unreadable[0].path + ') — refusing to delete a partly unreadable tree',
    };
  }
  const total = preflight.files + preflight.dirs + preflight.links.length;

  let removedFiles = 0;
  let removedLinks = 0;
  let removedDirs = 0;
  let lastReport = started;
  const detachedLinks = [];
  const brokenTargets = [];

  const report = (force = false) => {
    if (!onProgress) return;
    const at = now();
    if (!force && at - lastReport < progressIntervalMs) return;
    lastReport = at;
    const done = removedFiles + removedDirs + removedLinks;
    onProgress({
      removedFiles,
      removedLinks,
      removedDirs,
      remaining: Math.max(total - done, 0),
      elapsedMs: at - started,
    });
  };

  const detachLink = (linkPath) => {
    let target = null;
    try {
      target = fs.readlinkSync(linkPath);
    } catch {
      target = null;
    }
    const resolvedTarget = resolveLinkTarget(linkPath, target);
    const existedBefore = resolvedTarget !== null ? fs.existsSync(resolvedTarget) : null;
    fs.unlinkSync(linkPath);
    removedLinks += 1;
    const stillThere = resolvedTarget !== null ? fs.existsSync(resolvedTarget) : null;
    detachedLinks.push({ path: linkPath, target, targetExistedBefore: existedBefore, targetStillExists: stillThere });
    if (target && existedBefore === true && stillThere === false) {
      brokenTargets.push({ path: linkPath, target });
    }
    report();
  };

  // Open the directory first, then lstat its path before reading the handle.
  // If a directory is swapped for a junction between enumeration and descent,
  // the handle may have opened the target, but the post-open lstat detects the
  // reparse point and the handle is closed without reading a single entry.
  const walk = (dir, isRoot = false) => {
    let handle;
    try {
      handle = fs.opendirSync(dir);
    } catch (openError) {
      let stat;
      try {
        stat = fs.lstatSync(dir);
      } catch {
        if (openError && openError.code === 'ENOENT') return false;
        throw openError;
      }
      if (stat.isSymbolicLink()) {
        if (isRoot) throw new Error('refusing to traverse a root reparse point: ' + dir);
        detachLink(dir);
        return false;
      }
      if (!stat.isDirectory()) {
        // A directory recorded by the scan became an ordinary file mid-walk.
        // That file may be someone's data written through a non-cooperating
        // handle; deleting it would destroy unknown work (git-4). Fail closed.
        if (isRoot) throw new Error('root stopped being a directory: ' + dir);
        throw new Error('directory ' + dir + ' was replaced by a non-link object during deletion; refusing to unlink it (fail-closed)');
      }
      throw openError;
    }

    let stat;
    try {
      stat = fs.lstatSync(dir);
    } catch (err) {
      handle.closeSync();
      throw err;
    }
    if (stat.isSymbolicLink()) {
      handle.closeSync();
      if (isRoot) throw new Error('refusing to traverse a root reparse point: ' + dir);
      detachLink(dir);
      return false;
    }
    if (!stat.isDirectory()) {
      handle.closeSync();
      if (isRoot) throw new Error('root stopped being a directory: ' + dir);
      // Same rule as the open-failure path: a scanned directory that became an
      // ordinary file mid-walk is unknown work — never unlink it silently.
      throw new Error('directory ' + dir + ' was replaced by a non-link object during deletion; refusing to unlink it (fail-closed)');
    }

    // Identity of the exact directory this handle enumerates. Every path-based
    // child mutation below is preceded by a re-check against this identity: if
    // an ancestor swapped this path for a junction, lstat now names a different
    // object and the deletion fails closed instead of unlinking outside the
    // tree (Node has no unlink-at-fd primitive to do better).
    const dirIdentity = { dev: stat.dev, ino: stat.ino };
    const assertParentStable = () => {
      const now = fs.lstatSync(dir);
      if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== dirIdentity.dev || now.ino !== dirIdentity.ino) {
        throw new Error('directory ' + dir + ' was replaced during deletion; refusing path-based unlink (fail-closed)');
      }
    };
    const assertChildUnchanged = (full, childStat) => {
      const now = fs.lstatSync(full);
      if (now.dev !== childStat.dev || now.ino !== childStat.ino) {
        throw new Error('entry ' + full + ' changed identity during deletion; refusing to unlink it (fail-closed)');
      }
    };

    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        const full = path.join(dir, entry.name);
        let childStat;
        try {
          childStat = fs.lstatSync(full);
        } catch (err) {
          if (err && err.code === 'ENOENT') continue;
          throw err;
        }
        if (childStat.isSymbolicLink()) {
          assertParentStable();
          assertChildUnchanged(full, childStat);
          detachLink(full);
        } else if (childStat.isDirectory()) {
          assertParentStable();
          assertChildUnchanged(full, childStat);
          if (walk(full)) {
            assertParentStable();
            assertChildUnchanged(full, childStat);
            fs.rmdirSync(full);
            removedDirs += 1;
            report();
          }
        } else {
          assertParentStable();
          assertChildUnchanged(full, childStat);
          fs.unlinkSync(full);
          removedFiles += 1;
          if (removedFiles % progressEveryFiles === 0) report(true);
          else report();
        }
      }
    } finally {
      handle.closeSync();
    }
    return true;
  };

  try {
    walk(guard.resolved, true);
    // The final rmdir resolves the root path through its ancestors too. Verify
    // the root still names the directory this walk emptied before removing it.
    const rootNow = fs.lstatSync(guard.resolved);
    if (rootNow.isSymbolicLink() || !rootNow.isDirectory()
      || rootNow.dev !== rootIdentity.dev || rootNow.ino !== rootIdentity.ino) {
      throw new Error('tree root ' + guard.resolved + ' was replaced during deletion; refusing the final rmdir (fail-closed)');
    }
    fs.rmdirSync(guard.resolved);
    removedDirs += 1;
    report(true);
  } catch (err) {
    const elapsed = now() - started;
    report(true);
    return {
      ok: false,
      removedFiles,
      removedLinks,
      dirs: removedDirs,
      elapsedMs: elapsed,
      detachedLinks,
      brokenTargets,
      error: String((err && err.message) || err),
    };
  }

  const elapsedMs = now() - started;
  return {
    ok: brokenTargets.length === 0,
    removedFiles,
    removedLinks,
    dirs: removedDirs,
    elapsedMs,
    detachedLinks,
    brokenTargets,
    totalPlanned: total,
    error: brokenTargets.length > 0 ? 'a detached link lost its external target — investigate before continuing' : undefined,
  };
}

/** Default human-readable progress line (the walk stays silent without a sink). */
export function formatProgress(p) {
  const seconds = Math.round(p.elapsedMs / 1000);
  return (
    '  …deleting: ' +
    p.removedFiles +
    ' files, ' +
    p.removedLinks +
    ' links, ' +
    p.removedDirs +
    ' dirs; ~' +
    p.remaining +
    ' remaining; ' +
    seconds +
    's elapsed'
  );
}
