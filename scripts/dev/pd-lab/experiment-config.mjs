/**
 * PD-Lab v0.3 T3a (PRI-1253) — the ONE experiment-config loader/validator.
 *
 * Contract owners (do not reinterpret here):
 *   - TECH-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3 §4.1 (format), §4.4 (two-arm
 *     identity), §4.5 (path safety), §7 (run-manifest digest fields);
 *   - SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3 R1;
 *   - snapshot layout + `pd-lab-blob-manifest.v1` schema produced by
 *     experiment/prompt-v2/scripts/snapshot-and-discover.mjs (PRI-1251 / T1).
 *
 * What this module is (TECH §3.2): read, validate and FREEZE an experiment
 * config; on any failure throw ONE error carrying every field-level problem.
 * It performs the complete config-vs-current-files reconciliation:
 *   schema/unknown-field/type checks; explicit baseline/candidate identity;
 *   legacy closed set + mode exclusivity; preregistration binding (raw-byte
 *     SHA-256 + YAML front-matter experimentId); dataset / snapshot (state,
 *     trajectory, blob-manifest AND every referenced blob) digest checks;
 *     workspaceFiles source digests; feature-flag registration; and the §4.5
 *     path-safety fence (forbidden roots, nearest-existing-ancestor
 *     normalization, per-level reparse/symlink/junction fence, mutual
 *     experimentRoot↔arm-worktree containment, relative-target escape fence).
 *
 * What this module deliberately is NOT (those stay in the entry scripts that
 * T3b / PRI-1254 wires): per-arm `git rev-parse HEAD` vs expectedHead,
 * pd-cli dist existence, modelEnv presence, derived-config structured diff,
 * and any directory/file/subprocess side effect. It spawns NO child process
 * and writes NOTHING — validation is complete before any side effect exists.
 *
 * No caching: every call re-reads the config, preregistration, dataset,
 * snapshot and workspaceFiles from the CURRENT files and recomputes digests
 * (TECH §7: `lab:run` must re-preflight from current files, never reuse a
 * stale in-memory result). Two calls in a row can therefore legitimately
 * disagree when a bound file changed in between — that is CF-16's mechanism.
 *
 * T3b consumption contract (the reason this module exists):
 *   - `lab:preflight` calls `loadExperimentConfig(file)`; every downstream
 *     entry receives the FROZEN result and derives roles/paths from it.
 *   - `lab:run` MUST call `loadExperimentConfig(file)` again (the ONE
 *     parameter — there is no options object) BEFORE the first run-record
 *     write and BEFORE the first child process, and record
 *     `verification.configSha256`,
 *     `verification.preregistrationStatus` (VERIFIED | NOT_APPLICABLE_LEGACY)
 *     and `verification.preregistrationSha256` into the run-manifest
 *     (TECH §7 — legacy records digest null, never a forged value).
 *   - arm workspaces materialize at `<experimentRoot>/workspaces/<armId>`
 *     (this module fence-validates workspaceFiles targets against exactly
 *     that base; T3b must materialize there and re-run its own spawn-time
 *     fence after creation).
 *   - **runId validation is T3b's responsibility at its own path-join site**
 *     (TECH §4.5 "拼入路径前再校验一次" — the config loader deliberately does
 *     NOT own a runId parameter; PRI-1253 review reverted the unapproved
 *     `options.runId` extension). T3b MUST implement, at every site where a
 *     runId is joined into a path: (1) pattern check against TECH §4.5's
 *     `^[A-Za-z0-9._-]+$`; (2) a STRICT strictly-under-runs canonical
 *     re-check — the pattern ALONE admits the dot-only values `'..'` and
 *     `'.'`, and `path.join(root, 'runs', '..')` normalizes back onto the
 *     experiment root, so the joined path must resolve to a canonical path
 *     STRICTLY UNDER `<experimentRoot>/runs/` (starts-with runs + separator);
 *     (3) a reparse fence (`fenceWalk`-style per-level lstat) over the joined
 *     runs directory before anything is created under it. Do not rediscover
 *     the dot-only bypass the hard way — it is a proven escape, not theory.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';
import { DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime';

/**
 * Export surface (TECH §3.2 / PRI-1253): EXACTLY ONE function with EXACTLY
 * ONE parameter — `loadExperimentConfig(file)`. Everything below is
 * module-internal on purpose; downstream consumers receive the frozen load
 * result, never partial machinery. runId validation is NOT part of this
 * module (see the T3b contract above — the review-mandated revert of the
 * unapproved `options.runId` parameter); T3b implements the TECH §4.5 runId
 * checks at its own path-join sites.
 */
const CONFIG_SCHEMA_ID = 'pd-lab-experiment-config.v1';

/** Historical replay closed set (TECH §4.1 `legacy.batch`) — nothing else. */
const LEGACY_BATCHES = ['prompt-v2-round1', 'dreamer-v21-round2'];

/**
 * Workspace/state pointer vars whose CURRENT shell targets are forbidden
 * roots (TECH §4.1). TRIPWIRE: mirrored by POINTER_STRIP_LIST in
 * experiment/prompt-v2/scripts/ab/ab-lib.mjs and the two characterization
 * test lists — adding/removing a pointer var here MUST update those in the
 * same change (PRI-1252 r1 tripwire obligation extends to this module).
 */
const POINTER_ENV_VARS = [
  'PD_WORKSPACE_DIR',
  'OPENCLAW_WORKSPACE',
  'OPENCLAW_WORKSPACE_DIR',
  'PD_STATE_DIR',
  'OPENCLAW_HOME',
];

const EXPERIMENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ARM_ID_RE = /^[a-z][a-z0-9]*$/;
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const COMMIT_HEX_RE = /^[0-9a-fA-F]{40}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const here = path.dirname(fileURLToPath(import.meta.url));

/* ────────────────────────── small shared primitives ───────────────────── */

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Digest of the COMPLETE raw bytes (EP-07/ERR-188: never a formatted or
 *  truncated projection of the file). Throws only on I/O failure. */
