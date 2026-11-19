#!/usr/bin/env node
/**
 * PD-SPEC-001 round 2 - Owner spot-check list generator (SPEC section 8
 * layer 4: Owner manually reviews at least 20% of the blind packages).
 *
 * Deterministically selects ceil(20%) of packages across the round-2 blind
 * packs (paired + full-chain), sorted by evalId. The Owner-facing list is
 * blind (no arm mapping). The answer key (evalId -> arm mapping) is written
 * to a separate gitignored file and is unblinded only after the Owner's
 * scores are recorded.
 *
 * Usage:
 *   node owner-spotcheck-list.mjs --out <dir> [--runs paired-2,grid-3]
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootstrapConfigContext, experimentRoot, validateRunId, assertRunManifestIdentity, currentConfig } from '../ab/ab-lib.mjs';

function parseArgs(argv) {
  const out = { fraction: 0.2 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--runs') out.runs = argv[++i].split(',');
    else if (argv[i] === '--fraction') out.fraction = Number(argv[++i]);
    else if (argv[i] === '--config') { ++i; /* consumed by bootstrapConfigContext */ }
    else throw new Error(`unknown arg: ${argv[i]}`);
  }
  if (!out.runs) { console.error('--runs is required (no default since T3b — historical defaults hid the actual runs)'); process.exit(2); }
  if (!out.out) out.out = path.join(experimentRoot(), 'spotcheck');
  return out;
}

const args = (() => {
  bootstrapConfigContext(process.argv.slice(2), 'usage: node owner-spotcheck-list.mjs --config <experiment-config.json> --runs <runId,runId> [--fraction 0.2] [--out <dir>]');
  const parsed = parseArgs(process.argv);
  // PRI-1254 r2 (review P1-01): every requested run is validated BEFORE any
  // read (multi-run input → per-run validation), and each run's manifests
  // must prove the same config identity (P2-07).
  for (const runId of parsed.runs) {
    validateRunId(runId);
    assertRunManifestIdentity(currentConfig(), runId);
  }
  return parsed;
})();
const entries = [];
for (const runId of args.runs) {
  const packPath = path.join(validateRunId(runId), 'blindpack', 'packages.json');
  if (!fs.existsSync(packPath)) {
    console.error(`skip ${runId}: no blindpack yet`);
    continue;
  }
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  for (const p of pack.packages ?? []) {
    entries.push({ runId, evalId: p.evalId, stage: p.stage, sid: p.sid, rep: p.rep, source: p.source });
  }
}
entries.sort((a, b) => (a.evalId < b.evalId ? -1 : a.evalId > b.evalId ? 1 : 0));
const target = Math.ceil(entries.length * args.fraction);
const selected = [];
for (let i = 0; i < entries.length && selected.length < target; i += Math.max(1, Math.floor(entries.length / target))) {
  selected.push(entries[i]);
}

const lines = [];
lines.push('# PD-SPEC-001 round 2 - Owner spot-check list (blind)');
lines.push('');
lines.push(`Selected ${selected.length} of ${entries.length} packages (>= 20%). Each package below lives at:`);
lines.push('');
lines.push('```');
lines.push('.tmp/prompt-v2-ab/runs/<runId>/blindpack/packages.json  (keyed by evalId)');
lines.push('```');
lines.push('');
lines.push('Review instructions: read the package (pain report + Output-A / Output-B),');
lines.push('score it with the corresponding stage rubric, and record which output');
lines.push('(A or B) you prefer. Do NOT open blindmap.json (answer key) before scoring.');
lines.push('');
lines.push('| # | run | evalId | stage | sample | rep |');
lines.push('|---|-----|--------|-------|--------|-----|');
for (const [i, e] of selected.entries()) {
  lines.push(`| ${i + 1} | ${e.runId} | ${e.evalId} | ${e.stage} | ${e.sid} | ${e.rep} |`);
}
lines.push('');
fs.mkdirSync(args.out, { recursive: true });
fs.writeFileSync(path.join(args.out, 'OWNER_SPOTCHECK_LIST.md'), lines.join('\n') + '\n');
// Answer key stays OUT of the blind list (unblinded only after scoring).
fs.writeFileSync(path.join(args.out, 'owner-spotcheck-answer-key.local.json'), JSON.stringify({
  note: 'gitignored - unblind only after the Owner scores are recorded',
  selected,
}, null, 1) + '\n');

console.log(`selected ${selected.length}/${entries.length} packages -> ${args.out}`);
