#!/usr/bin/env node
/**
 * PD-SPEC-001 Round-2 Phase-0 audit: Dreamer V1 vs V2 from grid-2 blindpack.
 *
 * Owner SPEC §二: "必须先读取本地完整实验数据，核对 V1/V2 的 Dreamer 候选数量、
 * 语义重复率、评分维度及 Philosopher 的候选淘汰情况。" This script produces the
 * quantitative part of that audit. It reads ONLY local full-fidelity blindpack
 * data and writes ONLY aggregate numbers (no pain text, no free-text rationales)
 * so the aggregate output is safe for publication.
 *
 * Output: .tmp/prompt-v2-ab/analysis/dreamer-round1-audit.json
 *
 * Method notes (disclosed in the report):
 * - Semantic duplication heuristic: pairwise Jaccard over normalized character
 *   bigrams (CJK) / word tokens (Latin) of badDecision+betterDecision+rationale.
 *   This is a lexical proxy, not a semantic-embedding measure.
 * - Philosopher survival heuristic: a dreamer candidate index that is explicitly
 *   referenced ("候选N" / "candidate N") in the philosopher's thesis or risks is
 *   counted as surviving synthesis; unreferenced indexes are counted as dropped.
 *   The philosopher artifact has no explicit keep/eliminate ledger, so this is a
 *   lower-bound signal, not a ground truth.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../repo-root.mjs';

const repoRoot = findRepoRoot(import.meta.url);
const runDir = join(repoRoot, '.tmp', 'prompt-v2-ab', 'runs', 'grid-2');
const outDir = join(repoRoot, '.tmp', 'prompt-v2-ab', 'analysis');

const blindmap = JSON.parse(readFileSync(join(runDir, 'blindpack', 'blindmap.json'), 'utf8'));
const packagesFile = JSON.parse(readFileSync(join(runDir, 'blindpack', 'packages.json'), 'utf8'));
const packages = packagesFile.packages;
if (!Array.isArray(packages)) throw new Error('packages.json: expected packages array');
const map = blindmap.map;
if (!map || typeof map !== 'object') throw new Error('blindmap.json: expected map object');

// ---------- lexical similarity helpers ----------
function normalizeText(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function unitize(s) {
  const out = [];
  let word = '';
  for (const ch of s) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) {
      if (word) { for (const w of word.split(' ')) if (w) out.push(w); word = ''; }
      out.push(ch);
    } else if (/[a-z0-9_]+/i.test(ch)) {
      word += ch;
    } else {
      if (word) { for (const w of word.split(' ')) if (w) out.push(w); word = ''; }
    }
  }
  if (word) { for (const w of word.split(' ')) if (w) out.push(w); }
  return out;
}
function bigrams(units) {
  const set = new Set();
  for (let i = 0; i + 1 < units.length; i++) set.add(units[i] + '\u0000' + units[i + 1]);
  if (units.length === 1) set.add(units[0]);
  return set;
}
function jaccard(aText, bText) {
  const a = bigrams(unitize(normalizeText(aText)));
  const b = bigrams(unitize(normalizeText(bText)));
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function parseArtifactPackage(raw, label, tallies) {
  // raw is a JSON string like {"stage":..,"artifactCount":..,"candidateTotal":..,"artifacts":[..]}
  if (typeof raw !== 'string') { tallies.parseSkips.push(label + ':output-not-string'); return null; }
  try { return JSON.parse(raw); } catch (e) { tallies.parseSkips.push(label + ':json-parse-failed'); return null; }
}

function parseContent(str, label, tallies) {
  if (typeof str !== 'string') { tallies.parseSkips.push(label + ':content-not-string'); return null; }
  try { return JSON.parse(str); } catch (e) { tallies.parseSkips.push(label + ':content-parse-failed'); return null; }
}

// ---------- main ----------
const tallies = { parseSkips: [] };
const dreamerRuns = { v1: [], v2: [] }; // per-execution records
const philosopherRuns = { v1: [], v2: [] };
const dreamerArtifactIdIndex = {}; // artifactId -> {arm, candidates}

const dreamerEvalDims = { v1: {}, v2: {} }; // dim -> [scores]

for (const pkg of packages) {
  if (!pkg || typeof pkg.evalId !== 'string') { tallies.parseSkips.push('package:null-or-no-evalId'); continue; }
  const m = map[pkg.evalId];
  if (!m) { tallies.parseSkips.push('package:no-blindmap-entry:' + pkg.evalId); continue; }
  const armA = m.armA; const armB = m.armB;
  const label = pkg.evalId + '/' + m.stage + '/S' + String(m.sid).replace(/^S/, '') + '/rep' + m.rep;

  if (m.stage === 'dreamer') {
    for (const [arm, raw, attempts] of [[armA, pkg.outputA, pkg.attemptsA], [armB, pkg.outputB, pkg.attemptsB]]) {
      const doc = parseArtifactPackage(raw, label + ':' + arm, tallies);
      if (!doc) continue;
      // blindpack stores either an aggregate envelope {stage, artifacts:[{content}]}
      // or — when the stage has exactly one artifact — the raw stage output document
      // ({valid, candidates, ...}) directly. Handle both shapes.
      const artifacts = Array.isArray(doc.artifacts) && doc.artifacts.length
        ? doc.artifacts.map(a => ({ index: a.index, artifactId: a.artifactId ?? null, content: a.content }))
        : [{ index: 0, artifactId: null, content: raw }];
      for (const art of artifacts) {
        const content = parseContent(art.content, label + ':' + arm + ':art' + art.index, tallies);
        const candidates = Array.isArray(content?.candidates) ? content.candidates : null;
        if (!candidates) { tallies.parseSkips.push(label + ':' + arm + ':no-candidates-array'); continue; }
        const texts = candidates.map(c => `${c?.badDecision ?? ''} ${c?.betterDecision ?? ''} ${c?.rationale ?? ''}`);
        const sims = [];
        for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) sims.push(jaccard(texts[i], texts[j]));
        const rec = {
          sid: m.sid, rep: m.rep, source: m.source, arm,
          candidateCount: candidates.length,
          artifactId: art.artifactId ?? null,
          confidences: candidates.map(c => (typeof c?.confidence === 'number' ? c.confidence : null)),
          pairwise: sims.length ? {
            mean: +(sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(4),
            max: +Math.max(...sims).toFixed(4),
            pairs: sims.length,
            pairsGte05: sims.filter(s => s >= 0.5).length,
            pairsGte07: sims.filter(s => s >= 0.7).length,
          } : null,
          attempts: typeof attempts === 'number' ? attempts : null,
        };
        dreamerRuns[arm].push(rec);
        if (rec.artifactId) dreamerArtifactIdIndex[rec.artifactId] = { arm, sid: m.sid, rep: m.rep, candidateCount: rec.candidateCount };
      }
    }
  }

  if (m.stage === 'philosopher') {
    for (const [arm, raw] of [[armA, pkg.outputA], [armB, pkg.outputB]]) {
      const doc = parseArtifactPackage(raw, label + ':' + arm, tallies);
      if (!doc) continue;
      const artifacts = Array.isArray(doc.artifacts) && doc.artifacts.length
        ? doc.artifacts.map(a => ({ index: a.index, artifactId: a.artifactId ?? null, content: a.content }))
        : [{ index: 0, artifactId: null, content: raw }];
      for (const art of artifacts) {
        const content = parseContent(art.content, label + ':' + arm + ':art' + art.index, tallies);
        if (!content || !content.principleCandidate) { tallies.parseSkips.push(label + ':' + arm + ':no-principleCandidate'); continue; }
        const srcId = content.sourceDreamerArtifactId ?? null;
        const src = srcId ? dreamerArtifactIdIndex[srcId] : undefined;
        const thesis = String(content.thesis ?? '');
        const risks = Array.isArray(content.risks) ? content.risks.map(String).join(' ') : '';
        const referenced = new Set();
        for (const hay of [thesis, risks]) {
          for (const match of hay.matchAll(/候选\s*(\d+)/g)) referenced.add(Number(match[1]));
          for (const match of hay.matchAll(/candidate\s+(\d+)/gi)) referenced.add(Number(match[1]));
        }
        philosopherRuns[arm].push({
          sid: m.sid, rep: m.rep, source: m.source, arm,
          dreamerArtifactId: srcId,
          dreamerCandidateCount: src ? src.candidateCount : null,
          dreamerLinked: src !== undefined && srcId !== null,
          referencedCandidateIndexes: [...referenced].sort((a, b) => a - b),
          riskCount: Array.isArray(content.risks) ? content.risks.length : null,
          confidence: typeof content.principleCandidate?.confidence === 'number' ? content.principleCandidate.confidence : null,
        });
      }
    }
  }
}

// dreamer eval dimensions from evals/*.json
const evalsDir = join(runDir, 'evals');
const { readdirSync } = await import('node:fs');
for (const f of readdirSync(evalsDir)) {
  if (!f.endsWith('.json') || f.endsWith('.error.json')) continue;
  let ev;
  try { ev = JSON.parse(readFileSync(join(evalsDir, f), 'utf8')); } catch { tallies.parseSkips.push('eval:' + f + ':parse-failed'); continue; }
  if (ev?.stage !== 'dreamer' || !ev?.verdict) continue;
  const dims = ev.verdict.A?.dimensionScores ?? {};
  // arm attribution via blindmap
  const m = map[ev.evalId];
  if (!m) continue;
  const dimsA = ev.verdict.A?.dimensionScores ?? {};
  const dimsB = ev.verdict.B?.dimensionScores ?? {};
  const byArm = { [m.armA]: dimsA, [m.armB]: dimsB };
  for (const [arm, dd] of Object.entries(byArm)) {
    for (const [dim, info] of Object.entries(dd ?? {})) {
      if (typeof info?.score !== 'number') continue;
      (dreamerEvalDims[arm][dim] ??= []).push(info.score);
    }
  }
}

// ---------- aggregates ----------
function agg(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return { n: nums.length, mean: +mean.toFixed(3), median: +s[Math.floor(s.length / 2)].toFixed(3), min: s[0], max: s[s.length - 1] };
}
function simAgg(runs, arm) {
  const all = runs[arm];
  const means = all.filter(r => r.pairwise).map(r => r.pairwise.mean);
  const maxes = all.filter(r => r.pairwise).map(r => r.pairwise.max);
  const gte05 = all.reduce((a, r) => a + (r.pairwise?.pairsGte05 ?? 0), 0);
  const gte07 = all.reduce((a, r) => a + (r.pairwise?.pairsGte07 ?? 0), 0);
  const totalPairs = all.reduce((a, r) => a + (r.pairwise?.pairs ?? 0), 0);
  const artsWithHighPair = all.filter(r => (r.pairwise?.pairsGte05 ?? 0) > 0).length;
  return {
    executions: all.length,
    pairwisePairsTotal: totalPairs,
    meanOfPerExecutionMean: agg(means),
    meanOfPerExecutionMax: agg(maxes),
    pairsGte05: gte05,
    pairsGte07: gte07,
    shareExecutionsWithHighPair: all.length ? +(artsWithHighPair / all.length).toFixed(3) : null,
  };
}

function candidateCountAgg(runs, arm) {
  const all = runs[arm];
  return {
    executions: all.length,
    perExecution: agg(all.map(r => r.candidateCount)),
    candidatesTotal: all.reduce((a, r) => a + r.candidateCount, 0),
    distribution: Object.fromEntries(Object.entries(all.reduce((acc, r) => { acc[r.candidateCount] = (acc[r.candidateCount] ?? 0) + 1; return acc; }, {})).sort((a, b) => Number(a[0]) - Number(b[0]))),
  };
}

function survivalAgg(ph, dr, arm) {
  const rows = ph[arm].filter(r => r.dreamerLinked && r.dreamerCandidateCount !== null);
  let dreamerTotal = 0; let referenced = 0;
  for (const r of rows) {
    dreamerTotal += r.dreamerCandidateCount;
    referenced += r.referencedCandidateIndexes.filter(i => i >= 0 && i < r.dreamerCandidateCount).length;
  }
  return {
    chains: rows.length,
    dreamerCandidatesTotal: dreamerTotal,
    referencedInThesisOrRisks: referenced,
    survivalRatio: dreamerTotal ? +(referenced / dreamerTotal).toFixed(3) : null,
    unlinkedChains: ph[arm].length - rows.length,
  };
}

const dreamerEvalDimAgg = {};
for (const arm of ['v1', 'v2']) {
  dreamerEvalDimAgg[arm] = Object.fromEntries(
    Object.entries(dreamerEvalDims[arm]).map(([d, scores]) => [d, agg(scores)]),
  );
}

const result = {
  generatedAt: new Date().toISOString(),
  source: 'grid-2 blindpack (full-chain + dreamer-stage packages)',
  tallies,
  dreamerCandidateCounts: {
    v1: candidateCountAgg(dreamerRuns, 'v1'),
    v2: candidateCountAgg(dreamerRuns, 'v2'),
  },
  dreamerSemanticDuplication: {
    method: 'pairwise char-bigram/word-token Jaccard over badDecision+betterDecision+rationale within one dreamer execution',
    v1: simAgg(dreamerRuns, 'v1'),
    v2: simAgg(dreamerRuns, 'v2'),
  },
  dreamerEvalDimensions: dreamerEvalDimAgg,
  philosopherSurvival: {
    method: 'dreamer candidate index explicitly referenced in philosopher thesis/risks (lower-bound heuristic)',
    v1: survivalAgg(philosopherRuns, dreamerRuns, 'v1'),
    v2: survivalAgg(philosopherRuns, dreamerRuns, 'v2'),
  },
};

mkdirSync(dirname(join(outDir, 'x')), { recursive: true });
writeFileSync(join(outDir, 'dreamer-round1-audit.json'), JSON.stringify(result, null, 1) + '\n');

console.log(JSON.stringify({
  tallies,
  candidateCounts: result.dreamerCandidateCounts,
  duplication: result.dreamerSemanticDuplication,
  evalDims: result.dreamerEvalDimensions,
  survival: result.philosopherSurvival,
}, null, 1));
console.log('written: ' + join(outDir, 'dreamer-round1-audit.json'));
