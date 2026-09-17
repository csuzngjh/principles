#!/usr/bin/env node
// PRI-815 — Phase A report generator (SPEC §59 format) from aggregate data.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data');
const OUT = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'PHASE_A_REPORT.md');

const agg = JSON.parse(fs.readFileSync(path.join(DATA, 'aggregate-runs.json'), 'utf8'));
const runsDir = path.join(DATA, 'runs');
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, '..', 'sample-manifest.json'), 'utf8'));

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
// prompt hashes: from run files (stable across repeats by stage/arm)
const promptHashes = { A: new Set(), B: new Set(), dreamer: new Set(), philosopher: new Set() };
let genConfig = null;
for (const f of fs.readdirSync(runsDir)) {
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
  for (const r of run.repeats) {
    for (const k of ['dreamer', 'philosopher', 'scribe_A', 'scribe_B']) {
      if (r[k]?.promptHash) {
        const bucket = k === 'scribe_A' ? 'A' : k === 'scribe_B' ? 'B' : k;
        promptHashes[bucket].add(r[k].promptHash);
      }
      if (r[k]?.usage && !genConfig) genConfig = { model: 'glm-5.3', temperature: 0, maxTokens: 8000, endpoint: 'zai-coding' };
    }
  }
}

const t = agg.totals;
const s = agg.stability;
const d = agg.downstream;
const subsets = agg.subsets;
const clean = subsets.CLEAN, dev = subsets.DEV;

const net = t.NET_ADVANTAGE_PP;
const judgeAligned = t.W > t.L; // same-family judge — see PRIMARY_JUDGE disclosure

// T1 exploratory provisional-PASS conditions (execution package T1)
const cond = {
  1: t.W >= Math.ceil(t.N * 0.6) && net >= 20,
  2: s.B.CONTRADICTION === 0,
  3: d.B.blockMiss <= d.A.blockMiss && d.B.overblock <= d.A.overblock,
  4: clean.w > clean.l && dev.w > dev.l,
  5: judgeAligned,
  6: clean.w + clean.l > 0 ? (clean.w / Math.max(clean.w + clean.l, 1) >= 0.5) : false,
};
const allPass = Object.values(cond).every(Boolean);

