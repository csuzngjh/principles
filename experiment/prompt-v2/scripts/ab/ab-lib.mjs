/**
 * PD-SPEC-001 A/B harness — shared library (PD-Lab v0.3 T3b / PRI-1254).
 *
 * Config-driven since T3b: the six historical hardcoded constants
 * (WORKTREES / PRODUCTION_WORKSPACE / V1_BASE_COMMIT / EXPERIMENT_ROOT /
 * SNAPSHOT_DIR / DATASET_FILE) and the hardcoded production path list are
 * GONE. Every path, arm identity and digest now comes from the ONE
 * experiment-config loader (scripts/dev/pd-lab/experiment-config.mjs,
 * PRI-1253 / T3a), installed per process via useExperimentConfig(config).
 * There is no default config, no environment-variable fallback and no
 * constant fallback anywhere below.
 *
 * Design sources:
 * - TECH-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3 §4.1–§4.5, §7;
 * - HANDOFF T3 (PRI-1254);
 * - the T3a module header's T3b consumption contract (arm workspace base
 *   `<experimentRoot>/workspaces/<armId>`; runId validation belongs HERE,
 *   at this module's path-join sites — never back in the loader).
 *
 * Isolation layers (unchanged since PRI-1252 r2/r4, now config-fed):
 * validateWorkspaceIsolation() = lexical containment + per-level reparse
 * fence + realpath containment + production-overlap fence; childEnv()
 * strips every workspace/state pointer var; materializeWorkspace() refuses
 * to reuse artifacts without provenance-backed file identity.
 *
 * Historical note: full-fidelity data or nothing (loadDataset fails closed,
 * remediation directive §6.1); since T3b the redaction probe covers EVERY
 * sample, not just the first (TECH §7).
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime';
import { loadExperimentConfig } from '../../../../scripts/dev/pd-lab/experiment-config.mjs';

export { loadExperimentConfig };

const here = path.dirname(fileURLToPath(import.meta.url));

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

// ---------------------------------------------------------------------------
// Experiment-config context (T3b §5.1) — the ONLY source of paths/arms.
// ---------------------------------------------------------------------------

/**
 * The minimal slice of the loader result this harness consumes. The full
 * validation (schema, digests, path safety, preregistration binding) is the
 * T3a loader's job; here we only fail loud when a caller installs something
 * that is not a loadExperimentConfig-shaped result (mis-wiring, not user
 * error — user error surfaces from the loader with problems[]).
 */
