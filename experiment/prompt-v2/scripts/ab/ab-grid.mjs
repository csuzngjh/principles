/**
 * PD-SPEC-001 grid launcher — runs the full-chain A/B grid as N parallel
 * ab-run processes with disjoint sample shards (the AMD endpoint sustained
 * 3 concurrent realistic requests in preflight; sharding by sample keeps
 * records conflict-free; SQLite WAL absorbs cross-process writes).
 *
 * Usage: node ab-grid.mjs --run-id grid-1 [--parallel 4] [--samples-per-shard 4]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from './ab-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const runId = getOpt('--run-id', null);
const parallel = Number(getOpt('--parallel', 4));
if (!runId) throw new Error('--run-id required');

const dataset = loadDataset();
const ids = dataset.samples.map((s) => s.experimentPainId);
const shards = [];
const per = Math.ceil(ids.length / parallel);
for (let i = 0; i < ids.length; i += per) shards.push(ids.slice(i, i + per));
console.log(`run=${runId} parallel=${shards.length} shards=${JSON.stringify(shards)}`);

const children = shards.map((shard, i) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(here, 'ab-run.mjs'), '--run-id', runId, '--samples', shard.join(',')], {
    cwd: path.resolve(here, '..', '..', '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; process.stdout.write(`[shard${i}] ${d}`); });
  child.stderr.on('data', (d) => { out += d; process.stderr.write(`[shard${i}!] ${d}`); });
  child.on('close', (code) => resolve({ shard, code }));
}));

(async () => {
  const results = await Promise.all(children);
  console.log('grid complete:', JSON.stringify(results));
})();
