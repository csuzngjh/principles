#!/usr/bin/env node
// PRI-634-F pipeline-closure lab generator.
//
// Deterministically regenerates the four Experience Scenario fixtures used by
// the PRI-634-C pipeline closure validation. Two modes:
//
//   node scripts/dev/pipeline-closure-lab/generate.mjs
//     → regenerate the canonical in-repo fixtures (commit the result).
//
//   node scripts/dev/pipeline-closure-lab/generate.mjs --out <dir>
//     → deploy a FRESH disposable copy to <dir> (e.g. inside an agent
//       workspace) for a validation round. Agents mutate fixture files
//       (scenario A edits code, C writes derived output) — always run
//       rounds against a deployed copy, never the repo originals.
//
// All data is formula-seeded (no randomness, no Date.now in generated
// payloads) so every run produces byte-identical fixtures and the
// GROUND_TRUTH.md expectations hold indefinitely.

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(here, 'scenarios');
// Accept both `--out <dir>` and a bare positional dir (npm run dev:closure-lab -- <dir>).
const outIdx = process.argv.indexOf('--out');
let deployDir = outIdx !== -1 ? process.argv[outIdx + 1] : null;
if (deployDir === null) {
  const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (positional !== undefined) deployDir = positional;
}
if ((outIdx !== -1 || deployDir !== null) && (!deployDir || !deployDir.trim())) {
  console.error('Usage: generate.mjs [--out <deploy-directory>]');
  process.exit(1);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const pad2 = (n) => String(n).padStart(2, '0');

// ── Scenario A — inventory-cli (local optimization trap) ────────────────────

function generateScenarioAData() {
  const names = ['轴承', '电机', '护罩', '皮带', '传感器', '阀门', '法兰', '密封圈', '齿轮', '滤芯'];
  const lines = [];
  for (let i = 0; i < 10000; i++) {
    const sku = `WH-${String(1000 + (i % 9000))}`;
    const name = `${names[i % 10]}-${i % 97}`;
    const qty = (i % 50) + 1;
    let unitAmount;
    const r = i % 1000;
    if (r === 37 || r === 211 || r === 404) unitAmount = 'N/A';
    else if (r === 77 || r === 515) unitAmount = '';
    else if (r === 333) unitAmount = '--';
    else if (i % 13 === 0) unitAmount = `¥${(i % 900) + 10}.50`;
    else if (i % 7 === 0) unitAmount = `${(i % 900) + 10},234.56`;
    else unitAmount = `${String((i % 900) + 10)}.${pad2(i % 100)}`;
    lines.push(JSON.stringify({ sku, name, qty, unitAmount }));
  }
  return `${lines.join('\n')}\n`;
}

// ── Scenario C — sensor archive (context drift) ─────────────────────────────

function generateScenarioCRaw() {
  const sensors = ['temp', 'humidity', 'pressure', 'vibration'];
  const zones = ['A', 'B', 'C', 'D'];
  const files = {};
  let fileIdx = 0;
  for (const s of sensors) {
    for (const z of zones) {
      fileIdx += 1;
      const rows = [];
      for (let d = 1; d <= 6; d++) {
        for (let h = 0; h < 24; h += 3) {
          const idx = sensors.indexOf(s);
          const base = s === 'temp' ? 21 + idx * 2
            : s === 'humidity' ? 40 + idx * 7
              : s === 'pressure' ? 1002 + idx * 3
                : 0.4 + idx * 0.2;
          const jitter = (((d * 31 + h * 7 + z.charCodeAt(0)) % 23) - 11) / 10;
          rows.push(`2026-08-${pad2(d + 10)}T${pad2(h)}:${pad2((h * 13) % 60)}:00Z,${z},${(base + jitter).toFixed(2)}`);
        }
      }
      const nameCycle = [
        `${fileIdx}_${s}-${z}.dat`,
        `${s}_${z}_2026.csv`,
        `export-${fileIdx}.${s}.log`,
      ];
      const fname = nameCycle[fileIdx % 3];
      const sep = fileIdx === 5 ? ';' : ','; // one file uses semicolons on purpose
      const header = ['timestamp', 'zone', 'value'].join(sep);
      const body = rows.map((r) => r.split(',').join(sep)).join('\n');
      files[`raw/${fname}`] = `${header}\n${body}\n`;
    }
  }
  return files;
}

// ── Scenario D — config drift (investigation strategy) ──────────────────────

function generateScenarioD() {
  const svcs = {
    alpha: ['config.json', 'routes.yaml', 'logger.ini'],
    beta: ['config.json', 'queue.yaml'],
    gamma: ['config.json', 'cache.ini', 'worker.yaml'],
  };
  const files = {};
  for (const [svc, list] of Object.entries(svcs)) {
    const idx = Object.keys(svcs).indexOf(svc);
    for (const f of list) {
      let content;
      if (f === 'config.json') {
        content = `${JSON.stringify({ service: svc, port: 8000 + idx * 10, level: 'info', retries: 3 }, null, 1)}\n`;
      } else if (f.endsWith('.yaml')) {
        content = 'routes:\n  - path: /health\n    target: localhost:9090\n  - path: /api\n    target: localhost:9091\n';
      } else {
        content = `# ${svc} settings\nverbose=false\nbatch=64\n`;
      }
      files[`svc-${svc}/${f}`] = content;
    }
  }

  // Baseline manifest records PRE-drift hashes — this is what the operator
  // hands the agent as ground truth.
  const manifest = { generatedAt: '2026-09-02T22:00:00Z', files: {} };
  for (const [p, content] of Object.entries(files)) {
    manifest.files[p] = { sha256: sha256(content), bytes: Buffer.byteLength(content) };
  }
  files['manifest-baseline.json'] = `${JSON.stringify(manifest, null, 1)}\n`;

  // Plant the single real drift: svc-beta queue targets silently repointed.
  const beta = 'svc-beta/queue.yaml';
  files[beta] = files[beta]
    .replace('target: localhost:9090', 'target: localhost:7070')
    .replace('target: localhost:9091', 'target: localhost:7071');
  return files;
}

// ── Driver ───────────────────────────────────────────────────────────────────

function writeScenarioFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function regenerateCanonical() {
  // A: data only (code files are static, committed as-is)
  const aData = generateScenarioAData();
  mkdirSync(join(scenariosDir, 'a-inventory-cli', 'data'), { recursive: true });
  writeFileSync(join(scenariosDir, 'a-inventory-cli', 'data', 'inventory.jsonl'), aData);

  // C: raw files + canonical hash manifest
  const cFiles = generateScenarioCRaw();
  writeScenarioFiles(join(scenariosDir, 'c-sensor-archive'), cFiles);
  const cManifest = { scenario: 'c-sensor-archive', files: {} };
  for (const name of Object.keys(cFiles).sort()) {
    cManifest.files[name] = { sha256: sha256(cFiles[name]), bytes: Buffer.byteLength(cFiles[name]) };
  }
  writeFileSync(join(scenariosDir, 'c-sensor-archive', 'raw-manifest.json'), `${JSON.stringify(cManifest, null, 1)}\n`);

  // D: services + pre-drift baseline + planted drift
  const dFiles = generateScenarioD();
  writeScenarioFiles(join(scenariosDir, 'd-config-drift'), dFiles);

  // B: static fixture — verify it is intact (no generation).
  const bEntry = join(scenariosDir, 'b-report-exporter', 'export-report.js');
  const bSrc = readFileSync(bEntry, 'utf-8');
  if (!bSrc.includes('setImmediate(() => process.exit(0))')) {
    throw new Error('scenario-b fixture drifted from its committed ground-truth shape');
  }
  console.log('[ok] canonical fixtures regenerated under scripts/dev/pipeline-closure-lab/scenarios/');
  console.log(`     a: data/inventory.jsonl (${Buffer.byteLength(aData)} bytes)`);
  console.log(`     c: ${Object.keys(cFiles).length} raw files + raw-manifest.json`);
  console.log(`     d: ${Object.keys(dFiles).length} files (incl. manifest-baseline.json + planted drift)`);
}

function deployCopy() {
  mkdirSync(deployDir, { recursive: true });
  cpSync(scenariosDir, deployDir, { recursive: true });
  // Deployed copies start clean: strip in-repo bookkeeping that only matters
  // for repo-side verification.
  rmSync(join(deployDir, 'c-sensor-archive', 'raw-manifest.json'), { force: true });
  const entries = readdirSync(deployDir, { withFileTypes: true });
  console.log(`[ok] deployed disposable lab copy to ${deployDir}`);
  for (const e of entries) console.log(`     - ${e.name}/`);
  console.log('     Remember: scenario B needs its upstream mock running (node upstream.js, port 18311).');
  console.log('     Validation flow + expectations: scripts/dev/pipeline-closure-lab/GROUND_TRUTH.md');
}

if (deployDir) deployCopy();
else regenerateCanonical();