function assertConfigShape(config) {
  const problems = [];
  const push = (field, why) => problems.push(`${field}: ${why}`);
  if (config === null || typeof config !== 'object') push('$', 'config must be an object');
  else {
    if (typeof config.experimentId !== 'string' || config.experimentId === '') push('experimentId', 'required non-empty string');
    if (typeof config.experimentRoot !== 'string' || !path.isAbsolute(config.experimentRoot)) push('experimentRoot', 'required absolute path');
    for (const role of ['baselineArm', 'candidateArm']) {
      const armId = config[role];
      if (typeof armId !== 'string' || armId === '') { push(role, 'required arm id'); continue; }
      if (!config.arms || !Object.hasOwn(config.arms, armId)) push(role, `${String(armId)} is not declared in arms`);
    }
    if (typeof config.baselineArm === 'string' && config.baselineArm === config.candidateArm) push('candidateArm', 'must differ from baselineArm');
    for (const [armId, arm] of Object.entries(config.arms ?? {})) {
      if (!arm || typeof arm !== 'object') { push(`arms.${armId}`, 'must be an object'); continue; }
      if (typeof arm.worktree !== 'string' || !path.isAbsolute(arm.worktree)) push(`arms.${armId}.worktree`, 'required absolute path');
      if (typeof arm.expectedHead !== 'string' || !/^[0-9a-fA-F]{40}$/.test(arm.expectedHead)) push(`arms.${armId}.expectedHead`, 'required 40-hex commit');
    }
    if (!config.dataset || typeof config.dataset?.file !== 'string') push('dataset.file', 'required');
    if (typeof config.snapshot?.dir !== 'string') push('snapshot.dir', 'required');
    if (typeof config.baseConfigFile !== 'string') push('baseConfigFile', 'required');
    if (!Array.isArray(config.modelEnv)) push('modelEnv', 'required array of env var names');
    if (!config.verification || typeof config.verification.configSha256 !== 'string') push('verification.configSha256', 'required (install the loadExperimentConfig result, not a hand-written object)');
  }
  if (problems.length > 0) {
    throw new Error(`useExperimentConfig: not a loadExperimentConfig-shaped result — ${problems.join('; ')} `
      + '[nextAction: entries must pass loadExperimentConfig(file) output here; see scripts/dev/pd-lab/experiment-config.mjs]');
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

let activeConfig = null;

/**
 * Install the experiment config for THIS process (TECH §4.2: every entry
 * receives the frozen loadExperimentConfig result). Fail-closed before the
 * first use: a mis-shaped install throws immediately instead of at some
 * later call site. Re-installing a config that is byte-equal to the active
 * one is a no-op; installing a DIFFERENT config over an active one is
 * refused (one process = one experiment identity).
 */
export function useExperimentConfig(config) {
  assertConfigShape(config);
  const frozen = deepFreeze(structuredClone(config));
  if (activeConfig !== null) {
    if (JSON.stringify(activeConfig) !== JSON.stringify(frozen)) {
      throw new Error('useExperimentConfig: a different config is already installed in this process '
        + `[nextAction: one process runs one experiment; current experimentId=${JSON.stringify(activeConfig.experimentId)}]`);
    }
    return activeConfig;
  }
  activeConfig = frozen;
  return frozen;
}

/** The installed config, or a loud refusal (never a default, never env). */
export function currentConfig() {
  if (activeConfig === null) {
    throw new Error('currentConfig: no experiment config installed — an entry must call useExperimentConfig(loadExperimentConfig(file)) first '
      + '[nextAction: pass --config <file> (required, no default, no env fallback)]');
  }
  return activeConfig;
}

/** The installed config or null (for shared helpers that also serve
 *  config-less historical-record analysis; NEVER a fallback config source). */
export function tryConfig() {
  return activeConfig;
}

export function experimentRoot() { return currentConfig().experimentRoot; }
export function snapshotDir() { return currentConfig().snapshot.dir; }
export function datasetFile() { return currentConfig().dataset.file; }
export function baseConfigFile() { return currentConfig().baseConfigFile; }
export function baselineArmId() { return currentConfig().baselineArm; }
export function candidateArmId() { return currentConfig().candidateArm; }

/** The two configured arms, baseline first — the canonical arm pair order. */
export function configArms() {
  return [currentConfig().baselineArm, currentConfig().candidateArm];
}

/** Role map { <armId>: 'baseline'|'candidate' } — the ONLY role authority. */
export function armRoles() {
  return { [currentConfig().baselineArm]: 'baseline', [currentConfig().candidateArm]: 'candidate' };
}

export function armWorktree(arm) {
  const cfg = currentConfig();
  if (!Object.hasOwn(cfg.arms, arm)) {
    throw new Error(`armWorktree: unknown arm ${JSON.stringify(arm)} — configured arms are ${configArms().join(', ')} `
      + '[nextAction: arm ids come from the experiment config, not from CLI defaults]');
  }
  return cfg.arms[arm].worktree;
}

// ---------------------------------------------------------------------------
// CLI --config contract (TECH §4.2 / CF-01)
// ---------------------------------------------------------------------------

/**
 * Parse a REQUIRED --config <file> from argv. Missing/empty → usage on
 * stderr and exit code 2 (CF-01), before ANY file is read. No default, no
 * environment fallback — by design.
 */
export function requireConfigArg(argv, usage) {
  const i = argv.indexOf('--config');
  if (i === -1 || i + 1 >= argv.length || argv[i + 1].trim() === '') {
    process.stderr.write(`error: --config <file> is required (no default, no environment fallback)\n\n${usage}\n`);
    process.exit(2);
  }
  return argv[i + 1];
}

/**
 * Full entry bootstrap: --config required (exit 2) → loadExperimentConfig
 * (field-level problems on failure, exit 1 — every problem listed at once,
 * never an uncaught exception) → install via useExperimentConfig. Returns
 * the frozen config.
 */
export function bootstrapConfigContext(argv, usage) {
  const file = requireConfigArg(argv, usage);
  let config;
  try {
    config = loadExperimentConfig(file);
  } catch (err) {
    if (err && err.name === 'ExperimentConfigError') {
      process.stderr.write(`${String(err.message)}\n`);
      process.exit(1);
    }
    throw err;
  }
  useExperimentConfig(config);
  return config;
}

// ---------------------------------------------------------------------------
// Forbidden roots (TECH §4.1 derivation — mirrors the T3a loader; both
// derive from the same documented rule, fresh on every call).
// ---------------------------------------------------------------------------

function derivePrimaryCheckout() {
  const moduleRoot = path.resolve(here, '..', '..', '..', '..');
  let dotGit = null;
  try {
    dotGit = fs.lstatSync(path.join(moduleRoot, '.git'));
  } catch {
    return moduleRoot;
  }
  if (!dotGit.isFile()) return moduleRoot; // primary checkout (directory .git)
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
 * Workspace/state pointer vars (TRIPWIRE — controlled duplication): this
 * list is mirrored by POINTER_ENV_VARS in scripts/dev/pd-lab/experiment-config.mjs
 * and the two characterization test lists. Adding/removing a pointer var
 * here MUST update all of them in the same change (PRI-1252 r1).
 */
const POINTER_ENV_VARS = [
  'PD_WORKSPACE_DIR',
  'OPENCLAW_WORKSPACE',
  'OPENCLAW_WORKSPACE_DIR',
  'PD_STATE_DIR',
  'OPENCLAW_HOME',
];

/**
 * Fixed + shell-derived + config-declared forbidden roots, canonicalized.
 * Same derivation rule as the T3a loader (TECH §4.1): homedir .pd/.openclaw/
 * .codex, the primary checkout, every directory a pointer env var currently
 * targets, and the config's additionalForbiddenRoots (production workspaces).
 */
export function forbiddenRoots() {
  const cfg = currentConfig();
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
  for (const [i, extra] of (cfg.additionalForbiddenRoots ?? []).entries()) {
    roots.push({ label: `additionalForbiddenRoots[${i}]`, pathValue: extra });
  }
  return roots.map((r) => ({ ...r, canonical: canonical(r.pathValue) }));
}

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
 * THE unified physical-path isolation validator for experiment workspace
 * directories (PRI-1252 r2; config-fed since T3b). Layers:
 *   P1 lexical containment inside the configured experimentRoot;
 *   P2 per-level reparse fence (every existing level lstat'd — any
 *      symlink/junction/reparse point is refused);
 *   P3 physical containment via realpath of the deepest existing level;
 *   P4 production overlap against the derived forbidden roots (§4.1).
 * A not-yet-existing target validates through its deepest existing
 * ancestor; every caller re-validates AFTER creating the directory.
 */
export function validateWorkspaceIsolation(targetPath, { phase = 'validate' } = {}) {
  const failures = [];
  const rootReal = path.resolve(experimentRoot());
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
    failures.push({ reason: 'escapes_experiment_root', detail: `${resolved} is not inside the experiment root ${rootReal}` });
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
    failures.push({ reason: 'realpath_escapes_experiment_root', detail: `${candidateReal} resolves outside the experiment root ${rootReal}` });
  }

  // P4 — production overlap (both directions), against derived roots.
  for (const { label, pathValue, canonical: prodCanonical } of forbiddenRoots()) {
    if (isWithin(prodCanonical, candidateCanonical) || isWithin(candidateCanonical, prodCanonical)) {
      failures.push({ reason: 'production_overlap', detail: `${candidateReal} overlaps ${label} (${pathValue})` });
    }
  }

  return { ok: failures.length === 0, phase, target: resolved, canonical: candidateCanonical, real: candidateReal, failures };
}

/** Formatted, auditable refusal message (phase + every reason + next action). */
export function formatIsolationRefusal(verified) {
  const reasons = verified.failures.map((f) => `${f.reason}: ${f.detail}`).join('; ');
  return `workspace isolation refused (phase=${verified.phase}, target=${verified.target}) — ${reasons} `
    + `[nextAction: remove the unauthorized junction/symlink or use a workspace path inside ${experimentRoot()}]`;
}

/** validateWorkspaceIsolation + fail-closed throw (rc-3/rc-9: loud, structured). */
export function assertWorkspaceIsolation(targetPath, opts = {}) {
  const verified = validateWorkspaceIsolation(targetPath, opts);
  if (!verified.ok) throw new Error(formatIsolationRefusal(verified));
  return verified;
}

/**
 * Physical isolation preflight over the configured experiment tree: fence
 * the root → workspaces → each configured arm's workspace, then sweep every
 * entry under workspaces/ (plus .pd/.state roots) for reparse points, then
 * verify the child-env pointer hygiene. The config-level containment rules
 * (forbidden roots, experimentRoot↔worktree mutual exclusion) are the T3a
 * loader's — a config that violates them never reaches this function.
 */
export function preflightIsolation() {
  const cfg = currentConfig();
  const failures = [];
  const expRoot = cfg.experimentRoot;
  const expCanonical = canonical(expRoot);

  const fencePhases = [[expRoot, 'preflight:experiment-root']];
  for (const armId of configArms()) {
    fencePhases.push([path.join(expRoot, 'workspaces'), 'preflight:workspaces-root']);
    fencePhases.push([path.join(expRoot, 'workspaces', armId), `preflight:arm-workspace:${armId}`]);
  }
  for (const [target, phase] of fencePhases) {
    const verified = validateWorkspaceIsolation(target, { phase });
    for (const f of verified.failures) failures.push(`${phase}: ${f.reason}: ${f.detail}`);
  }
  // Sweep every entry under workspaces/ (plus its .pd/.state roots — the DB
  // copy / config write targets): a reparse point there silently redirects a
  // shard workspace outside the experiment root (PR #2694 round-3 defect).
  const workspacesDir = path.join(expRoot, 'workspaces');
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
  // childEnv() strips/overrides ALL of them; the enforced invariant is on the
  // CHILD environment the harness builds. Inherited production pointers are
  // recorded as hazards, not silently ignored.
  const pointerEnv = POINTER_ENV_VARS;
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
  for (const armId of configArms()) {
    const override = path.join(expRoot, 'workspaces', armId);
    const c = canonical(override);
    if (!(c === expCanonical || c.startsWith(expCanonical + path.sep) || c.startsWith(expCanonical + '/'))) {
      failures.push(`child PD_WORKSPACE_DIR override escapes experiment root: ${override}`);
    }
  }

  // Arm workspaces must live inside the experiment root (after junction resolution).
  for (const armId of configArms()) {
    const ws = path.join(expRoot, 'workspaces', armId);
    const c = canonical(ws);
    if (!(c === expCanonical || c.startsWith(expCanonical + path.sep) || c.startsWith(expCanonical + '/'))) {
      failures.push(`${armId} workspace escapes the experiment root after canonicalization: ${ws}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    experimentRoot: expRoot,
    env: envReport,
    productionPaths: Object.fromEntries(forbiddenRoots().map((r) => [r.label, r.pathValue])),
  };
}

/**
 * Workspace/state pointer vars that must never reach a harness-spawned child
 * (the 2026-11-12 incident class).
 *
 * TRIPWIRE — controlled duplication with a declared update obligation: this
 * list is mirrored by POINTER_ENV_VARS in scripts/dev/pd-lab/experiment-config.mjs
 * and POINTER_STRIP_LIST in experiment/prompt-v2/scripts/__tests__/
 * pdspec001-childenv-pointer-isolation.test.ts. Adding/removing a pointer var
 * here MUST update all three in the same change (PRI-1252 r1 review fix).
 */
const POINTER_STRIP_LIST = POINTER_ENV_VARS;

/**
 * Whitelist: the ONLY pointer vars `extra` may (re)inject into the child env.
 * The only `childEnv({...})` injection in the harness is inside
 * spawnPdChild() (`childEnv({ PD_WORKSPACE_DIR: ws }, ws)`), where ws is
 * always an armWorkspaceDir() path under the configured experimentRoot, and
 * the second argument makes childEnv VALUE-check the pointer against that
 * same ws (name-on-whitelist does not admit an arbitrary value). Guarded by
 * pdspec001-childenv-pointer-isolation.test.ts.
 */
const EXTRA_ALLOWED_POINTER_VARS = ['PD_WORKSPACE_DIR'];

/**
 * Clean env for child processes: strip every pointer the child must not
 * inherit. `extra` is merged BEFORE the strip so a forbidden pointer cannot
 * re-enter through it.
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
      + '[nextAction: only the spawn wiring may inject PD_WORKSPACE_DIR, equal to the validated arm/shard workspace]');
  }
}

export function gitHead(worktree) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, env: childEnv() }).toString().trim();
}

// ---------------------------------------------------------------------------
// Derived experiment config (TECH §4.3 — structured YAML, no regex surgery)
// ---------------------------------------------------------------------------

/**
 * Sections the derivation is ALLOWED to modify (TECH §4.3). Everything else
 * must stay key-for-key equal to the parsed template — asserted by
 * diffArmConfigs() in preflight and by tests (CF-07).
 */
export const DECLARED_DERIVATION_SECTIONS = ['workspace.default', 'ui', 'feedback', 'features', 'profileRebind', 'trajectoryRetention'];

/** deep-equal over plain JSON trees (order-insensitive for object keys). */
export function jsonEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

/**
 * Structured derivation of one arm's workspace config (TECH §4.3):
 *
 * 1. js-yaml-parse the configured baseConfigFile;
 * 2. verify the template itself round-trips (a template that cannot be
 *    structurally represented fails loud — no fallback to text surgery);
 * 3. apply ONLY the declared modifications:
 *    - workspace.default = this arm's workspace path;
 *    - drop `ui` and `feedback` (historical batch semantics: feedback
 *      carries an ingest token);
 *    - features.<flagId>.enabled = <value> for every flagId in this arm's
 *      featureOverrides (registration already verified by the loader);
 *    - profileRebind binding references: internalAgents.defaultRuntime and
 *      internalAgents.agents.<agent>.runtimeProfile equal to `from` become
 *      `to` (references only — profile DEFINITIONS are never rewritten);
 *    - trajectoryRetention.enabled = false (T0 conclusion: the harness
 *      chain never sweeps, and the derived config must not enable sweeping
 *      of the copied-in trajectory either);
 * 4. the result is returned as an OBJECT (callers dump/serialize).
 *
 * Undeclared sections are carried over untouched — preflight's structured
 * two-arm diff (diffArmConfigs) plus tests prove key-for-key equivalence.
 */
export function deriveExperimentConfigObject(wsPath, armId) {
  const cfg = currentConfig();
  if (!Object.hasOwn(cfg.arms, armId)) {
    throw new Error(`deriveExperimentConfigObject: unknown arm ${JSON.stringify(armId)} — configured arms are ${configArms().join(', ')}`);
  }
  let templateText;
  try {
    templateText = fs.readFileSync(cfg.baseConfigFile, 'utf8');
  } catch (err) {
    throw new Error(`baseConfigFile unreadable at ${cfg.baseConfigFile}: ${String(err?.message ?? err)} [nextAction: the loader verified this file — re-run with the current config]`);
  }
  let template;
  try {
    template = yamlLoad(templateText);
  } catch (err) {
    throw new Error(`baseConfigFile is not valid YAML (${cfg.baseConfigFile}): ${String(err?.message ?? err)} [nextAction: derivation requires a structurally parseable template — no text-surgery fallback]`);
  }
  if (template === null || typeof template !== 'object' || Array.isArray(template)) {
    throw new Error(`baseConfigFile must be a YAML mapping, got ${template === null ? 'null' : typeof template}`);
  }
  // Template round-trip proof: if yaml cannot re-represent the parsed tree,
  // structured derivation is impossible for this template — fail loud.
  let roundTrip;
  try {
    roundTrip = yamlLoad(yamlDump(template, { noRefs: true }));
  } catch (err) {
    throw new Error(`baseConfigFile cannot be structurally re-represented (${cfg.baseConfigFile}): ${String(err?.message ?? err)}`);
  }
  if (!jsonEqual(template, roundTrip)) {
    throw new Error(`baseConfigFile does not round-trip through structured YAML (${cfg.baseConfigFile}) — it contains a construct text surgery could express but structured derivation cannot; refusing [nextAction: fix the template]`);
  }

  const derived = structuredClone(template);

  // workspace.default → this arm's workspace.
  derived.workspace = { ...(derived.workspace ?? {}) };
  derived.workspace.default = wsPath;

  // ui / feedback removed (declared; historical batch semantics).
  delete derived.ui;
  delete derived.feedback;

  // features.<flagId>.enabled from this arm's featureOverrides. A flag the
  // template does not list gets its REQUIRED metadata (category) filled from
  // the feature-flag authority — an {enabled}-only entry is rejected by the
  // real production config validation (validateFeatureFlagEntry requires
  // category+enabled), which would fail the experiment AFTER preflight.
  // Registration of every override flagId is already verified by the loader.
  const overrides = cfg.arms[armId].featureOverrides ?? {};
  if (Object.keys(overrides).length > 0) {
    derived.features = { ...(derived.features ?? {}) };
    for (const [flagId, enabled] of Object.entries(overrides)) {
      const existing = derived.features[flagId];
      if (existing && typeof existing === 'object' && typeof existing.category === 'string') {
        derived.features[flagId] = { ...existing, enabled };
        continue;
      }
      const authority = DEFAULT_FEATURE_FLAGS.find((f) => f && f.id === flagId);
      if (!authority || typeof authority.category !== 'string' || authority.category === '') {
        throw new Error(`deriveExperimentConfigObject: flag ${JSON.stringify(flagId)} is not listed in baseConfigFile and the feature-flag authority does not expose a category for it — cannot build a production-valid feature entry `
          + '[nextAction: list the flag (with category) in baseConfigFile or fix the authority registration]');
      }
      derived.features[flagId] = { ...(existing && typeof existing === 'object' ? existing : {}), category: authority.category, enabled };
    }
  }

  // profileRebind binding REFERENCES only.
  if (cfg.profileRebind && typeof cfg.profileRebind === 'object') {
    const { from, to } = cfg.profileRebind;
    if (typeof from === 'string' && typeof to === 'string' && from !== to) {
      if (derived.internalAgents && typeof derived.internalAgents === 'object') {
        const agents = structuredClone(derived.internalAgents);
        if (agents.defaultRuntime === from) agents.defaultRuntime = to;
        if (agents.agents && typeof agents.agents === 'object') {
          for (const [agentId, agent] of Object.entries(agents.agents)) {
            if (agent && typeof agent === 'object' && agent.runtimeProfile === from) {
              agents.agents[agentId] = { ...agent, runtimeProfile: to };
            }
          }
        }
        derived.internalAgents = agents;
      }
    }
  }

  // trajectoryRetention: defensively disabled (declared section; T0).
  derived.trajectoryRetention = { ...(derived.trajectoryRetention ?? {}), enabled: false };

  return derived;
}

/** Serialized derived config (what materializeWorkspace writes to .pd/config.yaml). */
export function deriveExperimentConfig(wsPath, armId) {
  const derived = deriveExperimentConfigObject(wsPath, armId);
  const body = yamlDump(derived, { noRefs: true, lineWidth: 120 });
  return `# PD-Lab experiment workspace — DERIVED from baseConfigFile (structured YAML, TECH §4.3).\n# Dropped: ui, feedback (ingest token). Set: workspace.default, features (arm overrides), profileRebind bindings, trajectoryRetention.enabled=false.\n${body}`;
}

/**
 * Structured two-arm diff (CF-07): the two derived configs may differ ONLY
 * at `workspace.default` (different workspaces) and `features.*` (arm
 * featureOverrides). Any other difference — including profileRebind and
 * trajectoryRetention, which both arms derive identically — is a failure.
 */
export function diffArmConfigs(objectA, objectB) {
  const differences = [];
  const walk = (a, b, p) => {
    if (jsonEqual(a, b)) return;
    if (a !== null && typeof a === 'object' && !Array.isArray(a)
      && b !== null && typeof b === 'object' && !Array.isArray(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) walk(Object.hasOwn(a, k) ? a[k] : undefined, Object.hasOwn(b, k) ? b[k] : undefined, `${p}.${k}`);
      return;
    }
    differences.push({ path: p, a: a === undefined ? '<missing>' : a, b: b === undefined ? '<missing>' : b });
  };
  walk(objectA, objectB, '');
  const allowed = (p) => p === '.workspace.default' || p.startsWith('.features.');
  const undeclared = differences.filter((d) => !allowed(d.path));
  return { ok: undeclared.length === 0, differences, undeclared };
}

// ---------------------------------------------------------------------------
// Arm/shard workspace paths
// ---------------------------------------------------------------------------

/**
 * Single path-component rule for arm/shardId (PRI-1252 r2 structural fence):
 * a component that must never contain separators, traversal (`..`), drive
 * letters, colons or whitespace/quote metacharacters. The arm must ALSO be
 * a configured arm id (T3b) — unknown arms fail before any path exists.
 */
const PATH_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Per-shard arm workspace path. The base is the T3a contract's arm workspace
 * base: `<experimentRoot>/workspaces/<armId>` (loader fences workspaceFiles
 * targets against exactly this base). shardId=null is the legacy shared
 * layout, allowed only for explicitly-marked single-process invocations.
 */
export function armWorkspaceDir(arm, shardId = null) {
  currentConfig(); // fail loud when no config is installed
  if (typeof arm !== 'string' || !PATH_COMPONENT_RE.test(arm)) {
    throw new Error(`armWorkspaceDir: rejected unsafe arm ${JSON.stringify(arm)} — must match ${PATH_COMPONENT_RE} [nextAction: use a configured arm id]`);
  }
  if (!Object.hasOwn(currentConfig().arms, arm)) {
    throw new Error(`armWorkspaceDir: unknown arm ${JSON.stringify(arm)} — configured arms are ${configArms().join(', ')}`);
  }
  if (shardId !== null && (typeof shardId !== 'string' || !PATH_COMPONENT_RE.test(shardId))) {
    throw new Error(`armWorkspaceDir: rejected unsafe shardId ${JSON.stringify(shardId)} — must match ${PATH_COMPONENT_RE} [nextAction: shard ids are path components, e.g. 'solo', 'S01', 'up-S01']`);
  }
  return shardId
    ? path.join(experimentRoot(), 'workspaces', `${arm}-s${shardId}`)
    : path.join(experimentRoot(), 'workspaces', arm);
}

// ---------------------------------------------------------------------------
// File identity / provenance (PRI-1252 r4 — unchanged mechanics)
// ---------------------------------------------------------------------------

const TRAJECTORY_DB_REL = path.join('.state', 'trajectory.db');
const MATERIALIZE_ARTIFACTS = [
  { rel: TRAJECTORY_DB_REL, kind: 'trajectory-db' },
  { rel: path.join('.pd', 'config.yaml'), kind: 'config' },
];
const PROVENANCE_FILE = '.materialize-provenance.json';

function provenancePath(ws) { return path.join(ws, PROVENANCE_FILE); }

function fileIdentity(st, relPath) {
  const identity = {
    fileid: String(st.ino),
    device: String(st.dev),
    birthtimeMs: st.birthtimeMs,
    nlink: st.nlink,
  };
  if (relPath !== TRAJECTORY_DB_REL) {
    identity.size = st.size;
    identity.mtimeMs = st.mtimeMs;
  }
  return identity;
}

function compareArtifactIdentity(st, relPath, recorded) {
  const current = fileIdentity(st, relPath);
  const legacy = recorded.device === undefined || recorded.birthtimeMs === undefined;
  const compared = legacy
    ? { fileid: String(st.ino), nlink: st.nlink, size: st.size, mtimeMs: st.mtimeMs }
    : current;
  const mismatches = Object.keys(compared).filter((key) => compared[key] !== recorded[key]);
  return { current, legacy, mismatches };
}

function upgradeLegacyProvenance(ws, relPath, current) {
  const provenance = readProvenance(ws);
  if (!provenance || !provenance.artifacts || !Object.hasOwn(provenance.artifacts, relPath)) return;
  provenance.artifacts[relPath] = current;
  writeProvenance(ws, provenance.artifacts);
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
 * Every present artifact must be a regular file with nlink === 1; when a
 * provenance record exists, stable filesystem identity must also match.
 */
function checkArtifactSafety(ws, relPath, phase) {
  const artifactPath = path.join(ws, relPath);
  let st;
  try { st = fs.lstatSync(artifactPath); } catch { return false; }
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error(`workspace artifact ${relPath} is not a regular file — refusing to reuse or spawn against it `
      + `(phase=${phase}) [nextAction: remove the replacement and re-materialize]`);
  }
  if (st.nlink !== 1) {
    throw new Error(`workspace artifact ${relPath} has nlink=${st.nlink} (multiple hard links) — `
      + `an external hardlink cannot be ruled out; refusing to reuse or spawn against it `
      + `(phase=${phase}) [nextAction: remove the extraneous link and re-materialize]`);
  }
  const recorded = readProvenance(ws)?.artifacts?.[relPath];
  if (recorded) {
    const comparison = compareArtifactIdentity(st, relPath, recorded);
    if (comparison.mismatches.length > 0) {
      throw new Error(`workspace artifact ${relPath} identity mismatch (${comparison.mismatches.join(', ')}) vs provenance `
        + `(phase=${phase}) [nextAction: the file was replaced or tampered with — re-materialize this workspace]`);
    }
    if (comparison.legacy) upgradeLegacyProvenance(ws, relPath, comparison.current);
  }
  return true;
}

/** Public wrapper — negative tests drive the same gate real callers hit. */
export function assertArtifactReuseSafety(ws, relPath, phase = 'identity:check') {
  return checkArtifactSafety(ws, relPath, phase);
}

/**
 * Record (or refresh) provenance identity entries for artifacts PRESENT under
 * `ws`. Refuses to record an artifact with nlink !== 1.
 */
export function recordArtifactProvenance(ws, relPaths = MATERIALIZE_ARTIFACTS.map((a) => a.rel)) {
  const prov = readProvenance(ws)?.artifacts ?? {};
  let dirty = false;
  for (const rel of relPaths) {
    let st;
    try { st = fs.lstatSync(path.join(ws, rel)); } catch { continue; }
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new Error(`refusing to record provenance for ${rel}: artifact is not a regular file `
        + '(phase=provenance:record) [nextAction: recreate the artifact as a regular file]');
    }
    if (st.nlink !== 1) {
      throw new Error(`refusing to record provenance for ${rel}: nlink=${st.nlink} — an external `
        + `hardlink cannot be ruled out (phase=provenance:record) `
        + '[nextAction: remove the extraneous link and recreate the artifact]');
    }
    const id = fileIdentity(st, rel);
    const recorded = prov[rel];
    if (!recorded || Object.keys(id).length !== Object.keys(recorded).length
      || Object.keys(id).some((k) => recorded[k] !== id[k])) {
      prov[rel] = id;
      dirty = true;
    }
  }
  if (dirty) writeProvenance(ws, prov);
}

/**
 * Fail-closed identity check for every sensitive artifact of `ws` (spawn /
 * post-materialize boundary).
 */
export function assertWorkspaceFileIdentity(ws, phase = 'identity:check') {
  for (const artifact of MATERIALIZE_ARTIFACTS) checkArtifactSafety(ws, artifact.rel, phase);
}

// ---------------------------------------------------------------------------
// workspaceFiles materialization (TECH §4.1/§4.5 + T3a contract)
// ---------------------------------------------------------------------------

/**
 * Materialize the arm's declared `workspaceFiles` entries into `ws`.
 * Safety order (all checks BEFORE any file is created):
 *   1. target must be a relative path that stays lexically inside `ws`
 *      (no `..`, no absolute, no drive letters) — the loader fenced the
 *      declared targets against the arm-workspace base at load time; this
 *      re-checks at the materialization boundary;
 *   2. every EXISTING intermediate directory from `ws` down to the target's
 *      parent is a real directory (per-level lstat reparse fence);
 *   3. an already-present target file must be a regular file whose content
 *      digest equals the declared sha256 (reuse) — anything else refuses;
 *   4. fresh copies verify the SOURCE digest before copying and the TARGET
 *      digest after the atomic rename.
 */
/**
 * Exported for the run variants that build workspaces OUTSIDE the standard
 * materializeWorkspace flow (ab-dreamer-paired restoreClone, ab-stage
 * seedArm): the arm's declared workspaceFiles must be materialized with the
 * SAME digest/escape/symlink fences everywhere — a clone that skips them
 * silently drops the declared intervention inputs (review 0004).
 */
export function materializeWorkspaceFiles(armId, ws, { force = false } = {}) {
  const cfg = currentConfig();
  const entries = cfg.arms[armId].workspaceFiles ?? [];
  const results = [];
  const wsCanonical = canonical(ws);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const field = `arms.${armId}.workspaceFiles[${i}]`;
    const rel = entry.target;
    if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) {
      throw new Error(`${field}.target must be a relative workspace path, got ${JSON.stringify(rel)} (phase=materialize:workspace-files)`);
    }
    const target = path.resolve(ws, rel);
    // Lexical containment after normalization (backslashes, dot segments).
    const relNorm = path.relative(ws, target);
    if (relNorm === '' || relNorm.startsWith('..') || path.isAbsolute(relNorm)) {
      throw new Error(`${field}.target escapes the arm workspace: ${rel} (phase=materialize:workspace-files)`);
    }
    // Per-level reparse fence over every EXISTING intermediate directory.
    const parent = path.dirname(target);
    const segs = path.relative(ws, parent).split(/[\\/]+/).filter(Boolean);
    let cursor = ws;
    for (const seg of segs) {
      cursor = path.join(cursor, seg);
      const st = lstatSafe(cursor);
      if (st === null) continue; // not created yet — mkdir below is fenced by the isolation validator
      if (st.isSymbolicLink()) {
        throw new Error(`${field}.target intermediate directory ${cursor} is a symlink/junction/reparse point (phase=materialize:workspace-files) [nextAction: remove the redirect and re-materialize]`);
      }
      if (!st.isDirectory()) {
        throw new Error(`${field}.target intermediate path ${cursor} exists but is not a directory (phase=materialize:workspace-files)`);
      }
    }
    if (canonical(parent) !== wsCanonical && !isWithin(wsCanonical, canonical(parent))) {
      throw new Error(`${field}.target parent resolves outside the arm workspace (phase=materialize:workspace-files)`);
    }
    fs.mkdirSync(parent, { recursive: true });
    // Re-validate the physical fence AFTER creating the intermediate dirs.
    assertWorkspaceIsolation(ws, { phase: 'materialize:workspace-files:post-create' });

    const existing = lstatSafe(target);
    if (existing !== null && !force) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error(`refusing to reuse ${field} target ${rel}: not a regular file (phase=materialize:workspace-files)`);
      }
      if (sha256File(target) !== entry.sha256.toLowerCase()) {
        throw new Error(`refusing to reuse ${field} target ${rel}: content digest does not match the configured sha256 (phase=materialize:workspace-files) [nextAction: re-materialize with force]`);
      }
      results.push({ target: rel, state: 'reused' });
      continue;
    }
    // Source digest verified again at copy time (loader verified at load; a
    // file swapped in between must not silently flow into the workspace).
    const sourceDigest = sha256File(entry.source);
    if (sourceDigest !== entry.sha256.toLowerCase()) {
      throw new Error(`${field}.source digest changed since config load: ${entry.source} (phase=materialize:workspace-files) [nextAction: reload the config so the loader re-verifies current files]`);
    }
    const tmp = `${target}.${process.pid}.tmp`;
    fs.copyFileSync(entry.source, tmp);
    fs.renameSync(tmp, target);
    const writtenDigest = sha256File(target);
    if (writtenDigest !== entry.sha256.toLowerCase()) {
      throw new Error(`${field} target ${rel} digest mismatch after copy (phase=materialize:workspace-files) — written bytes do not equal the configured sha256`);
    }
    results.push({ target: rel, state: 'created', sha256: writtenDigest });
  }
  return results;
}

