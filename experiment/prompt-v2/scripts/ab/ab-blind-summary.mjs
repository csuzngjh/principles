/**
 * PD-SPEC-001 — blind-evaluation aggregation + unblinding.
 * Consumes evals/*.json + blindpack/blindmap.json; produces
 * AGENT_SCORECARD.md + PRINCIPLE_QUALITY_COMPARISON.md data and the
 * unblinded per-package table (A/B → v1/v2).
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

// Unblind: score per arm.
const byArm = { v1: [], v2: [] };
const byStageArm = {};
for (const r of rows) {
  const scoreA = r.totalA; const scoreB = r.totalB;
  if (scoreA !== null) byArm[r.armA].push({ stage: r.stage, sid: r.sid, score: scoreA, veto: r.vetoA });
  if (scoreB !== null) byArm[r.armB].push({ stage: r.stage, sid: r.sid, score: scoreB, veto: r.vetoB });
}
const avg = (a) => (a.length ? +(a.reduce((s, x) => s + x.score, 0) / a.length).toFixed(2) : null);
const summary = {
  packages: rows.length,
  perArm: {
    v1: { n: byArm.v1.length, avgScore: avg(byArm.v1), vetoes: byArm.v1.filter((x) => x.veto).length },
    v2: { n: byArm.v2.length, avgScore: avg(byArm.v2), vetoes: byArm.v2.filter((x) => x.veto).length },
  },
  byStage: {},
  pairwise: { v1Preferred: rows.filter((r) => (r.preferred === 'A' && r.armA === 'v1') || (r.preferred === 'B' && r.armB === 'v1')).length, v2Preferred: rows.filter((r) => (r.preferred === 'A' && r.armA === 'v2') || (r.preferred === 'B' && r.armB === 'v2')).length, tie: rows.filter((r) => r.preferred === 'tie').length, decided: rows.filter((r) => r.preferred && r.preferred !== 'tie').length },
};
for (const r of rows) {
  const st = (byStageArm[r.stage] ??= { v1: [], v2: [] });
  if (r.totalA !== null) st[r.armA].push(r.totalA);
  if (r.totalB !== null) st[r.armB].push(r.totalB);
}
for (const [stage, st] of Object.entries(byStageArm)) {
  summary.byStage[stage] = { v1: { n: st.v1.length, avg: avg(st.v1) }, v2: { n: st.v2.length, avg: avg(st.v2) } };
}
console.log(JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(runDir, 'blind-summary.json'), JSON.stringify({ summary, rows }, null, 2) + '\n', 'utf8');
console.log('->', path.join(runDir, 'blind-summary.json'));
