#!/usr/bin/env node
// PRI-815 — deterministic aggregation of the exploratory A/B results
// (SPEC §16–§18, §23–§31). Computes:
//   per-group pairwise verdict (>=2/3 repeats -> B_WIN / A_WIN / TIE)
//   BOTH_BAD bookkeeping (never converted into a win)
//   stability classification counts per arm
//   downstream gate correctness per arm
//   cost totals + formation-level delta (SPEC §31)
//   dev vs clean subset breakdown (sample-contamination guard, §T1-6)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data');
const runsDirName = process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 'runs';
const runsDir = path.join(DATA, runsDirName);

const manifest = JSON.parse(fs.readFileSync(path.join(DATA, '..', 'sample-manifest.json'), 'utf8'));
const classOf = new Map(manifest.groups.map((g) => [g.source_group_id, g.class]));
const qual = JSON.parse(fs.readFileSync(path.join(DATA, `judgments-quality-${runsDirName}.json`), 'utf8')).pairs;
const stab = JSON.parse(fs.readFileSync(path.join(DATA, `judgments-stability-${runsDirName}.json`), 'utf8')).groups;
const down = JSON.parse(fs.readFileSync(path.join(DATA, `judgments-downstream-${runsDirName}.json`), 'utf8')).groups;

const groups = {};
for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json'))) {
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
  groups[run.group] = run;
}

const report = { perGroup: {}, totals: {}, subsets: {}, cost: {}, stability: {}, downstream: {}, validity: { A: { ok: 0, fail: 0 }, B: { ok: 0, fail: 0 }, abortedRepeats: 0 } };
let W = 0, L = 0, T = 0;
let bothBadGroups = 0;
const stabCounts = { A: { CONTRADICTION: 0, MATERIAL_DRIFT: 0, STABLE: 0, other: 0 }, B: { CONTRADICTION: 0, MATERIAL_DRIFT: 0, STABLE: 0, other: 0 } };
const downAgg = { A: { correct: 0, blockMiss: 0, overblock: 0, invalid: 0 }, B: { correct: 0, blockMiss: 0, overblock: 0, invalid: 0 } };
let tokensA = 0, tokensB = 0;
const subsetW = { DEV: { w: 0, l: 0, t: 0 }, CLEAN: { w: 0, l: 0, t: 0 } };

for (const [gid, run] of Object.entries(groups)) {
  const verdicts = [];
  let gTokensA = 0, gTokensB = 0;
  let gBothBad = 0;
  for (const r of run.repeats) {
    const key = `${gid}#r${r.repeat}`;
    const j = qual[key];
    if (!j) continue;
    if (j.skipped) { verdicts.push(j.verdict === 'BOTH_BAD' ? 'BOTH_BAD' : j.verdict); continue; }
    if (j.verdict === 'BOTH_BAD') { verdicts.push('BOTH_BAD'); gBothBad += 1; continue; }
    if (j.verdict === 'JUDGE_INVALID') { verdicts.push('JUDGE_INVALID'); continue; }
    verdicts.push(j.verdict);
  }
  const count = (v) => verdicts.filter((x) => x === v).length;
  const bWins = count('B'), aWins = count('A');
  let groupVerdict;
  if (bWins >= 2 && bWins > aWins) { groupVerdict = 'B_WIN'; W += 1; subsetW[classOf.get(gid)]?.w !== undefined && (subsetW[classOf.get(gid)].w += 1); }
  else if (aWins >= 2 && aWins > bWins) { groupVerdict = 'A_WIN'; L += 1; subsetW[classOf.get(gid)]?.l !== undefined && (subsetW[classOf.get(gid)].l += 1); }
  else { groupVerdict = 'TIE'; T += 1; subsetW[classOf.get(gid)]?.t !== undefined && (subsetW[classOf.get(gid)].t += 1); }
  if (gBothBad > 0) bothBadGroups += 1;
  report.perGroup[gid] = {
    class: classOf.get(gid),
    verdicts, groupVerdict,
    bothBadRepeats: gBothBad,
    stabilityA: stab[`${gid}#A`]?.classification,
    stabilityB: stab[`${gid}#B`]?.classification,
    downstreamA: down[`${gid}#A`]?.evaluation,
    downstreamB: down[`${gid}#B`]?.evaluation,
  };
  for (const arm of ['A', 'B']) {
    const cls = stab[`${gid}#${arm}`]?.classification;
    if (cls) stabCounts[arm][cls] = (stabCounts[arm][cls] ?? 0) + 1;
    const d = down[`${gid}#${arm}`]?.evaluation;
    if (!d || typeof d !== 'object') { if (d) downAgg[arm].invalid += 1; continue; }
    let ok = true;
    if (d.target_violation === 'allow') { downAgg[arm].blockMiss += 1; ok = false; }
    const over = [d.valid_compliant, d.near_boundary_legal, d.out_of_scope].filter((x) => x === 'block').length;
    if (over > 0) { downAgg[arm].overblock += over; ok = false; }
    if (ok) downAgg[arm].correct += 1;
  }
  for (const r of run.repeats) {
    if (r.aborted) { report.validity.abortedRepeats += 1; continue; }
    for (const arm of ['A', 'B']) {
      const st = r[`scribe_${arm}`];
      if (!st) continue;
      if (st.ok) report.validity[arm].ok += 1; else report.validity[arm].fail += 1;
    }
    gTokensA += (r.dreamer?.usage?.total ?? 0) + (r.philosopher?.usage?.total ?? 0) + (r.scribe_A?.usage?.total ?? 0);
    gTokensB += (r.dreamer?.usage?.total ?? 0) + (r.philosopher?.usage?.total ?? 0) + (r.scribe_B?.usage?.total ?? 0);
  }
  tokensA += gTokensA; tokensB += gTokensB;
  report.perGroup[gid].tokensA = gTokensA;
  report.perGroup[gid].tokensB = gTokensB;
}

const N = W + L + T;
report.totals = { N, W, L, T, BOTH_BAD_GROUPS: bothBadGroups, NET_ADVANTAGE_PP: N > 0 ? Number((((W - L) / N) * 100).toFixed(1)) : null };
report.subsets = subsetW;
report.cost = {
  tokensA, tokensB,
  deltaPct: tokensA > 0 ? Number((((tokensB - tokensA) / tokensA) * 100).toFixed(1)) : null,
  budgetGuard: 'B total <= A + 20% (SPEC §31)',
};
report.stability = stabCounts;
report.downstream = downAgg;

fs.writeFileSync(path.join(DATA, `aggregate-${runsDirName}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ totals: report.totals, subsets: report.subsets, cost: report.cost, stability: report.stability, downstream: report.downstream }, null, 2));