/**
 * Materialize an arm workspace: fresh .pd (state.db initialized by the
 * runtime on first use), trajectory.db copied from the configured snapshot,
 * derived config, declared workspaceFiles. Fence timing (PRI-1252 r2):
 * validate BEFORE creating the shard dirs (nearest-existing-ancestor mode),
 * again AFTER creation, and the DB copy / config write go through the
 * atomic-placement path. Reuse additionally requires provenance-backed
 * file identity (PRI-1252 r4).
 */
export function materializeWorkspace(arm, { force = false, shardId = null } = {}) {
  const worktree = armWorktree(arm);
  if (!fs.existsSync(worktree)) throw new Error(`arm worktree missing: ${worktree}`);
  const ws = armWorkspaceDir(arm, shardId); // structural fence: safe path components
  assertWorkspaceIsolation(ws, { phase: 'materialize:pre-create' });
  fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
  assertWorkspaceIsolation(ws, { phase: 'materialize:post-create' });
  const workspaceFilesState = materializeWorkspaceFiles(arm, ws, { force });
  // Each artifact is created ONCE (subsequent processes skip). Creation goes
  // through a per-process temp file + atomic rename.
  const provenance = readProvenance(ws)?.artifacts ?? {};
  let provenanceDirty = false;
  const placeAtomic = (relPath, write) => {
    const target = path.join(ws, relPath);
    const existing = (() => { try { return fs.lstatSync(target); } catch { return null; } })();
    if (existing !== null && !force) {
      const recorded = provenance[relPath];
      if (!recorded) {
        throw new Error(`refusing to reuse unverified ${relPath}: no provenance record (phase=materialize:reuse) `
          + '[nextAction: re-materialize with force so the harness records file identity]');
      }
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error(`refusing to reuse ${relPath}: artifact is not a regular file `
          + '(phase=materialize:reuse) [nextAction: remove the replacement and re-materialize with force]');
      }
      if (existing.nlink !== 1) {
        throw new Error(`refusing to reuse ${relPath}: nlink=${existing.nlink} — multiple hard links, `
          + 'external hardlink cannot be ruled out (phase=materialize:reuse) '
          + '[nextAction: remove the extraneous link and re-materialize with force]');
      }
      const comparison = compareArtifactIdentity(existing, relPath, recorded);
      if (comparison.mismatches.length > 0) {
        throw new Error(`refusing to reuse ${relPath}: identity mismatch (${comparison.mismatches.join(', ')}) vs provenance `
          + '(phase=materialize:reuse) [nextAction: the file was replaced or tampered with — re-materialize with force]');
      }
      if (comparison.legacy) {
        provenance[relPath] = comparison.current;
        provenanceDirty = true;
      }
      return 'reused';
    }
    const tmp = `${target}.${process.pid}.tmp`;
    write(tmp);
    fs.renameSync(tmp, target); // same-volume rename: atomic; concurrent last-writer wins whole-file
    provenance[relPath] = fileIdentity(fs.lstatSync(target), relPath);
    provenanceDirty = true;
    return 'created';
  };
  const trajState = placeAtomic(path.join('.state', 'trajectory.db'), (t) => fs.copyFileSync(path.join(snapshotDir(), 'trajectory.db'), t));
  const cfgText = deriveExperimentConfig(ws, arm);
  // PRI-1254 r2 (review 0003): the config artifact is derived from the ARM +
  // CURRENT config, but the workspace path is NOT config-derived — a reused
  // workspace can silently carry a config derived under an OLDER config
  // (changed featureOverrides / profileRebind / base template). Content-verify
  // the reused file against the CURRENT derivation before trusting it; a
  // mismatch refuses instead of recording the new digest for an old config.
  const cfgTarget = path.join(ws, '.pd', 'config.yaml');
  const cfgExisting = lstatSafe(cfgTarget);
  if (cfgExisting !== null && !force) {
    const actualSha = sha256File(cfgTarget);
    if (actualSha !== sha256(cfgText)) {
      throw new Error(`refusing to reuse .pd/config.yaml: its content was derived under a DIFFERENT config `
        + `(actual ${actualSha} != current derivation ${sha256(cfgText)}) (phase=materialize:config-content) `
        + '[nextAction: re-materialize with force so the workspace config matches the current experiment config]');
    }
  }
  const cfgState = placeAtomic(path.join('.pd', 'config.yaml'), (t) => fs.writeFileSync(t, cfgText, 'utf8'));
  if (provenanceDirty) writeProvenance(ws, provenance);
  assertWorkspaceFileIdentity(ws, 'materialize:final');
  // The manifest digest must describe the file that WILL run (the actual
  // artifact on disk), never the would-be derivation text.
  const configSha256 = sha256File(cfgTarget);
  return { workspace: ws, trajectory: trajState, config: cfgState, configSha256, workspaceFiles: workspaceFilesState };
}

