/**
 * PD-SPEC-001 grid launcher — remediated (Owner §7.4); config-driven since
 * PD-Lab v0.3 T3b (PRI-1254).
 *
 * - Shards are ISOLATED: each shard runs ab-run with its own --shard-id (and
 *   the SAME --config), so every shard gets its own per-arm workspaces/
 *   databases/output namespace.
 * - Arms come from the experiment config (baseline/candidate); --arms has NO
 *   default and, when passed, must be exactly the configured pair.
 * - Failure propagation: each shard's exit code is recorded; if ANY required
 *   shard fails, the launcher exits non-zero.
 * - --simulate-failure <shardIndex>: Gate-0 hook that forces one shard to
 *   exit non-zero to prove propagation (never used for real runs).
 *
 * Usage:
 *   node ab-grid.mjs --config <experiment-config.json> --run-id <id> [--parallel 6] [--arms <a>,<b>] [--simulate-failure <index>]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bootstrapConfigContext, loadDataset, experimentRoot, gitHead, armWorktree,
  currentConfig, configArms, validateRunId, preflightChecks,
} from './ab-lib.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

const argv = process.argv.slice(2);
const USAGE = 'usage: node ab-grid.mjs --config <experiment-config.json> --run-id <id> [--parallel 1..8] [--arms <armA>,<armB>] [--simulate-failure <index>] [--reps N] [--formation-depth N]';
// PRI-1254 r2 (review 0001 / P1-04): keep the config OBJECT (validated, for
// this parent process) strictly apart from the config FILE PATH (the
// normalized string every shard child receives via --config). The previous
// code assigned the object to `configFile` and spawned children with
// `--config [object Object]` — every shard failed config loading.
const configArgIndex = argv.indexOf('--config');
bootstrapConfigContext(argv, USAGE); // required --config (exit 2) + load + install
const configFile = path.resolve(argv[configArgIndex + 1]);
const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const runId = getOpt('--run-id', null);
const parallel = Number(getOpt('--parallel', 6));
const armsOpt = getOpt('--arms', null);
const simulateFailureIndex = getOpt('--simulate-failure', null);
const repsOpt = getOpt('--reps', null);
const formationDepthOpt = getOpt('--formation-depth', null);
if (!runId) throw new Error('--run-id required');
if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('--parallel must be 1..8');
// Budget flags are forwarded verbatim to every shard child (PRI-1284 —
// the shard launcher used to drop them, so lab:run silently reverted to
// dataset reps and unbounded formation depth). Validate them HERE, before
// any side effect, with the same positive-integer contract ab-run enforces.
const positiveIntOpt = (flag, raw) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer — got ${JSON.stringify(raw)}`);
  return n;
};
const reps = repsOpt === null ? null : positiveIntOpt('--reps', repsOpt);
const formationDepth = formationDepthOpt === null ? null : positiveIntOpt('--formation-depth', formationDepthOpt);

// Arms: config pair by default; --arms must be exactly that pair (any order).
const configuredArms = configArms();
const arms = armsOpt ? armsOpt.split(',') : configuredArms;
if (armsOpt && ([...arms].sort().join(',') !== [...configuredArms].sort().join(',') || arms.length !== 2)) {
  throw new Error(`--arms must be exactly the configured arm pair (${configuredArms.join(',')} in any order) — got ${armsOpt}`);
}

// PRI-1254 r2 (review 0005 / P1-03): lab:run's REAL entry is ab-grid — the
// FULL generic preflight must pass BEFORE any side effect (run directory,
// grid manifest, shard children). ab-run keeps its own preflight: the two
// layers are independent defenses (TECH §7 — never reuse a stale preflight).
const preflight = preflightChecks();
if (!preflight.ok) {
  console.error('grid preflight failed BEFORE any side effect:');
  for (const c of preflight.checks.filter((x) => !x.ok)) console.error(`  - ${c.name}: ${JSON.stringify(c.detail).slice(0, 400)}`);
  process.exit(1);
}
const dataset = loadDataset();
const ids = dataset.samples.map((s) => s.experimentPainId);
const shards = [];
const per = Math.ceil(ids.length / parallel);
for (let i = 0; i < ids.length; i += per) shards.push(ids.slice(i, i + per));

const runDirPath = validateRunId(runId); // TECH §4.5 runId checks BEFORE mkdir
fs.mkdirSync(runDirPath, { recursive: true });
const cfg = currentConfig();
const gridManifest = {
  runId, parallel: shards.length, arms,
  roles: { baseline: cfg.baselineArm, candidate: cfg.candidateArm },
  experimentId: cfg.experimentId,
  configSha256: cfg.verification.configSha256,
  preregistrationStatus: cfg.verification.preregistrationStatus,
  preregistrationSha256: cfg.verification.preregistrationSha256,
  datasetSha256: cfg.dataset.sha256,
  snapshot: { dir: cfg.snapshot.dir, sha256: cfg.snapshot.sha256 },
  simulateFailure: simulateFailureIndex === null ? null : Number(simulateFailureIndex),
  armsHeads: Object.fromEntries(configuredArms.map((armId) => [armId, gitHead(armWorktree(armId))])),
  shards: shards.map((s, i) => ({ index: i, samples: s, exitCode: null })),
  startedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(runDirPath, `grid-manifest.json`), JSON.stringify(gridManifest, null, 2) + '\n', 'utf8');
console.log(`run=${runId} parallel=${shards.length} shards=${JSON.stringify(shards.map((_, i) => i))}`);

const children = shards.map((shard, i) => new Promise((resolve) => {
  // Forward --config AND --arms explicitly: the child must run the SAME
  // experiment identity and the SAME arm pair as this launcher.
  const childArgs = [
    path.join(here, 'ab-run.mjs'),
    '--config', configFile,
    '--run-id', runId,
    '--samples', shard.join(','),
    '--shard-id', String(i),
    '--arms', arms.join(','),
  ];
  // Forward the budget flags verbatim: without this the shard silently ran
  // with dataset repeatRunPicks and unbounded formation depth (PRI-1284).
  if (reps !== null) childArgs.push('--reps', String(reps));
  if (formationDepth !== null) childArgs.push('--formation-depth', String(formationDepth));
  if (simulateFailureIndex !== null && Number(simulateFailureIndex) === i) {
    // Deliberate failure hook (Gate 0): exit non-zero without side effects.
    resolve({ index: i, code: 42, simulated: true });
    return;
  }
  const child = spawn(process.execPath, childArgs, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`[shard${i}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[shard${i}!] ${d}`));
  child.on('close', (code) => resolve({ index: i, code }));
}));

(async () => {
  const results = await Promise.all(children);
  for (const r of results) gridManifest.shards[r.index].exitCode = r.code;
  gridManifest.finishedAt = new Date().toISOString();
  const failedShards = results.filter((r) => r.code !== 0);
  gridManifest.ok = failedShards.length === 0;
  fs.writeFileSync(path.join(runDirPath, 'grid-manifest.json'), JSON.stringify(gridManifest, null, 2) + '\n', 'utf8');
  console.log('grid complete:', JSON.stringify(results.map((r) => ({ shard: r.index, code: r.code }))));
  if (failedShards.length > 0) {
    console.error(`GRID FAILED: ${failedShards.length}/${results.length} shard(s) non-zero — see grid-manifest.json`);
    process.exit(1);
  }
  console.log('GRID OK');
})();
