/**
 * PD-SPEC-001 Phase 0c step 1 — workspace DB snapshot (read-only, gated)
 * + linkage discovery for the pain inventory.
 *
 * PD-Lab v0.3 / PRI-1251 (T1): parameterized, blob-inclusive read-only
 * snapshot per TECH-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3 §5.1.
 * PRI-1251 remediation round (P1 review A1–A4).
 *
 * Contract:
 * - `--source-workspace <dir>` and `--out <dir>` are both REQUIRED. A missing
 *   or valueless flag exits 2 with usage on stderr. No defaults, no machine
 *   paths, no env fallback.
 * - WRITE-ONCE: `--out` must not exist (a dangling junction/symlink at the
 *   target counts as existing). Even an empty directory is refused: a snapshot
 *   directory must be born from exactly one verified run, and admitting
 *   pre-existing content would complicate the atomic-publish guarantee. The
 *   run materializes in a private sibling staging directory and is RENAMED to
 *   `--out` only after every check passed; the published layout is unchanged
 *   (<out>/snapshot/..., <out>/README.md, <out>/snapshot-report.json). Any
 *   failure removes the staging directory and never touches `--out`.
 * - Source DBs are opened READONLY (fileMustExist) and never written; copies
 *   come from the better-sqlite3 backup API. HARD GATES (exit 1, nothing
 *   published): source integrity_check not ok; copy integrity_check not ok;
 *   a core table missing on either side; a row-count divergence between
 *   source and copy that no detected source-side change explains.
 * - Physical path containment (A1): the containment check resolves REAL paths
 *   (`fs.realpathSync.native`, which follows Windows junctions/symlinks), not
 *   lexical ones; a target that does not exist is resolved through its nearest
 *   existing ancestor, so an alias parent (junction/symlink pointing into the
 *   source workspace) cannot smuggle the output inside the source. Windows
 *   comparison is case-insensitive. Referenced blob sources must resolve, via
 *   realpath, INSIDE the authorized source blob dir and must be regular
 *   files; out-of-bounds aliases and directories-in-blob-names are rejected
 *   before copying.
 * - TOCTOU staging fence (round 3): the staging area is THREE layers —
 *   `<staging>`, `<staging>/snapshot`, `<staging>/snapshot/blobs` — and each
 *   layer carries an identity anchor captured at creation time: the expected
 *   canonical path, the `fs.realpathSync.native()` real path, the directory
 *   type, and platform file identity (the NTFS/ReFS file id `ino` everywhere,
 *   plus the creation time `birthtimeMs` on Windows), plus a per-layer
 *   marker file `.pd-snapshot-fence-marker` holding a per-run random token —
 *   the PORTABLE delete-and-recreate detector, because some Linux filesystems
 *   (ext4/overlayfs/tmpfs) can hand a freed inode straight back to the
 *   recreated directory, making `ino` alone unreliable there (observed on CI).
 *   `mtimeMs` is NOT used: legitimate writes into a layer change the
 *   directory mtime and would false-positive. The anchors are re-verified
 *   BEFORE AND AFTER every critical operation — each SQLite backup (the async
 *   backup completes and the test-only hooks run BEFORE the post-backup
 *   verification, so a hook that swaps a layer mid-run is caught before the
 *   next phase reads or writes through the replacement), each blob copy, the
 *   manifest write, the README write, the report write and the final publish
 *   (markers are stripped after publish:pre and one marker-exempt
 *   publish:final verification runs before the rename, so the published
 *   layout stays exactly `<out>/snapshot/...`). A layer that is missing, a
 *   symlink/junction/reparse point (`lstat.isSymbolicLink()`), an
 *   unresolvable path, a changed real path, a real path inside the source
 *   workspace, or a platform-identity/marker mismatch (deleted-and-recreated
 *   directory) fails the run immediately: structured reason naming the
 *   failing layer and phase, staging cleaned, nothing published, exit 1.
 *   Cleanup is identity-bound too: only directories whose root identity is
 *   still provable are removed; a replaced link is DETACHED (`unlink`, with
 *   a plain `rmdir` fallback) and never recursed into, and a directory whose
 *   identity cannot be proven is left on disk and the refusal is recorded on
 *   the error's `details.stagingCleanup`.
 * - Cross-source consistency (A3): the two DBs and the blob files are not one
 *   atomic transaction. The pipeline captures a source-side BASELINE before
 *   the backups — `PRAGMA data_version` per DB (catches any other-connection
 *   commit, including updates that change no timestamp), per-core-table
 *   `COUNT(*)`/`MAX(rowid)`, and a blob-dir hash map — and re-reads the same
 *   facts after the copies. Any difference proves (or cannot disprove) a
 *   concurrent write, and the run is marked PARTIAL_CONSISTENCY: the outputs
 *   ARE published (layout unchanged, `published: true`) but `ok` is FALSE —
 *   in the returned result, the top level of snapshot-report.json and
 *   blob-manifest.json, the CLI stdout JSON, and the README. The EXIT CODE IS
 *   1 — formal pipelines must treat the directory as NOT a complete snapshot;
 *   publication is not success.
 *   This tool proves at most that the source stayed stable across its own
 *   window; it does not freeze a distributed transaction (TECH §5.1).
 * - All SQL uses bound parameters. The only identifiers interpolated into
 *   statement text come from the copy's own sqlite_master and must match
 *   /^[A-Za-z0-9_]+$/; blob refs must match the store's plain-file-name shape
 *   (no separators, no traversal).
 *
 * Testability (deterministic fault injection — tests only):
 * - `runSnapshotPipeline({ sourceWorkspace, outDir }, hooks?)` is exported so
 *   tests can drive the REAL pipeline in-process. The CLI entry passes no
 *   hooks; its observable behavior does not depend on them.
 * - hooks.afterBackup({ name, stagingDbPath, sourceDbPath }) fires after a
 *   backup lands in staging and before that copy's integrity gate. The
 *   staging fence re-verifies all three layers immediately AFTER the hook
 *   returns.
 * - hooks.afterBlobCopy({ stagingBlobDir, sourceBlobDir }) fires after the
 *   blob copy loop and before the post-copy re-verification; the fence
 *   re-verifies all three layers immediately after it returns.
 * - hooks.beforePublish({ stagingDir, outDir }) fires right before the final
 *   publish gate (after every artifact was written and verified, before the
 *   rename). The fence verifies all three layers there too.
 * - `SnapshotError` (with `.reason`) is thrown for every structural refusal;
 *   the CLI prints it as structured JSON on stderr and exits 1.
 */
import { createRequire } from 'node:module';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { resolveStateDbPath, resolveTrajectoryDbPath } = require('@principles/core/runtime/storage-paths');
const { resolvePdPath } = require('../../../packages/openclaw-plugin/dist/core/paths.js');

const USAGE = [
  'usage: node snapshot-and-discover.mjs --source-workspace <dir> --out <dir>',
  '',
  '  --source-workspace <dir>  PD workspace whose .pd/state.db,',
  '                            .state/trajectory.db and .state/blobs are',
  '                            snapshotted. Opened read-only; never written.',
  '  --out <dir>               snapshot output directory. Must live outside',
  '                            the source workspace (checked through junctions',
  '                            and symlinks) and must NOT already exist',
  '                            (write-once; the run publishes atomically).',
  '',
  'Both flags are required; there are no defaults.',
].join('\n');

// ── Structured failure (rc-9 / cli-6: reason + next action, fail loud) ──────

export class SnapshotError extends Error {
  /**
   * @param {string} reason   machine-readable cause code
   * @param {string} nextAction what the operator should do next
   * @param {{ stage?: string, details?: unknown }} [meta]
   */
  constructor(reason, nextAction, meta = {}) {
    super(reason);
    this.name = 'SnapshotError';
    this.reason = reason;
    this.nextAction = nextAction;
    this.stage = meta.stage ?? 'pipeline';
    this.details = meta.details;
  }
}

function fail(reason, nextAction, meta) {
  throw new SnapshotError(reason, nextAction, meta);
}

// ── Argument parsing (exit 2 on any misuse) ─────────────────────────────────

