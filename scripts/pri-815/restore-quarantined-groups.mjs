#!/usr/bin/env node
// One-shot (review fix follow-up): merge the 3 incident-quarantined groups
// back into the fresh aggregate. Deterministic, no LLM.
//
// Context: the data incident overwrote those groups' raw run files; the
// quarantined files are INCIDENT-RERUN data (not original). This script takes
// group rows from the PRE-INCIDENT aggregate snapshot (tokens/validity/stability
// preserved from the original run), re-derives their repeat verdicts from the
// cached quality judgments (authoritative, pre-incident), and merges with the
// freshly recomputed 18-group aggregate. Totals are recomputed from all 21.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data');

const fresh = JSON.parse(fs.readFileSync(path.join(DATA, 'aggregate-runs.json'), 'utf8'));
const pre = JSON.parse(fs.readFileSync(path.join(DATA, 'aggregate-runs-preincident-snapshot.json'), 'utf8'));
const qual = JSON.parse(fs.readFileSync(path.join(DATA, 'judgments-quality-runs.json'), 'utf8')).pairs;
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, '..', 'sample-manifest.json'), 'utf8'));
const classOf = new Map(manifest.groups.map((g) => [g.source_group_id, g.class]));

const quarantined = Object.keys(pre.perGroup).filter((g) => !(g in fresh.perGroup));
for (const gid of quarantined) {
  const row = pre.perGroup[gid];
  // re-derive repeat verdicts from the authoritative cached judgments
  const verdicts = [];
  let bothBad = 0;
  for (let r = 1; r <= 3; r++) {
    const j = qual[`${gid}#r${r}`];
    if (!j) continue;
    verdicts.push(j.verdict);
    if (j.verdict === 'BOTH_BAD') bothBad += 1;
  }
  const bW = verdicts.filter((v) => v === 'B').length;
  const aW = verdicts.filter((v) => v === 'A').length;
  const groupVerdict = bW >= 2 && bW > aW ? 'B_WIN' : aW >= 2 && aW > bW ? 'A_WIN' : 'TIE';
  fresh.perGroup[gid] = {
    ...row,
    verdicts,
    groupVerdict,
    bothBadRepeats: bothBad,
    note: 'raw run file overwritten by incident; tokens/stability/validity preserved from pre-incident snapshot; verdicts re-derived from cached judgments',
  };
  const cls = classOf.get(gid);
  if (groupVerdict === 'B_WIN') { fresh.totals.W += 1; fresh.subsets[cls].w += 1; }
  else if (groupVerdict === 'A_WIN') { fresh.totals.L += 1; fresh.subsets[cls].l += 1; }
  else { fresh.totals.T += 1; fresh.subsets[cls].t += 1; }
  if (bothBad > 0) fresh.totals.BOTH_BAD_GROUPS += 1;
  fresh.cost.tokensA += row.tokensA ?? 0;
  fresh.cost.tokensB += row.tokensB ?? 0;
}

const { W, L, T } = fresh.totals;
const N = W + L + T;
fresh.totals.N = N;
fresh.totals.NET_ADVANTAGE_PP = N > 0 ? Number((((W - L) / N) * 100).toFixed(1)) : null;
fresh.cost.deltaPct = fresh.cost.tokensA > 0
  ? Number((((fresh.cost.tokensB - fresh.cost.tokensA) / fresh.cost.tokensA) * 100).toFixed(1)) : null;

// stability/downstream/validity aggregates: the review fixes did NOT change
// any of these values, and the pre-incident snapshot already counted all 21
// groups — copy them wholesale (the fresh 18-group pass lacks the 3
// quarantined groups' judge rows).
fresh.stability = pre.stability;
fresh.downstream = pre.downstream;
fresh.validity = pre.validity;

fs.writeFileSync(path.join(DATA, 'aggregate-runs.json'), JSON.stringify(fresh, null, 2));
console.log('merged back:', quarantined.join(', '));
console.log(JSON.stringify({ totals: fresh.totals, subsets: fresh.subsets, cost: fresh.cost }));
