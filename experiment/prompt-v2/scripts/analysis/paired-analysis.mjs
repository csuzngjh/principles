#!/usr/bin/env node
/**
 * PD-SPEC-001 round 2 — Experiment A analysis aggregator.
 *
 * Combines per (sid, rep) pair across the two CONFIGURED arms (baseline vs
 *  - run records (candidate counts per chain, chain terminal states, needs_human_review)
 *  - main-rubric blind evals (dreamer/philosopher/scribe dims + pairwise)
 *  - diversity evals (8 observation metrics per arm)
 *  - lexical duplication proxy (same method as the round-1 audit)
 *  - downstream: philosopher survival heuristic + scribe presence
 *
 * Writes ONLY aggregates (no pain text) to
 * .tmp/prompt-v2-ab/analysis/paired-<runId>-analysis.json and prints them.
 *
 * Usage: node experiment/prompt-v2/scripts/analysis/paired-analysis.mjs --run-id paired-2
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootstrapConfigContext, experimentRoot, baselineArmId, candidateArmId, validateRunId, assertRunManifestIdentity, currentConfig } from '../ab/ab-lib.mjs';

bootstrapConfigContext(process.argv.slice(2), 'usage: node paired-analysis.mjs --config <experiment-config.json> --run-id <id>');
// Arms/roles from the config (historical v2c/v21 hardcoding removed; the
// record grammar uses the configured arm ids).
const ARM_C = baselineArmId();
const ARM_T = candidateArmId();
const PAIRED_FILE_RE = new RegExp(`^([^.]+)[.]r([0-9]+)[.](${[ARM_C, ARM_T].join('|')})[.]json$`);

function agg(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return { n: nums.length, mean: +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3), median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] };
}

function normalizeText(s) { return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function unitize(s) {
  const out = [];
  let word = '';
  for (const ch of s) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) { if (word) { for (const w of word.split(' ')) if (w) out.push(w); word = ''; } out.push(ch); }
    else if (/[a-z0-9_]+/i.test(ch)) word += ch;
    else { if (word) { for (const w of word.split(' ')) if (w) out.push(w); word = ''; } }
  }
  if (word) { for (const w of word.split(' ')) if (w) out.push(w); }
  return out;
}
function bigrams(units) { const set = new Set(); for (let i = 0; i + 1 < units.length; i++) set.add(units[i] + '\u0000' + units[i + 1]); if (units.length === 1) set.add(units[0]); return set; }
function jaccard(a, b) {
  const A = bigrams(unitize(normalizeText(a))); const B = bigrams(unitize(normalizeText(b)));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--run-id') out.runId = argv[++i];
    else if (argv[i] === '--config') { ++i; /* consumed by bootstrapConfigContext */ }
  else throw new Error('unknown arg ' + argv[i]);
  }
  if (!out.runId) throw new Error('--run-id required');
  return out;
}

const args = parseArgs(process.argv);
const runDir = validateRunId(args.runId); // runId fence BEFORE any read
// PRI-1254 r2 (review P2-07): the analyzed run must belong to the same
// config identity.
assertRunManifestIdentity(currentConfig(), args.runId);
const recordsDir = path.join(runDir, 'records');
const evalsDir = path.join(runDir, 'evals');
const divDir = path.join(runDir, 'diversity-evals');

// --- records ---
const pairs = new Map(); // `${sid}|${rep}` -> { [baselineArm], [candidateArm], upstream }
const upstream = {};
for (const f of fs.readdirSync(recordsDir)) {
  const p = PAIRED_FILE_RE.exec(f);
  if (p) {
    const [, sid, rep, arm] = p;
    const rec = JSON.parse(fs.readFileSync(path.join(recordsDir, f), 'utf8'));
    const k = `${sid}|${rep}`;
    pairs.set(k, pairs.get(k) ?? {});
    pairs.get(k)[arm] = rec;
    continue;
  }
  const upm = /^([^.]+)\.upstream\.json$/.exec(f);
  if (upm) upstream[upm[1]] = JSON.parse(fs.readFileSync(path.join(recordsDir, f), 'utf8'));
}

// --- evals ---
function loadEvals(dir, slotArmFrom) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.includes('summary')) continue;
    const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    out[e.evalId] = e;
  }
  return out;
}
const blindmap = fs.existsSync(path.join(runDir, 'blindpack', 'blindmap.json'))
  ? JSON.parse(fs.readFileSync(path.join(runDir, 'blindpack', 'blindmap.json'), 'utf8')).map
  : {};
