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
 * - Each arm gets its OWN experiment workspace: fresh state.db (diagnosis
 *   tasks seeded from the frozen dataset's production rows), trajectory.db
 *   copied from the integrity-verified production snapshot, filtered config.
 * - Both arms share: frozen inputs, model profile (pi-ai.amd-ds-vision /
 *   GLM-5.3-Flash / maxTokens 16384), flags, validators, retry policy.
 * - Execution goes through the production CLI surface (`pd diagnose run`,
 *   `pd runtime internalization run-once`) so gates, committers, leases and
 *   repair loops are the real ones.
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
};

export const PRODUCTION_WORKSPACE = 'D:/.openclaw/workspace';
export const V1_BASE_COMMIT = '0485046e71d2aeba4769725adb4f2aac35a5dd9b';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXPERIMENT_ROOT = path.resolve(here, '..', '..', '..', '..', '.tmp', 'prompt-v2-ab');
export const SNAPSHOT_DIR = path.resolve(WORKTREES.v2, '.tmp/prompt-v2-inventory/snapshot');
/**
 * The committed dataset copy is FIELD-REDACTED for the PUBLIC repo (verbatim
 * pain text → sha256 placeholders, see scripts/redact-for-publication.mjs).
 * Execution and blind evaluation need the FULL-fidelity dataset, which lives
 * in .tmp (gitignored) next to the snapshot DBs; the committed freeze script
 * writes both copies, so the full one is locally regenerable at any time.
 */
const FULL_DATASET_FILE = path.resolve(WORKTREES.v2, '.tmp/prompt-v2-inventory/pain-dataset.full.json');
export const DATASET_FILE = fs.existsSync(FULL_DATASET_FILE)
  ? FULL_DATASET_FILE
  : path.resolve(WORKTREES.v2, 'experiment/prompt-v2/dataset/pain-dataset.json');

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

/** Refuse anything that could route a write into production state (SPEC §5.2/§5.3). */
export function preflightIsolation() {
  const failures = [];
  const prodPaths = [
    ['production workspace', PRODUCTION_WORKSPACE],
    ['production openclaw root', 'D:/.openclaw'],
    ['pd home', 'C:/Users/Administrator/.pd'],
    ['openclaw home', 'C:/Users/Administrator/.openclaw'],
    ['codex home', 'C:/Users/Administrator/.codex'],
    ['primary repo', 'D:/Code/principles'],
  ].map(([label, p]) => [label, canonical(p)]);

  const expCanonical = canonical(EXPERIMENT_ROOT);
  for (const [label, p] of prodPaths) {
    if (expCanonical === p || expCanonical.startsWith(p + path.sep) || expCanonical.startsWith(p + '/')) {
      failures.push(`experiment root resolves inside ${label}: ${EXPERIMENT_ROOT}`);
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

/** Clean env for child processes: strip every pointer the child must not inherit. */
export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of ['PD_WORKSPACE_DIR', 'OPENCLAW_WORKSPACE', 'OPENCLAW_WORKSPACE_DIR', 'PD_STATE_DIR', 'OPENCLAW_HOME']) {
    delete env[name];
  }
  return { ...env, ...extra };
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
 * - downstream observers not in the six-agent scope disabled.
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
  for (const agent of ['artificer', 'evaluator', 'rolloutReviewer', 'correctionObserver', 'signalCollector', 'empathyObserver']) {
    config = config.replace(new RegExp(`^(    ${agent}:\\r?\\n      enabled: )true`, 'm'), '$1false');
  }
  return `# PD-SPEC-001 experiment workspace — DERIVED from production config.\n# Dropped: ui, feedback (ingest token). Remapped: workspace.default. Disabled: non-six observers.\n` + config;
}

/**
 * Materialize an arm workspace: fresh .pd (state.db initialized by the
 * runtime on first use), trajectory.db copied from the snapshot, derived config.
 */
export function materializeWorkspace(arm, { force = false } = {}) {
  const worktree = WORKTREES[arm];
  if (!fs.existsSync(worktree)) throw new Error(`arm worktree missing: ${worktree}`);
  const ws = path.join(EXPERIMENT_ROOT, 'workspaces', arm);
  fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
  // Each artifact is created ONCE (subsequent processes skip). Creation goes
  // through a per-process temp file + atomic rename: concurrent shard
  // processes must never copy 43MB onto a destination another process's CLI
  // already has open (Windows sharing violation killed 4/6 shards once).
  const placeAtomic = (target, write) => {
    if (fs.existsSync(target) && !force) return 'reused';
    const tmp = `${target}.${process.pid}.tmp`;
    write(tmp);
    fs.renameSync(tmp, target); // same-volume rename: atomic; concurrent last-writer wins whole-file
    return 'created';
  };
  const trajState = placeAtomic(path.join(ws, '.state', 'trajectory.db'), (t) => fs.copyFileSync(path.join(SNAPSHOT_DIR, 'trajectory.db'), t));
  const cfgState = placeAtomic(path.join(ws, '.pd', 'config.yaml'), (t) => fs.writeFileSync(t, deriveExperimentConfig(ws), 'utf8'));
  return { workspace: ws, trajectory: trajState, config: cfgState };
}

/** Run a pd-cli command from an arm worktree against its experiment workspace. */
export function runPd(arm, args, { timeoutMs = 45 * 60_000 } = {}) {
  const worktree = WORKTREES[arm];
  const ws = path.join(EXPERIMENT_ROOT, 'workspaces', arm);
  const cli = path.join(worktree, 'packages/pd-cli/dist/index.js');
  if (!fs.existsSync(cli)) throw new Error(`pd-cli dist missing in ${arm} arm: ${cli}`);
  const env = childEnv({ PD_WORKSPACE_DIR: ws });
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

export function loadDataset() {
  return JSON.parse(fs.readFileSync(DATASET_FILE, 'utf8'));
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
export function armOrderFor(runId, sampleIndex) {
  const h = parseInt(sha256(runId).slice(0, 8), 16);
  const flip = (h + sampleIndex) % 2;
  return flip === 0 ? ['v1', 'v2'] : ['v2', 'v1'];
}
