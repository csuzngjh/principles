/**
 * PD-SPEC-001 — blind-evaluation aggregation + unblinding.
 * Consumes evals/*.json + blindpack/blindmap.json; produces
 * AGENT_SCORECARD.md + PRINCIPLE_QUALITY_COMPARISON.md data and the
 * unblinded per-package table (A/B → arms).
 *
 * Arms are discovered from the blind map (round-1: v1/v2; round-2: v2c/v21),
 * never hardcoded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXPERIMENT_ROOT } from '../ab/ab-lib.mjs';

const runId = process.argv[2] ?? 'grid-2';
const runDir = path.join(EXPERIMENT_ROOT, 'runs', runId);
const evalsDir = path.join(runDir, 'evals');
const blindMap = JSON.parse(fs.readFileSync(path.join(runDir, 'blindpack', 'blindmap.json'), 'utf8')).map;

const rows = [];
for (const f of fs.readdirSync(evalsDir).filter((x) => x.endsWith('.json') && !x.includes('.error'))) {
  const v = JSON.parse(fs.readFileSync(path.join(evalsDir, f), 'utf8'));
  const bm = blindMap[v.evalId];
  if (!bm) continue;
  rows.push({
    evalId: v.evalId, stage: v.stage, source: v.source, sid: v.sid,
    armA: bm.armA, armB: bm.armB,
    totalA: v.verdict?.A?.weightedTotal ?? null,
    totalB: v.verdict?.B?.weightedTotal ?? null,
    vetoA: v.verdict?.A?.veto ?? null,
    vetoB: v.verdict?.B?.veto ?? null,
    preferred: v.verdict?.pairwise?.preferred ?? null,
    confidence: v.verdict?.pairwise?.confidence ?? null,
    reason: (v.verdict?.pairwise?.reason ?? '').slice(0, 160),
  });
}

// Unblind: score per arm (arms discovered from the blind map).
const arms = [...new Set(rows.flatMap((r) => [r.armA, r.armB]))].sort();
const byArm = Object.fromEntries(arms.map((a) => [a, []]));
const byStageArm = {};
for (const r of rows) {
  if (r.totalA !== null) byArm[r.armA].push({ stage: r.stage, sid: r.sid, score: r.totalA, veto: r.vetoA });
  if (r.totalB !== null) byArm[r.armB].push({ stage: r.stage, sid: r.sid, score: r.totalB, veto: r.vetoB });
}
const avg = (a) => (a.length ? +(a.reduce((s, x) => s + x.score, 0) / a.length).toFixed(2) : null);
const pairwise = Object.fromEntries(arms.map((a) => [a + 'Preferred', rows.filter((r) => (r.preferred === 'A' && r.armA === a) || (r.preferred === 'B' && r.armB === a)).length]));
pairwise.tie = rows.filter((r) => r.preferred === 'tie').length;
pairwise.decided = rows.filter((r) => r.preferred && r.preferred !== 'tie').length;
const summary = {
  packages: rows.length,
  perArm: Object.fromEntries(arms.map((a) => [a, { n: byArm[a].length, avgScore: avg(byArm[a]), vetoes: byArm[a].filter((x) => x.veto).length }])),
  byStage: {},
  pairwise,
};
for (const r of rows) {
  const st = (byStageArm[r.stage] ??= Object.fromEntries(arms.map((a) => [a, []])));
  if (r.totalA !== null && Number.isFinite(r.totalA)) st[r.armA].push(r.totalA);
  if (r.totalB !== null && Number.isFinite(r.totalB)) st[r.armB].push(r.totalB);
}
const avgNum = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
for (const [stage, st] of Object.entries(byStageArm)) {
  summary.byStage[stage] = Object.fromEntries(arms.map((a) => [a, { n: st[a].length, avg: avgNum(st[a]) }]));
}
console.log(JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(runDir, 'blind-summary.json'), JSON.stringify({ summary, rows }, null, 2) + '\n', 'utf8');
console.log('->', path.join(runDir, 'blind-summary.json'));
