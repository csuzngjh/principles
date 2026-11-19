/**
 * PD-SPEC-001 round 2 — blind packager for the PAIRED Dreamer experiment
 * (Experiment A records from ab-dreamer-paired.mjs).
 *
 * Mirrors ab-blindpack.mjs's package contract exactly (same package fields,
 * same scrubbing, same randomized A/B flip, same leak self-check) but pairs
 * the PAIRED run's records:
 *   <SID>.r<rep>.<v2c>.json / <SID>.r<rep>.<v21>.json
 * Stages: dreamer / philosopher / scribe (the paired experiment's formation
 * stages; source='paired'). Both arms' clone records must be VERIFIED done
 * for a (sid, rep) pair to be packaged; a one-sided record is reported in
 * `missing`, never silently dropped.
 *
 * The upstream predecessorOutput is BYTE-IDENTICAL across arms by
 * construction (cloned post-diagnosis state) — this is the round-2 pairing
 * guarantee the full-chain pack cannot make; the blind map records the
 * upstream artifacts digest per pair for the report.
 *
 * Usage: node ab-blindpack-paired.mjs --run-id <pairedRunId>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  bootstrapConfigContext, experimentRoot, loadDataset, baselineArmId, candidateArmId,
  validateRunId, assertRunManifestIdentity, currentConfig,
} from './ab-lib.mjs';
import {
  buildSampleMeta, collectStageArtifacts, makePrng, assertFullFidelityDataset,
} from './ab-blindpack.mjs';

const PAIRED_STAGES = ['dreamer', 'philosopher', 'scribe'];

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Same shape as ab-blindpack's private primaryOutput(). */
function primaryOutput(stage, collection) {
  if (collection.attempts.length === 1) return collection.attempts[0].content;
  return JSON.stringify({
    stage,
    artifactCount: collection.attempts.length,
    candidateTotal: collection.candidateTotal || undefined,
    artifacts: collection.attempts.map((a) => ({ index: a.index, artifactId: a.artifactId, candidateCount: a.candidateCount, content: a.content })),
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--run-id') out.runId = argv[++i];
    else if (argv[i] === '--config') { ++i; /* consumed by bootstrapConfigContext */ }
    else throw new Error(`unknown arg: ${argv[i]}`);
  }
  if (!out.runId) throw new Error('--run-id is required');
  return out;
}

bootstrapConfigContext(process.argv, 'usage: node ab-blindpack-paired.mjs --config <experiment-config.json> --run-id <pairedRunId>');
const args = parseArgs(process.argv);
// Arm pair + roles from the config — the historical v2c/v21 vocabulary is
// gone; the record filename grammar uses the configured arm ids.
const BASE_ARM = baselineArmId();
const CAND_ARM = candidateArmId();
const PAIRED_FILE_RE = new RegExp(`^([^.]+)[.]r([0-9]+)[.](${[BASE_ARM, CAND_ARM].join('|')})[.]json$`);
const recordsDir = path.join(validateRunId(args.runId), 'records'); // runId fence
// PRI-1254 r2 (review P2-07): the paired run's manifests must prove the SAME
// config identity before any record is read into a blind pack.
assertRunManifestIdentity(currentConfig(), args.runId);
if (!fs.existsSync(recordsDir)) throw new Error(`no records dir for run ${args.runId}`);
const dataset = loadDataset();
assertFullFidelityDataset(dataset);
const byPain = new Map(dataset.samples.map((s) => [s.experimentPainId, s]));

// Parse paired records.
const index = new Map(); // `${sid}|${rep}|${arm}` -> rec
const parseFailures = [];
for (const f of fs.readdirSync(recordsDir)) {
  const m = PAIRED_FILE_RE.exec(f);
  if (!m) continue;
  const [, sid, rep, arm] = m;
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(recordsDir, f), 'utf8')); } catch (e) {
    parseFailures.push({ file: f, reason: String(e?.message ?? e).slice(0, 200) });
    continue;
  }
  index.set(`${sid}|${rep}|${arm}`, rec);
}

const keys = new Set([...index.keys()].map((k) => k.split('|').slice(0, 2).join('|')));
const rand = makePrng('paired-' + args.runId);
const packages = [];
const blindMap = {};
const missing = [];
const warnings = [];