const evals = loadEvals(evalsDir);
const divs = {};
const divDirUsed = fs.existsSync(divDir) ? divDir : (fs.existsSync(divDir.replace('diversity-evals', 'diversity-evals.paired')) ? divDir.replace('diversity-evals', 'diversity-evals.paired') : null);
if (divDirUsed) {
  for (const f of fs.readdirSync(divDirUsed)) {
    if (!f.endsWith('.json') || f.includes('summary')) continue;
    const e = JSON.parse(fs.readFileSync(path.join(divDirUsed, f), 'utf8'));
    divs[`${e.evalId}.${e.slot}`] = e;
  }
}

// --- aggregate ---
function dreamerDocs(rec, arm) {
  const docs = [];
  for (const a of rec?.artifacts?.formationArtifacts ?? []) {
    if (!a.source_task_id.startsWith('dreamer-')) continue;
    try {
      const parsed = JSON.parse(a.content_json);
      const doc = parsed?.output ?? parsed;
      if (Array.isArray(doc?.candidates)) docs.push({ taskId: a.source_task_id, candidates: doc.candidates });
    } catch { /* unparseable counted elsewhere */ }
  }
  return docs;
}

const perPair = [];
const armAgg = { [ARM_C]: { candidateCounts: [], chainCounts: [], needsReview: 0, dupMeans: [], dupMaxes: [], dreamerDims: {}, philosopherDims: {}, scribeDims: {}, divMetrics: {}, pairwise: { win: 0, lose: 0, tie: 0 } },
  [ARM_T]: { candidateCounts: [], chainCounts: [], needsReview: 0, dupMeans: [], dupMaxes: [], dreamerDims: {}, philosopherDims: {}, scribeDims: {}, divMetrics: {}, pairwise: { win: 0, lose: 0, tie: 0 } } };
const DIVERSITY_KEYS = ['candidateDiversity', 'semanticDuplication', 'evidenceFidelity', 'decisionActionability', 'strategicDistinctness', 'confidenceCalibration', 'riskCalibration', 'candidateCountAdequacy'];
for (const k of DIVERSITY_KEYS) { armAgg[ARM_C].divMetrics[k] = []; armAgg[ARM_T].divMetrics[k] = []; }

function addDims(store, verdictSlot) {
  if (!verdictSlot?.dimensionScores) return;
  for (const [dim, info] of Object.entries(verdictSlot.dimensionScores)) {
    if (typeof info?.score !== 'number') continue;
    (store[dim] ??= []).push(info.score);
  }
}

const pairwiseByStage = { dreamer: { [ARM_C]: 0, [ARM_T]: 0, tie: 0 }, philosopher: { [ARM_C]: 0, [ARM_T]: 0, tie: 0 }, scribe: { [ARM_C]: 0, [ARM_T]: 0, tie: 0 } };