const argv = process.argv.slice(2);

/**
 * null = flag absent; undefined = present but its value is missing/empty/another
 * flag (a usage error); string = the value.
 */
function readOpt(name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const value = argv[i + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) return undefined;
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(text, max = 200) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

// ── Physical path containment helpers (A1) ──────────────────────────────────

/** Locale-independent ASCII lowercasing (Windows path comparison). */
function asciiLower(p) {
  return p.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function pathsEqual(a, b) {
  if (process.platform === 'win32') return asciiLower(a) === asciiLower(b);
  return a === b;
}

function containsLexical(ancestor, candidate) {
  let a = path.resolve(ancestor);
  let c = path.resolve(candidate);
  if (process.platform === 'win32') {
    a = asciiLower(a);
    c = asciiLower(c);
  }
  const rel = path.relative(a, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Real-path resolution that survives missing leaf directories: walk up to the
 * nearest EXISTING ancestor, realpath it (follows junctions/symlinks), then
 * re-attach the non-existing remainder lexically. This is what lets the
 * containment check catch `alias/newdir/out` where `alias` is a junction into
 * the source workspace and `newdir/out` do not exist yet.
 */
function realPathPreservingMissing(target) {
  let current = path.resolve(target);
  const remainder = [];
  for (;;) {
    if (existsSync(current)) break;
    const parent = path.dirname(current);
    if (parent === current) break; // reached the root
    remainder.unshift(path.basename(current));
    current = parent;
  }
  const real = realpathSync.native(current); // throws if the drive is gone
  return path.join(real, ...remainder);
}

/** existsSync follows dangling reparse points to `false`; lstat catches them. */
function pathExistsIncludingDangling(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const IDENTIFIER_RE = /^[A-Za-z0-9_]+$/;
const BLOB_REF_SHAPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const COUNT_TABLES = {
  state: ['tasks', 'runs', 'artifacts', 'pi_artifacts', 'principle_candidates', 'pain_diagnoses', 'dead_letter_pains', 'pending_agent_drafts', 'intent_decisions'],
  trajectory: ['pain_events'],
};

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function tableExists(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
}

function openReadonly(dbPath, errorReason, nextAction) {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    fail(`${errorReason}:${bounded(e?.message ?? e, 160)}`, nextAction, { details: { dbPath } });
  }
}

/**
 * Strict regular-file hash map of a directory, classified with lstat:
 * a reparse point (symlink/junction) is NEVER followed — its target bytes are
 * not read, and the entry fails the run instead; a non-regular entry (a
 * directory or special file occupying a blob-store name) also fails the run.
 * Only plain regular files are hashed, so SHA-256 semantics are unchanged
 * for a well-formed store. A momentary ENOENT (entry vanished between
 * readdir and lstat) is skipped here by design: the second captureFacts()
 * pass at the end of the window surfaces it as a blob drift.
 */
function hashRegularFiles(dir, when) {
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = lstatSync(full, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (st === undefined) continue; // vanished mid-scan; drift detection covers it
    if (st.isSymbolicLink()) {
      fail(
        `source_blob_dir_entry_reparse:${entry}:${when}`,
        'The source blob dir contains a symlink/junction instead of a plain file; refusing to read through it or copy from it. Inspect the blob dir',
        { stage: `blob-baseline:${when}`, details: { dir } },
      );
    }
    if (!st.isFile()) {
      fail(
        `source_blob_dir_entry_not_regular:${entry}:${st.isDirectory() ? 'directory' : 'special'}:${when}`,
        'The source blob dir must contain plain regular files only; refusing to snapshot around this entry',
        { stage: `blob-baseline:${when}`, details: { dir } },
      );
    }
    map.set(entry, sha256File(full));
  }
  return map;
}

function diffFileMaps(baseline, current) {
  const changed = [];
  for (const [name, sha] of current) {
    if (!baseline.has(name)) changed.push(`source_blob_added:${name}`);
    else if (baseline.get(name) !== sha) changed.push(`source_blob_changed:${name}`);
  }
  for (const name of baseline.keys()) {
    if (!current.has(name)) changed.push(`source_blob_removed:${name}`);
  }
  return changed.sort();
}

// ── Staging identity fence (three layers: staging / snapshot / blobs) ───────

/**
 * Capture a directory identity anchor at creation time.
 *
 * Anchor components (and why):
 * - `realPath`: `fs.realpathSync.native()` at capture time. A later realpath
 *   that differs proves the path now resolves somewhere else (replaced by an
 *   alias, or its parent chain was re-pointed).
 * - `ino`: the platform file id (`statSync().ino`; NTFS/ReFS file reference
 *   number on Windows). Stable across content writes, metadata changes and
 *   renames for the lifetime of the directory. On Windows a delete-and-recreate
 *   at the same path yields a fresh id; on some Linux filesystems (ext4 group
 *   allocators, overlayfs, tmpfs) the freed id CAN be handed straight back to
 *   the recreated directory, so `ino` alone is not portable evidence — CI
 *   proved this (FENCE-9/10 red on ubuntu: recreated dir kept the same ino).
 * - `birthtimeMs` (win32 only): the NTFS creation time. Independent of
 *   content writes; hardens the same recreate case. Not usable on POSIX
 *   (where Node derives birthtime from ctime, which legitimate writes change).
 * - `marker` (portable, primary recreate detector): a per-layer file
 *   `.pd-snapshot-fence-marker` holding a per-run random token written at
 *   capture and verified byte-exact at every gate — classified and read
 *   through ONE file handle (`openSync` + `fstatSync` + bounded `readSync`),
 *   so there is no separate check-then-read window on the marker path. Any
 *   delete-and-recreate — even one that reuses the inode — loses the marker;
 *   a swapped-in directory does not know the token. Markers are stripped
 *   immediately before the publish rename (after the final verification) so
 *   the published layout stays exactly `<out>/snapshot/...`; that
 *   strip-to-rename window is nanoseconds and keeps every non-marker check
 *   active.
 * - `mtimeMs` is deliberately NOT anchored: adding/removing entries (i.e.
 *   every legitimate backup/blob write into the layer) updates directory
 *   mtime and would false-positive.
 * - Symlinks/junctions are rejected at capture (nothing legitimate ever
 *   makes a staging layer a reparse point) and at every verification via
 *   `lstat().isSymbolicLink()`, which is true for both symlinks and Windows
 *   junctions (directory reparse points).
 */
const FENCE_MARKER_NAME = '.pd-snapshot-fence-marker';
// The marker token is 32 hex chars; anything longer is not our marker.
const FENCE_MARKER_MAX_BYTES = 64;

/**
 * Classify-and-read the fence marker through ONE file handle: `fstatSync(fd)`
 * and the bounded `readSync` share the same fd, so there is no separate
 * check-then-read window on the path (CodeQL js/toctou-race-condition). The
 * marker's purpose is only to give its bytes back — the LAYER's identity is
 * pinned by the directory anchor (lstat/realpath/ino/birthtime), not by the
 * marker's path metadata. Returns null for anything that is not a small
 * readable regular file (missing, directory, symlink target, oversized).
 */
function readFenceMarker(markerPath) {
  let fd;
  try {
    fd = openSync(markerPath, 'r');
  } catch {
    return null;
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) return null;
    const size = fst.size;
    if (!Number.isInteger(size) || size < 0 || size > FENCE_MARKER_MAX_BYTES) return null;
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (!Number.isInteger(n) || n <= 0) return null;
      off += n;
    }
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already closed */
    }
  }
}

function captureDirIdentity(layer, dirPath) {
  const lst = lstatSync(dirPath);
  if (lst.isSymbolicLink()) {
    fail(`staging_layer_reparse:${layer}:capture`, 'A staging layer must be a real directory, not a symlink/junction; refusing to build the snapshot through it', { stage: `staging-fence:capture:${layer}` });
  }
  if (!lst.isDirectory()) {
    fail(`staging_layer_not_directory:${layer}:capture`, 'A staging layer is not a directory; refusing to continue', { stage: `staging-fence:capture:${layer}` });
  }
  const real = realpathSync.native(dirPath);
  const st = statSync(dirPath);
  const markerPath = path.join(dirPath, FENCE_MARKER_NAME);
  const token = randomBytes(16).toString('hex');
  writeFileSync(markerPath, token, 'utf8');
  if (readFenceMarker(markerPath) !== token) {
    fail(`staging_layer_marker_invalid:${layer}:capture`, 'The staging fence marker could not be established as a small plain file holding its token; refusing to continue', { stage: `staging-fence:capture:${layer}` });
  }
  return {
    layer,
    expectedPath: dirPath,
    realPath: real,
    ino: st.ino,
    ...(process.platform === 'win32' ? { birthtimeMs: st.birthtimeMs } : {}),
    markerPath,
    markerToken: token,
  };
}

/**
 * Re-verify a layer anchor. Every failure is a hard, structured stop: the
 * failing layer and the pipeline phase (`what`) are part of the reason so an
 * operator can tell WHICH swap at WHICH stage was refused.
 */
function verifyDirIdentity(anchor, what, sourceReal, opts = {}) {
  const { layer } = anchor;
  const skipMarker = opts.skipMarker === true;
  let lst;
  try {
    lst = lstatSync(anchor.expectedPath, { throwIfNoEntry: false });
  } catch {
    lst = undefined;
  }
  if (lst === undefined) {
    fail(`staging_layer_missing:${layer}:${what}`, 'A staging layer disappeared mid-run (deleted/replaced?); refusing to continue — nothing was published', { stage: `staging-fence:${what}`, details: { layer, expectedPath: anchor.expectedPath } });
  }
  if (lst.isSymbolicLink()) {
    fail(`staging_layer_reparse:${layer}:${what}`, 'A staging layer was replaced by a symlink/junction mid-run; refusing to read or write through it — nothing was published', { stage: `staging-fence:${what}`, details: { layer, expectedPath: anchor.expectedPath } });
  }
  if (!lst.isDirectory()) {
    fail(`staging_layer_not_directory:${layer}:${what}`, 'A staging layer is no longer a directory; refusing to continue — nothing was published', { stage: `staging-fence:${what}`, details: { layer, expectedPath: anchor.expectedPath } });
  }
  let real;
  try {
    real = realpathSync.native(anchor.expectedPath);
  } catch (e) {
    fail(`staging_layer_unresolvable:${layer}:${what}:${bounded(e?.message ?? e, 120)}`, 'A staging layer path could not be resolved to a physical location; refusing to continue — nothing was published', { stage: `staging-fence:${what}`, details: { layer } });
  }
  if (!pathsEqual(real, anchor.realPath)) {
    fail(`staging_layer_path_changed:${layer}:${what}:${real}`, 'A staging layer now resolves to a different physical location; refusing to continue — nothing was published', { stage: `staging-fence:${what}`, details: { layer, expected: anchor.realPath, actual: real } });
  }
  if (containsLexical(sourceReal, real)) {
    fail(`staging_layer_inside_source:${layer}:${what}:${real}`, 'A staging layer resolved INSIDE the source workspace; refusing to write there — nothing was published', { stage: `staging-fence:${what}`, details: { layer } });
  }
  let st;
  try {
    st = statSync(anchor.expectedPath);
  } catch (e) {
    fail(`staging_layer_unresolvable:${layer}:${what}:${bounded(e?.message ?? e, 120)}`, 'A staging layer could not be stat-ed; refusing to continue — nothing was published', { stage: `staging-fence:${what}`, details: { layer } });
  }
  if (typeof anchor.ino === 'number' && anchor.ino > 0 && st.ino !== anchor.ino) {
    fail(`staging_layer_identity_changed:${layer}:${what}:ino:${anchor.ino}->${st.ino}`, 'A staging layer was deleted and recreated (or swapped for another directory) mid-run; the platform file id changed — refusing to continue, nothing was published', { stage: `staging-fence:${what}`, details: { layer } });
  }
  if (process.platform === 'win32' && typeof anchor.birthtimeMs === 'number' && st.birthtimeMs !== anchor.birthtimeMs) {
    fail(`staging_layer_identity_changed:${layer}:${what}:birthtime`, 'A staging layer was deleted and recreated mid-run (creation time changed) — refusing to continue, nothing was published', { stage: `staging-fence:${what}`, details: { layer } });
  }
  // Portable delete-and-recreate proof: the per-run random marker must still
  // be there, be a small plain file, and carry the exact capture-time token
  // (classified and read through a single fd — no check-then-read window).
  // An inode-reusing recreate (observed on Linux CI filesystems) loses the
  // marker; a swapped-in directory cannot know the token. Skipped only at
  // the publish:final gate AFTER the markers were deliberately stripped.
  if (!skipMarker && typeof anchor.markerPath === 'string') {
    const markerBody = readFenceMarker(anchor.markerPath);
    if (markerBody === null || markerBody !== anchor.markerToken) {
      const detail = markerBody === null ? 'marker_missing' : 'marker_content_mismatch';
      fail(`staging_layer_identity_changed:${layer}:${what}:${detail}`, 'A staging layer was deleted and recreated (or swapped) mid-run; the fence marker is gone or altered — refusing to continue, nothing was published', { stage: `staging-fence:${what}`, details: { layer } });
    }
  }
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Run the whole gated snapshot pipeline. Throws SnapshotError on any
 * structural refusal (nothing is published, staging cleaned). Returns
 * `{ ok, published, status, report, manifest, outDir }`; status is
 * 'CONSISTENT_WITHIN_WINDOW' (ok:true, exit 0 semantics) or
 * 'PARTIAL_CONSISTENCY' (ok:false BUT published:true — outputs are on disk
 * and flagged; exit 1 semantics for the CLI).
 */
export async function runSnapshotPipeline(options, hooks = {}) {
  const { sourceWorkspace: sourceRaw, outDir: outRaw } = options;
  if (typeof sourceRaw !== 'string' || sourceRaw.length === 0) fail('source_workspace_missing', 'Pass --source-workspace <dir> pointing at an initialized PD workspace');
  if (typeof outRaw !== 'string' || outRaw.length === 0) fail('out_missing', 'Pass --out <dir> outside the source workspace');

  const sourceWorkspace = path.resolve(sourceRaw);
  const outDir = path.resolve(outRaw);

  // A1: physical containment FIRST (before any directory is created).
  const sourceReal = realPathPreservingMissing(sourceWorkspace);
  const outReal = realPathPreservingMissing(outDir);
  if (containsLexical(sourceReal, outReal)) {
    fail(
      `out_inside_source_workspace:${outReal}`,
      'The snapshot output must live OUTSIDE the source workspace (junction and symlink aliases are resolved before judging); writing into it would violate the read-only discipline',
      { stage: 'containment', details: { sourceReal } },
    );
  }

  // Source DB existence keeps priority over write-once so an uninitialized
  // workspace is reported as the input problem it is.
  const SOURCES = {
    state: resolveStateDbPath(sourceWorkspace),
    trajectory: resolveTrajectoryDbPath(sourceWorkspace),
  };
  const sourceBlobDir = resolvePdPath(sourceWorkspace, 'TRAJECTORY_BLOBS_DIR');
  for (const [name, srcPath] of Object.entries(SOURCES)) {
    if (!existsSync(srcPath)) {
      fail(
        `source_db_missing:${name}:${srcPath}`,
        'Point --source-workspace at an initialized PD workspace (pd runtime init) and retry',
        { stage: 'source-check' },
      );
    }
  }

  // A4: write-once — the target must not exist in any form (dangling aliases
  // included). Strict semantics: even an empty directory is refused so a
  // snapshot directory is always born from exactly one verified run.
  if (pathExistsIncludingDangling(outDir)) {
    fail(
      `out_already_exists:${outDir}`,
      'Write-once: pick a fresh --out or deliberately remove the stale directory first; the tool never merges into or overwrites an existing snapshot',
      { stage: 'write-once' },
    );
  }

  // Prepare the publish parent, re-verify containment physically (a mkdir
  // through an alias could have landed elsewhere), then create the staging
  // directory on the SAME volume so publishing is an atomic rename.
  const outParent = path.dirname(outDir);
  mkdirSync(outParent, { recursive: true });
  const outParentReal = realpathSync.native(outParent);
  if (containsLexical(sourceReal, outParentReal)) {
    fail(
      `out_parent_inside_source_workspace:${outParentReal}`,
      'The resolved parent of --out sits inside the source workspace; choose an --out whose parent is outside it',
      { stage: 'staging' },
    );
  }
  const stagingDir = mkdtempSync(path.join(outParentReal, '.pd-snapshot-staging-'));
  const stagingReal = realpathSync.native(stagingDir);
  const snapDir = path.join(stagingDir, 'snapshot');
  const snapBlobsDir = path.join(snapDir, 'blobs');
  // Set by the publish gate once the fence markers were deliberately
  // stripped (post publish:pre verification, pre rename); from that moment
  // the cleanup identity proof relies on path/ino/birthtime alone.
  let markersStripped = false;

  // Identity anchor for the staging fence. The staging layer exists now;
  // snapshot/ and blobs/ are created (and anchored) at the start of Phase 1
  // inside the guarded pipeline body. If THIS capture fails, the root's
  // identity is unprovable — per the cleanup policy such a directory is
  // deliberately left for a human, so the failure is converted to a
  // structured SnapshotError BEFORE the guarded body (no cleanup path runs).
  let stagingAnchor;
  try {
    stagingAnchor = captureDirIdentity('staging', stagingDir);
  } catch (e) {
    if (e instanceof SnapshotError) throw e;
    fail(
      `staging_layer_capture_failed:staging:${bounded(e?.message ?? e, 120)}`,
      'The freshly created staging directory could not be anchored; nothing was published. Inspect the output volume and re-run',
      { stage: 'staging-fence:capture:staging' },
    );
  }
  const layerAnchors = { staging: stagingAnchor };

  /**
   * TOCTOU fence: EVERY layer must still be the directory we created.
   * `what` names the pipeline phase so a refusal says which swap at which
   * stage was caught. Called before AND after every critical write. `opts`
   * is forwarded to the verifier (publish:final skips the already-stripped
   * marker checks).
   */
  const assertStagingIntact = (what, opts = {}) => {
    if (layerAnchors.snapshot === undefined || layerAnchors.blobs === undefined) {
      fail('staging_fence_anchors_incomplete', 'Internal error: staging layers were not anchored before use; nothing was published', { stage: `staging-fence:${what}` });
    }
    verifyDirIdentity(layerAnchors.staging, what, sourceReal, opts);
    verifyDirIdentity(layerAnchors.snapshot, what, sourceReal, opts);
    verifyDirIdentity(layerAnchors.blobs, what, sourceReal, opts);
  };

  /** Detach a symlink/junction itself; never recurse into its target. */
  const detachLink = (linkPath) => {
    try {
      unlinkSync(linkPath);
    } catch {
      // Some platforms/Node versions require rmdir for a junction. Plain
      // rmdirSync is non-recursive by definition (the `recursive` option was
      // removed outright in newer Node).
      rmdirSync(linkPath);
    }
  };

  /**
   * No-follow tree removal for directories WE created and can still prove:
   * every entry is classified with lstat first; a symlink/junction child is
   * detached (never traversed), real directories are recursed and rmdir'd,
   * files are unlinked. Cleanup failures are collected, never silent.
   */
  const removeTreeNoFollow = (rootPath, failures) => {
    let lst;
    try {
      lst = lstatSync(rootPath, { throwIfNoEntry: false });
    } catch (e) {
      failures.push(`lstat_failed:${bounded(e?.message ?? e, 120)}`);
      return;
    }
    if (lst === undefined) return;
    if (lst.isSymbolicLink()) {
      try {
        detachLink(rootPath);
      } catch (e) {
        failures.push(`detach_link_failed:${bounded(e?.message ?? e, 120)}`);
      }
      return;
    }
    if (!lst.isDirectory()) {
      try {
        rmSync(rootPath, { force: true, maxRetries: 3, retryDelay: 100 });
      } catch (e) {
        failures.push(`unlink_file_failed:${bounded(e?.message ?? e, 120)}`);
      }
      return;
    }
    let entries;
    try {
      entries = readdirSync(rootPath);
    } catch (e) {
      failures.push(`readdir_failed:${bounded(e?.message ?? e, 120)}`);
      return;
    }
    for (const entry of entries) removeTreeNoFollow(path.join(rootPath, entry), failures);
    try {
      // Plain rmdirSync: children are already gone; non-recursive by
      // definition (the `recursive` option was removed in newer Node).
      rmdirSync(rootPath);
    } catch (e) {
      failures.push(`rmdir_failed:${path.basename(rootPath)}:${bounded(e?.message ?? e, 120)}`);
    }
  };

  /**
   * Remove only what we created AND can still prove. The root's identity is
   * re-checked first: a replaced root is never rmSync'd (an rmSync through a
   * swapped path could delete foreign territory); a root replaced by a
   * reparse point is DETACHED; a root whose identity cannot be proven is
   * LEFT on disk and the refusal returned for the error's details.
   */
  const safeCleanupStaging = () => {
    try {
      const rootLstat = lstatSync(stagingDir, { throwIfNoEntry: false });
      if (rootLstat === undefined) return 'staging_already_gone';
      if (rootLstat.isSymbolicLink()) {
        try {
          detachLink(stagingDir);
          return 'staging_cleanup_detached_root_link';
        } catch (e) {
          return `staging_cleanup_detach_failed:${bounded(e?.message ?? e, 120)}`;
        }
      }
      if (!rootLstat.isDirectory()) {
        try {
          rmSync(stagingDir, { force: true, maxRetries: 3, retryDelay: 100 });
          return null;
        } catch (e) {
          return `staging_cleanup_remove_failed:${bounded(e?.message ?? e, 120)}`;
        }
      }
      const real = realpathSync.native(stagingDir);
      if (!pathsEqual(real, stagingReal)) return `staging_cleanup_skipped_path_replaced:${real}`;
      if (containsLexical(sourceReal, real)) return `staging_cleanup_skipped_inside_source:${real}`;
      // Identity (marker/ino/birthtime) must still match the anchor: a
      // recreated directory at the same path is NOT provably ours, so it is
      // left alone. The marker is the portable recreate detector; it is
      // exempt only after the publish gate deliberately stripped it.
      const anchor = layerAnchors.staging;
      const st = statSync(stagingDir);
      if (!markersStripped && typeof anchor.markerPath === 'string') {
        const markerOk = readFenceMarker(anchor.markerPath) === anchor.markerToken;
        if (!markerOk) return 'staging_cleanup_skipped_identity_changed:marker';
      }
      if (typeof anchor.ino === 'number' && anchor.ino > 0 && st.ino !== anchor.ino) {
        return `staging_cleanup_skipped_identity_changed:ino:${anchor.ino}->${st.ino}`;
      }
      if (process.platform === 'win32' && typeof anchor.birthtimeMs === 'number' && st.birthtimeMs !== anchor.birthtimeMs) {
        return 'staging_cleanup_skipped_identity_changed:birthtime';
      }
      const failures = [];
      removeTreeNoFollow(stagingDir, failures);
      return failures.length === 0 ? null : `staging_cleanup_partial:${failures.slice(0, 3).join('; ')}`;
    } catch (e) {
      return `staging_cleanup_error:${bounded(e?.message ?? e, 120)}`;
    }
  };

  // Every Database opened by the pipeline registers here so a mid-run refusal
  // can release them all (a leaked readonly handle keeps the source locked on
  // Windows and would block any later cleanup of the fixture/workspace).
  const openHandles = new Set();
  const trackedOpen = (dbPath, errorReason, nextAction) => {
    const db = openReadonly(dbPath, errorReason, nextAction);
    openHandles.add(db);
    return db;
  };
  const closeTracked = (db) => {
    if (!db) return;
    openHandles.delete(db);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  };
  const closeAllTracked = () => {
    for (const db of [...openHandles]) closeTracked(db);
  };

  const windowStartIso = new Date().toISOString();
  const report = {
    spec: 'PD-SPEC-001',
    phase: '0c-snapshot',
    takenAt: windowStartIso,
    params: { sourceWorkspace, outDir },
    sources: {},
    snapshots: {},
    counts: {},
    blobs: {},
    consistency: {},
    discovery: {},
  };

  // Report paths are FINAL (post-publish) locations; I/O uses staging paths.
  const finalDbPath = (name) => path.join(outDir, 'snapshot', `${name}.db`);

  try {
    // ── Phase 0: source integrity gates + consistency baseline (A2 + A3) ──
    //
    // The monitor connections stay OPEN for the whole window: PRAGMA
    // data_version on the same connection is what detects a concurrent commit
    // (including updates that change no timestamp), which reopened
    // connections could never see.
    const monitor = {};
    for (const name of Object.keys(SOURCES)) {
      const conn = trackedOpen(
        SOURCES[name],
        `source_db_open_failed:${name}`,
        'Check that the source workspace DBs are readable (not exclusively locked) and retry',
      );
      monitor[name] = conn;
      const integrity = conn.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') {
        fail(
          `source_integrity_not_ok:${name}:${bounded(integrity)}`,
          'The source database failed integrity_check; no snapshot was taken from it. Inspect the source before retrying',
          { stage: 'source-integrity' },
        );
      }
      for (const t of COUNT_TABLES[name]) {
        if (!tableExists(conn, t)) {
          fail(
            `core_table_missing:source:${name}:${t}`,
            `The source ${name} DB is missing the core table "${t}"; the snapshot contract cannot be verified against it. Inspect the workspace before retrying`,
            { stage: 'source-schema' },
          );
        }
      }
    }

    const captureFacts = (when) => {
      const facts = { dbs: {}, blobs: hashRegularFiles(sourceBlobDir, when) };
      for (const [name, conn] of Object.entries(monitor)) {
        const rawVersion = conn.pragma('data_version', { simple: true });
        const tables = {};
        for (const t of COUNT_TABLES[name]) {
          const row = conn.prepare(`SELECT COUNT(*) AS c, MAX(rowid) AS m FROM "${t}"`).get(); // t from COUNT_TABLES
          tables[t] = { count: isRecord(row) && typeof row.c === 'number' ? row.c : -1, maxRowid: isRecord(row) && typeof row.m === 'number' ? row.m : -1 };
        }
        facts.dbs[name] = { dataVersion: typeof rawVersion === 'number' ? rawVersion : -1, tables };
      }
      return facts;
    };

    const baseline = captureFacts('window-start');

    // ── Phase 1: backup-API copy of both DBs + copy integrity gates (A2) ──
    mkdirSync(snapBlobsDir, { recursive: true });
    layerAnchors.snapshot = captureDirIdentity('snapshot', snapDir);
    layerAnchors.blobs = captureDirIdentity('blobs', snapBlobsDir);
    const stagingDbPath = {};
    for (const [name, srcPath] of Object.entries(SOURCES)) {
      const src = trackedOpen(srcPath, `source_db_open_failed:${name}`, 'Check that the source workspace DBs are readable and retry');
      const destPath = path.join(snapDir, `${name}.db`);
      stagingDbPath[name] = destPath;
      try {
        assertStagingIntact(`backup:${name}:pre`);
        await src.backup(destPath);
      } finally {
        closeTracked(src);
      }
      hooks.afterBackup?.({ name, stagingDbPath: destPath, sourceDbPath: srcPath });
      // The async backup AND the test-only hook have both completed; re-prove
      // every layer before anything reads or writes through these paths again
      // (this is the gate that stops a hook that swapped a layer mid-run).
      assertStagingIntact(`backup:${name}:post-hook`);

      const snap = trackedOpen(destPath, `snapshot_open_failed:${name}`, 'The backup-API copy could not be reopened; inspect the output volume and retry');
      const snapIntegrity = snap.pragma('integrity_check', { simple: true });
      closeTracked(snap);
      if (snapIntegrity !== 'ok') {
        fail(
          `snapshot_integrity_not_ok:${name}:${bounded(snapIntegrity)}`,
          'The backup copy failed integrity_check; it will not be published. Verify the output volume and re-run',
          { stage: 'copy-integrity', details: { destPath } },
        );
      }
      report.sources[name] = { path: srcPath, integrityCheck: 'ok', sizeBytes: statSync(srcPath).size };
      report.snapshots[name] = { path: finalDbPath(name), integrityCheck: 'ok', sha256: sha256File(destPath), sizeBytes: statSync(destPath).size };
    }

    // ── Phase 2: count verification source vs snapshot (A2) ────────────────
    // Mismatches are recorded first and judged after the drift comparison: a
    // mismatch EXPLAINED by a detected source-side change belongs to
    // PARTIAL_CONSISTENCY; an unexplained one means the copy does not
    // correspond to the source at all and fails the run.
    const countMismatches = [];
    for (const [name, tables] of Object.entries(COUNT_TABLES)) {
      const src = trackedOpen(SOURCES[name], `source_db_open_failed:${name}`, 'Check that the source workspace DBs are readable and retry');
      const snap = trackedOpen(stagingDbPath[name], `snapshot_open_failed:${name}`, 'The backup-API copy could not be reopened; inspect the output volume and retry');
      report.counts[name] = {};
      for (const t of tables) {
        if (!tableExists(snap, t)) {
          fail(
            `core_table_missing:snapshot:${name}:${t}`,
            'The backup copy is missing a core table the source has; the copy is not trustworthy and will not be published',
            { stage: 'count-verify' },
          );
        }
        const a = src.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
        const b = snap.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
        report.counts[name][t] = { source: a, snapshot: b, match: a === b };
        if (a !== b) countMismatches.push({ name, table: t, source: a, snapshot: b });
      }
      closeTracked(snap);
      closeTracked(src);
    }

    // ── Phase 3: blob reference scan (on the trajectory copy) ──────────────
    //
    // "Referenced" follows TECH §5.1 (scan the DB's own `blob_ref` columns).
    // This is a superset of the plugin's orphan-prune set (assistant_turns ∪
    // user_turns): a blob referenced by any table is preserved here even if
    // the plugin's sweeper would not count it.
    const trajSnap = trackedOpen(stagingDbPath.trajectory, 'snapshot_open_failed:trajectory', 'The backup-API copy could not be reopened; inspect the output volume and retry');
    const refTables = [];
    for (const row of trajSnap.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      if (!isRecord(row) || typeof row.name !== 'string' || !IDENTIFIER_RE.test(row.name)) continue;
      const cols = trajSnap.prepare(`PRAGMA table_info("${row.name}")`).all();
      if (Array.isArray(cols) && cols.some((c) => isRecord(c) && c.name === 'blob_ref')) {
        refTables.push(row.name);
      }
    }

    /** ref -> { count, tables } */
    const referenced = new Map();
    for (const table of refTables) {
      const rows = trajSnap
        .prepare(`SELECT blob_ref AS ref, COUNT(*) AS c FROM "${table}" WHERE blob_ref IS NOT NULL AND blob_ref <> '' GROUP BY blob_ref`)
        .all();
      for (const row of rows) {
        if (!isRecord(row) || typeof row.ref !== 'string' || typeof row.c !== 'number') {
          fail('blob_ref_scan_row_invalid', 'The trajectory copy returned an unexpected blob_ref row shape; no blobs were copied', { stage: 'blob-scan' });
        }
        const entry = referenced.get(row.ref) ?? { count: 0, tables: new Set() };
        entry.count += row.c;
        entry.tables.add(table);
        referenced.set(row.ref, entry);
      }
    }

    const unsafeRefs = [...referenced.keys()].filter((ref) => !BLOB_REF_SHAPE_RE.test(ref));
    if (unsafeRefs.length > 0) {
      fail(
        `blob_ref_shape_unsafe:${unsafeRefs.slice(0, 3).join(',')}`,
        'blob_ref values must be plain file names (no separators/traversal); refusing to resolve them',
        { stage: 'blob-scan' },
      );
    }

    // ── Phase 4: copy referenced blobs, count orphans (A1 blob safety) ─────
    const sourceBlobDirReal = realPathPreservingMissing(sourceBlobDir);
    const manifestFiles = [];
    const missingRefs = [];
    /** ref -> { realPath, copySha } for the post-copy re-verification. */
    const copiedBlobs = [];
    for (const ref of [...referenced.keys()].sort()) {
      const src = path.join(sourceBlobDir, ref);
      if (!pathExistsIncludingDangling(src)) {
        missingRefs.push(ref);
        continue;
      }
      // A1: the blob source must resolve (through any junction/symlink chain)
      // INSIDE the authorized blob dir and must be a regular file.
      const lstat = lstatSync(src);
      if (lstat.isDirectory()) {
        fail(`blob_source_not_regular_file:${ref}`, 'A blob_ref resolves to a directory; the blob store expects regular files. Inspect the blob dir', { stage: 'blob-copy' });
      }
      let real;
      try {
        real = realpathSync.native(src);
      } catch (e) {
        fail(`blob_source_unresolvable:${ref}:${bounded(e?.message ?? e, 120)}`, 'A blob_ref path could not be resolved to a physical location; inspect the blob dir', { stage: 'blob-copy' });
      }
      if (!containsLexical(sourceBlobDirReal, real)) {
        fail(
          `blob_source_outside_blob_dir:${ref}:${real}`,
          'A referenced blob resolves OUTSIDE the authorized source blob dir (alias/junction into foreign territory); refusing to copy it',
          { stage: 'blob-copy', details: { sourceBlobDirReal } },
        );
      }
      const realStat = statSync(real);
      if (!realStat.isFile()) {
        fail(`blob_source_not_regular_file:${ref}`, 'A blob_ref resolves to something that is not a regular file; refusing to copy it', { stage: 'blob-copy' });
      }
      const dest = path.join(snapBlobsDir, ref);
      assertStagingIntact(`blob-copy:${ref}`);
      const copySha = sha256File(real);
      copyFileSync(real, dest);
      copiedBlobs.push({ ref, real, dest, copySha });
      manifestFiles.push({
        path: `blobs/${ref}`,
        ref,
        bytes: statSync(dest).size,
        sha256: copySha,
        referenceCount: referenced.get(ref).count,
        referencedBy: [...referenced.get(ref).tables].sort(),
      });
    }
    if (missingRefs.length > 0) {
      fail(
        `referenced_blob_missing:${missingRefs.slice(0, 3).join(',')}${missingRefs.length > 3 ? ` (+${missingRefs.length - 3} more)` : ''}`,
        'A row references a blob file that is absent from the source blob dir; the snapshot would be incomplete',
        { stage: 'blob-copy' },
      );
    }
    if (manifestFiles.length !== referenced.size) {
      fail(
        `blob_copy_count_mismatch:referenced=${referenced.size}:copied=${manifestFiles.length}`,
        'Copied blob count does not reconcile with the referenced set; inspect the blob dir',
        { stage: 'blob-copy' },
      );
    }

    hooks.afterBlobCopy?.({ stagingBlobDir: snapBlobsDir, sourceBlobDir });
    // Re-prove the layers right after the test-only hook returns, BEFORE the
    // re-verification re-copies run (a hook-swapped layer must never become a
    // write path into the source).
    assertStagingIntact('blob-copy:post-hook');

    // Post-copy re-verification (A3 closure): re-read every source blob and
    // compare with the copied bytes. A source blob that changed under us is
    // re-copied ONCE for a stable end-state; a still-moving source fails the
    // run instead of freezing torn content.
    const blobsChangedDuringWindow = new Set();
    for (const entry of copiedBlobs) {
      const rehash = sha256File(entry.real);
      if (rehash === entry.copySha) continue;
      assertStagingIntact(`blob-recopy:${entry.ref}`);
      const second = sha256File(entry.real);
      copyFileSync(entry.real, entry.dest);
      const secondCopySha = sha256File(entry.dest);
      const verify = sha256File(entry.real);
      if (secondCopySha !== verify) {
        fail(`blob_changed_unstable:${entry.ref}`, 'A source blob kept changing while being copied; no verifiable snapshot copy exists. Re-run when the source is quiet', { stage: 'blob-verify' });
      }
      const manifestEntry = manifestFiles.find((f) => f.ref === entry.ref);
      if (manifestEntry) {
        manifestEntry.sha256 = secondCopySha;
        manifestEntry.bytes = statSync(entry.dest).size;
      }
      blobsChangedDuringWindow.add(entry.ref);
    }

    const orphanNames = [];
    if (existsSync(sourceBlobDir)) {
      for (const entryName of readdirSync(sourceBlobDir)) {
        if (referenced.has(entryName)) continue;
        let st;
        try {
          st = lstatSync(path.join(sourceBlobDir, entryName));
        } catch {
          continue;
        }
        if (st.isFile()) orphanNames.push(entryName);
      }
    }

    // ── Phase 5: cross-source consistency judgment (A3) ─────────────────────
    const windowEndIso = new Date().toISOString();
    const current = captureFacts('window-end');
    for (const [, conn] of Object.entries(monitor)) closeTracked(conn);

    const reasons = [];
    const consistencyChecks = { dataVersion: {}, changedTables: [], changedBlobs: [] };
    for (const name of Object.keys(monitor)) {
      const b = baseline.dbs[name];
      const c = current.dbs[name];
      consistencyChecks.dataVersion[name] = { baseline: b.dataVersion, afterCopy: c.dataVersion };
      if (b.dataVersion !== c.dataVersion) {
        reasons.push(`source_committed_during_window:${name}`);
      }
      for (const t of Object.keys(b.tables)) {
        const bt = b.tables[t];
        const ct = c.tables[t];
        if (bt.count !== ct.count || bt.maxRowid !== ct.maxRowid) {
          consistencyChecks.changedTables.push(`${name}:${t}`);
          reasons.push(`source_table_changed:${name}:${t}:baseline=${bt.count}:afterCopy=${ct.count}`);
        }
      }
    }
    const blobDiff = diffFileMaps(baseline.blobs, current.blobs);
    consistencyChecks.changedBlobs = blobDiff;
    reasons.push(...blobDiff);

    // Legacy supporting evidence (kept): rows newer than the window start in
    // the copies prove a write between windowStart and the backup moment.
    const stateLatestRowAt = latestRowIso(stagingDbPath.state, ['tasks', 'runs']);
    const trajectoryLatestRowAt = latestRowIso(stagingDbPath.trajectory, ['pain_events', 'assistant_turns', 'user_turns', 'tool_calls']);
    const windowStartMs = Date.parse(windowStartIso);
    const rowsNewerThanWindowStart = [stateLatestRowAt, trajectoryLatestRowAt]
      .filter((iso) => iso !== null && Number.isFinite(Date.parse(iso)) && Date.parse(iso) > windowStartMs)
      .length;
    if (rowsNewerThanWindowStart > 0) {
      reasons.push(`row_newer_than_window_start:state=${stateLatestRowAt ?? 'n/a'}:trajectory=${trajectoryLatestRowAt ?? 'n/a'}`);
    }
    for (const m of countMismatches) {
      if (reasons.length > 0) {
        // Explained by a detected source-side change → PARTIAL evidence.
        reasons.push(`count_mismatch_explained_by_drift:${m.name}:${m.table}:source=${m.source}:snapshot=${m.snapshot}`);
      } else {
        fail(
          `snapshot_divergence_unexplained:${m.name}:${m.table}:source=${m.source}:snapshot=${m.snapshot}`,
          'The copy disagrees with the source while no concurrent write was detected; the copy is not trustworthy and will not be published. Re-run on a quiet source',
          { stage: 'consistency', details: { mismatches: countMismatches } },
        );
      }
    }
    if (blobsChangedDuringWindow.size > 0) {
      for (const ref of [...blobsChangedDuringWindow].sort()) {
        reasons.push(`blob_changed_during_copy:${ref}`);
      }
    }

    const status = reasons.length > 0 ? 'PARTIAL_CONSISTENCY' : 'CONSISTENT_WITHIN_WINDOW';
    // Status semantics (round 3): ok means "complete snapshot". A published
    // PARTIAL_CONSISTENCY directory is NOT ok — `published: true` records
    // that the directory exists while `ok: false` forbids treating it as a
    // complete snapshot. Every artifact carries both fields.
    const ok = status === 'CONSISTENT_WITHIN_WINDOW';
    report.ok = ok;
    report.published = true;
    report.consistency = {
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      status,
      reasons,
      stateLatestRowAt,
      trajectoryLatestRowAt,
      rowsNewerThanWindowStart,
      checks: consistencyChecks,
      boundaries:
        'This run proves AT MOST that the source DBs and blob files did not change between windowStart and the '
        + 'post-copy re-verification (PRAGMA data_version + COUNT/MAX(rowid) per core table + blob-dir hashes on '
        + 'connections held open across the window). It does not freeze a distributed transaction and cannot prove '
        + 'anything about writes that happened before windowStart. A snapshot with status PARTIAL_CONSISTENCY must '
        + 'not be used as a complete snapshot by downstream formal experiments.',
      note:
        'The two SQLite DBs and the blob files are not one atomic transaction; '
        + 'consistency is declared for the recorded window only. Any detected '
        + 'source-side change downgrades the snapshot to PARTIAL_CONSISTENCY.',
    };

    // ── Phase 6: blob manifest ──────────────────────────────────────────────
    const manifest = {
      schema: 'pd-lab-blob-manifest.v1',
      generatedAt: new Date().toISOString(),
      sourceWorkspace,
      blobDir: 'blobs',
      ok,
      consistencyStatus: status,
      consistencyReasons: reasons,
      files: manifestFiles,
      counts: {
        referencedDistinct: referenced.size,
        referencedRows: [...referenced.values()].reduce((sum, e) => sum + e.count, 0),
        copied: manifestFiles.length,
        orphansNotCopied: orphanNames.length,
      },
    };
    const manifestPath = path.join(snapDir, 'blob-manifest.json');
    assertStagingIntact('manifest:pre');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assertStagingIntact('manifest:post');
    const manifestSha256 = sha256File(manifestPath);
    report.blobs = {
      sourceBlobDir,
      scanTables: [...refTables].sort(),
      manifestPath: path.join(outDir, 'snapshot', 'blob-manifest.json'),
      manifestSha256,
      consistencyStatus: status,
      ...manifest.counts,
      orphanNames,
    };

    // ── Phase 7: discovery (on the copies, unchanged from Phase 0c) ─────────
    const state = trackedOpen(stagingDbPath.state, 'snapshot_open_failed:state', 'The backup-API copy could not be reopened; inspect the output volume and retry');

    report.discovery.painBySource = trajSnap.prepare('SELECT source, count(*) AS c FROM pain_events GROUP BY source ORDER BY c DESC').all();
    report.discovery.painBySeverity = trajSnap.prepare('SELECT severity, count(*) AS c FROM pain_events GROUP BY severity ORDER BY c DESC').all();
    report.discovery.painByHostKind = trajSnap.prepare('SELECT host_kind, count(*) AS c FROM pain_events GROUP BY host_kind ORDER BY c DESC').all();
    report.discovery.painColumns = trajSnap.prepare('PRAGMA table_info(pain_events)').all().map((c) => c.name);

    report.discovery.taskKindStatus = state.prepare('SELECT task_kind, status, count(*) AS c FROM tasks GROUP BY task_kind, status ORDER BY task_kind, c DESC').all();

    const kinds = state.prepare('SELECT DISTINCT task_kind FROM tasks').all().map((r) => r.task_kind);
    report.discovery.taskIdSamples = {};
    for (const k of kinds) {
      report.discovery.taskIdSamples[k] = state.prepare('SELECT task_id FROM tasks WHERE task_kind = ? LIMIT 2').all(k).map((r) => r.task_id);
    }

    report.discovery.painDiagnosesColumns = state.prepare('PRAGMA table_info(pain_diagnoses)').all().map((c) => c.name);
    report.discovery.painDiagnosesSamples = state.prepare('SELECT id, pain_id, task_id, diagnosis_id, category, confidence, created_at FROM pain_diagnoses ORDER BY created_at DESC LIMIT 5').all();

    report.discovery.principleCandidateColumns = state.prepare('PRAGMA table_info(principle_candidates)').all().map((c) => c.name);
    report.discovery.piArtifactKinds = state.prepare('SELECT artifact_kind, validation_status, count(*) AS c FROM pi_artifacts GROUP BY artifact_kind, validation_status ORDER BY c DESC').all();

    report.discovery.allTables = state.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);

    closeTracked(state);
    closeTracked(trajSnap);

    // ── Phase 8: README index (AGENTS.md git-16) + report, then publish ─────
    const totalBytesOut =
      report.snapshots.state.sizeBytes
      + report.snapshots.trajectory.sizeBytes
      + manifestFiles.reduce((sum, f) => sum + f.bytes, 0);
    const consistencyLine = reasons.length > 0
      ? `${status} — NOT a complete snapshot. Reasons: ${reasons.join('; ')}`
      : `${status} (source verified stable across the snapshot window)`;
    const readme = [
      '# PD workspace snapshot (read-only copy)',
      '',
      `- source workspace: ${sourceWorkspace}`,
      `- taken at: ${report.takenAt}`,
      `- snapshot window: ${windowStartIso} .. ${windowEndIso}`,
      `- consistency: ${consistencyLine}`,
      `- consistency boundaries: ${report.consistency.boundaries}`,
      `- state.db: ${report.snapshots.state.sizeBytes} bytes, sha256 ${report.snapshots.state.sha256}, integrity ${report.snapshots.state.integrityCheck}`,
      `- trajectory.db: ${report.snapshots.trajectory.sizeBytes} bytes, sha256 ${report.snapshots.trajectory.sha256}, integrity ${report.snapshots.trajectory.integrityCheck}`,
      `- blobs: ${manifest.counts.copied} copied (${manifestFiles.reduce((sum, f) => sum + f.bytes, 0)} bytes), ${manifest.counts.orphansNotCopied} orphans NOT copied`,
      `- blob-manifest.json sha256: ${manifestSha256}`,
      `- total snapshot payload: ${totalBytesOut} bytes across ${2 + manifest.counts.copied} files (DBs + blobs)`,
      `- source latest rows: state=${stateLatestRowAt ?? 'n/a'} trajectory=${trajectoryLatestRowAt ?? 'n/a'}`,
      '',
      'Contents: snapshot/state.db, snapshot/trajectory.db, snapshot/blobs/,',
      'snapshot/blob-manifest.json, snapshot-report.json. The source workspace was',
      'opened read-only and never written. Orphan blobs (present in the source blob',
      'dir but referenced by no `blob_ref` row) are intentionally excluded.',
      status === 'PARTIAL_CONSISTENCY'
        ? 'WARNING: consistencyStatus is PARTIAL_CONSISTENCY — formal experiments must NOT treat this directory as a complete snapshot.'
        : 'Consistency: CONSISTENT_WITHIN_WINDOW (see snapshot-report.json for the proof boundaries).',
      '',
      `Reproduce: node experiment/prompt-v2/scripts/snapshot-and-discover.mjs --source-workspace <dir> --out <dir>`,
      '',
    ].join('\n');
    assertStagingIntact('readme:pre');
    writeFileSync(path.join(stagingDir, 'README.md'), readme, 'utf8');
    assertStagingIntact('readme:post');

    assertStagingIntact('snapshot-report:pre');
    writeFileSync(path.join(stagingDir, 'snapshot-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    assertStagingIntact('snapshot-report:post');

    // ── Publish: atomic rename into the write-once target ───────────────────
    hooks.beforePublish?.({ stagingDir, outDir });
    assertStagingIntact('publish:pre');
    if (pathExistsIncludingDangling(outDir)) {
      fail(
        `out_already_exists_publish:${outDir}`,
        'The target appeared while the snapshot was being verified (concurrent run?); the verified staging copy was discarded and the existing directory was left untouched',
        { stage: 'publish' },
      );
    }
    // Strip the fence markers so the published layout stays exactly
    // `<out>/snapshot/...` (markers are internal fence state, never payload),
    // then run one final full verification (marker checks exempted — they
    // were just removed by us; every other anchor check stays active) before
    // the rename.
    for (const anchor of [layerAnchors.staging, layerAnchors.snapshot, layerAnchors.blobs]) {
      try {
        unlinkSync(anchor.markerPath);
      } catch (e) {
        fail(`staging_marker_strip_failed:${anchor.layer}:${bounded(e?.message ?? e, 120)}`, 'The fence marker could not be removed before publish; the run was stopped with nothing published', { stage: 'publish' });
      }
    }
    markersStripped = true;
    assertStagingIntact('publish:final', { skipMarker: true });
    try {
      renameSync(stagingDir, outDir);
    } catch (e) {
      fail(
        `out_publish_failed:${e?.code ?? bounded(e?.message ?? e, 120)}:${outDir}`,
        'The verified snapshot could not be renamed into place; the existing directory was left untouched and staging was cleaned. Re-run',
        { stage: 'publish' },
      );
    }
    if (!existsSync(path.join(outDir, 'snapshot-report.json')) || !existsSync(path.join(outDir, 'snapshot', 'state.db'))) {
      fail(`out_publish_incomplete:${outDir}`, 'The published directory is missing expected files; treat it as failed and re-run', { stage: 'publish' });
    }
    // Post-publish structural sanity: every published layer must be a REAL
    // directory (never a reparse point) — the rename must not have carried a
    // hijacked layer into the published tree. This is defense-in-depth for
    // the sub-millisecond window between publish:pre verification and the
    // rename; if it ever fires, the published root is ROLLED BACK when the
    // staging anchor still proves it is ours (rename preserves the file id),
    // otherwise it is left untouched and the run fails loud.
    const publishedLayers = [
      ['staging', outDir],
      ['snapshot', path.join(outDir, 'snapshot')],
      ['blobs', path.join(outDir, 'snapshot', 'blobs')],
    ];
    for (const [layer, layerPath] of publishedLayers) {
      const lst = lstatSync(layerPath, { throwIfNoEntry: false });
      if (lst === undefined || lst.isSymbolicLink() || !lst.isDirectory()) {
        let rollback = false;
        try {
          const outLst = lstatSync(outDir, { throwIfNoEntry: false });
          if (outLst && !outLst.isSymbolicLink() && outLst.isDirectory()) {
            const outReal = realpathSync.native(outDir);
            const anchor = layerAnchors.staging;
            const st = statSync(outDir);
            const samePath = pathsEqual(outReal, outDir);
            const sameIno = !(typeof anchor.ino === 'number' && anchor.ino > 0 && st.ino !== anchor.ino);
            const sameBirth = !(process.platform === 'win32' && typeof anchor.birthtimeMs === 'number' && st.birthtimeMs !== anchor.birthtimeMs);
            const notInSource = !containsLexical(sourceReal, outReal);
            rollback = samePath && sameIno && sameBirth && notInSource;
          }
        } catch {
          rollback = false;
        }
        if (rollback) removeTreeNoFollow(outDir, []);
        fail(
          `published_layer_invalid:${layer}:${layerPath}`,
          rollback
            ? 'The published directory contained a layer that is not a real directory; it was rolled back. Nothing valid was published; re-run'
            : 'The published directory contained a layer that is not a real directory and its identity could not be proven; it was left untouched. Treat the output as invalid and inspect the volume',
          { stage: 'publish:post', details: { layer } },
        );
      }
    }

    return { ok, published: true, status, report, manifest, outDir, publishedFiles: 2 + manifest.counts.copied };
  } catch (e) {
    closeAllTracked();
    const cleanupNote = safeCleanupStaging();
    // rc-9: the cleanup outcome is recorded on the error, never silently
    // dropped. A null note means the staging area was removed cleanly.
    if (e instanceof SnapshotError) {
      const prior = e.details;
      const priorDetails = prior === null || prior === undefined || typeof prior !== 'object' ? {} : prior;
      e.details = { ...priorDetails, stagingCleanup: cleanupNote ?? 'staging_removed' };
    }
    throw e;
  }
}

/** MAX(created_at) evidence kept as SUPPORTING proof (not the sole gate). */
function latestRowIso(dbPath, tables) {
  const db = new Database(dbPath, { readonly: true });
  let latest = null;
  try {
    for (const table of tables) {
      if (!tableExists(db, table)) continue;
      const row = db.prepare(`SELECT MAX(created_at) AS m FROM "${table}"`).get();
      if (isRecord(row) && typeof row.m === 'string' && (latest === null || row.m > latest)) {
        latest = row.m;
      }
    }
  } finally {
    db.close();
  }
  return latest;
}

// ── CLI entry ────────────────────────────────────────────────────────────────

function printSummary(result) {
  const { report } = result;
  console.log(JSON.stringify({
    // ok mirrors the pipeline result: false for PARTIAL_CONSISTENCY even
    // though the directory was published (publication is not success).
    ok: result.status === 'CONSISTENT_WITHIN_WINDOW',
    published: true,
    consistencyStatus: result.status,
    params: report.params,
    sources: report.sources,
    snapshots: report.snapshots,
    counts: report.counts,
    blobs: { ...report.blobs, orphanNames: undefined },
    consistency: report.consistency,
  }, null, 1));
  console.log('painBySource:', JSON.stringify(report.discovery.painBySource));
  console.log('taskKindStatus:', JSON.stringify(report.discovery.taskKindStatus));
  console.log('piArtifactKinds:', JSON.stringify(report.discovery.piArtifactKinds.slice(0, 12)));
  console.log('allTables:', JSON.stringify(report.discovery.allTables));
  console.log('report ->', path.relative(process.cwd(), path.join(result.outDir, 'snapshot-report.json')));
}

async function main() {
  if (argv.includes('--help')) {
    console.error(USAGE);
    process.exit(0);
  }
  const sourceWorkspaceRaw = readOpt('--source-workspace');
  const outRaw = readOpt('--out');
  if (sourceWorkspaceRaw == null || outRaw == null) {
    console.error(USAGE);
    process.exit(2);
  }

  let result;
  try {
    result = await runSnapshotPipeline({ sourceWorkspace: sourceWorkspaceRaw, outDir: outRaw });
  } catch (e) {
    if (e instanceof SnapshotError) {
      console.error(JSON.stringify({ ok: false, reason: e.reason, stage: e.stage, nextAction: e.nextAction }, null, 2));
    } else {
      console.error(JSON.stringify({
        ok: false,
        reason: `unexpected_error:${bounded(e?.message ?? e, 300)}`,
        nextAction: 'Re-run the tool; if it persists inspect the environment (paths, permissions, SQLite state)',
      }, null, 2));
    }
    process.exit(1);
  }

  printSummary(result);
  if (result.status === 'PARTIAL_CONSISTENCY') {
    // TECH §5.1: a snapshot whose consistency cannot be proven must never be
    // consumable as a complete one. The directory IS published (flagged in
    // report/manifest/README) but the exit code fails closed for pipelines.
    console.error(JSON.stringify({
      ok: false,
      reason: `consistency_unprovable:${result.report.consistency.reasons.join(',')}`,
      nextAction: 'The output directory was published but is NOT a complete snapshot: it is flagged PARTIAL_CONSISTENCY in README.md, snapshot-report.json and blob-manifest.json. Formal experiments must not consume it; re-run when the source is quiet',
    }, null, 2));
    process.exit(1);
  }
  process.exit(0);
}

/** True only when this file is the Node entry module (never on import). */
function isDirectRun() {
  const arg1 = process.argv[1];
  if (typeof arg1 !== 'string' || arg1.length === 0) return false;
  try {
    const selfPath = realpathSync.native(fileURLToPath(import.meta.url));
    const entryPath = realpathSync.native(path.resolve(arg1));
    return pathsEqual(selfPath, entryPath);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  await main();
}
