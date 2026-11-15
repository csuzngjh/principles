/**
 * PD-SPEC-001 grid launcher — remediated (Owner §7.4).
 *
 * - Shards are ISOLATED: each shard runs ab-run with its own --shard-id, so
 *   every shard gets its own per-arm workspaces/databases/output namespace.
 * - Failure propagation: each shard's exit code is recorded; if ANY required
 *   shard fails, the launcher exits non-zero (a child failure can no longer
 *   hide behind a green launcher).
 * - --simulate-failure <shardIndex>: Gate-0 hook that forces one shard to
 *   exit non-zero to prove propagation (never used for real runs).
 *
 * Usage:
 *   node ab-grid.mjs --run-id <id> [--parallel 6] [--arms v1,v2] [--simulate-failure <index>]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDataset, EXPERIMENT_ROOT, gitHead, WORKTREES } from './ab-lib.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const runId = getOpt('--run-id', null);
const parallel = Number(getOpt('--parallel', 6));
const arms = (getOpt('--arms', 'v1,v2')).split(',');
const simulateFailureIndex = getOpt('--simulate-failure', null);
if (!runId) throw new Error('--run-id required');
if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('--parallel must be 1..8');

const dataset = loadDataset();
const ids = dataset.samples.map((s) => s.experimentPainId);
const shards = [];
const per = Math.ceil(ids.length / parallel);
for (let i = 0; i < ids.length; i += per) shards.push(ids.slice(i, i + per));

const runDir = path.join(EXPERIMENT_ROOT, 'runs', runId);
fs.mkdirSync(runDir, { recursive: true });
const gridManifest = {
  runId, parallel: shards.length, arms,
  simulateFailure: simulateFailureIndex === null ? null : Number(simulateFailureIndex),
  heads: { v1: gitHead(WORKTREES.v1), v2: gitHead(WORKTREES.v2) },
  shards: shards.map((s, i) => ({ index: i, samples: s, exitCode: null })),
  startedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(runDir, `grid-manifest.json`), JSON.stringify(gridManifest, null, 2) + '\n', 'utf8');
console.log(`run=${runId} parallel=${shards.length} shards=${JSON.stringify(shards.map((_, i) => i))}`);

const children = shards.map((shard, i) => new Promise((resolve) => {
  const childArgs = [path.join(here, 'ab-run.mjs'), '--run-id', runId, '--samples', shard.join(','), '--shard-id', String(i)];
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
  fs.writeFileSync(path.join(runDir, 'grid-manifest.json'), JSON.stringify(gridManifest, null, 2) + '\n', 'utf8');
  console.log('grid complete:', JSON.stringify(results.map((r) => ({ shard: r.index, code: r.code }))));
  if (failedShards.length > 0) {
    console.error(`GRID FAILED: ${failedShards.length}/${results.length} shard(s) non-zero — see grid-manifest.json`);
    process.exit(1);
  }
  console.log('GRID OK');
})();
