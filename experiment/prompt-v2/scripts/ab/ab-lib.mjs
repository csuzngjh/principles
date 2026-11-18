/**
 * PD-SPEC-001 A/B harness — shared library.
 *
 * Design (SPEC Part IV/V):
 * - Two ARMS, each running REAL production code from its own worktree:
 *     v1 = frozen worktree at base commit 0485046e7 (V1 prompts)
 *     v2 = task worktree ai/adhoc-20261115-prompt-v2-k4wz9t (V2 prompts)
 *   Everything except the six prompt builders (+ adapter example) is
 *   byte-identical between the arms (proven by empty git diff on the frozen
 *   file list, see baseline/PROMPT_SCHEMA_BASELINE.md §9).
 * - Each arm gets its OWN experiment workspace (per shard: workspaces/<arm>-s<shard>).
 * - Both arms share: frozen inputs, model profile (pi-ai.amd-ds-vision /
 *   GLM-5.3-Flash / maxTokens 16384), flags, validators, retry policy.
 * - Execution goes through the production CLI surface (`pd diagnose run`,
 *   `pd runtime internalization run-once`) so gates, committers, leases and
 *   repair loops are the real ones.
 *
 * Remediation (Owner directive): NO fallback to the public redacted dataset —
 * full-fidelity data or nothing (loadDataset fails closed).
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKTREES = {
  v2: 'D:/Code/_worktrees/principles/adhoc-20261115-prompt-v2-k4wz9t',
  // v1 arm worktree (created at base commit); path asserted by preflight.
  v1: 'D:/Code/_worktrees/principles/adhoc-20261115-prompt-v2-v1arm-v1-base',
  // PD-SPEC-001 round 2 (Dreamer V2.1): control arm = first-round V2 prompts
  // pinned at the PR #2653 head the Owner referenced (9b87e9bc4); treatment
  // arm = this task worktree (only dreamer-prompt-builder.ts differs from the
  // control arm — asserted by the round-2 preflight).
  v2c: 'D:/Code/_worktrees/principles/adhoc-20261115-prompt-v21-v2control',
  v21: 'D:/Code/_worktrees/principles/adhoc-20261115-prompt-v2-k4wz9t',
};

export const PRODUCTION_WORKSPACE = 'D:/.openclaw/workspace';
export const V1_BASE_COMMIT = '0485046e71d2aeba4769725adb4f2aac35a5dd9b';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXPERIMENT_ROOT = path.resolve(here, '..', '..', '..', '..', '.tmp', 'prompt-v2-ab');
export const SNAPSHOT_DIR = path.resolve(WORKTREES.v2, '.tmp/prompt-v2-inventory/snapshot');
/**
 * The committed dataset copy is FIELD-REDACTED for the PUBLIC repo (verbatim
 * pain text → sha256 placeholders, see scripts/redact-for-publication.mjs).
 * Execution REQUIRES the FULL-fidelity dataset at the gitignored local path —
 * there is deliberately NO fallback to the public redacted copy: no full data,
 * no experiment (remediation directive §6.1).
 */