function sha256FileRaw(p) {
  return sha256Buffer(fs.readFileSync(p));
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(obj, key) {
  return Object.hasOwn(obj, key);
}

/** Bounded value preview for problem messages (rc-8: no unbounded echo of
 *  untrusted config content). */
function preview(v, max = 80) {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v;
  const s = JSON.stringify(v);
  const text = s === undefined ? String(v) : s;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Canonical comparison form (ab-lib canonical() semantics: realpath where
 *  resolvable, else lexically resolved; case-folded on Windows). */
function canonical(p) {
  const resolved = path.resolve(p);
  try {
    const real = fs.realpathSync.native(resolved);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

/** Containment over ALREADY-canonical paths (both separator forms, as in
 *  ab-lib isWithin). */
function isWithin(rootCanonical, candidateCanonical) {
  return candidateCanonical === rootCanonical
    || candidateCanonical.startsWith(rootCanonical + path.sep)
    || candidateCanonical.startsWith(rootCanonical + '/');
}

/* ───────────────── forbidden roots & primary checkout (§4.1/§4.5) ─────── */

/**
 * Primary checkout WITHOUT spawning git: in a linked worktree the `.git`
 * entry is a FILE ("gitdir: <primary>/.git/worktrees/<name>"); in the
 * primary it is a DIRECTORY. Falls back to this module's own checkout root
 * when the layout is unreadable (fail-closed best effort — the fallback is
 * still a repository root, never an unrelated directory).
 */
function derivePrimaryCheckout() {
  const moduleRoot = path.resolve(here, '..', '..', '..');
  let dotGit = null;
  try {
    dotGit = fs.lstatSync(path.join(moduleRoot, '.git'));
  } catch {
    return moduleRoot;
  }
  if (!dotGit.isFile()) return moduleRoot; // primary (directory) or exotic
  try {
    const text = fs.readFileSync(path.join(moduleRoot, '.git'), 'utf8').trim();
    const m = text.match(/^gitdir:\s*(.+)$/);
    if (!m) return moduleRoot;
    let gitdir = m[1].trim();
    if (!path.isAbsolute(gitdir)) gitdir = path.resolve(moduleRoot, gitdir);
    const worktreesDir = path.dirname(gitdir); // <primary>/.git/worktrees
    if (path.basename(worktreesDir) === 'worktrees') {
      return path.dirname(path.dirname(worktreesDir)); // strip /.git → <primary>
    }
    return moduleRoot;
  } catch {
    return moduleRoot;
  }
}

/**
 * Fixed + shell-derived forbidden roots, canonicalized (TECH §4.1):
 * `~/.pd`, `~/.openclaw`, `~/.codex`, the primary checkout, and every
 * directory a workspace/state pointer env var currently targets. Derived
 * fresh on EVERY call — a pointer changed between two loads changes the
 * fence, which is exactly the CF-16/CF-08 behavior.
 */
function deriveForbiddenRoots() {
  const roots = [];
  const home = os.homedir();
  for (const name of ['.pd', '.openclaw', '.codex']) {
    roots.push({ label: `homedir ${name}`, pathValue: path.join(home, name) });
  }
  roots.push({ label: 'primary checkout', pathValue: derivePrimaryCheckout() });
  for (const name of POINTER_ENV_VARS) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      roots.push({ label: `shell pointer ${name}`, pathValue: value });
    }
  }
  return roots.map((r) => ({ ...r, canonical: canonical(r.pathValue) }));
}

/** Archive root for dataset/snapshot placement (§4.5 “归档根”, AGENTS
 *  git-16 + TECH §7: artifacts/pd-lab under the primary checkout). */
function deriveArchiveRoot() {
  return path.join(derivePrimaryCheckout(), 'artifacts', 'pd-lab');
}

/* ─────────────────── nearest-existing-ancestor normalization (§4.5) ───── */

/**
 * Walk EVERY existing level of `p` from the filesystem root down, lstat'ing
 * one level at a time:
 *   - any existing level that is a symlink/junction/reparse point is
 *     recorded (the caller rejects) and the walk stops — nothing below a
 *     redirect can be trusted;
 *   - the walk stops at the first MISSING level — a target directory that
 *     does not exist yet still fences through its deepest existing
 *     ancestor, exactly the §4.5 "nonexistent target through a symlinked
 *     parent" case.
 * `nearestCanonical` is the §4.5 nearest-existing-ancestor normalization:
 * the realpath of the deepest existing non-reparse level joined with the
 * lexical remainder — the REAL location the path resolves to, computed
 * without trusting any single realpath of the (possibly nonexistent) target.
 * Containment itself compares canonical() (realpath through links) — the
 * fence here exists to catch redirects even when they land somewhere legal.
 */
function fenceWalk(p) {
  const resolved = path.resolve(p);
  const reparseHits = [];
  const uncMatch = resolved.match(/^\\\\[^\\/]+\\[^\\/]+/);
  const driveMatch = resolved.match(/^[A-Za-z]:[\\/]/);
  const rootMatch = resolved.match(/^[\\/]+/);
  let prefix;
  if (uncMatch) prefix = uncMatch[0];
  else if (driveMatch) prefix = driveMatch[0];
  else if (rootMatch) prefix = rootMatch[0];
  else prefix = path.parse(resolved).root;
  const acc0 = /[\\/]$/.test(prefix) ? prefix : `${prefix}${path.sep}`;
  let acc = acc0;
  let deepestExisting = null;
  let cutIndex = -1;
  const segs = resolved.slice(prefix.length).split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < segs.length; i += 1) {
    const level = path.join(acc, segs[i]);
    let st = null;
    try {
      st = fs.lstatSync(level);
    } catch {
      cutIndex = i; // first missing level — tail is lexical
      break;
    }
    if (st.isSymbolicLink()) {
      reparseHits.push({ path: level });
      cutIndex = i; // nothing below a redirect is trusted
      break;
    }
    acc = level;
    deepestExisting = level;
  }
  // Nearest-existing-ancestor normalization: realpath of the deepest
  // existing clean level (or the volume root when level 1 is missing) plus
  // the not-yet-walked lexical tail.
  let nearestBase = deepestExisting ?? prefix;
  let real = nearestBase;
  try {
    real = fs.realpathSync.native(nearestBase);
  } catch { /* raced away — lexical fallback still bounds the tail */ }
  const tail = cutIndex === -1 ? [] : segs.slice(cutIndex);
  const nearest = tail.length > 0 ? path.join(real, ...tail) : real;
  const nearestCanonical = process.platform === 'win32' ? nearest.toLowerCase() : nearest;
  return { resolved, reparseHits, nearestCanonical };
}

/* ─────────────────────────── relative-path fence (§4.5) ───────────────── */

/**
 * A relative target that must never escape its base directory when joined:
 * no absolute form (incl. drive letters / UNC), no `..`/`.`/empty segments.
 * When `existingBase` is provided AND already exists on disk, every EXISTING
 * intermediate directory between the base and the target is additionally
 * fenced against symlinks/junctions (CF-06). Purely read-only.
 */
function checkRelativeTarget(field, target, existingBase) {
  const problems = [];
  if (typeof target !== 'string' || target.trim() === '') {
    problems.push({ field, code: 'invalid_type', message: `${field} must be a non-empty relative path string, got ${preview(target)}` });
    return { ok: false, problems };
  }
  if (path.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\') || target.startsWith('//')) {
    problems.push({ field, code: 'path_traversal', message: `${field} must be relative (no absolute/drive/UNC form), got ${preview(target)}` });
    return { ok: false, problems };
  }
  const segments = target.split(/[\\/]+/);
  for (const seg of segments) {
    if (seg === '' || seg === '.') {
      problems.push({ field, code: 'path_traversal', message: `${field} has an empty or '.' segment, got ${preview(target)}` });
      return { ok: false, problems };
    }
    if (seg === '..') {
      problems.push({ field, code: 'path_traversal', message: `${field} must not traverse upwards ('..' segment), got ${preview(target)}` });
      return { ok: false, problems };
    }
  }
  if (typeof existingBase === 'string') {
    let baseSt = null;
    try { baseSt = fs.lstatSync(existingBase); } catch { /* not materialized yet */ }
    if (baseSt !== null && baseSt.isDirectory() && !baseSt.isSymbolicLink()) {
      let acc = existingBase;
      for (const seg of segments.slice(0, -1)) {
        const level = path.join(acc, seg);
        let st = null;
        try { st = fs.lstatSync(level); } catch { break; } // missing → run-time fence owns creation
        if (st.isSymbolicLink()) {
          problems.push({ field, code: 'symlink_in_path', message: `intermediate directory ${level} is a symlink/junction/reparse point — ${field} would write through a redirect` });
          return { ok: false, problems };
        }
        if (!st.isDirectory()) break;
        acc = level;
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/* ───────────────────────────── error carrier ──────────────────────────── */

/**
 * Structured, field-level rejection. `problems[]` carries every finding at
 * once (TECH §4.5 “一次性报告，不部分生效”); the message stays bounded (rc-8)
 * and names a nextAction (rc-9). Identified by `err.name` because this
 * module's export surface is exactly one loader function.
 */
class ExperimentConfigError extends Error {
  constructor(problems, configSha256) {
    super(
      `experiment config rejected (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`
      + problems.map((p) => `  - [${p.field}] ${p.code}: ${p.message}`).join('\n')
      + '\n[nextAction: fix every listed field against TECH-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3 §4.1/§4.5, then load again]',
    );
    this.name = 'ExperimentConfigError';
    this.problems = problems;
    if (configSha256 !== undefined) this.configSha256 = configSha256;
  }
}

/* ─────────────────────────── front matter (§4.1) ──────────────────────── */

/**
 * Parse the YAML front matter at the TOP of the preregistration file.
 * Only `---` fences at line 0 and the following line are considered; the
 * body after the closing fence is irrelevant here. Digests are always taken
 * over the whole raw file — this parse is identity-only.
 */
function parseFrontMatterExperimentId(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { ok: false, reason: 'frontmatter_missing', message: 'preregistration file does not start with a `---` YAML front-matter fence' };
  }
  const closeIndex = lines.indexOf('---', 1);
  if (closeIndex === -1) {
    return { ok: false, reason: 'frontmatter_missing', message: 'preregistration front matter has no closing `---` fence' };
  }
  let parsed;
  try {
    parsed = yamlLoad(lines.slice(1, closeIndex).join('\n'));
  } catch (err) {
    return { ok: false, reason: 'frontmatter_invalid', message: `preregistration front matter is not valid YAML: ${preview(err && err.message ? err.message : String(err), 160)}` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'frontmatter_invalid', message: 'preregistration front matter is not a YAML mapping' };
  }
  const id = parsed.experimentId;
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, reason: 'frontmatter_missing', message: 'preregistration front matter does not declare a string experimentId' };
  }
  return { ok: true, experimentId: id.trim() };
}

/* ─────────────────────────── structural validation ────────────────────── */

/** Top-level allow-list. Anything else is an unknown field (CF-02). */
const KNOWN_TOP_LEVEL_FIELDS = [
  'schema',
  'experimentId',
  'preregistration',
  'baselineArm',
  'candidateArm',
  'experimentRoot',
  'additionalForbiddenRoots',
  'dataset',
  'snapshot',
  'baseConfigFile',
  'profileRebind',
  'arms',
  'modelEnv',
  '_note',
  'legacy',
];

const KNOWN_ARM_FIELDS = ['worktree', 'expectedHead', 'featureOverrides', 'workspaceFiles'];

function validateStructure(raw, problems, out) {
  if (!isPlainObject(raw)) {
    problems.push({ field: '$', code: 'invalid_type', message: `config root must be a JSON object, got ${preview(raw)}` });
    return {
      experimentRootOk: false, additionalRootsOk: false, datasetOk: false, snapshotOk: false,
      baseConfigOk: false, armsOk: false, preregOk: false, legacyOk: false,
      preregPresent: false, legacyPresent: false,
    };
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.includes(key)) {
      problems.push({ field: key, code: 'unknown_field', message: `unknown field ${preview(key)} — only TECH §4.1 fields plus _note/legacy are accepted` });
    }
  }

  // schema
  if (!hasOwn(raw, 'schema')) {
    problems.push({ field: 'schema', code: 'missing_required_field', message: 'schema is required' });
  } else if (raw.schema !== CONFIG_SCHEMA_ID) {
    problems.push({ field: 'schema', code: 'invalid_value', message: `schema must equal ${CONFIG_SCHEMA_ID}, got ${preview(raw.schema)}` });
  }

  // experimentId
  if (!hasOwn(raw, 'experimentId')) {
    problems.push({ field: 'experimentId', code: 'missing_required_field', message: 'experimentId is required' });
  } else if (typeof raw.experimentId !== 'string' || !EXPERIMENT_ID_RE.test(raw.experimentId)) {
    problems.push({ field: 'experimentId', code: 'invalid_value', message: `experimentId must match ${EXPERIMENT_ID_RE}, got ${preview(raw.experimentId)}` });
  } else {
    out.experimentId = raw.experimentId;
  }

  // _note — string only, never affects semantics (CF-13)
  if (hasOwn(raw, '_note')) {
    if (typeof raw._note !== 'string') {
      problems.push({ field: '_note', code: 'invalid_type', message: `_note must be a string (documentation only), got ${preview(raw._note)}` });
    } else {
      out.note = raw._note;
    }
  }

  // experimentRoot
  let experimentRootOk = false;
  if (!hasOwn(raw, 'experimentRoot')) {
    problems.push({ field: 'experimentRoot', code: 'missing_required_field', message: 'experimentRoot is required' });
  } else if (typeof raw.experimentRoot !== 'string' || raw.experimentRoot.trim() === '' || !path.isAbsolute(raw.experimentRoot)) {
    problems.push({ field: 'experimentRoot', code: 'not_absolute_path', message: `experimentRoot must be a non-empty absolute path, got ${preview(raw.experimentRoot)}` });
  } else {
    out.experimentRoot = raw.experimentRoot;
    experimentRootOk = true;
  }

  // additionalForbiddenRoots (required, possibly empty)
  let additionalRootsOk = false;
  if (!hasOwn(raw, 'additionalForbiddenRoots')) {
    problems.push({ field: 'additionalForbiddenRoots', code: 'missing_required_field', message: 'additionalForbiddenRoots is required (may be an empty array)' });
  } else if (!Array.isArray(raw.additionalForbiddenRoots)) {
    problems.push({ field: 'additionalForbiddenRoots', code: 'invalid_type', message: `additionalForbiddenRoots must be an array of absolute paths, got ${preview(raw.additionalForbiddenRoots)}` });
  } else {
    let ok = true;
    out.additionalForbiddenRoots = [];
    raw.additionalForbiddenRoots.forEach((item, i) => {
      if (typeof item !== 'string' || item.trim() === '' || !path.isAbsolute(item)) {
        ok = false;
        problems.push({ field: `additionalForbiddenRoots[${i}]`, code: 'not_absolute_path', message: `entry must be a non-empty absolute path, got ${preview(item)}` });
      } else {
        out.additionalForbiddenRoots.push(item);
      }
    });
    additionalRootsOk = ok;
  }

  // dataset {file, sha256}
  let datasetOk = false;
  if (!hasOwn(raw, 'dataset')) {
    problems.push({ field: 'dataset', code: 'missing_required_field', message: 'dataset is required' });
  } else if (!isPlainObject(raw.dataset)) {
    problems.push({ field: 'dataset', code: 'invalid_type', message: `dataset must be an object {file, sha256}, got ${preview(raw.dataset)}` });
  } else {
    for (const key of Object.keys(raw.dataset)) {
      if (key !== 'file' && key !== 'sha256') {
        problems.push({ field: `dataset.${key}`, code: 'unknown_field', message: 'dataset accepts only file and sha256' });
      }
    }
    let ok = true;
    if (typeof raw.dataset.file !== 'string' || raw.dataset.file.trim() === '' || !path.isAbsolute(raw.dataset.file)) {
      ok = false;
      problems.push({ field: 'dataset.file', code: 'not_absolute_path', message: `dataset.file must be a non-empty absolute path, got ${preview(raw.dataset.file)}` });
    }
    if (typeof raw.dataset.sha256 !== 'string' || !SHA256_HEX_RE.test(raw.dataset.sha256)) {
      ok = false;
      problems.push({ field: 'dataset.sha256', code: 'invalid_value', message: `dataset.sha256 must be 64 hex characters, got ${preview(raw.dataset.sha256)}` });
    }
    if (ok) {
      out.dataset = { file: raw.dataset.file, sha256: raw.dataset.sha256.toLowerCase() };
      datasetOk = true;
    }
  }

  // snapshot {dir, sha256:{state,trajectory,blobManifest}}
  let snapshotOk = false;
  if (!hasOwn(raw, 'snapshot')) {
    problems.push({ field: 'snapshot', code: 'missing_required_field', message: 'snapshot is required' });
  } else if (!isPlainObject(raw.snapshot)) {
    problems.push({ field: 'snapshot', code: 'invalid_type', message: `snapshot must be an object {dir, sha256}, got ${preview(raw.snapshot)}` });
  } else {
    for (const key of Object.keys(raw.snapshot)) {
      if (key !== 'dir' && key !== 'sha256') {
        problems.push({ field: `snapshot.${key}`, code: 'unknown_field', message: 'snapshot accepts only dir and sha256' });
      }
    }
    let sha256Ok = true;
    if (!isPlainObject(raw.snapshot.sha256)) {
      sha256Ok = false;
      problems.push({ field: 'snapshot.sha256', code: 'invalid_type', message: 'snapshot.sha256 must be an object {state, trajectory, blobManifest}' });
    } else {
      for (const key of Object.keys(raw.snapshot.sha256)) {
        if (key !== 'state' && key !== 'trajectory' && key !== 'blobManifest') {
          problems.push({ field: `snapshot.sha256.${key}`, code: 'unknown_field', message: 'snapshot.sha256 accepts only state, trajectory, blobManifest' });
        }
      }
      for (const key of ['state', 'trajectory', 'blobManifest']) {
        const v = raw.snapshot.sha256[key];
        if (typeof v !== 'string' || !SHA256_HEX_RE.test(v)) {
          sha256Ok = false;
          problems.push({ field: `snapshot.sha256.${key}`, code: 'invalid_value', message: `snapshot.sha256.${key} must be 64 hex characters, got ${preview(v)}` });
        }
      }
    }
    const dirOk = typeof raw.snapshot.dir === 'string' && raw.snapshot.dir.trim() !== '' && path.isAbsolute(raw.snapshot.dir);
    if (!dirOk) {
      problems.push({ field: 'snapshot.dir', code: 'not_absolute_path', message: `snapshot.dir must be a non-empty absolute path, got ${preview(raw.snapshot.dir)}` });
    }
    if (dirOk && sha256Ok) {
      out.snapshot = {
        dir: raw.snapshot.dir,
        sha256: {
          state: raw.snapshot.sha256.state.toLowerCase(),
          trajectory: raw.snapshot.sha256.trajectory.toLowerCase(),
          blobManifest: raw.snapshot.sha256.blobManifest.toLowerCase(),
        },
      };
      snapshotOk = true;
    }
  }

  // baseConfigFile
  let baseConfigOk = false;
  if (!hasOwn(raw, 'baseConfigFile')) {
    problems.push({ field: 'baseConfigFile', code: 'missing_required_field', message: 'baseConfigFile is required' });
  } else if (typeof raw.baseConfigFile !== 'string' || raw.baseConfigFile.trim() === '' || !path.isAbsolute(raw.baseConfigFile)) {
    problems.push({ field: 'baseConfigFile', code: 'not_absolute_path', message: `baseConfigFile must be a non-empty absolute path, got ${preview(raw.baseConfigFile)}` });
  } else {
    out.baseConfigFile = raw.baseConfigFile;
    baseConfigOk = true;
  }

  // profileRebind {from,to} — optional
  if (hasOwn(raw, 'profileRebind')) {
    if (!isPlainObject(raw.profileRebind)) {
      problems.push({ field: 'profileRebind', code: 'invalid_type', message: `profileRebind must be an object {from, to}, got ${preview(raw.profileRebind)}` });
    } else {
      for (const key of Object.keys(raw.profileRebind)) {
        if (key !== 'from' && key !== 'to') {
          problems.push({ field: `profileRebind.${key}`, code: 'unknown_field', message: 'profileRebind accepts only from and to' });
        }
      }
      let ok = true;
      for (const key of ['from', 'to']) {
        const v = raw.profileRebind[key];
        if (typeof v !== 'string' || v.trim() === '') {
          ok = false;
          problems.push({ field: `profileRebind.${key}`, code: 'invalid_value', message: `profileRebind.${key} must be a non-empty profile binding string, got ${preview(v)}` });
        }
      }
      if (ok) out.profileRebind = { from: raw.profileRebind.from, to: raw.profileRebind.to };
    }
  }

  // modelEnv — required array of env var NAMES (values are never read)
  if (!hasOwn(raw, 'modelEnv')) {
    problems.push({ field: 'modelEnv', code: 'missing_required_field', message: 'modelEnv is required' });
  } else if (!Array.isArray(raw.modelEnv)) {
    problems.push({ field: 'modelEnv', code: 'invalid_type', message: `modelEnv must be an array of environment variable names, got ${preview(raw.modelEnv)}` });
  } else {
    let ok = true;
    out.modelEnv = [];
    raw.modelEnv.forEach((item, i) => {
      if (typeof item !== 'string' || !ENV_NAME_RE.test(item)) {
        ok = false;
        problems.push({ field: `modelEnv[${i}]`, code: 'invalid_value', message: `modelEnv entries must be environment variable names matching ${ENV_NAME_RE}, got ${preview(item)}` });
      } else {
        out.modelEnv.push(item);
      }
    });
    if (!ok) delete out.modelEnv;
  }

  // arms — exactly two, plus per-arm shape
  let armsOk = false;
  if (!hasOwn(raw, 'arms')) {
    problems.push({ field: 'arms', code: 'missing_required_field', message: 'arms is required' });
  } else if (!isPlainObject(raw.arms)) {
    problems.push({ field: 'arms', code: 'invalid_type', message: `arms must be an object keyed by armId, got ${preview(raw.arms)}` });
  } else {
    const armIds = Object.keys(raw.arms);
    for (const armId of armIds) {
      if (!ARM_ID_RE.test(armId)) {
        problems.push({ field: `arms.${armId}`, code: 'invalid_value', message: `armId must match ${ARM_ID_RE}, got ${preview(armId)}` });
      }
    }
    if (armIds.length !== 2) {
      problems.push({ field: 'arms', code: 'invalid_value', message: `arms must declare EXACTLY two arms (baselineArm + candidateArm), got ${armIds.length}: ${preview(armIds.join(', '))}` });
    }
    let allArmsOk = true;
    out.arms = {};
    for (const armId of armIds) {
      if (!ARM_ID_RE.test(armId)) { allArmsOk = false; continue; }
      const arm = raw.arms[armId];
      if (!isPlainObject(arm)) {
        allArmsOk = false;
        problems.push({ field: `arms.${armId}`, code: 'invalid_type', message: `arm must be an object, got ${preview(arm)}` });
        continue;
      }
      for (const key of Object.keys(arm)) {
        if (!KNOWN_ARM_FIELDS.includes(key)) {
          problems.push({ field: `arms.${armId}.${key}`, code: 'unknown_field', message: `arm accepts only ${KNOWN_ARM_FIELDS.join(', ')}` });
        }
      }
      let armOk = true;
      if (typeof arm.worktree !== 'string' || arm.worktree.trim() === '' || !path.isAbsolute(arm.worktree)) {
        armOk = false;
        problems.push({ field: `arms.${armId}.worktree`, code: 'not_absolute_path', message: `worktree must be a non-empty absolute path, got ${preview(arm.worktree)}` });
      }
      if (typeof arm.expectedHead !== 'string' || !COMMIT_HEX_RE.test(arm.expectedHead)) {
        armOk = false;
        problems.push({ field: `arms.${armId}.expectedHead`, code: 'invalid_value', message: `expectedHead must be a 40-hex commit id, got ${preview(arm.expectedHead)}` });
      }
      let overridesOk = true;
      if (hasOwn(arm, 'featureOverrides')) {
        if (!isPlainObject(arm.featureOverrides)) {
          overridesOk = false;
          problems.push({ field: `arms.${armId}.featureOverrides`, code: 'invalid_type', message: `featureOverrides must be an object {<flagId>: boolean}, got ${preview(arm.featureOverrides)}` });
        } else {
          for (const [flagId, value] of Object.entries(arm.featureOverrides)) {
            if (typeof value !== 'boolean') {
              overridesOk = false;
              problems.push({ field: `arms.${armId}.featureOverrides.${flagId}`, code: 'invalid_type', message: `featureOverrides values must be boolean, got ${preview(value)}` });
            }
          }
        }
      }
      let filesOk = true;
      if (hasOwn(arm, 'workspaceFiles')) {
        if (!Array.isArray(arm.workspaceFiles)) {
          filesOk = false;
          problems.push({ field: `arms.${armId}.workspaceFiles`, code: 'invalid_type', message: `workspaceFiles must be an array of {source, target, sha256}, got ${preview(arm.workspaceFiles)}` });
        } else {
          arm.workspaceFiles.forEach((entry, i) => {
            if (!isPlainObject(entry)) {
              filesOk = false;
              problems.push({ field: `arms.${armId}.workspaceFiles[${i}]`, code: 'invalid_type', message: `entry must be an object, got ${preview(entry)}` });
              return;
            }
            for (const key of Object.keys(entry)) {
              if (key !== 'source' && key !== 'target' && key !== 'sha256') {
                problems.push({ field: `arms.${armId}.workspaceFiles[${i}].${key}`, code: 'unknown_field', message: 'workspaceFiles entries accept only source, target, sha256' });
              }
            }
            if (typeof entry.source !== 'string' || entry.source.trim() === '' || !path.isAbsolute(entry.source)) {
              filesOk = false;
              problems.push({ field: `arms.${armId}.workspaceFiles[${i}].source`, code: 'not_absolute_path', message: `source must be a non-empty absolute path, got ${preview(entry.source)}` });
            }
            if (typeof entry.sha256 !== 'string' || !SHA256_HEX_RE.test(entry.sha256)) {
              filesOk = false;
              problems.push({ field: `arms.${armId}.workspaceFiles[${i}].sha256`, code: 'invalid_value', message: `sha256 must be 64 hex characters, got ${preview(entry.sha256)}` });
            }
            const rel = checkRelativeTarget(`arms.${armId}.workspaceFiles[${i}].target`, entry.target, null);
            if (!rel.ok) {
              filesOk = false;
              problems.push(...rel.problems);
            }
          });
        }
      }
      if (armOk && overridesOk && filesOk) {
        out.arms[armId] = {
          worktree: arm.worktree,
          expectedHead: arm.expectedHead.toLowerCase(),
        };
        if (hasOwn(arm, 'featureOverrides')) out.arms[armId].featureOverrides = { ...arm.featureOverrides };
        if (hasOwn(arm, 'workspaceFiles')) out.arms[armId].workspaceFiles = arm.workspaceFiles.map((e) => ({ source: e.source, target: e.target, sha256: e.sha256.toLowerCase() }));
      } else {
        allArmsOk = false;
      }
    }
    armsOk = allArmsOk && armIds.length === 2 && armIds.every((id) => ARM_ID_RE.test(id));
    if (!armsOk) delete out.arms;
  }

  // baselineArm / candidateArm — explicit identity, no inference (CF-09)
  const roleValues = {};
  for (const field of ['baselineArm', 'candidateArm']) {
    if (!hasOwn(raw, field)) {
      problems.push({ field, code: 'missing_required_field', message: `${field} is required — roles are never inferred from order, alphabet or arm name` });
    } else if (typeof raw[field] !== 'string' || !ARM_ID_RE.test(raw[field])) {
      problems.push({ field, code: 'invalid_value', message: `${field} must be an armId matching ${ARM_ID_RE}, got ${preview(raw[field])}` });
    } else {
      roleValues[field] = raw[field];
    }
  }
  if (roleValues.baselineArm !== undefined && roleValues.candidateArm !== undefined) {
    if (roleValues.baselineArm === roleValues.candidateArm) {
      problems.push({ field: 'candidateArm', code: 'duplicate_arm_roles', message: `baselineArm and candidateArm must be two DIFFERENT arms, both got ${preview(roleValues.baselineArm)}` });
    } else if (armsOk && (!hasOwn(out.arms, roleValues.baselineArm) || !hasOwn(out.arms, roleValues.candidateArm))) {
      problems.push({ field: 'baselineArm', code: 'arm_not_declared', message: `both role arms must exist in arms (baseline=${preview(roleValues.baselineArm)}, candidate=${preview(roleValues.candidateArm)})` });
    } else if (armsOk) {
      out.baselineArm = roleValues.baselineArm;
      out.candidateArm = roleValues.candidateArm;
    }
  }

  // preregistration {file, sha256} — new-experiment mode (CF-14/CF-15)
  const preregPresent = hasOwn(raw, 'preregistration');
  let preregOk = false;
  if (preregPresent) {
    if (!isPlainObject(raw.preregistration)) {
      problems.push({ field: 'preregistration', code: 'invalid_type', message: `preregistration must be an object {file, sha256}, got ${preview(raw.preregistration)}` });
    } else {
      for (const key of Object.keys(raw.preregistration)) {
        if (key !== 'file' && key !== 'sha256') {
          problems.push({ field: `preregistration.${key}`, code: 'unknown_field', message: 'preregistration accepts only file and sha256' });
        }
      }
      let ok = true;
      if (typeof raw.preregistration.file !== 'string' || raw.preregistration.file.trim() === '' || !path.isAbsolute(raw.preregistration.file)) {
        ok = false;
        problems.push({ field: 'preregistration.file', code: 'not_absolute_path', message: `preregistration.file must be a non-empty absolute path, got ${preview(raw.preregistration.file)}` });
      }
      if (typeof raw.preregistration.sha256 !== 'string' || !SHA256_HEX_RE.test(raw.preregistration.sha256)) {
        ok = false;
        problems.push({ field: 'preregistration.sha256', code: 'invalid_value', message: `preregistration.sha256 must be 64 hex characters, got ${preview(raw.preregistration.sha256)}` });
      }
      if (ok) {
        out.preregistration = { file: raw.preregistration.file, sha256: raw.preregistration.sha256.toLowerCase() };
        preregOk = true;
      }
    }
  }

  // legacy {batch} — historical closed set (CF-13)
  const legacyPresent = hasOwn(raw, 'legacy');
  let legacyOk = false;
  if (legacyPresent) {
    if (!isPlainObject(raw.legacy)) {
      problems.push({ field: 'legacy', code: 'invalid_type', message: `legacy must be an object {batch}, got ${preview(raw.legacy)}` });
    } else {
      for (const key of Object.keys(raw.legacy)) {
        if (key !== 'batch') {
          problems.push({ field: `legacy.${key}`, code: 'unknown_field', message: 'legacy accepts ONLY batch — no additional fields' });
        }
      }
      if (!hasOwn(raw.legacy, 'batch')) {
        problems.push({ field: 'legacy.batch', code: 'missing_required_field', message: 'legacy.batch is required' });
      } else if (typeof raw.legacy.batch !== 'string' || !LEGACY_BATCHES.includes(raw.legacy.batch)) {
        problems.push({ field: 'legacy.batch', code: 'unknown_legacy_batch', message: `legacy.batch must be one of ${LEGACY_BATCHES.join(' | ')}, got ${preview(raw.legacy.batch)}` });
      } else {
        out.legacyBatch = raw.legacy.batch;
        legacyOk = true;
      }
    }
  }

  // Mode exclusivity (TECH §4.1: exactly one of the two modes, ever)
  if (preregPresent && legacyPresent) {
    problems.push({ field: 'legacy', code: 'mode_conflict', message: 'legacy and preregistration are mutually exclusive — historical replays must omit preregistration, new experiments must not declare legacy' });
  } else if (!preregPresent && !legacyPresent) {
    problems.push({ field: 'preregistration', code: 'mode_missing', message: 'config must declare EITHER preregistration (new experiment) OR legacy.batch (historical replay) — neither is present' });
  }

  return {
    experimentRootOk,
    additionalRootsOk,
    datasetOk,
    snapshotOk,
    baseConfigOk,
    armsOk,
    preregOk,
    legacyOk,
    preregPresent,
    legacyPresent,
  };
}

/* ───────────────────────── file-level reconciliation ──────────────────── */

function fileExistsRegular(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

function fileExistsDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * P1-2 snapshot-object fence — runs BEFORE any digest read of a snapshot
 * object (state.db, trajectory.db, blob-manifest.json, blobs/, every blob):
 *   1. every ALREADY-EXISTING level of the path is walked (fenceWalk) and
 *      any symlink/junction/reparse point anywhere in the chain is rejected;
 *   2. the final component must be a REAL file/directory on disk — symlinks
 *      (incl. dangling ones) are rejected even when they point at identical
 *      bytes, because a snapshot is a physical copy, not a view;
 *   3. file objects additionally require nlink === 1: T1 produces snapshot
 *      files as independent copies, so a hardlink would share identity with
 *      content outside the snapshot;
 *   4. the nearest-existing-ancestor realpath must land inside the snapshot
 *      root (containment over REAL paths, not string prefixes).
 * Returns the lstat stats when the object may safely be opened for hashing;
 * returns null (with a problem recorded) when the caller MUST skip the read.
 */
function fenceSnapshotObject(field, filePath, snapshotCanonical, opts, problems) {
  const noun = opts.kind === 'dir' ? 'directory' : 'regular file';
  const fw = fenceWalk(filePath);
  for (const hit of fw.reparseHits) {
    problems.push({ field, code: 'reparse_point', message: `${field} passes through a symlink/junction/reparse point: ${hit.path} — snapshot objects must be real ${noun}s, never redirects` });
    return null;
  }
  let st = null;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    problems.push({ field, code: 'file_missing', message: `${field}: does not exist: ${filePath}` });
    return null;
  }
  if (st.isSymbolicLink()) {
    problems.push({ field, code: 'file_type', message: `${field} must be a REAL ${noun} on disk — a symlink/junction/reparse point is rejected even when it currently points at identical bytes (the link target can be re-aimed after preflight)` });
    return null;
  }
  if (opts.kind === 'dir' && !st.isDirectory()) {
    problems.push({ field, code: 'file_type', message: `${field} must be a directory, got a non-directory at ${filePath}` });
    return null;
  }
  if (opts.kind === 'file' && !st.isFile()) {
    problems.push({ field, code: 'file_type', message: `${field} must be a regular file, got a non-regular file at ${filePath}` });
    return null;
  }
  if (opts.kind === 'file' && opts.requireIndependentCopy && st.nlink !== 1) {
    problems.push({ field, code: 'hardlink_not_independent_copy', message: `${field} has nlink=${st.nlink} — snapshot files are independent copies (T1), so a hardlink would share identity with content outside the snapshot dir` });
    return null;
  }
  if (!isWithin(snapshotCanonical, fw.nearestCanonical)) {
    problems.push({ field, code: 'path_traversal', message: `${field} resolves (nearest-existing-ancestor) outside the snapshot dir: ${fw.nearestCanonical}` });
    return null;
  }
  return st;
}

/** Verify one declared digest against the CURRENT raw bytes of a file. */
function verifyFileDigest(field, file, declared, problems) {
  if (!fileExistsRegular(file)) {
    problems.push({ field, code: 'file_missing', message: `${field}: file does not exist or is not readable: ${file}` });
    return null;
  }
  let actual;
  try {
    actual = sha256FileRaw(file);
  } catch (err) {
    problems.push({ field, code: 'file_unreadable', message: `${field}: reading failed: ${preview(err && err.message ? err.message : String(err), 160)}` });
    return null;
  }
  if (actual !== declared) {
    problems.push({ field, code: 'digest_mismatch', message: `${field}: declared sha256 ${declared} but current raw bytes hash to ${actual} (${file})` });
    return null;
  }
  return actual;
}

/**
 * Parse + verify the snapshot's blob manifest and every referenced blob
 * (TECH §4.1/§5.1: verifying only the two DB files is NOT enough).
 *
 * The manifest must satisfy the FULL production contract of T1's
 * snapshot-and-discover.mjs (`pd-lab-blob-manifest.v1`):
 *   - `ok` strictly true and `consistencyStatus` strictly
 *     CONSISTENT_WITHIN_WINDOW — a PARTIAL_CONSISTENCY directory is by
 *     definition NOT a complete snapshot and must never anchor an experiment;
 *   - `blobDir` exactly `blobs`;
 *   - every entry shaped exactly like the producer emits it:
 *     `path` = `blobs/<ref>` (single safe segment), string `ref`, 64-hex
 *     `sha256`, non-negative integer `bytes`, positive integer
 *     `referenceCount`, `referencedBy` array of strings;
 *   - no duplicate ref and no duplicate path;
 *   - counts cross-checked against the files array (copied == files.length,
 *     referencedDistinct == distinct refs, referencedRows == Σ referenceCount).
 *     An empty files array is legal ONLY with all three derived counts at 0.
 *     (`orphansNotCopied` is intentionally NOT forced to 0: the producer
 *     legitimately reports source-side orphan blobs with zero referenced
 *     blobs, and nothing inside the manifest can contradict that number.)
 * Every blob is then P1-2-fenced (real regular file, clean chain, hardlink
 * check, nearest-existing-ancestor containment) before its digest is read —
 * a forged manifest must not be able to make the verifier hash files outside
 * the snapshot dir or through redirects.
 */
function verifySnapshotBlobs(snapshot, snapshotCanonical, problems) {
  const manifestPath = path.join(snapshot.dir, 'blob-manifest.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    problems.push({ field: 'snapshot.blobManifest', code: 'file_unreadable', message: `blob-manifest.json missing or not valid JSON: ${preview(err && err.message ? err.message : String(err), 120)}` });
    return { verified: 0 };
  }
  if (!isPlainObject(parsed) || parsed.schema !== 'pd-lab-blob-manifest.v1') {
    problems.push({ field: 'snapshot.blobManifest', code: 'invalid_value', message: `blob manifest schema must be pd-lab-blob-manifest.v1, got ${preview(parsed && parsed.schema)}` });
    return { verified: 0 };
  }

  // P1-1: completeness state — the producer's "complete snapshot" verdict.
  if (parsed.ok !== true) {
    problems.push({ field: 'snapshot.blobManifest', code: 'manifest_not_ok', message: `blob manifest ok must be exactly true (a complete snapshot), got ${preview(parsed.ok)}` });
  }
  if (!hasOwn(parsed, 'consistencyStatus') || parsed.consistencyStatus === undefined) {
    problems.push({ field: 'snapshot.blobManifest', code: 'missing_consistency_status', message: 'blob manifest consistencyStatus is missing — a snapshot without a recorded consistency verdict is not loadable' });
  } else if (parsed.consistencyStatus !== 'CONSISTENT_WITHIN_WINDOW') {
    problems.push({ field: 'snapshot.blobManifest', code: 'inconsistent_snapshot', message: `blob manifest consistencyStatus must be exactly CONSISTENT_WITHIN_WINDOW, got ${preview(parsed.consistencyStatus)} — PARTIAL_CONSISTENCY (or any unknown/type-invalid status) must not anchor an experiment` });
  }
  if (!Array.isArray(parsed.consistencyReasons) || parsed.consistencyReasons.some((r) => typeof r !== 'string')) {
    problems.push({ field: 'snapshot.blobManifest', code: 'invalid_type', message: 'blob manifest consistencyReasons must be an array of strings (producer contract)' });
  }
  if (parsed.blobDir !== 'blobs') {
    problems.push({ field: 'snapshot.blobManifest.blobDir', code: 'invalid_value', message: `blob manifest blobDir must be exactly 'blobs' (T1 layout contract), got ${preview(parsed.blobDir)}` });
  }

  if (!Array.isArray(parsed.files)) {
    problems.push({ field: 'snapshot.blobManifest', code: 'invalid_type', message: 'blob manifest files must be an array' });
    return { verified: 0 };
  }

  // counts shape (P1-1): every count must be a non-negative safe integer —
  // and a missing/non-object `counts` is itself a violation: without this
  // problem, countsOkShape is false with nothing recorded, the reconciliation
  // below is skipped, and an otherwise-valid manifest passes with no counts.
  const countsOkShape = (() => {
    if (!isPlainObject(parsed.counts)) {
      problems.push({ field: 'snapshot.blobManifest.counts', code: 'invalid_type', message: `blob manifest counts must be an object with non-negative integer counts, got ${preview(parsed.counts)}` });
      return false;
    }
    return ['referencedDistinct', 'referencedRows', 'copied', 'orphansNotCopied'].every((k) => {
      const v = parsed.counts[k];
      if (!Number.isSafeInteger(v) || v < 0) {
        problems.push({ field: `snapshot.blobManifest.counts.${k}`, code: 'invalid_type', message: `blob manifest counts.${k} must be a non-negative integer, got ${preview(v)}` });
        return false;
      }
      return true;
    });
  })();

  const seenPaths = new Set();
  const seenRefs = new Set();
  let referenceCountSum = 0;
  let verified = 0;
  parsed.files.forEach((entry, i) => {
    if (!isPlainObject(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || !SHA256_HEX_RE.test(entry.sha256)) {
      problems.push({ field: `snapshot.blobManifest.files[${i}]`, code: 'invalid_type', message: `manifest entry must carry string path and 64-hex sha256, got ${preview(entry)}` });
      return;
    }
    // Producer shape: exactly `blobs/<ref>` — one safe segment, nothing else.
    const pathMatch = typeof entry.path === 'string' ? entry.path.match(/^blobs\/([^\\/]+)$/) : null;
    if (!pathMatch || pathMatch[1] === '.' || pathMatch[1] === '..') {
      problems.push({ field: `snapshot.blobManifest.files[${i}].path`, code: 'path_traversal', message: `manifest entry path must match blobs/<ref> exactly (one safe segment), got ${preview(entry.path)}` });
      return;
    }
    if (typeof entry.ref !== 'string' || entry.ref === '' || entry.path !== `blobs/${entry.ref}`) {
      problems.push({ field: `snapshot.blobManifest.files[${i}].path`, code: 'invalid_value', message: `manifest entry path must equal blobs/${preview(entry.ref)} (the entry's own ref), got ${preview(entry.path)}` });
      return;
    }
    if (seenPaths.has(entry.path)) {
      problems.push({ field: `snapshot.blobManifest.files[${i}].path`, code: 'duplicate_manifest_entry', message: `duplicate manifest path ${preview(entry.path)} — each blob is copied exactly once by T1` });
      return;
    }
    if (seenRefs.has(entry.ref)) {
      problems.push({ field: `snapshot.blobManifest.files[${i}].ref`, code: 'duplicate_manifest_entry', message: `duplicate manifest ref ${preview(entry.ref)} — each blob is copied exactly once by T1` });
      return;
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      problems.push({ field: `snapshot.blobManifest.files[${i}].bytes`, code: 'invalid_type', message: `manifest entry bytes must be a non-negative integer, got ${preview(entry.bytes)}` });
      return;
    }
    if (!Number.isSafeInteger(entry.referenceCount) || entry.referenceCount < 1) {
      problems.push({ field: `snapshot.blobManifest.files[${i}].referenceCount`, code: 'invalid_type', message: `manifest entry referenceCount must be a positive integer (the entry exists because rows reference it), got ${preview(entry.referenceCount)}` });
      return;
    }
    if (!Array.isArray(entry.referencedBy) || entry.referencedBy.some((t) => typeof t !== 'string')) {
      problems.push({ field: `snapshot.blobManifest.files[${i}].referencedBy`, code: 'invalid_type', message: `manifest entry referencedBy must be an array of table-name strings, got ${preview(entry.referencedBy)}` });
      return;
    }
    seenPaths.add(entry.path);
    seenRefs.add(entry.ref);
    referenceCountSum += entry.referenceCount;

    // P1-2 fence BEFORE the digest read; skip hashing anything that failed.
    const blobPath = path.join(snapshot.dir, 'blobs', entry.ref);
    const st = fenceSnapshotObject(`snapshot.blobManifest.files[${i}]`, blobPath, snapshotCanonical, { kind: 'file', requireIndependentCopy: true }, problems);
    if (st === null) return;
    if (verifyFileDigest(`snapshot.blobManifest.files[${i}]`, blobPath, entry.sha256.toLowerCase(), problems) !== null) {
      verified += 1;
    }
  });

  // P1-1: counts must reconcile with the files array (only when well-typed).
  if (countsOkShape) {
    if (parsed.counts.copied !== parsed.files.length) {
      problems.push({ field: 'snapshot.blobManifest.counts.copied', code: 'counts_mismatch', message: `blob manifest counts.copied (${parsed.counts.copied}) must equal the number of files entries (${parsed.files.length})` });
    }
    if (parsed.counts.referencedDistinct !== seenRefs.size) {
      problems.push({ field: 'snapshot.blobManifest.counts.referencedDistinct', code: 'counts_mismatch', message: `blob manifest counts.referencedDistinct (${parsed.counts.referencedDistinct}) must equal the number of distinct blob refs (${seenRefs.size})` });
    }
    if (parsed.counts.referencedRows !== referenceCountSum) {
      problems.push({ field: 'snapshot.blobManifest.counts.referencedRows', code: 'counts_mismatch', message: `blob manifest counts.referencedRows (${parsed.counts.referencedRows}) must equal the sum of entry referenceCounts (${referenceCountSum})` });
    }
  }
  return { verified };
}

/* ───────────────────────────── path-safety fence ──────────────────────── */

function checkPathSafety(out, okFlags, problems) {
  const forbidden = deriveForbiddenRoots();
  if (okFlags.additionalRootsOk) {
    out.additionalForbiddenRoots.forEach((rootPath, i) => {
      forbidden.push({ label: `additionalForbiddenRoots[${i}]`, pathValue: rootPath, canonical: canonical(rootPath) });
    });
  }
  const archiveRootCanonical = canonical(deriveArchiveRoot());

  // Arm worktree fence (independent of experimentRoot validity): reparse
  // fence + existence — on a machine without the historical paths these are
  // the itemized "missing path" findings T3's lab:preflight reports.
  if (okFlags.armsOk) {
    for (const [armId, arm] of Object.entries(out.arms)) {
      for (const hit of fenceWalk(arm.worktree).reparseHits) {
        problems.push({ field: `arms.${armId}.worktree`, code: 'reparse_point', message: `arm worktree passes through a symlink/junction/reparse point: ${hit.path}` });
      }
      if (!fileExistsDir(arm.worktree)) {
        problems.push({ field: `arms.${armId}.worktree`, code: 'file_missing', message: `arm worktree directory does not exist: ${arm.worktree}` });
      }
    }
  }

  if (okFlags.experimentRootOk) {
    const root = out.experimentRoot;
    for (const hit of fenceWalk(root).reparseHits) {
      problems.push({ field: 'experimentRoot', code: 'reparse_point', message: `experimentRoot passes through a symlink/junction/reparse point: ${hit.path} — refusing to anchor the experiment behind a redirect` });
    }
    const rootCanonical = canonical(root);
    for (const f of forbidden) {
      if (isWithin(f.canonical, rootCanonical) || isWithin(rootCanonical, f.canonical)) {
        problems.push({ field: 'experimentRoot', code: 'forbidden_root', message: `experimentRoot overlaps forbidden root (${f.label}: ${f.pathValue})` });
      }
    }
    // Mutual containment vs arm worktrees, both directions (§4.5)
    if (okFlags.armsOk) {
      for (const [armId, arm] of Object.entries(out.arms)) {
        const armCanonical = canonical(arm.worktree);
        if (isWithin(armCanonical, rootCanonical)) {
          problems.push({ field: 'experimentRoot', code: 'escapes_into_arm_worktree', message: `experimentRoot (${root}) resolves inside arm ${armId}'s worktree (${arm.worktree})` });
        }
        if (isWithin(rootCanonical, armCanonical)) {
          problems.push({ field: `arms.${armId}.worktree`, code: 'worktree_inside_experiment_root', message: `arm ${armId}'s worktree (${arm.worktree}) resolves inside the experimentRoot (${root})` });
        }
      }
    }
    // dataset / snapshot location fence (§4.5: inside experimentRoot or the archive root)
    if (okFlags.datasetOk) {
      const c = canonical(out.dataset.file);
      if (!isWithin(rootCanonical, c) && !isWithin(archiveRootCanonical, c)) {
        problems.push({ field: 'dataset.file', code: 'outside_experiment_or_archive_root', message: `dataset.file must live inside the experimentRoot or the pd-lab archive root, got ${out.dataset.file}` });
      }
    }
    if (okFlags.snapshotOk) {
      const c = canonical(out.snapshot.dir);
      if (!isWithin(rootCanonical, c) && !isWithin(archiveRootCanonical, c)) {
        problems.push({ field: 'snapshot.dir', code: 'outside_experiment_or_archive_root', message: `snapshot.dir must live inside the experimentRoot or the pd-lab archive root, got ${out.snapshot.dir}` });
      }
    }
    // workspaceFiles physical fence against the arm-workspace base (CF-06).
    // P1-3: the fence covers the WHOLE chain — experimentRoot → workspaces →
    // <armId> → every target intermediate → the existing target file — via
    // fenceWalk over the joined path, which walks every ALREADY-EXISTING
    // level and stops at the first missing one. A missing arm workspace is
    // therefore NOT a skip: a junction/symlink at any higher existing level
    // (e.g. `workspaces` itself) is still caught. Containment uses the
    // nearest-existing-ancestor REAL path (never string prefixes alone).
    if (okFlags.armsOk) {
      for (const [armId, arm] of Object.entries(out.arms)) {
        if (!arm.workspaceFiles) continue;
        const base = path.join(out.experimentRoot, 'workspaces', armId);
        arm.workspaceFiles.forEach((entry, i) => {
          const field = `arms.${armId}.workspaceFiles[${i}].target`;
          const rel = checkRelativeTarget(field, entry.target, base);
          problems.push(...rel.problems);
          if (!rel.ok) return; // lexical violations already reported
          const full = path.join(base, ...entry.target.split(/[\\/]+/));
          const fw = fenceWalk(full);
          for (const hit of fw.reparseHits) {
            problems.push({ field, code: 'reparse_point', message: `${field} chain passes through a symlink/junction/reparse point: ${hit.path} — every existing level from experimentRoot through workspaces/${armId} to the target must be a real directory` });
          }
          if (fw.reparseHits.length === 0 && !isWithin(canonical(base), fw.nearestCanonical)) {
            problems.push({ field, code: 'path_traversal', message: `${field} resolves (nearest-existing-ancestor) outside the arm workspace base ${base}: ${fw.nearestCanonical}` });
          }
        });
      }
    }
  }
}

/* ─────────────────────────── feature-flag authority ───────────────────── */

const REGISTERED_FLAG_IDS = new Set(DEFAULT_FEATURE_FLAGS.map((f) => f && f.id).filter((id) => typeof id === 'string'));

function checkFeatureFlagRegistration(out, okFlags, problems) {
  if (!okFlags.armsOk) return;
  for (const [armId, arm] of Object.entries(out.arms)) {
    if (!arm.featureOverrides) continue;
    for (const flagId of Object.keys(arm.featureOverrides)) {
      if (!REGISTERED_FLAG_IDS.has(flagId)) {
        problems.push({ field: `arms.${armId}.featureOverrides.${flagId}`, code: 'unregistered_feature_flag', message: `flagId ${preview(flagId)} is not registered in the feature-flag authority (DEFAULT_FEATURE_FLAGS) — a typo here would silently make both arms identical` });
      }
    }
  }
}

/* ──────────────────────────── freeze utilities ────────────────────────── */

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/* ─────────────────────────────── main entry ───────────────────────────── */

/**
 * Load, validate and freeze the experiment config at `file`.
 *
 * @param {string} file - path to the experiment config JSON (absolute, or
 *   resolved against the caller's cwd). The ONLY parameter — TECH §3.2
 *   declares `loadExperimentConfig(file)` as the module's sole public
 *   interface; runId validation belongs to T3b's path-join sites (see the
 *   module header).
 * @returns {object} frozen validated config:
 *   { schema, experimentId, mode: 'preregistered'|'legacy', legacy,
 *     preregistration, baselineArm, candidateArm, arms, experimentRoot,
 *     additionalForbiddenRoots, dataset, snapshot, baseConfigFile,
 *     profileRebind?, modelEnv, note?, verification: { configSha256,
 *     preregistrationStatus: 'VERIFIED'|'NOT_APPLICABLE_LEGACY',
 *     preregistrationSha256: string|null, datasetSha256Verified,
 *     snapshotVerified: { state, trajectory, blobManifest, blobsVerified } } }
 * @throws {ExperimentConfigError} with `problems[]` — every finding at once.
 */
export function loadExperimentConfig(file) {
  const problems = [];
  if (typeof file !== 'string' || file.trim() === '') {
    problems.push({ field: 'file', code: 'missing_argument', message: 'config file path is required — entries must pass an explicit --config (no default, no env fallback)' });
    throw new ExperimentConfigError(problems);
  }
  const configPath = path.resolve(file);

  let configBytes;
  try {
    configBytes = fs.readFileSync(configPath);
  } catch (err) {
    problems.push({ field: 'file', code: 'config_file_unreadable', message: `cannot read config file ${configPath}: ${preview(err && err.message ? err.message : String(err), 160)}` });
    throw new ExperimentConfigError(problems);
  }
  const configSha256 = sha256Buffer(configBytes);

  let raw;
  try {
    raw = JSON.parse(configBytes.toString('utf8'));
  } catch (err) {
    problems.push({ field: 'file', code: 'invalid_json', message: `config is not valid JSON: ${preview(err && err.message ? err.message : String(err), 160)}` });
    throw new ExperimentConfigError(problems, configSha256);
  }

  const out = { schema: CONFIG_SCHEMA_ID };
  const okFlags = validateStructure(raw, problems, out);
  checkPathSafety(out, okFlags, problems);
  checkFeatureFlagRegistration(out, okFlags, problems);

  // ── file-level digest/identity reconciliation (current files, every call)
  let preregistrationStatus = 'NOT_APPLICABLE_LEGACY';
  let preregistrationSha256 = null;
  if (okFlags.preregOk && !okFlags.legacyPresent) {
    // New experiment: bind the preregistration file's CURRENT raw bytes.
    const preregProblems = [];
    const actual = verifyFileDigest('preregistration', out.preregistration.file, out.preregistration.sha256, preregProblems);
    if (actual !== null) {
      let text = null;
      try {
        text = fs.readFileSync(out.preregistration.file, 'utf8');
      } catch (err) {
        preregProblems.push({ field: 'preregistration.file', code: 'file_unreadable', message: `preregistration could not be decoded as text: ${preview(err && err.message ? err.message : String(err), 120)}` });
      }
      if (text !== null) {
        const fm = parseFrontMatterExperimentId(text);
        if (!fm.ok) {
          preregProblems.push({ field: 'preregistration.file', code: fm.reason, message: fm.message });
        } else if (out.experimentId === undefined) {
          // structural problems already cover a bad experimentId
        } else if (fm.experimentId !== out.experimentId) {
          preregProblems.push({ field: 'preregistration.file', code: 'experiment_id_mismatch', message: `front-matter experimentId ${preview(fm.experimentId)} does not match config experimentId ${preview(out.experimentId)}` });
        }
      }
    }
    if (preregProblems.length === 0) {
      preregistrationStatus = 'VERIFIED';
      preregistrationSha256 = actual;
    } else {
      problems.push(...preregProblems);
    }
  }
  // Historical legacy mode: preregistrationStatus stays NOT_APPLICABLE_LEGACY
  // with a null digest — never a forged value (TECH §7 / CF-13).

  if (okFlags.datasetOk) {
    verifyFileDigest('dataset', out.dataset.file, out.dataset.sha256, problems);
  }
  let blobsVerified = null;
  if (okFlags.snapshotOk) {
    // P1-2: fence + file-type checks run BEFORE any digest read — the loader
    // must never open (hash) a snapshot object through a symlink/junction,
    // a hardlink, or a redirected parent chain.
    const snapshotCanonical = canonical(out.snapshot.dir);
    fenceSnapshotObject('snapshot.dir', out.snapshot.dir, snapshotCanonical, { kind: 'dir' }, problems);
    const snapshotFiles = [
      ['state', 'snapshot.sha256.state', 'state.db'],
      ['trajectory', 'snapshot.sha256.trajectory', 'trajectory.db'],
      ['blobManifest', 'snapshot.sha256.blobManifest', 'blob-manifest.json'],
    ];
    let manifestFenced = false;
    for (const [key, field, name] of snapshotFiles) {
      const filePath = path.join(out.snapshot.dir, name);
      const st = fenceSnapshotObject(field, filePath, snapshotCanonical, { kind: 'file', requireIndependentCopy: true }, problems);
      if (st === null) continue;
      verifyFileDigest(field, filePath, out.snapshot.sha256[key], problems);
      if (key === 'blobManifest') manifestFenced = true;
    }
    const blobsDirSt = fenceSnapshotObject('snapshot.blobsDir', path.join(out.snapshot.dir, 'blobs'), snapshotCanonical, { kind: 'dir' }, problems);
    if (manifestFenced && blobsDirSt !== null) {
      blobsVerified = verifySnapshotBlobs(out.snapshot, snapshotCanonical, problems).verified;
    }
  }
  if (okFlags.baseConfigOk) {
    // P2: baseConfigFile is the derivation TEMPLATE — its file judgment is
    // strict: real, regular, readable, reached without redirects. A missing
    // file, a dangling symlink, a symlink to a directory, a plain directory
    // or an unreadable file are each rejected; no lstat-symlink shortcut.
    const fw = fenceWalk(out.baseConfigFile);
    for (const hit of fw.reparseHits) {
      problems.push({ field: 'baseConfigFile', code: 'reparse_point', message: `baseConfigFile passes through a symlink/junction/reparse point: ${hit.path} — the derivation template must be a real file at its declared location` });
    }
    let st = null;
    try {
      st = fs.lstatSync(out.baseConfigFile);
    } catch { /* missing — reported below */ }
    if (st === null) {
      problems.push({ field: 'baseConfigFile', code: 'file_missing', message: `baseConfigFile does not exist: ${out.baseConfigFile}` });
    } else if (st.isSymbolicLink()) {
      problems.push({ field: 'baseConfigFile', code: 'file_type', message: `baseConfigFile must be a REAL regular file — a symlink (including a dangling one, or one pointing at a directory) is rejected: ${out.baseConfigFile}` });
    } else if (!st.isFile()) {
      problems.push({ field: 'baseConfigFile', code: 'file_type', message: `baseConfigFile must be a regular file, got a directory or other non-regular file: ${out.baseConfigFile}` });
    } else {
      try {
        fs.readFileSync(out.baseConfigFile);
      } catch (err) {
        problems.push({ field: 'baseConfigFile', code: 'file_unreadable', message: `baseConfigFile exists but cannot be read: ${preview(err && err.message ? err.message : String(err), 120)}` });
      }
    }
  }
  if (okFlags.armsOk) {
    for (const [armId, arm] of Object.entries(out.arms)) {
      if (!arm.workspaceFiles) continue;
      arm.workspaceFiles.forEach((entry, i) => {
        verifyFileDigest(`arms.${armId}.workspaceFiles[${i}].source`, entry.source, entry.sha256, problems);
      });
    }
  }

  if (problems.length > 0) {
    throw new ExperimentConfigError(problems, configSha256);
  }

  out.mode = out.legacyBatch !== undefined ? 'legacy' : 'preregistered';
  out.legacy = out.legacyBatch !== undefined ? { batch: out.legacyBatch } : null;
  delete out.legacyBatch;
  out.preregistration = out.preregistration ?? null;
  out.verification = {
    configSha256,
    preregistrationStatus,
    preregistrationSha256,
    datasetSha256Verified: true,
    snapshotVerified: {
      state: true,
      trajectory: true,
      blobManifest: true,
      blobsVerified,
    },
  };
  return deepFreeze(out);
}
