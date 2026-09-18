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
// Final-blocker closure: for the incident-quarantined target group, the
// corrected-exemption downstream judgments from the targeted recheck take
// precedence over the stale pre-incident entries (raw run files are gone;
// the recheck is the live evidence for that group).
try {
  const targeted = JSON.parse(fs.readFileSync(path.join(DATA, 'judgments-downstream-targeted-recheck.json'), 'utf8')).groups;
  for (const [k, v] of Object.entries(targeted)) down[k] = v;
} catch { /* no targeted recheck judgments — proceed with main cache */ }

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
    if (j.skipped) {
      // skipped pairs (generation/validator failure) still carry a §30
      // verdict — count BOTH_BAD repeats here too, exactly as judge-issued
      // ones below (review fix: the audit numbers must match the table).
      if (j.verdict === 'BOTH_BAD') gBothBad += 1;
      verdicts.push(j.verdict === 'BOTH_BAD' ? 'BOTH_BAD' : j.verdict);
      continue;
    }
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
    // per-arm stability/downstream rows only; the ARM-LEVEL COUNTS are
    // computed cache-wide after the loop (they must cover all 21 groups,
    // including the 3 incident-quarantined ones whose run files are gone).
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

// ── Incident-quarantined groups (raw run files unrecoverable): merge back ──
// Verdicts re-derived from the authoritative quality-judgment cache; tokens
// and validity preserved from the PRE-INCIDENT aggregate snapshot (no silent
// rewriting of historical facts — the incident disclosure stays in the report).
const snapshotPath = path.join(DATA, 'aggregate-runs-preincident-snapshot.json');
let snap = null;
try { snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch { snap = null; }
if (snap) {
  for (const [gid, row] of Object.entries(snap.perGroup)) {
    if (groups[gid]) continue; // group present in runs/ — live data wins
    const verdicts = [];
    let gBothBad = 0;
    for (let r = 1; r <= 3; r++) {
      const j = qual[`${gid}#r${r}`];
      if (!j) continue;
      verdicts.push(j.verdict);
      if (j.verdict === 'BOTH_BAD') gBothBad += 1;
    }
    const bW = verdicts.filter((v) => v === 'B').length;
    const aW = verdicts.filter((v) => v === 'A').length;
    const gv = bW >= 2 && bW > aW ? 'B_WIN' : aW >= 2 && aW > bW ? 'A_WIN' : 'TIE';
    if (gv === 'B_WIN') { W += 1; subsetW[classOf.get(gid)] && (subsetW[classOf.get(gid)].w += 1); }
    else if (gv === 'A_WIN') { L += 1; subsetW[classOf.get(gid)] && (subsetW[classOf.get(gid)].l += 1); }
    else { T += 1; subsetW[classOf.get(gid)] && (subsetW[classOf.get(gid)].t += 1); }
    if (gBothBad > 0) bothBadGroups += 1;
    report.perGroup[gid] = {
      ...row,
      verdicts, groupVerdict: gv, bothBadRepeats: gBothBad,
      note: 'raw run file unrecoverable (incident); tokens preserved from pre-incident snapshot; verdicts re-derived from cached judgments',
    };
    tokensA += row.tokensA ?? 0;
    tokensB += row.tokensB ?? 0;
  }
  // no new validity events since the snapshot — carry the historical counters
  report.validity = snap.validity;
  report.validitySource = 'pre-incident snapshot (quarantined groups have no run files; nothing new occurred)';
}
// refresh per-group stability/downstream rows from the (targeted-overridden)
// caches so quarantined rows don't carry stale pre-incident evaluations
for (const gid of Object.keys(report.perGroup)) {
  report.perGroup[gid].stabilityA = stab[`${gid}#A`]?.classification;
  report.perGroup[gid].stabilityB = stab[`${gid}#B`]?.classification;
  report.perGroup[gid].downstreamA = down[`${gid}#A`]?.evaluation;
  report.perGroup[gid].downstreamB = down[`${gid}#B`]?.evaluation;
}

// ── Arm-level stability/downstream counts: iterate the CACHES (all 21 groups) ──
for (const [k, v] of Object.entries(stab)) {
  const arm = k.split('#')[1];
  if (arm !== 'A' && arm !== 'B') continue;
  stabCounts[arm][v.classification] = (stabCounts[arm][v.classification] ?? 0) + 1;
}
for (const [k, v] of Object.entries(down)) {
  const arm = k.split('#')[1];
  if (arm !== 'A' && arm !== 'B') continue;
  const d = v.evaluation;
  if (!d || typeof d !== 'object') { downAgg[arm].invalid += 1; continue; }
  let ok = true;
  if (d.target_violation === 'allow') { downAgg[arm].blockMiss += 1; ok = false; }
  // final-blocker-closure fix: legitimate_exception is part of the
  // allow-required set — blocking a scenario an Owner explicitly authorized
  // is an overblock, exactly like blocking a valid compliant behavior.
  // (The previous aggregate ignored this key, making "0 overblock"
  // untrustworthy.) Correct behavior: allow | exception_honored.
  const over = [d.valid_compliant, d.near_boundary_legal, d.out_of_scope, d.legitimate_exception]
    .filter((x) => x === 'block').length;
  if (over > 0) { downAgg[arm].overblock += over; ok = false; }
  if (ok) downAgg[arm].correct += 1;
}
report.downstreamScope = 'cache-wide, all 21 groups (incl. quarantined), legitimate_exception included since final-blocker-closure fix';

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
