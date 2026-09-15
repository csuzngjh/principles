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
 * Returns the counts (for progress) and every link found (for the safety
 * report), so the operator sees what will be detached BEFORE anything is.
 *
 * @returns {{links: Array<{path: string, target: string, targetExists: boolean}>,
 *            files: number, dirs: number}}
 */
export function scanReparsePoints(root) {
  const links = [];
  let files = 0;
  let dirs = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — the delete walk will surface it
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
  return { links, files, dirs };
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
