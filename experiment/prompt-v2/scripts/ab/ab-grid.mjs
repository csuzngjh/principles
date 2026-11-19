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
  currentConfig, configArms, validateRunId,
} from './ab-lib.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

const argv = process.argv.slice(2);
const USAGE = 'usage: node ab-grid.mjs --config <experiment-config.json> --run-id <id> [--parallel 1..8] [--arms <armA>,<armB>] [--simulate-failure <index>]';
const configFile = bootstrapConfigContext(argv, USAGE);
const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const runId = getOpt('--run-id', null);
const parallel = Number(getOpt('--parallel', 6));
const armsOpt = getOpt('--arms', null);
const simulateFailureIndex = getOpt('--simulate-failure', null);
if (!runId) throw new Error('--run-id required');
if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('--parallel must be 1..8');

// Arms: config pair by default; --arms must be exactly that pair (any order).
const configuredArms = configArms();
const arms = armsOpt ? armsOpt.split(',') : configuredArms;
if (armsOpt && ([...arms].sort().join(',') !== [...configuredArms].sort().join(',') || arms.length !== 2)) {
  throw new Error(`--arms must be exactly the configured arm pair (${configuredArms.join(',')} in any order) — got ${armsOpt}`);
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