// ---------------------------------------------------------------------------
// Spawn wiring (PRI-1252 r2/r4 — unchanged mechanics, worktree now config-fed)
// ---------------------------------------------------------------------------

/**
 * The ONE spawn wiring for pd-cli children: runPd() (ab-lib) AND runPdIn()
 * (ab-stage.mjs) both delegate here so the physical fence is enforced
 * exactly once, at the only place a child process can start.
 */
export function spawnPdChild({ arm = null, worktree, ws, args, timeoutMs = 45 * 60_000 }) {
  assertWorkspaceIsolation(ws, { phase: 'spawn:pre-spawn' });
  assertWorkspaceFileIdentity(ws, 'spawn:pre-spawn');
  const cli = path.join(worktree, 'packages/pd-cli/dist/index.js');
  if (!fs.existsSync(cli)) throw new Error(`pd-cli dist missing in ${arm ?? 'unknown'} arm: ${cli}`);
  const env = childEnv({ PD_WORKSPACE_DIR: ws }, ws);
  if (env['PD_WORKSPACE_DIR'] !== ws) {
    throw new Error(`spawn env PD_WORKSPACE_DIR does not match the validated workspace `
      + `(phase=spawn:env-consistency): expected ${ws} [nextAction: this is a harness bug — `
      + 'childEnv must keep the validated pointer unchanged]');
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

/** Run a pd-cli command from an arm's configured worktree against its experiment workspace. */
export function runPd(arm, args, { timeoutMs = 45 * 60_000, shardId = null } = {}) {
  const worktree = armWorktree(arm);
  const ws = armWorkspaceDir(arm, shardId);
  return spawnPdChild({ arm, worktree, ws, args, timeoutMs });
}

// ---------------------------------------------------------------------------
// Dataset (full fidelity, every sample probed — TECH §7 / T3b §5.11)
// ---------------------------------------------------------------------------

/**
 * Load the FULL-fidelity dataset from the configured path — fail-closed:
 * the file must exist and NO sample may carry redaction markers (every
 * sample probed since T3b; the historical first-sample-only probe let a
 * partially redacted dataset through). No fallback to any public copy.
 */
export function loadDataset() {
  const file = datasetFile();
  if (!fs.existsSync(file)) {
    throw new Error(
      `FULL-fidelity dataset missing at ${file} — regenerate it with ` +
      'experiment/prompt-v2/scripts/freeze-dataset.mjs against the configured snapshot. ' +
      'NO FALLBACK: the committed public copy is redacted and must never drive an experiment.',
    );
  }
  const dataset = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(dataset.samples) || dataset.samples.length === 0) {
    throw new Error(`Dataset at ${file} has no samples.`);
  }
  for (let i = 0; i < dataset.samples.length; i++) {
    const probe = JSON.stringify(dataset.samples[i]?.painEvent ?? {}).slice(0, 2000);
    if (probe.includes('«redacted') || probe.includes('anon-')) {
      throw new Error(`Dataset at ${file} carries redaction markers in sample[${i}] (painEvent ${JSON.stringify(dataset.samples[i]?.experimentPainId ?? i)}) — refusing to run an experiment on redacted data (remediation §6.1; every sample is probed since T3b).`);
    }
  }
  return dataset;
}

// ---------------------------------------------------------------------------
// runId path safety (TECH §4.5 — THIS module's responsibility per the T3a
// handoff; the loader deliberately has no runId parameter)
// ---------------------------------------------------------------------------

/**
 * TRIPWIRE — mirrors TECH §4.5's runId pattern. The pattern ALONE admits the
 * dot-only values '.' and '..' — every join site MUST also run the strict
 * under-runs re-check (validateRunId) before creating anything.
 */
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Validate a runId for path joining (TECH §4.5, T3b contract):
 *   1. pattern `^[A-Za-z0-9._-]+$` (rejects separators, absolute prefixes);
 *   2. reject the dot-only values the pattern alone admits ('.', '..');
 *   3. STRICT under-runs re-check — the joined path, canonically resolved
 *      through its nearest existing ancestor, must sit strictly UNDER
 *      `<experimentRoot>/runs/` (never ON it, never outside it);
 *   4. reparse fence — every EXISTING level from the runs root down is
 *      lstat'd; a symlink/junction anywhere in the chain refuses.
 * Fail-closed: throws with a structured reason + nextAction.
 */
export function validateRunId(runId) {
  const root = experimentRoot();
  const runsRoot = path.join(root, 'runs');
  const problems = [];
  if (typeof runId !== 'string' || runId === '' || !RUN_ID_RE.test(runId)) {
    problems.push(`pattern: runId must match ${RUN_ID_RE}, got ${JSON.stringify(String(runId))}`);
  }
  if (runId === '.' || runId === '..') {
    problems.push(`dot_only: runId ${JSON.stringify(runId)} normalizes onto a parent directory — this exact value passes the pattern and is the proven escape`);
  }
  const joined = path.join(runsRoot, String(runId));
  const runsCanonical = canonical(runsRoot);
  const joinedCanonical = canonical(joined);
  if (joinedCanonical === runsCanonical || !isWithin(runsCanonical, joinedCanonical)) {
    problems.push(`not_strictly_under_runs: ${joined} canonicalizes to ${joinedCanonical}, which is not strictly under ${runsCanonical}`);
  }
  // Reparse fence over every existing level of the runs chain.
  const segs = path.relative(runsRoot, joined).split(/[\\/]+/).filter(Boolean);
  let cursor = runsRoot;
  const rootSt = lstatSafe(runsRoot);
  if (rootSt !== null) {
    if (rootSt.isSymbolicLink()) problems.push(`reparse_point: runs root ${runsRoot} is a symlink/junction/reparse point`);
    else if (!rootSt.isDirectory()) problems.push(`not_directory: runs root ${runsRoot} is not a directory`);
    else {
      for (const seg of segs) {
        cursor = path.join(cursor, seg);
        const st = lstatSafe(cursor);
        if (st === null) break;
        if (st.isSymbolicLink()) { problems.push(`reparse_point: ${cursor} is a symlink/junction/reparse point`); break; }
        if (!st.isDirectory()) { problems.push(`not_directory: ${cursor} exists but is not a directory`); break; }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`runId rejected: ${JSON.stringify(String(runId))} — ${problems.join('; ')} `
      + `[nextAction: runId must be a single safe path segment under ${runsRoot}]`);
  }
  return joined;
}

/** Validated run directory (create happens only after validateRunId passes). */
export function runDir(runId) {
  const dir = validateRunId(runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Deterministic arm order (SPEC §4.7 — GLOBAL sample index since T3b)
// ---------------------------------------------------------------------------

/**
 * Deterministic interleave for A/B ordering: alternate arms per sample with
 * a stable per-run offset derived from the run id, so no arm systematically
 * runs first. The index MUST be the sample's GLOBAL index in the full
 * dataset (not the shard-local list position) — that is what makes the
 * order invariant under different shard layouts (CF-12).
 */
export function armOrderFor(runId, globalSampleIndex, arms = ['v1', 'v2']) {
  const h = parseInt(sha256(runId).slice(0, 8), 16);
  const flip = (h + globalSampleIndex) % 2;
  return flip === 0 ? [...arms] : [...arms].reverse();
}

// ---------------------------------------------------------------------------
// Ingress contract (TECH §7 — shared by every pain-record call site)
// ---------------------------------------------------------------------------

export const REASON_CLI_MAX = 500; // pain-record.ts MAX_REASON_LENGTH — hard CLI rejection

/**
 * Decide the --host argument from the sample's host_kind and session
 * evidence (PT-05 + PRI-1254 r2 review P1-02).
 *
 * REAL CLI contract (packages/pd-cli/src/commands/pain-record.ts, audited):
 * with `--session` and NO explicit --host the CLI hard-attributes
 * `hostKind='openclaw'` (the pre-PRI-743 default); `--host` only accepts
 * `openclaw|codex` and codex additionally requires rollout lineage. The CLI
 * therefore cannot express "unknown host, session-bound" — omitting --host
 * would SILENTLY record OpenClaw for a sample we have no host evidence for.
 *
 * Decision table:
 *   session + host_kind=openclaw  → --host openclaw (evidence-backed);
 *   session + codex/unknown/other → FAIL-CLOSED (failClosed: true): the
 *     caller must refuse the sample BEFORE any CLI invocation — no write, no
 *     attribution guess, no unbound re-record;
 *   no session                    → unbound Owner report: the CLI records NO
 *     host attribution on this path, so --host is omitted regardless of
 *     host_kind and the basis is recorded.
 */
export function decideHostArg(painEvent) {
  const kind = typeof painEvent?.host_kind === 'string' ? painEvent.host_kind.trim().toLowerCase() : '';
  const hasSession = typeof painEvent?.session_id === 'string' && painEvent.session_id !== '';
  if (hasSession && kind === 'openclaw') {
    return { hostArg: ['--host', 'openclaw'], decision: { basis: 'host_kind=openclaw + session evidence', applicable: true, failClosed: false } };
  }
  if (hasSession && kind === 'codex') {
    // Codex ingress needs --rollout-id/--host-turn-id lineage the dataset
    // does not carry; omitting --host would default the CLI to openclaw.
    return { hostArg: [], decision: { basis: 'host_kind=codex without rollout lineage — the CLI cannot express a session-bound non-OpenClaw attribution', applicable: false, failClosed: true } };
  }
  if (hasSession) {
    return { hostArg: [], decision: { basis: `host_kind=${kind || '<empty>'} with a bound session — no source evidence and the CLI would default to openclaw`, applicable: false, failClosed: true } };
  }
  // No session → unbound report; the CLI records no host attribution here.
  return { hostArg: [], decision: { basis: `host_kind=${kind || '<empty>'}, unbound report — no host attribution involved`, applicable: false, failClosed: false } };
}

/**
 * Build the pain-record argument vector per the TECH §7 contract plus the
 * per-sample ingress evidence record. --score takes painEvent.score (NEVER
 * confidence); --reason is truncated to <=500 BEFORE the CLI with the
 * truncation recorded; the input digest covers the parameterized CLI input
 * (byte-stable, credential-free).
 */
export function buildIngressArgs(painEvent) {
  const rawReason = String(painEvent.reason ?? painEvent.text ?? '');
  const truncated = rawReason.length > REASON_CLI_MAX;
  const reason = truncated ? rawReason.slice(0, REASON_CLI_MAX) : rawReason;
  const { hostArg, decision } = decideHostArg(painEvent);
  const argv = [
    'pain', 'record',
    '--reason', reason,
    '--source', String(painEvent.source ?? 'manual'),
    ...hostArg,
  ];
  if (typeof painEvent.score === 'number') argv.push('--score', String(painEvent.score));
  if (typeof painEvent.session_id === 'string' && painEvent.session_id !== '') argv.push('--session', String(painEvent.session_id));
  const inputDigest = sha256(JSON.stringify({
    reason, source: String(painEvent.source ?? 'manual'), score: typeof painEvent.score === 'number' ? painEvent.score : null,
    session_id: typeof painEvent.session_id === 'string' ? painEvent.session_id : null,
    host: decision.applicable && hostArg[1] ? hostArg[1] : null,
  }));
  const evidence = {
    ingressMode: typeof painEvent.session_id === 'string' && painEvent.session_id !== '' ? 'bound' : 'unbound',
    hostDecision: decision,
    reasonTruncated: truncated,
    reasonOriginalLength: rawReason.length,
    reasonSentLength: reason.length,
    inputDigest,
    inputArgsSummary: {
      source: String(painEvent.source ?? 'manual'),
      score: typeof painEvent.score === 'number' ? painEvent.score : null,
      hasSession: typeof painEvent.session_id === 'string' && painEvent.session_id !== '',
      host: decision.applicable && hostArg[1] ? hostArg[1] : null,
    },
  };
  return { argv, evidence };
}

// ---------------------------------------------------------------------------
// Terminal-state classification (TECH §7 终态语义)
// ---------------------------------------------------------------------------

/**
 * Detect "every router recommendation is a defer" from the collected stage
 * artifacts. Returns true only when a parseable router artifact carries a
 * non-empty recommendations array whose every entry is kind 'defer'; any
 * parse failure or non-defer entry returns false (never guesses defer).
 */
export function detectDeferOnly(stageArtifacts) {
  const routerArts = (stageArtifacts ?? []).filter((a) => String(a?.source_task_id ?? '').startsWith('diag_router-'));
  const last = routerArts[routerArts.length - 1];
  if (!last) return false;
  let recommendations = null;
  try { recommendations = JSON.parse(last?.content_json ?? 'null')?.recommendations ?? null; } catch { recommendations = null; }
  return Array.isArray(recommendations) && recommendations.length > 0
    && recommendations.every((r) => String(r?.kind ?? r?.recommendationKind ?? '') === 'defer');
}

/**
 * Classify one sample-arm terminal state (TECH §7): `done-admission-refused`
 * and `done-deferred` are LEGITIMATE research outcomes — verification.ok is
 * TRUE for them and they are NOT harness failures; only real
 * execution/infrastructure errors produce `failed`. `incomplete` keeps its
 * historical meaning (router succeeded but verification failed).
 *
 * PRI-1256 r3 — `done-no-candidate` is RETIRED as a producible terminal:
 * under the current production contract (DiagnosticianOutputV2 requires
 * >=1 recommendation; SqliteDiagnosticianCommitter transactionally writes
 * ONE candidate per recommendation, defers included) a succeeded chain
 * ALWAYS persists >=1 candidate. Router success with zero candidates is
 * therefore a persistence/execution anomaly, never a legitimate outcome —
 * it classifies `incomplete` (fail-closed) no matter what else is true:
 * an all-defer output does NOT rescue it into `done-deferred`, and an
 * admissionRefused flag does NOT bypass the persistence check. The string
 * survives ONLY as a persisted historical terminal that ab-run's resume
 * set still honors — this classifier can never emit it again.
 *
 * See `classifyTerminal` for the classifier itself.
 */
/** Canonicalize parsed JSON (sorted object keys) so two persistences of the
 * same logical payload compare equal regardless of serialization order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalJson(value[k]);
    return out;
  }
  return value;
}

/**
 * PRI-1256 r4/r5 — verify the 1:1 correspondence between the recommendations
 * in the committed router artifact and the persisted principle_candidates
 * rows (TECH §7 candidate-completeness). Production's committer
 * transactionally writes exactly ONE candidate per recommendation, linked by
 * the V2-required unique `recommendationRef` (carried in
 * source_recommendation_json), the commit `artifact_id`, the router
 * `task_id` and the router `source_run_id` — so any deviation (missing /
 * duplicated / mis-linked / extra candidates) is a persistence anomaly and
 * the unit must classify `incomplete`, never a legitimate terminal.
 * `commitArtifact` is the artifacts-table row of the committed
 * diagnostician_output — the AUTHORITATIVE expected set, since commitSync
 * persisted it atomically with the candidates. A missing commit artifact
 * means the commit unit itself is absent and linkage is unverifiable
 * (-> fail). Returns { ok, expected, actual, problems }.
 *
 * `context` (PRI-1256 r5, P2-01) supplies the two rows that complete the
 * ownership/dual-write contract:
 *   - `succeededRouterRunId`: run_id of the ACTUAL succeeded router run. The
 *     commit artifact must be bound to it (production writes artifact,
 *     commit and candidates with the same input.runId); pass null when no
 *     router run succeeded — a commit artifact then cannot be bound.
 *   - `piArtifact`: the router pi_artifacts row. Production dual-writes the
 *     SAME routerContentJson to the commit artifact and the pi_artifact in
 *     one transaction, so the normalized contents must be identical.
 * Both are checked per candidate too: `task_id` must equal the commit
 * artifact's task_id, `recommendation_kind` must equal the committed
 * recommendation's kind, and the stored `source_recommendation_json` must
 * match the committed recommendation verbatim (a correct ref over tampered
 * content is still an anomaly).
 */
export function verifyCandidateLinkage(commitArtifact, candidates, context = {}) {
  const problems = [];
  if (!commitArtifact) {
    return { ok: false, expected: 0, actual: candidates?.length ?? 0,
      problems: ['committed diagnostician_output artifact row not found — the Stage C commit unit is absent'] };
  }
  let commitContent = null;
  try { commitContent = JSON.parse(commitArtifact?.content_json ?? 'null'); } catch { commitContent = null; }
  const recs = commitContent?.recommendations ?? null;
  if (!Array.isArray(recs) || recs.length === 0) {
    return { ok: false, expected: 0, actual: candidates?.length ?? 0, problems: ['committed artifact has no parseable non-empty recommendations list'] };
  }
  const expected = new Map();
  const recByRef = new Map();
  for (const r of recs) {
    const ref = r?.recommendationRef;
    if (typeof ref !== 'string' || ref === '') {
      return { ok: false, expected: recs.length, actual: candidates?.length ?? 0, problems: ['a committed recommendation has no recommendationRef'] };
    }
    expected.set(ref, (expected.get(ref) ?? 0) + 1);
    if (!recByRef.has(ref)) recByRef.set(ref, r);
  }
  // P2-01/C: bind the commit artifact to the run that actually succeeded.
  if (context.succeededRouterRunId !== undefined
    && commitArtifact.run_id !== context.succeededRouterRunId) {
    problems.push(`commit artifact run_id ${commitArtifact.run_id} != the succeeded router run ${context.succeededRouterRunId ?? '(none)'}`);
  }
  // P2-01/B: the Stage C dual-write consistency contract — commit artifact
  // and router pi_artifact must carry the same normalized output.
  if (context.piArtifact !== undefined) {
    if (!context.piArtifact) {
      problems.push('router pi_artifact row missing — the Stage C dual-write is absent');
    } else {
      let piContent = null;
      try { piContent = JSON.parse(context.piArtifact?.content_json ?? 'null'); } catch { piContent = null; }
      if (piContent === null) {
        problems.push('router pi_artifact content_json is unparseable — the dual-write cannot be verified');
      } else if (JSON.stringify(canonicalJson(piContent)) !== JSON.stringify(canonicalJson(commitContent))) {
        problems.push('router pi_artifact diverges from the committed artifact — Stage C dual-write inconsistency');
      }
    }
  }
  const actual = new Map();
  for (const c of candidates ?? []) {
    let srcRec = null;
    try { srcRec = JSON.parse(c?.source_recommendation_json ?? 'null'); } catch { srcRec = null; }
    const ref = srcRec?.recommendationRef;
    if (typeof ref !== 'string' || ref === '') {
      problems.push(`candidate ${c?.candidate_id ?? '?'} carries no parseable recommendationRef`);
    } else {
      actual.set(ref, (actual.get(ref) ?? 0) + 1);
      const committed = recByRef.get(ref);
      if (committed) {
        // A correct ref over tampered content/kind is still an anomaly:
        // production persists JSON.stringify(rec) verbatim and rec.kind.
        if (JSON.stringify(canonicalJson(srcRec)) !== JSON.stringify(canonicalJson(committed))) {
          problems.push(`candidate ${c.candidate_id} source_recommendation_json diverges from the committed recommendation ${ref}`);
        }
        if (c.recommendation_kind !== committed.kind) {
          problems.push(`candidate ${c.candidate_id} recommendation_kind ${c.recommendation_kind} != committed kind ${committed.kind}`);
        }
      }
    }
    // P2-01/A: candidate ownership — production writes every candidate with
    // the same input.taskId as the commit artifact (the router stage task).
    if (c.task_id !== commitArtifact.task_id)
      problems.push(`candidate ${c.candidate_id} task_id ${c.task_id} != commit task ${commitArtifact.task_id}`);
    if (c.artifact_id !== commitArtifact.artifact_id)
      problems.push(`candidate ${c.candidate_id} artifact_id ${c.artifact_id} != commit artifact ${commitArtifact.artifact_id}`);
    if (c.source_run_id !== commitArtifact.run_id)
      problems.push(`candidate ${c.candidate_id} source_run_id ${c.source_run_id} != commit run ${commitArtifact.run_id}`);
  }
  for (const [ref, n] of expected) {
    const a = actual.get(ref) ?? 0;
    if (a < n) problems.push(`recommendation ${ref}: ${n - a} missing candidate(s)`);
    else if (a > n) problems.push(`recommendation ${ref}: ${a - n} duplicate candidate(s)`);
  }
  for (const [ref, n] of actual) {
    if (!expected.has(ref)) problems.push(`${n} candidate(s) claim unknown recommendationRef ${ref}`);
  }
  return { ok: problems.length === 0, expected: recs.length, actual: candidates?.length ?? 0, problems };
}

/**
 * Classify one sample-arm terminal state (TECH §7): `done-admission-refused`
 * and `done-deferred` are LEGITIMATE research outcomes — verification.ok is
 * TRUE for them and they are NOT harness failures; only real
 * execution/infrastructure errors produce `failed`. `incomplete` keeps its
 * historical meaning (router succeeded but verification failed).
 */
export function classifyTerminal({
  diagnoseOk, routerTaskSucceeded, routerRunSucceeded, stageArtifactsSchemaValid,
  candidatesComplete, admissionRefused, deferOnly, formationComplete,
}) {
  const chainOk = Boolean(diagnoseOk && routerTaskSucceeded && routerRunSucceeded && stageArtifactsSchemaValid);
  // Candidates are REQUIRED for every legitimate terminal: the commit unit
  // writes one per recommendation atomically, so their absence means the
  // commit did not complete — certifying done/done-deferred/
  // done-admission-refused over that state would certify a persistence
  // failure as success. `candidatesComplete` is the r4 1:1
  // recommendation↔candidate linkage check, not merely `count > 0`.
  // PRI-1284 (P1-3): the formation loop's exit reason is likewise part of
  // the contract — `formationComplete` is false only when the loop budget
  // was exhausted while chain tasks remained executable. The by-design
  // early stop (--formation-depth reached) and the normal chain-terminal
  // outcome both count as complete; a budget-exhausted loop does not, and
  // the unit falls to `incomplete` (resumable) instead of certifying `done`.
  const ok = chainOk && Boolean(candidatesComplete) && formationComplete === true;
  const status = ok
    ? (admissionRefused ? 'done-admission-refused' : (deferOnly ? 'done-deferred' : 'done'))
    : (routerTaskSucceeded ? 'incomplete' : 'failed');
  const legitimateTerminal = !ok ? null
    : admissionRefused ? 'admission-refused'
    : deferOnly ? 'deferred' : null;
  return { status, ok, legitimateTerminal };
}

// ---------------------------------------------------------------------------
// Run-manifest identity verification (TECH §4.1/§4.4/§7 + PRI-1254 r2 P2-07)
// ---------------------------------------------------------------------------

/**
 * Verify the EXISTING run manifests of `runId` against the CURRENT config
 * before any downstream consumer (ab-metrics / ab-blindpack /
 * ab-blindpack-paired / ab-eval / ab-blind-summary / analysis/
 * paired-analysis) reads records or generates results. Reuses the manifest
 * files lab:run already wrote — no new persistence, no manifest service.
 *
 * Two manifest shapes exist and BOTH stay readable (TECH §8 historical
 * reading capability):
 *  - new format (written since T3b): carries experimentId / configSha256 /
 *    preregistrationStatus / preregistrationSha256 / roles / arms.{id}.head /
 *    datasetSha256 / snapshot.sha256 — verified field-by-field against the
 *    current config;
 *  - legacy format (pre-T3b historical runs): { runId, heads: {<arm>: …},
 *    datasetSha256 } without identity fields — verifiable only against
 *    dataset digest and per-arm heads, and ONLY acceptable when the CURRENT
 *    config is a legacy batch (a preregistered config reading a manifest
 *    without identity fields is fail-closed: identity cannot be proven).
 *
 * Legacy rules (CF-13 semantics preserved): preregistration is never
 * required for legacy manifests; preregistrationSha256 must be null when
 * present; VERIFIED is never fabricated.
 *
 * Fail-closed: every mismatch is collected and thrown at once.
 */
export function assertRunManifestIdentity(config, runId, { requireManifest = true } = {}) {
  const runsDir = validateRunId(runId);
  const problems = [];
  let manifestFiles = [];
  try {
    manifestFiles = fs.readdirSync(runsDir)
      .filter((f) => f === 'grid-manifest.json' || f.startsWith('run-manifest.'))
      .sort();
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`run-manifest identity verification failed for ${JSON.stringify(runId)} — the run directory ${runsDir} does not exist `
        + '[nextAction: point --run-id/--pa-run-id at an existing run, or create it through lab:run]');
    }
    throw err; // unreadable directory: not a manifest-identity problem — rethrow raw
  }
  if (manifestFiles.length === 0) {
    if (requireManifest) {
      throw new Error(`run-manifest identity verification failed for ${JSON.stringify(runId)} — no run-manifest.*.json or grid-manifest.json exists under ${runsDir} `
        + '[nextAction: run the experiment through lab:run so a manifest pins its identity, or point --run-id at an existing run]');
    }
    return { ok: true, verified: [], problems: ['no manifests present (requireManifest=false)'] };
  }
  const isLegacyConfig = config.mode === 'legacy';
  const verified = [];
  for (const file of manifestFiles) {
    const label = `${runId}/${file}`;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8'));
    } catch (err) {
      problems.push(`${label}: manifest unreadable: ${String(err?.message ?? err).slice(0, 160)}`);
      continue;
    }
    if (manifest.runId !== undefined && manifest.runId !== runId) {
      problems.push(`${label}: manifest.runId ${JSON.stringify(manifest.runId)} does not match the requested run`);
    }
    // Digests every shape carries or must carry.
    if (manifest.datasetSha256 !== undefined && manifest.datasetSha256 !== config.dataset.sha256) {
      problems.push(`${label}: datasetSha256 ${manifest.datasetSha256} != config dataset digest ${config.dataset.sha256} — this run was NOT produced from the current dataset`);
    }
    if (manifest.snapshot?.sha256 !== undefined) {
      for (const key of ['state', 'trajectory', 'blobManifest']) {
        const recorded = manifest.snapshot.sha256[key];
        const expected = config.snapshot?.sha256?.[key];
        if (recorded !== undefined && expected !== undefined && recorded !== expected) {
          problems.push(`${label}: snapshot.sha256.${key} ${recorded} != config ${expected}`);
        }
      }
    }
    const hasIdentityFields = manifest.experimentId !== undefined || manifest.configSha256 !== undefined;
    if (hasIdentityFields) {
      // New-format manifest — full identity verification for BOTH modes.
      if (manifest.experimentId !== config.experimentId) {
        problems.push(`${label}: experimentId ${JSON.stringify(manifest.experimentId)} != config ${JSON.stringify(config.experimentId)}`);
      }
      if (manifest.configSha256 !== config.verification.configSha256) {
        problems.push(`${label}: configSha256 ${manifest.configSha256} != current config digest ${config.verification.configSha256} — this run was NOT produced from the current config`);
      }
      const expectedStatus = config.verification.preregistrationStatus;
      if (manifest.preregistrationStatus !== expectedStatus) {
        problems.push(`${label}: preregistrationStatus ${JSON.stringify(manifest.preregistrationStatus)} != config ${JSON.stringify(expectedStatus)}`);
      }
      const expectedPreregSha = config.verification.preregistrationSha256;
      if ((manifest.preregistrationSha256 ?? null) !== (expectedPreregSha ?? null)) {
        problems.push(`${label}: preregistrationSha256 ${JSON.stringify(manifest.preregistrationSha256 ?? null)} != config ${JSON.stringify(expectedPreregSha ?? null)}`);
      }
      if (manifest.roles !== undefined) {
        const expectedRoles = { baseline: config.baselineArm, candidate: config.candidateArm };
        if (JSON.stringify(sortKeys(manifest.roles)) !== JSON.stringify(sortKeys(expectedRoles))) {
          problems.push(`${label}: roles ${JSON.stringify(manifest.roles)} != config arms ${JSON.stringify(expectedRoles)}`);
        }
      }
    } else if (!isLegacyConfig) {
      // Identity-less manifest can only be trusted for a legacy replay.
      problems.push(`${label}: manifest carries no experimentId/configSha256 identity fields — only legacy batch replays may read identity-less manifests`);
    } else if (manifest.datasetSha256 === undefined) {
      problems.push(`${label}: legacy manifest records no datasetSha256 — cannot prove the run used the configured dataset`);
    }
    // Per-arm heads: whatever shape recorded them, each CONFIGURED arm's
    // recorded head must equal the config's expectedHead.
    const recordedHeads = manifest.armsHeads ?? (manifest.heads ?? null);
    if (recordedHeads !== null && typeof recordedHeads === 'object') {
      for (const [armId, arm] of Object.entries(config.arms)) {
        const recorded = recordedHeads[armId];
        if (recorded !== undefined && String(recorded).toLowerCase() !== arm.expectedHead.toLowerCase()) {
          problems.push(`${label}: head for arm ${armId} ${recorded} != config expectedHead ${arm.expectedHead}`);
        }
      }
    }
    if (Array.isArray(manifest.arms)) {
      // Grid manifests carry the arm IDS as an array — each must be a
      // configured arm (order-insensitive membership, no third arm).
      for (const armId of manifest.arms) {
        if (!Object.hasOwn(config.arms, armId)) {
          problems.push(`${label}: manifest arms list ${JSON.stringify(manifest.arms)} does not match the configured arms`);
          break;
        }
      }
    } else if (manifest.arms !== undefined && typeof manifest.arms === 'object') {
      for (const [armId, armInfo] of Object.entries(manifest.arms)) {
        const cfgArm = config.arms[armId];
        if (!cfgArm) {
          problems.push(`${label}: manifest records arm ${armId} which is not in the current config arms`);
          continue;
        }
        if (armInfo?.head !== undefined && String(armInfo.head).toLowerCase() !== cfgArm.expectedHead.toLowerCase()) {
          problems.push(`${label}: arms.${armId}.head ${armInfo.head} != config expectedHead ${cfgArm.expectedHead}`);
        }
        if (armInfo?.expectedHead !== undefined && String(armInfo.expectedHead).toLowerCase() !== cfgArm.expectedHead.toLowerCase()) {
          problems.push(`${label}: arms.${armId}.expectedHead ${armInfo.expectedHead} != config ${cfgArm.expectedHead}`);
        }
      }
    }
    if (problems.length === 0) verified.push(label);
  }
  if (problems.length > 0) {
    throw new Error(`run-manifest identity verification failed for ${JSON.stringify(runId)} (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`
      + problems.map((p) => `  - ${p}`).join('\n')
      + '\n[nextAction: point --run-id/--pa-run-id at a run produced by the SAME config (configSha256/dataset/arms must match), or re-run the experiment]');
  }
  return { ok: true, verified, problems: [] };
}

// ---------------------------------------------------------------------------
// Generic preflight (TECH §7 — the checks that live OUTSIDE the loader)
// ---------------------------------------------------------------------------

/**
 * Generic preflight checks over an installed config (TECH §7). The loader
 * already owns: schema, forbidden roots, arm-worktree containment, dataset/
 * snapshot/blob digests, workspaceFiles source digests + target fencing,
 * feature-flag registration, preregistration binding + experimentId. THIS
 * function owns the remaining generic checks and must run before ANY side
 * effect (ab-preflight reports it; ab-run RE-RUNS it before the first run
 * record write / child process — CF-16):
 *
 *   1. physical isolation of the experiment workspace tree (+ env pointers);
 *   2. every arm's actual `git rev-parse HEAD` == expectedHead (CF-04);
 *   3. `packages/pd-cli/dist/index.js` exists in every arm worktree;
 *   4. every modelEnv variable EXISTS in the environment (presence only —
 *      values are never read or recorded);
 *   5. the two arms' derived configs differ only at declared keys (CF-07);
 *   6. baseline/candidate identity + preregistration digests re-asserted
 *      from the loaded verification block (the loader's own results).
 *
 * Returns { ok, checks: [{name, ok, detail}], experimentId, configSha256 }.
 */
export function preflightChecks() {
  const cfg = currentConfig();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // 1. isolation + env pointer hygiene.
  const iso = preflightIsolation();
  add('isolation-containment+env', iso.ok, iso);

  // 2/3. per-arm HEAD + dist readiness.
  for (const armId of configArms()) {
    const arm = cfg.arms[armId];
    let head = null;
    let headErr = null;
    try { head = gitHead(arm.worktree); } catch (err) { headErr = String(err?.message ?? err).slice(0, 200); }
    add(`arm-head-matches-expected:${armId}`, headErr === null && head === arm.expectedHead.toLowerCase(),
      headErr === null ? { head, expected: arm.expectedHead } : { error: headErr });
    const cli = path.join(arm.worktree, 'packages/pd-cli/dist/index.js');
    add(`pd-cli-dist-exists:${armId}`, fs.existsSync(cli), { cli });
  }

  // 4. modelEnv presence (names only — never values).
  const missingEnv = cfg.modelEnv.filter((name) => process.env[name] === undefined || process.env[name] === '');
  add('model-env-present', missingEnv.length === 0, { modelEnv: cfg.modelEnv, missing: missingEnv, valuesRecorded: false });

  // 5. two-arm derived-config structured diff (CF-07).
  {
    let diffDetail = null;
    let diffOk = false;
    try {
      const a = deriveExperimentConfigObject(armWorkspaceDir(cfg.baselineArm), cfg.baselineArm);
      const b = deriveExperimentConfigObject(armWorkspaceDir(cfg.candidateArm), cfg.candidateArm);
      const diff = diffArmConfigs(a, b);
      diffOk = diff.ok;
      diffDetail = { differences: diff.differences, undeclared: diff.undeclared };
    } catch (err) {
      diffDetail = { error: String(err?.message ?? err).slice(0, 300) };
    }
    add('derived-config-declared-diff-only', diffOk, diffDetail);
  }

  // 6. loader-verified facts re-asserted (identity/digest authority).
  add('baseline-candidate-identity', cfg.baselineArm !== cfg.candidateArm && Object.hasOwn(cfg.arms, cfg.baselineArm) && Object.hasOwn(cfg.arms, cfg.candidateArm),
    { baselineArm: cfg.baselineArm, candidateArm: cfg.candidateArm });
  add('preregistration-binding', cfg.verification.preregistrationStatus === 'VERIFIED' || cfg.verification.preregistrationStatus === 'NOT_APPLICABLE_LEGACY',
    { status: cfg.verification.preregistrationStatus, preregistrationSha256: cfg.verification.preregistrationSha256, configSha256: cfg.verification.configSha256 });
  add('dataset-snapshot-digests', cfg.verification.datasetSha256Verified === true && cfg.verification.snapshotVerified?.state === true && cfg.verification.snapshotVerified?.trajectory === true && cfg.verification.snapshotVerified?.blobManifest === true,
    { dataset: cfg.dataset.sha256, snapshot: cfg.snapshot.sha256, blobsVerified: cfg.verification.snapshotVerified?.blobsVerified ?? null });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    experimentId: cfg.experimentId,
    configSha256: cfg.verification.configSha256,
    preregistrationStatus: cfg.verification.preregistrationStatus,
    preregistrationSha256: cfg.verification.preregistrationSha256,
    legacyBatch: cfg.legacy?.batch ?? null,
  };
}