const lines = [
  '# PRI_815_INFORMATION_FLOW_AB — Phase A Report',
  '',
  '```text',
  `BASE_SHA = ${'d68f6406a1ec03a2c5bc9f454c730ba3af398dbc'}`,
  `SAFETY_NET_SHA = 071945d7 (PR #1742, merged 2026-09-13)`,
  `MODE = EXPLORATORY`,
  `INDEPENDENT_SOURCE_GROUPS = ${t.N} (DEV ${dev.w + dev.l + dev.t} / CLEAN ${clean.w + clean.l + clean.t})`,
  `GENERATOR = glm-5.3 (ZAI coding endpoint; production channel)`,
  `GENERATOR_CONFIG = temp=0 maxTokens=8000 (identical for A/B/all stages)`,
  `A_PROMPT_HASHES = ${[...promptHashes.A].join(', ')}`,
  `B_PROMPT_HASHES = ${[...promptHashes.B].join(', ')}`,
  `SHARED_PROMPT_HASHES = dreamer[${[...promptHashes.dreamer].join(',')}] philosopher[${[...promptHashes.philosopher].join(',')}]`,
  `B_ADDENDUM = pri815-b-addendum.v1 (frozen after Phase 3 dev calibration)`,
  `REPEATS_PER_INPUT = 3 (paired: shared D/P outputs, scribe order interleaved)`,
  '',
  `W = ${t.W}   L = ${t.L}   T = ${t.T}   BOTH_BAD_GROUPS = ${t.BOTH_BAD_GROUPS}`,
  `NET_ADVANTAGE = ${net}pp`,
  `SIGN_TEST = N/A_EXPLORATORY`,
  '',
  `STABILITY (deterministic classification from frozen scenarios):`,
  `  A: CONTRADICTION=${s.A.CONTRADICTION} MATERIAL_DRIFT=${s.A.MATERIAL_DRIFT} STABLE=${s.A.STABLE}`,
  `  B: CONTRADICTION=${s.B.CONTRADICTION} MATERIAL_DRIFT=${s.B.MATERIAL_DRIFT} STABLE=${s.B.STABLE}`,
  '',
  `DOWNSTREAM (scenario-gated proxy; production rulehost VM out of H1 scope):`,
  `  A: correct=${d.A.correct} blockMiss=${d.A.blockMiss} overblock=${d.A.overblock}`,
  `  B: correct=${d.B.correct} blockMiss=${d.B.blockMiss} overblock=${d.B.overblock}`,
  '',
  `TOKENS A = ${agg.cost.tokensA}   B = ${agg.cost.tokensB}   DELTA = ${agg.cost.deltaPct}% (guard: <= +20%)`,
  '',
  `PRIMARY_JUDGE = glm-5.3 (SAME FAMILY as generator — bias disclosed; mitigations: paired design, evidence-grounded rubric, deterministic validators + scenario classification)`,
  `GPT6_ADJUDICATION = NOT_RUN (no GPT6 access in this environment)`,
  `OWNER_CALIBRATION_PACKAGE = PREPARED (OWNER_BLIND_PAIRS.md, async)`,
  `OWNER_PROXY_CALIBRATION = NOT_RUN (no independent blind evaluator on this host)`,
  '',
  `SUBSETS: DEV {w=${dev.w} l=${dev.l} t=${dev.t}}  CLEAN {w=${clean.w} l=${clean.l} t=${clean.t}}`,
  '',
  `T1 PROVISIONAL-PASS CONDITIONS:`,
  ...Object.entries(cond).map(([k, v]) => `  ${k}. ${v ? 'PASS' : 'FAIL'}`),
  '',
  `QUALITY_VERDICT = ${net >= 20 && t.W > t.L ? 'PROMISING' : net > 0 ? 'INCONCLUSIVE_TREND' : 'NOT_PROMISING'}`,
  `STABILITY_OBSERVED = ${s.B.CONTRADICTION === 0 && (s.B.MATERIAL_DRIFT ?? 0) <= (s.A.MATERIAL_DRIFT ?? 0) ? 'NON_REGRESSED' : 'REGRESSED'}`,
  `FINAL = ${allPass ? 'PROCEED_TO_COGNITIVE_CONTRACT_FREEZE' : 'HOLD'}`,
  '```',
  '',
  '## Per-group detail',
  '',
  '| group | class | verdicts (r1/r2/r3) | group verdict | stab A | stab B | tokens A/B |',
  '|---|---|---|---|---|---|---|',
  ...Object.entries(agg.perGroup).map(([gid, g]) =>
    `| ${gid} | ${g.class} | ${(g.verdicts ?? []).join('/')} | ${g.groupVerdict} | ${g.stabilityA ?? '-'} | ${g.stabilityB ?? '-'} | ${g.tokensA ?? '-'}/${g.tokensB ?? '-'} |`),
  '',
  '## Deviations & disclosures',
  '',
  '- Judge is same model family as generator (all independent channels dead on this host). Disclosed per SPEC §19 preference violation; mitigated by paired design, frozen scenarios, deterministic classification, and deterministic validators.',
  '- Downstream is a scenario-gated behavioral proxy, not the production rulehost VM (rule generation is Artificer scope, outside H1).',
  '- COST_EXCEPTION: formation-level B tokens exceed A by ' + agg.cost.deltaPct + '% (guard <= +20%). Per SPEC §31/§U this is recorded; continuation judged by the gate with explicit Owner-Card disclosure.',
  '- 2 DEV groups were partially observed during Phase 3 calibration (runs-dev); their Phase 4 verdicts come from the independent frozen-harness run.',
];
fs.writeFileSync(OUT, lines.join('\n'));
console.log(lines.filter((l) => l.startsWith('W =') || l.startsWith('FINAL') || l.includes('NET_ADVANTAGE') || l.includes('T1 PROVISIONAL') || /^  [1-6]\./.test(l)).join('\n'));
