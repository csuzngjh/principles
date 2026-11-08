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
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      unreadable.push({ path: dir, error: String((err && err.message) || err) });
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // Dirent for a reparse point reports isSymbolicLink(); never call stat,
      // which would traverse into the target.
      if (entry.isSymbolicLink()) {
      // PRI-796 review: readlink returns RELATIVE targets verbatim — resolving
      // them against the process cwd reports existence wrongly. The shared
      // resolveLinkTarget anchors them at the link's own directory.
      let target = null;
      try {
        target = fs.readlinkSync(full);
      } catch {
        target = null;
      }
      const resolvedTarget = resolveLinkTarget(full, target);
      links.push({ path: full, target, targetExists: resolvedTarget !== null && fs.existsSync(resolvedTarget) });
      continue;
      }
      if (entry.isDirectory()) {
        dirs += 1;
        stack.push(full);
      } else {
        files += 1;
      }
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
 * `external` = every link the deleter must NOT be allowed to traverse:
 *   * target outside `root` (the ERR-098 direction);
 *   * target unresolvable / unreadable — an unprovable direction is UNKNOWN,
 *     and git-14 forbids acting on unknowns;
 *   * target containing a `..` component: lexical normalisation is not what the
 *     OS does when a link precedes it (R/a -> R, R/a/../victim is R's sibling);
 *   * a link whose target contains the link itself (self/ancestor cycle) — git
 *     recurses through it until the removal fails and leaves a residue shell.
 * `internal` = targets proven inside `root` and non-cyclic.
 *
 * `complete` is false when any directory could not be enumerated or `root`
 * itself could not be resolved. `safe` is the ONLY flag a deleter may use.
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
    const row = {
      path: link.path,
      target: link.target,
      resolvedTarget: lexical,
      canonicalTarget,
      targetExists: link.targetExists,
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
    const probe = link.canonicalTarget || link.resolvedTarget;
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
  const failed = detached.filter((d) => d.error !== null);
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
  for (const link of before.internal) {
    try {
      fs.unlinkSync(link.path);
      detached.push({ path: link.path, target: link.target });
    } catch (err) {
      failedToDetach.push({ path: link.path, error: String((err && err.message) || err) });
    }
  }
  const after = classifyReparsePoints(root);
  return {
    detached,
    failedToDetach,
    remainingLinks: after.links,
    complete: after.complete,
    ok: failedToDetach.length === 0 && after.complete && after.links === 0,
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

  const walk = (dir) => {
    let entries;
    entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Detach the link ITSELF. `unlink` on a Windows directory junction is
        // verified to remove only the reparse point, leaving the target intact.
        let target = null;
        try {
          target = fs.readlinkSync(full);
        } catch {
          target = null;
        }
        // Round-3 review: the existence probe must go through the SAME
        // link-directory resolver as the pre-flight scan — a relative target
        // checked against the process cwd wrongly reported "did not exist",
        // silently downgrading the very anomaly detection this walk performs.
        const resolvedTarget = resolveLinkTarget(full, target);
        const existedBefore = resolvedTarget !== null ? fs.existsSync(resolvedTarget) : null;
        fs.unlinkSync(full);
        removedLinks += 1;
        const stillThere = resolvedTarget !== null ? fs.existsSync(resolvedTarget) : null;
        detachedLinks.push({ path: full, target, targetExistedBefore: existedBefore, targetStillExists: stillThere });
        if (target && existedBefore === true && stillThere === false) {
          // The link was followed, or the external target was destroyed
          // concurrently. Either way this is a serious anomaly — surface it.
          brokenTargets.push({ path: full, target });
        }
        report();
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        fs.rmdirSync(full);
        removedDirs += 1;
        report();
      } else {
        fs.unlinkSync(full);
        removedFiles += 1;
        if (removedFiles % progressEveryFiles === 0) report(true);
        else report();
      }
    }
  };

  try {
    walk(guard.resolved);
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