const FULL_DATASET_FILE = path.resolve(WORKTREES.v2, '.tmp/prompt-v2-inventory/pain-dataset.full.json');
export const DATASET_FILE = FULL_DATASET_FILE;

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export function canonical(p) {
  const resolved = path.resolve(p);
  try {
    const real = fs.realpathSync.native(resolved);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

/**
 * Production control-plane directories the experiment must never touch.
 * PRI-1252 r2: hoisted to ONE source of truth so preflightIsolation(),
 * validateWorkspaceIsolation() and the childEnv() value gate all compare
 * against the same list (previously only preflightIsolation knew it).
 */
export const PRODUCTION_NO_WRITE_PATHS = [
  ['production workspace', PRODUCTION_WORKSPACE],
  ['production openclaw root', 'D:/.openclaw'],
  ['pd home', 'C:/Users/Administrator/.pd'],
  ['openclaw home', 'C:/Users/Administrator/.openclaw'],
  ['codex home', 'C:/Users/Administrator/.codex'],
  ['primary repo', 'D:/Code/principles'],
];

/** Containment predicate over ALREADY-canonical (realpath'd, case-folded) paths. */
function isWithin(rootCanonical, candidateCanonical) {
  return candidateCanonical === rootCanonical
    || candidateCanonical.startsWith(rootCanonical + path.sep)
    || candidateCanonical.startsWith(rootCanonical + '/');
}

/** lstat or null (missing / unreadable) — never throws. */
function lstatSafe(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

/**
 * PRI-1252 r2 — THE unified physical-path isolation validator for experiment
 * workspace directories (one mechanism, consumed by preflightIsolation(),
 * materializeWorkspace(), spawnPdChild()/runPd()/runPdIn() and the childEnv()
 * PD_WORKSPACE_DIR value gate — deliberately NOT a second ad-hoc startsWith
 * check per call site).
 *
 * Layers (every failure is collected — the refusal lists them all):
 *   P1 lexical containment: the resolved path stays inside EXPERIMENT_ROOT;
 *   P2 per-level reparse fence: every EXISTING directory level from
 *      EXPERIMENT_ROOT down to the target is a REAL directory — lstat()'d one
 *      level at a time, any symlink/junction/reparse point is refused
 *      (startsWith string containment cannot see a junction);
 *   P3 physical containment: fs.realpathSync.native() of the deepest existing
 *      level (+ the not-yet-existing tail) stays inside the experiment root;
 *   P4 production overlap: the canonical path neither lives inside nor
 *      contains any PRODUCTION_NO_WRITE_PATHS entry.
 *
 * A not-yet-existing target validates through its deepest existing ancestor;
 * every caller re-validates AFTER creating the directory (see the phase
 * wiring in materializeWorkspace / spawnPdChild).
 *
 * Returns { ok, phase, target, canonical, real, failures: [{reason, detail}] }.
 * Use assertWorkspaceIsolation() at call sites that must fail closed.
 */
export function validateWorkspaceIsolation(targetPath, { phase = 'validate' } = {}) {
  const failures = [];
  const rootReal = path.resolve(EXPERIMENT_ROOT);
  const rootCanonical = canonical(rootReal);

  // P1 — lexical containment.
  if (typeof targetPath !== 'string' || targetPath.trim() === '' || !path.isAbsolute(targetPath)) {
    return {
      ok: false, phase, target: String(targetPath), canonical: null, real: null,
      failures: [{ reason: 'not_absolute_path', detail: `workspace path must be absolute, got ${JSON.stringify(String(targetPath))}` }],
    };
  }
  const resolved = path.resolve(targetPath);
  if (!isWithin(rootCanonical, canonical(resolved))) {
    failures.push({ reason: 'escapes_experiment_root', detail: `${resolved} is not inside the experiment root ${EXPERIMENT_ROOT}` });
  }

  // P2 — per-level reparse fence from the root down to the target.
  const segments = path.relative(rootReal, resolved).split(/[\\/]+/).filter(Boolean);
  const rootLs = lstatSafe(rootReal);
  let deepestExisting;
  let existingCount = 0;
  if (rootLs === null) {
    deepestExisting = rootReal; // fresh machine: nothing below the root can exist yet
  } else if (rootLs.isSymbolicLink()) {
    failures.push({ reason: 'reparse_point', detail: `experiment root itself is a symlink/junction/reparse point: ${rootReal}` });
    deepestExisting = null;
  } else {
    deepestExisting = rootReal;
    for (const seg of segments) {
      const level = path.join(deepestExisting, seg);
      const st = lstatSafe(level);
      if (st === null) break; // first missing level — the tail is validated lexically (P3)
      deepestExisting = level;
      existingCount += 1;
      if (st.isSymbolicLink()) {
        failures.push({ reason: 'reparse_point', detail: `${level} is a symlink/junction/reparse point (unauthorized redirect of the workspace path)` });
        deepestExisting = null; // cannot trust anything below a link
        break;
      }
      if (!st.isDirectory()) {
        failures.push({ reason: 'mid_path_not_directory', detail: `${level} exists but is not a directory` });
        deepestExisting = null;
        break;
      }
    }
  }

  // P3 — physical containment via realpath of the deepest existing level.
  let deepestReal = deepestExisting;
  if (deepestReal !== null) {
    try { deepestReal = fs.realpathSync.native(deepestReal); } catch { deepestReal = path.resolve(deepestReal); }
  }
  const missingTail = segments.slice(existingCount);
  const candidateReal = deepestReal === null ? resolved : (missingTail.length > 0 ? path.join(deepestReal, ...missingTail) : deepestReal);
  const candidateCanonical = canonical(candidateReal);
  if (!isWithin(rootCanonical, candidateCanonical)) {
    failures.push({ reason: 'realpath_escapes_experiment_root', detail: `${candidateReal} resolves outside the experiment root ${EXPERIMENT_ROOT}` });
  }

  // P4 — production overlap (both directions).
  for (const [label, p] of PRODUCTION_NO_WRITE_PATHS) {
    const prodCanonical = canonical(p);
    if (isWithin(prodCanonical, candidateCanonical) || isWithin(candidateCanonical, prodCanonical)) {
      failures.push({ reason: 'production_overlap', detail: `${candidateReal} overlaps ${label} (${p})` });
    }
  }

  return { ok: failures.length === 0, phase, target: resolved, canonical: candidateCanonical, real: candidateReal, failures };
}

/** Formatted, auditable refusal message (phase + every reason + next action). */
export function formatIsolationRefusal(verified) {
  const reasons = verified.failures.map((f) => `${f.reason}: ${f.detail}`).join('; ');
  return `workspace isolation refused (phase=${verified.phase}, target=${verified.target}) — ${reasons} `
    + `[nextAction: remove the unauthorized junction/symlink or use a workspace path inside ${EXPERIMENT_ROOT}]`;
}

/** validateWorkspaceIsolation + fail-closed throw (rc-3/rc-9: loud, structured). */
export function assertWorkspaceIsolation(targetPath, opts = {}) {
  const verified = validateWorkspaceIsolation(targetPath, opts);
  if (!verified.ok) throw new Error(formatIsolationRefusal(verified));
  return verified;
}

/** Refuse anything that could route a write into production state (SPEC §5.2/§5.3). */
export function preflightIsolation() {
  const failures = [];
  const prodPaths = PRODUCTION_NO_WRITE_PATHS.map(([label, p]) => [label, canonical(p)]);

  const expCanonical = canonical(EXPERIMENT_ROOT);
  for (const [label, p] of prodPaths) {
    if (expCanonical === p || expCanonical.startsWith(p + path.sep) || expCanonical.startsWith(p + '/')) {
      failures.push(`experiment root resolves inside ${label}: ${EXPERIMENT_ROOT}`);
    }
  }

  // PRI-1252 r2 — physical fence over the shard workspace tree. The fixed
  // v1/v2 checks below are NOT enough: real shard dirs are armWorkspaceDir()
  // paths that only exist at run time, so a planted junction/symlink anywhere
  // in the tree must be caught here BEFORE any shard materializes or spawns.
  const fencePhases = [
    [EXPERIMENT_ROOT, 'preflight:experiment-root'],
    [path.join(EXPERIMENT_ROOT, 'workspaces'), 'preflight:workspaces-root'],
    [path.join(EXPERIMENT_ROOT, 'workspaces', 'v1'), 'preflight:arm-workspace'],
    [path.join(EXPERIMENT_ROOT, 'workspaces', 'v2'), 'preflight:arm-workspace'],
  ];
  for (const [target, phase] of fencePhases) {
    const verified = validateWorkspaceIsolation(target, { phase });
    for (const f of verified.failures) failures.push(`${phase}: ${f.reason}: ${f.detail}`);
  }
  // Sweep every entry under workspaces/ (plus its .pd/.state roots — the DB
  // copy / config write targets): a reparse point there silently redirects a
  // shard workspace outside the experiment root (the PR #2694 round-3 defect:
  // preflight returned ok with `workspaces/v2-ssreview-probe` junctioned out).
  const workspacesDir = path.join(EXPERIMENT_ROOT, 'workspaces');
  let wsEntries = null;
  try { wsEntries = fs.readdirSync(workspacesDir, { withFileTypes: true }); } catch { /* not created yet */ }
  if (wsEntries !== null) {
    for (const entry of wsEntries) {
      const entryPath = path.join(workspacesDir, entry.name);
      const st = lstatSafe(entryPath);
      if (st !== null && st.isSymbolicLink()) {
        failures.push(`preflight:workspaces-sweep: reparse_point: ${entryPath} is a symlink/junction/reparse point (unauthorized shard workspace redirect)`);
        continue;
      }
      if (st !== null && st.isDirectory()) {
        for (const sub of ['.pd', '.state']) {
          const subPath = path.join(entryPath, sub);
          const subSt = lstatSafe(subPath);
          if (subSt !== null && subSt.isSymbolicLink()) {
            failures.push(`preflight:workspaces-sweep: reparse_point: ${subPath} is a symlink/junction/reparse point (unauthorized DB/config redirect)`);
          }
        }
      }
    }
  }

  // Workspace pointer env vars: the experiment must NOT inherit pointers that
  // outrank the explicit --workspace flag in any child resolution chain.
  // The parent shell MAY carry production pointers (this machine's shell
  // exports PD_WORKSPACE_DIR=d:\.openclaw\workspace — the exact hazard class
  // from the 2026-11-12 incident); childEnv() strips/overrides ALL of them, so
  // the enforced invariant is on the CHILD environment the harness builds:
  // no pointer survives, and the only injected PD_WORKSPACE_DIR points inside
  // the experiment root. Inherited production pointers are recorded as
  // hazards, not silently ignored.
  const pointerEnv = ['PD_WORKSPACE_DIR', 'OPENCLAW_WORKSPACE', 'OPENCLAW_WORKSPACE_DIR', 'PD_STATE_DIR', 'OPENCLAW_HOME'];
  const envReport = { inheritedHazards: {} };
  const cleaned = childEnv();
  for (const name of pointerEnv) {
    const inherited = process.env[name];
    if (inherited !== undefined) envReport.inheritedHazards[name] = canonical(inherited);
    if (cleaned[name] !== undefined) {
      failures.push(`childEnv still carries ${name}=${cleaned[name]} — pointer stripping is broken`);
    }
  }
  // The per-arm override injected at spawn time must land INSIDE the root.
  for (const arm of ['v1', 'v2']) {
    const override = path.join(EXPERIMENT_ROOT, 'workspaces', arm);
    const c = canonical(override);
    if (!(c === expCanonical || c.startsWith(expCanonical + path.sep) || c.startsWith(expCanonical + '/'))) {
      failures.push(`child PD_WORKSPACE_DIR override escapes experiment root: ${override}`);
    }
  }

  // Arm workspaces must live inside the experiment root (after junction resolution).
  for (const arm of ['v1', 'v2']) {
    const ws = path.join(EXPERIMENT_ROOT, 'workspaces', arm);
    const c = canonical(ws);
    if (!(c === expCanonical || c.startsWith(expCanonical + path.sep) || c.startsWith(expCanonical + '/'))) {
      failures.push(`${arm} workspace escapes the experiment root after canonicalization: ${ws}`);
    }
  }

  return { ok: failures.length === 0, failures, experimentRoot: EXPERIMENT_ROOT, env: envReport, productionPaths: Object.fromEntries(prodPaths) };
}

/**
 * Workspace/state pointer vars that must never reach a harness-spawned child
 * (the 2026-11-12 incident class: an inherited production pointer outranks
 * the explicit --workspace flag in the child resolution chain).
 *
 * TRIPWIRE — controlled duplication with a declared update obligation: this
 * list is mirrored by POINTER_ENV_VARS in
 * scripts/__tests__/pd-lab-harness-characterization.test.ts and
 * POINTER_STRIP_LIST in experiment/prompt-v2/scripts/__tests__/
 * pdspec001-childenv-pointer-isolation.test.ts. Adding/removing a pointer var
 * here MUST update all three in the same change (PRI-1252 r1 review fix).
 */
const POINTER_STRIP_LIST = ['PD_WORKSPACE_DIR', 'OPENCLAW_WORKSPACE', 'OPENCLAW_WORKSPACE_DIR', 'PD_STATE_DIR', 'OPENCLAW_HOME'];

/**
 * Whitelist: the ONLY pointer vars `extra` may (re)inject into the child env.
 * rg evidence (PRI-1252 r1/r2 review): the only `childEnv({...})` injection in
 * the harness is inside spawnPdChild() below (`childEnv({ PD_WORKSPACE_DIR: ws }, ws)`)
 * — runPd() and ab-stage.mjs runPdIn() both delegate there — where ws is
 * always an armWorkspaceDir() path under EXPERIMENT_ROOT, and the second
 * argument makes childEnv VALUE-check the pointer against that same ws
 * (PRI-1252 r2: name-on-whitelist no longer admits an arbitrary value). The
 * four production state/host pointers have no legitimate `extra` caller and
 * are force-stripped even when re-injected through extra. Guarded by
 * pdspec001-childenv-pointer-isolation.test.ts (per-variable negative
 * controls + a source scan over every childEnv({...}) call site + the r2
 * value-gate, spawn-refusal and runPdIn-delegation tripwires).
 *
 * TRIPWIRE: if POINTER_STRIP_LIST gains a new pointer var, decide explicitly
 * whether it is extra-injectable and update this whitelist (and the two
 * mirror test lists) in the same change.
 */
const EXTRA_ALLOWED_POINTER_VARS = ['PD_WORKSPACE_DIR'];

/**
 * Clean env for child processes: strip every pointer the child must not
 * inherit. `extra` is merged BEFORE the strip so a forbidden pointer cannot
 * re-enter through it (pre-fix `{ ...env, ...extra }` let extra restore
 * PD_STATE_DIR/OPENCLAW_HOME after the strip — PR #2694 review defect).
 *
 * PRI-1252 r2 — whitelist is now NAME+VALUE, not name-only. When the caller
 * passes `expectedWorkspace` (the validated arm/shard workspace of THIS
 * execution), an extra-injected PD_WORKSPACE_DIR must pass the full value
 * gate or childEnv throws before anything spawns:
 *   - legal absolute path;
 *   - validateWorkspaceIsolation() (lexical + per-level reparse + realpath
 *     containment + production overlap);
 *   - canonically EQUAL to expectedWorkspace (the caller's intended workspace);
 * The gate cannot know the expected workspace by itself — the spawn wiring
 * (spawnPdChild) always passes it, so a bare childEnv() keeps the legacy
 * precedence behavior pinned by the characterization suite (scripts/__tests__/
 * pd-lab-harness-characterization.test.ts re-injection contract). Trade-off
 * recorded in the PR: strictness lives at the only place a pointer can reach
 * a child process (the spawn path); bare childEnv() callers inject no pointer
 * at all (rg evidence: only runPd/runPdIn inject PD_WORKSPACE_DIR).
 */
export function childEnv(extra = {}, expectedWorkspace = undefined) {
  const env = { ...process.env, ...extra };
  for (const name of POINTER_STRIP_LIST) {
    if (EXTRA_ALLOWED_POINTER_VARS.includes(name) && Object.hasOwn(extra, name)) {
      if (expectedWorkspace !== undefined) {
        assertWorkspacePointerValue(extra[name], expectedWorkspace);
      }
      continue;
    }
    delete env[name];
  }
  return env;
}

/**
 * Value-level gate for the extra-injected PD_WORKSPACE_DIR (PRI-1252 r2):
 * absolute + physically isolated + canonically equal to the expected
 * workspace of the current arm/shard. Throws with a structured, auditable
 * reason — a mismatch must never silently fall back to either value.
 */
export function assertWorkspacePointerValue(value, expectedWorkspace) {
  const problems = [];
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    problems.push(`not_absolute_path: PD_WORKSPACE_DIR extra must be an absolute path, got ${JSON.stringify(String(value))}`);
  } else {
    const verified = validateWorkspaceIsolation(value, { phase: 'childenv:pd-workspace-dir' });
    for (const f of verified.failures) problems.push(`${f.reason}: ${f.detail}`);
    if (canonical(value) !== canonical(expectedWorkspace)) {
      problems.push(`expected_workspace_mismatch: ${value} != expectedWorkspace ${expectedWorkspace}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`childEnv PD_WORKSPACE_DIR value rejected (phase=childenv) — ${problems.join('; ')} `
      + `[nextAction: only the spawn wiring may inject PD_WORKSPACE_DIR, equal to the validated arm/shard workspace]`);
  }
}

export function gitHead(worktree) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, env: childEnv() }).toString().trim();
}

/**
 * Derive the experiment config for a given experiment workspace path from the
 * production config (structure guaranteed valid):
 * - workspace.default remapped to THIS experiment workspace;
 * - `ui:` and `feedback:` sections dropped (feedback carries an ingest token);
 * - async CLI ingress enabled (orchestration-only) so `pd pain record` enqueues;
 * - downstream observers not in the six-agent scope disabled;
 * - MODEL PROFILE SWITCH (remediation, Owner-directed): the six learning-chain
 *   agents are re-bound to the production fallback profile `pi-ai.glm`
 *   (zai / glm-5.3) — the pinned AMD endpoint is daily-rate-limited and the
 *   intern-ai token is expired (both facts evidenced in model-config.json).
 *   Both arms run the SAME profile, so pairing fairness is unaffected.
 */
export function deriveExperimentConfig(wsPath) {
  const prod = fs.readFileSync(path.join(PRODUCTION_WORKSPACE, '.pd', 'config.yaml'), 'utf8');
  const cutAt = prod.search(/^ui:\r?$/m);
  let config = cutAt === -1 ? prod : prod.slice(0, cutAt);
  config = config.replace(/^(\s*default:\s*).*$/m, `$1${wsPath.replace(/\\/g, '\\\\')}`);
  if (/^  diagnostician_async_cli:/m.test(config)) {
    config = config.replace(/^(  diagnostician_async_cli:\r?\n    category: [^\n]+\r?\n    enabled: )false/m, '$1true');
  } else {
    config = config.replace(/^(features:\r?\n)/m, '$1  diagnostician_async_cli:\n    category: quiet\n    enabled: true\n');
  }
  // Six-agent rebind to the zai fallback profile. IMPORTANT: only BINDING
  // REFERENCES (`: pi-ai.amd-ds-vision`) are replaced — replacing the profile
  // DEFINITION key too created a duplicate `pi-ai.glm:` mapping key and broke
  // YAML parsing for the whole workspace config.
  config = config.split(': pi-ai.amd-ds-vision').join(': pi-ai.glm');
  for (const agent of ['artificer', 'evaluator', 'rolloutReviewer', 'correctionObserver', 'signalCollector', 'empathyObserver']) {
    config = config.replace(new RegExp(`^(    ${agent}:\\r?\\n      enabled: )true`, 'm'), '$1false');
  }
  return `# PD-SPEC-001 experiment workspace — DERIVED from production config.\n# Dropped: ui, feedback (ingest token). Remapped: workspace.default. Disabled: non-six observers.\n` + config;
}

/**
 * Single path-component rule for arm/shardId (PRI-1252 r2 structural fence):
 * a component that must never contain separators, traversal (`..`), drive
 * letters, colons or whitespace/quote metacharacters. This rejects the
 * shardId traversal class (`../..`, `a\b`, `C:/abs`) at the point where the
 * path is DERIVED; the physical (junction/realpath) layers are enforced
 * separately by validateWorkspaceIsolation at every use site.
 */
const PATH_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Per-shard arm workspace path (remediation Phase 4: shards never share a
 * workspace — the shared-workspace concurrency was the grid-1 INVALID root
 * cause). shardId=null is the legacy shared layout, allowed only for
 * single-process invocations that are explicitly marked (e.g. Gate solo runs
 * use shardId 'solo'). Throws on arm/shardId values that could move the path
 * outside `workspaces/` (scenario: shardId traversal / absolute injection —
 * PRI-1252 r2).
 */
export function armWorkspaceDir(arm, shardId = null) {
  if (typeof arm !== 'string' || !PATH_COMPONENT_RE.test(arm)) {
    throw new Error(`armWorkspaceDir: rejected unsafe arm ${JSON.stringify(arm)} — must match ${PATH_COMPONENT_RE} [nextAction: use an arm key from WORKTREES]`);
  }
  if (shardId !== null && (typeof shardId !== 'string' || !PATH_COMPONENT_RE.test(shardId))) {
    throw new Error(`armWorkspaceDir: rejected unsafe shardId ${JSON.stringify(shardId)} — must match ${PATH_COMPONENT_RE} [nextAction: shard ids are path components, e.g. 'solo', 'S01', 'up-S01']`);
  }
  return shardId
    ? path.join(EXPERIMENT_ROOT, 'workspaces', `${arm}-s${shardId}`)
    : path.join(EXPERIMENT_ROOT, 'workspaces', arm);
}

/**
 * PRI-1252 r4 (P1-2) — file-level identity for sensitive workspace artifacts.
 *
 * The directory fence (assertWorkspaceIsolation) proves the PATH is physically
 * inside the experiment root; it does NOT prove a FILE found there is the one
 * this harness created. A real attack (reproduced before this fix): an
 * external file hardlinked (fs.linkSync) onto `<ws>/.state/trajectory.db`
 * passes every directory-level check and materializeWorkspace() returned
 * `trajectory: reused` — the harness would then write experiment state into a
 * file that lives (also) outside, through the shared inode.
 *
 * Fix: artifacts are only reused when a provenance manifest written at
 * creation time matches the CURRENT file identity exactly. Identity combines
 * four observations (no single unstable value is trusted):
 *   - nlink === 1  (a hardlink to an external file necessarily has nlink >= 2;
 *                   this alone kills the reproduced attack)
 *   - file id (ino — NTFS File Reference Number on Windows)
 *   - size
 *   - mtimeMs
 * A pre-existing artifact WITHOUT a matching provenance record is never
 * silently reused ("reused" is reserved for verified identity): the call
 * throws fail-closed with the phase and a nextAction.
 */
const MATERIALIZE_ARTIFACTS = [
  { rel: path.join('.state', 'trajectory.db'), kind: 'trajectory-db' },
  { rel: path.join('.pd', 'config.yaml'), kind: 'config' },
];
const PROVENANCE_FILE = '.materialize-provenance.json';

function provenancePath(ws) { return path.join(ws, PROVENANCE_FILE); }

function fileIdentity(st) {
  return { fileid: String(st.ino), nlink: st.nlink, size: st.size, mtimeMs: st.mtimeMs };
}

function readProvenance(ws) {
  try {
    return JSON.parse(fs.readFileSync(provenancePath(ws), 'utf8'));
  } catch { return null; }
}

function writeProvenance(ws, artifacts) {
  const payload = { schemaVersion: 'pd-lab-provenance.v1', artifacts };
  const tmp = `${provenancePath(ws)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, provenancePath(ws));
}

/**
 * Safety gate for ONE workspace artifact (re-use / spawn boundary).
 * Proportional identity policy (PRI-1252 r4):
 *   - the artifact is ABSENT  -> nothing to verify, returns false (caller decides);
 *   - nlink !== 1             -> THROW always (a hardlink to an external file
 *     necessarily has nlink >= 2; this is the reproduced attack class and
 *     needs no provenance to detect);
 *   - a provenance record EXISTS -> full identity match (fileid/size/mtimeMs)
 *     is required, any drift throws;
 *   - no record (bare/seed-created artifact from outside materialize)
 *     -> the nlink gate is the enforceable boundary; the absence is recorded
 *     as a known limitation in the PR (path-level fence + nlink still apply).
 */
function checkArtifactSafety(ws, relPath, phase) {
  const artifactPath = path.join(ws, relPath);
  let st;
  try { st = fs.lstatSync(artifactPath); } catch { return false; }
  if (st.nlink !== 1) {
    throw new Error(`workspace artifact ${relPath} has nlink=${st.nlink} (multiple hard links) — `
      + `an external hardlink cannot be ruled out; refusing to reuse or spawn against it `
      + `(phase=${phase}) [nextAction: remove the extraneous link and re-materialize]`);
  }
  const recorded = readProvenance(ws)?.artifacts?.[relPath];
  if (recorded) {
    const current = fileIdentity(st);
    const mismatches = Object.keys(current).filter((k) => current[k] !== recorded[k]);
    if (mismatches.length > 0) {
      throw new Error(`workspace artifact ${relPath} identity mismatch (${mismatches.join(', ')}) vs provenance `
        + `(phase=${phase}) [nextAction: the file was replaced or tampered with — re-materialize this workspace]`);
    }
  }
  return true;
}

/** Public wrapper — negative tests drive the same gate real callers hit. */
export function assertArtifactReuseSafety(ws, relPath, phase = 'identity:check') {
  return checkArtifactSafety(ws, relPath, phase);
}

/**
 * Record (or refresh) provenance identity entries for artifacts PRESENT under
 * `ws`. Called at creation time (materializeWorkspace) and after ab-stage
 * seedArm finishes seeding. Refuses to record an artifact with nlink !== 1 —
 * provenance must never legitimize a shared inode.
 */
export function recordArtifactProvenance(ws, relPaths = MATERIALIZE_ARTIFACTS.map((a) => a.rel)) {
  const prov = readProvenance(ws)?.artifacts ?? {};
  let dirty = false;
  for (const rel of relPaths) {
    let st;
    try { st = fs.lstatSync(path.join(ws, rel)); } catch { continue; }
    if (st.nlink !== 1) {
      throw new Error(`refusing to record provenance for ${rel}: nlink=${st.nlink} — an external `
        + `hardlink cannot be ruled out (phase=provenance:record) `
        + `[nextAction: remove the extraneous link and recreate the artifact]`);
    }
    const id = fileIdentity(st);
    const recorded = prov[rel];
    if (!recorded || Object.keys(id).some((k) => recorded[k] !== id[k])) {
      prov[rel] = id;
      dirty = true;
    }
  }
  if (dirty) writeProvenance(ws, prov);
}

/**
 * Fail-closed identity check for every sensitive artifact of `ws` (spawn /
 * post-materialize boundary). Absent artifacts are skipped (bare workspace
 * bootstraps its state on first use); present artifacts go through the
 * proportional gate of checkArtifactSafety. Exported for the spawn boundary
 * and the r4 negative tests.
 */
export function assertWorkspaceFileIdentity(ws, phase = 'identity:check') {
  for (const artifact of MATERIALIZE_ARTIFACTS) checkArtifactSafety(ws, artifact.rel, phase);
}

/**
 * Materialize an arm workspace: fresh .pd (state.db initialized by the
 * runtime on first use), trajectory.db copied from the snapshot, derived config.
 * PRI-1252 r2 fence timing: validate BEFORE creating the shard dirs
 * (nearest-existing-ancestor mode), then AGAIN after creation (full realpath
 * + per-level reparse check) and BEFORE the DB copy / config write go through
 * this path — a junction swapped in between phases is refused, nothing is
 * copied through an out-of-bounds path.
 * PRI-1252 r4: reuse additionally requires provenance-backed file identity
 * (assertWorkspaceFileIdentity) — see the block comment above.
 */
export function materializeWorkspace(arm, { force = false, shardId = null } = {}) {
  const worktree = WORKTREES[arm];
  if (!fs.existsSync(worktree)) throw new Error(`arm worktree missing: ${worktree}`);
  const ws = armWorkspaceDir(arm, shardId); // structural fence: safe path components
  assertWorkspaceIsolation(ws, { phase: 'materialize:pre-create' });
  fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
  assertWorkspaceIsolation(ws, { phase: 'materialize:post-create' });
  // Each artifact is created ONCE (subsequent processes skip). Creation goes
  // through a per-process temp file + atomic rename: concurrent shard
  // processes must never copy 43MB onto a destination another process's CLI
  // already has open (Windows sharing violation killed 4/6 shards once).
  const provenance = readProvenance(ws)?.artifacts ?? {};
  let provenanceDirty = false;
  const placeAtomic = (relPath, write) => {
    const target = path.join(ws, relPath);
    // CodeQL js/file-system-race: stat once instead of existsSync-then-rename.
    const existing = (() => { try { return fs.lstatSync(target); } catch { return null; } })();
    if (existing !== null && !force) {
      // PRI-1252 r4: "reused" now REQUIRES provenance-backed identity — an
      // existing file is never trusted on existence alone (hardlink attack
      // class). verifyArtifactIdentity below re-checks every artifact after
      // placement; for the reuse decision we check this one file here.
      const recorded = provenance[relPath];
      if (!recorded) {
        throw new Error(`refusing to reuse unverified ${relPath}: no provenance record (phase=materialize:reuse) `
          + `[nextAction: re-materialize with force so the harness records file identity]`);
      }
      if (existing.nlink !== 1) {
        throw new Error(`refusing to reuse ${relPath}: nlink=${existing.nlink} — multiple hard links, `
          + `external hardlink cannot be ruled out (phase=materialize:reuse) `
          + `[nextAction: remove the extraneous link and re-materialize with force]`);
      }
      const current = fileIdentity(existing);
      const mismatches = Object.keys(current).filter((k) => current[k] !== recorded[k]);
      if (mismatches.length > 0) {
        throw new Error(`refusing to reuse ${relPath}: identity mismatch (${mismatches.join(', ')}) vs provenance `
          + `(phase=materialize:reuse) [nextAction: the file was replaced or tampered with — re-materialize with force]`);
      }
      return 'reused';
    }
    const tmp = `${target}.${process.pid}.tmp`;
    write(tmp);
    fs.renameSync(tmp, target); // same-volume rename: atomic; concurrent last-writer wins whole-file
    provenance[relPath] = fileIdentity(fs.lstatSync(target));
    provenanceDirty = true;
    return 'created';
  };
  const trajState = placeAtomic(path.join('.state', 'trajectory.db'), (t) => fs.copyFileSync(path.join(SNAPSHOT_DIR, 'trajectory.db'), t));
  const cfgState = placeAtomic(path.join('.pd', 'config.yaml'), (t) => fs.writeFileSync(t, deriveExperimentConfig(ws), 'utf8'));
  if (provenanceDirty) writeProvenance(ws, provenance);
  assertWorkspaceFileIdentity(ws, 'materialize:final');
  return { workspace: ws, trajectory: trajState, config: cfgState };
}

/**
 * The ONE spawn wiring for pd-cli children (PRI-1252 r2): runPd() (ab-lib)
 * AND runPdIn() (ab-stage.mjs) both delegate here so the physical fence is
 * enforced exactly once, at the only place a child process can start.
 * Fail-closed BEFORE spawn: any isolation refusal throws — no child, no env,
 * no partially valid experiment result. The env handed to the child is built
 * with childEnv(extra, expectedWorkspace) so the injected PD_WORKSPACE_DIR is
 * value-checked against THIS workspace (name-whitelist alone would allow any
 * value).
 */
export function spawnPdChild({ arm = null, worktree, ws, args, timeoutMs = 45 * 60_000 }) {
  assertWorkspaceIsolation(ws, { phase: 'spawn:pre-spawn' });
  // PRI-1252 r4 (P1-3): the spawn boundary re-verifies FILE identity too — a
  // workspace whose trajectory.db/config.yaml was hardlink-swapped after
  // materialize must never back a child process (the child would write
  // experiment state through a shared inode that also lives outside).
  assertWorkspaceFileIdentity(ws, 'spawn:pre-spawn');
  const cli = path.join(worktree, 'packages/pd-cli/dist/index.js');
  if (!fs.existsSync(cli)) throw new Error(`pd-cli dist missing in ${arm ?? 'unknown'} arm: ${cli}`);
  const env = childEnv({ PD_WORKSPACE_DIR: ws }, ws);
  if (env['PD_WORKSPACE_DIR'] !== ws) {
    // PRI-1252 r2 (CodeQL js/clear-text-logging): the mismatch message must
    // NOT carry the env value — it is process.env-derived and must never
    // reach console logs. The expected workspace + phase are sufficient audit
    // evidence (rc-8: log a closed reason, not the tainted value).
    throw new Error(`spawn env PD_WORKSPACE_DIR does not match the validated workspace `
      + `(phase=spawn:env-consistency): expected ${ws} [nextAction: this is a harness bug — `
      + `childEnv must keep the validated pointer unchanged]`);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, '--workspace', ws, '--json'], { env, cwd: ws });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ arm, args, code, stdout, stderr });
    });
  });
}

/** Run a pd-cli command from an arm worktree against its experiment workspace. */
export function runPd(arm, args, { timeoutMs = 45 * 60_000, shardId = null } = {}) {
  const worktree = WORKTREES[arm];
  if (!worktree) throw new Error(`runPd: unknown arm ${JSON.stringify(arm)} — not in WORKTREES`);
  const ws = armWorkspaceDir(arm, shardId);
  return spawnPdChild({ arm, worktree, ws, args, timeoutMs });
}

/**
 * Load the FULL-fidelity dataset — fail-closed: the file must exist and must
 * NOT be the public redacted copy (placeholder markers reject).
 */
export function loadDataset() {
  if (!fs.existsSync(DATASET_FILE)) {
    throw new Error(
      `FULL-fidelity dataset missing at ${DATASET_FILE} — regenerate it with ` +
      `experiment/prompt-v2/scripts/freeze-dataset.mjs against the local snapshot. ` +
      `NO FALLBACK: the committed public copy is redacted and must never drive an experiment.`,
    );
  }
  const dataset = JSON.parse(fs.readFileSync(DATASET_FILE, 'utf8'));
  const probe = JSON.stringify(dataset.samples?.[0]?.painEvent ?? {}).slice(0, 2000);
  if (probe.includes('«redacted') || probe.includes('anon-')) {
    throw new Error(`Dataset at ${DATASET_FILE} carries redaction markers — refusing to run an experiment on redacted data (remediation §6.1).`);
  }
  if (!Array.isArray(dataset.samples) || dataset.samples.length === 0) {
    throw new Error(`Dataset at ${DATASET_FILE} has no samples.`);
  }
  return dataset;
}

export function runDir(runId) {
  const dir = path.join(EXPERIMENT_ROOT, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Deterministic interleave for A/B ordering (SPEC §4.7): alternate arms per
 * sample with a stable per-run offset derived from the run id, so no arm
 * systematically runs first.
 */
export function armOrderFor(runId, sampleIndex, arms = ['v1', 'v2']) {
  const h = parseInt(sha256(runId).slice(0, 8), 16);
  const flip = (h + sampleIndex) % 2;
  return flip === 0 ? [...arms] : [...arms].reverse();
}