for (const [k, pair] of [...pairs.entries()].sort()) {
  const [sid, repStr] = k.split('|');
  const rep = Number(repStr);
  const row = { sid, rep, arms: {} };
  for (const arm of [ARM_C, ARM_T]) {
    const rec = pair[arm];
    if (!rec) { row.arms[arm] = { missing: true }; continue; }
    const docs = dreamerDocs(rec);
    const texts = docs.flatMap((d) => d.candidates.map((c) => `${c?.badDecision ?? ''} ${c?.betterDecision ?? ''} ${c?.rationale ?? ''}`));
    const sims = [];
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) sims.push(jaccard(texts[i], texts[j]));
    const candTotal = docs.reduce((n, d) => n + d.candidates.length, 0);
    row.arms[arm] = {
      status: rec.status,
      chains: docs.length,
      candidatesTotal: candTotal,
      perChainCounts: docs.map((d) => d.candidates.length),
      duplication: sims.length ? { mean: +(sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(4), max: +Math.max(...sims).toFixed(4), pairs: sims.length } : null,
      needsHumanReview: rec.verification?.needsHumanReviewTasks ?? 0,
      verificationOk: rec.verification?.ok === true,
    };
    armAgg[arm].candidateCounts.push(candTotal);
    armAgg[arm].chainCounts.push(docs.length);
    armAgg[arm].needsReview += row.arms[arm].needsHumanReview;
    if (sims.length) { armAgg[arm].dupMeans.push(row.arms[arm].duplication.mean); armAgg[arm].dupMaxes.push(row.arms[arm].duplication.max); }
  }
  // blind evals for this (sid, rep) across stages
  // (blindmap evalIds are the KEYS of the map, not fields on the values)
  for (const [ek, entry] of Object.entries(blindmap)) {
    if (entry.sid !== sid || entry.rep !== rep) continue;
    const stage = entry.stage;
    if (!['dreamer', 'philosopher', 'scribe'].includes(stage)) continue;
    const ev = evals[ek];
    if (!ev?.verdict) continue;
    const armA = entry.armA; const armB = entry.armB;
    addDims(armAgg[armA][stage + 'Dims'], ev.verdict.A);
    addDims(armAgg[armB][stage + 'Dims'], ev.verdict.B);
    const pref = ev.verdict.pairwise?.preferred;
    if (pref === 'A') pairwiseByStage[stage][armA] += 1;
    else if (pref === 'B') pairwiseByStage[stage][armB] += 1;
    else if (pref === 'tie') pairwiseByStage[stage].tie += 1;
  }
  // diversity evals
  for (const [ek, entry] of Object.entries(blindmap)) {
    if (entry.sid !== sid || entry.rep !== rep || entry.stage !== 'dreamer' || entry.source !== 'paired') continue;
    for (const [slot, arm] of [['A', entry.armA], ['B', entry.armB]]) {
      const dv = divs[`${ek}.${slot}`];
      if (!dv?.verdict?.scores) continue;
      for (const key of DIVERSITY_KEYS) {
        const v = dv.verdict.scores[key];
        if (typeof v === 'number') armAgg[arm].divMetrics[key].push(v);
      }
    }
  }
  perPair.push(row);
}

const dimAgg = (store) => Object.fromEntries(Object.entries(store ?? {}).map(([d, arr]) => [d, agg(arr)]));

const result = {
  generatedAt: new Date().toISOString(),
  runId: args.runId,
  upstreamSummary: Object.fromEntries(Object.entries(upstream).map(([sid, u]) => [sid, { status: u.status, taskId: u.taskId ?? null, intake: u.intake ?? null }])),
  pairs: perPair.length,
  perPair,
  roles: { baseline: ARM_C, candidate: ARM_T },
  arms: {
    [ARM_C]: {
      candidatesPerPair: agg(armAgg[ARM_C].candidateCounts),
      chainsPerPair: agg(armAgg[ARM_C].chainCounts),
      needsHumanReviewTotal: armAgg[ARM_C].needsReview,
      lexicalDuplication: { meanOfMeans: agg(armAgg[ARM_C].dupMeans), meanOfMaxes: agg(armAgg[ARM_C].dupMaxes) },
      dreamerDims: dimAgg(armAgg[ARM_C].dreamerDims),
      philosopherDims: dimAgg(armAgg[ARM_C].philosopherDims),
      scribeDims: dimAgg(armAgg[ARM_C].scribeDims),
      diversityMetrics: Object.fromEntries(DIVERSITY_KEYS.map((k) => [k, agg(armAgg[ARM_C].divMetrics[k])])),
    },
    [ARM_T]: {
      candidatesPerPair: agg(armAgg[ARM_T].candidateCounts),
      chainsPerPair: agg(armAgg[ARM_T].chainCounts),
      needsHumanReviewTotal: armAgg[ARM_T].needsReview,
      lexicalDuplication: { meanOfMeans: agg(armAgg[ARM_T].dupMeans), meanOfMaxes: agg(armAgg[ARM_T].dupMaxes) },
      dreamerDims: dimAgg(armAgg[ARM_T].dreamerDims),
      philosopherDims: dimAgg(armAgg[ARM_T].philosopherDims),
      scribeDims: dimAgg(armAgg[ARM_T].scribeDims),
      diversityMetrics: Object.fromEntries(DIVERSITY_KEYS.map((k) => [k, agg(armAgg[ARM_T].divMetrics[k])])),
    },
  },
  pairwiseByStage,
};

fs.mkdirSync(path.join(experimentRoot(), 'analysis'), { recursive: true });
const outPath = path.join(experimentRoot(), 'analysis', `paired-${args.runId}-analysis.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 1) + '\n');
console.log('written:', outPath);
console.log(JSON.stringify({
  pairs: result.pairs,
  arms: result.arms,
  pairwiseByStage,
}, null, 1).slice(0, 6000));