for (const key of [...keys].sort()) {
  const [sid, repStr] = key.split('|');
  const rep = Number(repStr);
  const recC = index.get(`${sid}|${rep}|${BASE_ARM}`);
  const recT = index.get(`${sid}|${rep}|${CAND_ARM}`);
  if (!recC || !recT) {
    missing.push({ sid, rep, missingArm: !recC && !recT ? 'both' : (!recC ? BASE_ARM : CAND_ARM) });
    continue;
  }
  const doneOk = (r) => r?.status === 'done' && r?.verification?.ok === true;
  if (!doneOk(recC) || !doneOk(recT)) {
    missing.push({ sid, rep, missingArm: !doneOk(recC) && !doneOk(recT) ? 'both-unverified' : (!doneOk(recC) ? `${BASE_ARM}-unverified` : `${CAND_ARM}-unverified`) });
    continue;
  }
  if (recC.upstreamArtifactsSha !== recT.upstreamArtifactsSha) {
    warnings.push(`${sid} rep${rep}: upstream artifacts digest differs across arms — pairing broken, package skipped`);
    continue;
  }
  for (const stage of PAIRED_STAGES) {
    const colC = collectStageArtifacts(recC, stage);
    const colT = collectStageArtifacts(recT, stage);
    if (colC.attempts.length === 0 && colT.attempts.length === 0) continue; // stage absent in both (e.g. no scribe for this chain set)
    if (colC.attempts.length === 0 || colT.attempts.length === 0) {
      missing.push({ sid, rep, stage, missingArm: colC.attempts.length === 0 ? BASE_ARM : CAND_ARM, reason: 'stage-artifacts-missing' });
      continue;
    }
    const meta = buildSampleMeta(byPain.get(sid));
    if (!meta) { warnings.push(`no dataset sample for ${sid} — pair skipped (${stage}/rep${rep})`); continue; }
    const outC = primaryOutput(stage, colC);
    const outT = primaryOutput(stage, colT);
    const flip = rand() < 0.5;
    const pkgId = sha256Hex(JSON.stringify({ stage, sid, rep, source: 'paired', outC: sha256Hex(outC), outT: sha256Hex(outT) })).slice(0, 16);
    packages.push({
      evalId: pkgId,
      stage,
      source: 'paired',
      sid,
      rep,
      sample: meta,
      outputA: flip ? outT : outC,
      outputB: flip ? outC : outT,
      attemptsA: flip ? colT.attempts : colC.attempts,
      attemptsB: flip ? colC.attempts : colT.attempts,
      completeness: {
        A: flip ? { artifactCount: colT.attempts.length, candidateCount: colT.candidateTotal, complete: colT.complete } : { artifactCount: colC.attempts.length, candidateCount: colC.candidateTotal, complete: colC.complete },
        B: flip ? { artifactCount: colC.attempts.length, candidateCount: colC.candidateTotal, complete: colC.complete } : { artifactCount: colT.attempts.length, candidateCount: colT.candidateTotal, complete: colT.complete },
      },
    });
    blindMap[pkgId] = { armA: flip ? CAND_ARM : BASE_ARM, armB: flip ? BASE_ARM : CAND_ARM, stage, sid, rep, source: 'paired', upstreamArtifactsSha: recC.upstreamArtifactsSha };
  }
}

// Leak self-check over the whole pack (same hardening as round 1).
const { findBlindViolations } = await import('./ab-blindpack.mjs');
let leakFailures = 0;
for (const p of packages) {
  const v = findBlindViolations({ ...p, outputA: JSON.parse(p.outputA), outputB: JSON.parse(p.outputB) }, p.evalId);
  if (v.length) { leakFailures += 1; warnings.push(`${p.evalId}: leak tokens survived scrub: ${v.slice(0, 3).map((x) => x.reason).join(', ')}`); }
}
if (leakFailures > 0) {
  console.error(`FAIL: ${leakFailures} packages carry group-revealing material — pack NOT written`);
  process.exit(1);
}

const outDir = path.join(validateRunId(args.runId));
fs.mkdirSync(path.join(outDir, 'blindpack'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'blindpack', 'packages.json'), JSON.stringify({
  runId: args.runId,
  experiment: 'paired Dreamer A/B (config arms)',
  roles: { baseline: BASE_ARM, candidate: CAND_ARM },
  generatedAt: new Date().toISOString(),
  count: packages.length,
  byStage: packages.reduce((acc, p) => { acc[p.stage] = (acc[p.stage] ?? 0) + 1; return acc; }, {}),
  missing,
  parseFailures,
  packages,
}, null, 1) + '\n');
fs.writeFileSync(path.join(outDir, 'blindpack', 'blindmap.json'), JSON.stringify({
  runId: args.runId,
  generatedAt: new Date().toISOString(),
  map: blindMap,
  missing,
  warnings,
}, null, 1) + '\n');

console.log(`packaged: ${packages.length} packages (${JSON.stringify(packages.reduce((a, p) => { a[p.stage] = (a[p.stage] ?? 0) + 1; return a; }, {}))}), missing: ${missing.length}, warnings: ${warnings.length}`);
console.log('->', path.join(outDir, 'blindpack'));
