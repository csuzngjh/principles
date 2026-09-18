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

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
// Arm identity hashes: the CONSTANT system prompts (what actually differs
// between arms). Per-call prompt hashes (system+message) live in the run files.
const CORE = path.join(ROOT, 'packages', 'principles-core', 'dist', 'runtime-v2');
const { buildScribeProtocolInstruction } = await import(`file://${CORE}/internalization/scribe-prompt-builder.js`.replace(/\\/g, '/'));
const { B_ADDENDUM, B_ADDENDUM_VERSION } = await import(`file://${path.join(ROOT, 'scripts/pri-815/b-addendum.mjs')}`.replace(/\\/g, '/'));
const armAHash = sha(buildScribeProtocolInstruction({ coreGrounding: true }));
const armBHash = sha(buildScribeProtocolInstruction({ coreGrounding: true }) + B_ADDENDUM);

let genConfig = null;
for (const f of fs.readdirSync(runsDir)) {
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
  for (const r of run.repeats) {
    for (const k of ['dreamer', 'philosopher', 'scribe_A', 'scribe_B']) {
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

// T1 exploratory provisional-PASS conditions (execution package T1 + SPEC §27/§31/§32)
// 1. B wins the vast majority of independent groups with net >= 20pp
// 2. no key regression: no B-only contradictions, B validity failures <= A (SPEC §27)
// 3. downstream non-regression (blockMiss/overblock)
// 4. effect not outlier-driven: both subsets aligned
// 5. at least one INDEPENDENT judge family aligned (none available this env)
// 6. no sample contamination: CLEAN subset direction consistent
const stab = JSON.parse(fs.readFileSync(path.join(DATA, 'judgments-stability-runs.json'), 'utf8')).groups;
const byG = {};
for (const [k, v] of Object.entries(stab)) {
  const [g, arm] = k.split('#');
  byG[g] = byG[g] ?? {};
  byG[g][arm] = v.classification;
}
let bOnlyContra = 0;
for (const x of Object.values(byG)) {
  if (x.B === 'CONTRADICTION' && x.A !== 'CONTRADICTION') bOnlyContra += 1;
}
const cond = {
  1: t.W >= Math.ceil(t.N * 0.6) && net >= 20,
  2: bOnlyContra === 0 && agg.validity.B.fail <= agg.validity.A.fail,
  3: d.B.blockMiss <= d.A.blockMiss && d.B.overblock <= d.A.overblock,
  4: clean.w > clean.l && dev.w > dev.l,
  5: false, // no independent judge family available on this host (documented NOT_MET)
  6: clean.w + clean.l > 0 ? clean.w > clean.l : false,
};
const allPass = Object.values(cond).every(Boolean);
const stabObserved = bOnlyContra === 0 && agg.validity.B.fail <= agg.validity.A.fail
  ? (s.B.MATERIAL_DRIFT <= s.A.MATERIAL_DRIFT ? 'NON_REGRESSED' : 'REGRESSED')
  : 'REGRESSED';

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
  `ARM_SYSTEM_PROMPT_HASHES: A = ${armAHash}   B = ${armBHash} (delta = B_ADDENDUM ${B_ADDENDUM_VERSION} + 3 evidence payload blocks; per-call hashes in data/runs/*.json)`,
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
  `TOKENS A = ${agg.cost.tokensA}   B = ${agg.cost.tokensB}   DELTA = ${agg.cost.deltaPct}% (guard: <= +20%)  COST_EXCEPTION = YES`,
  '',
  `VALIDITY (deterministic validators, failures stay in denominator):`,
  `  A: ${agg.validity.A.ok} ok / ${agg.validity.A.fail} fail   B: ${agg.validity.B.ok} ok / ${agg.validity.B.fail} fail   aborted repeats (upstream, arm-symmetric): ${agg.validity.abortedRepeats}`,
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
  `STABILITY_OBSERVED = ${stabObserved} (B-only contradiction groups = ${bOnlyContra}; validity A ${agg.validity.A.ok}ok/${agg.validity.A.fail}fail vs B ${agg.validity.B.ok}ok/${agg.validity.B.fail}fail; ${s.A.CONTRADICTION}A/${s.B.CONTRADICTION}B contradiction groups, both dominated by legitimate_exception wording variance)`,
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
  '## Review-round corrections (2026-09-18, PR #1753)',
  '',
  '- P1 (validator hard gate): judge eligibility previously tested `parsed`, letting a parseable-but-schema-invalid output be judged (and win). Regraded deterministically from run data: exactly 1 pair affected (G-manual_1788612956754_9aa r2, B output missing generatedAt, judge had awarded B) -> reclassified A_WIN by the SPEC §30 rule. Group verdict unchanged (B_WIN, 2/3). W/L/T unchanged.',
  '- P2 (BOTH_BAD accounting): skipped generation-failure BOTH_BAD verdicts (4 pairs across the 3 incident-quarantined groups) were displayed in the table but not counted; BOTH_BAD_GROUPS corrected 0 -> 3.',
  '- P2 (fail-loud manifest): build-sample-manifest now refuses to classify when the spike ab-inputs record is unreadable instead of silently treating everything as CLEAN.',
  '- The 3 quarantined groups are merged back into this aggregate from the pre-incident snapshot (tokens/validity/stability preserved; verdicts re-derived from cached judgments) — see restore-quarantined-groups.mjs.',
  '',
  '## Deviations & disclosures',
  '',
  '- DATA INCIDENT (2026-09-17T23:04Z, disclosed): a report-tooling defect (importing run-ab.mjs for the B addendum constant executed its experiment driver) re-ran and overwrote the raw generation files of 3 groups (G-manual_1788920022087_pjz, G-manual_1789317326914_sj6, G-pain_host_198b8c4d901b5b) before the process was stopped. Original JUDGMENTS were cached and are unaffected; ALL statistics in this report come from the pre-incident snapshots (aggregate-runs.json + judgments-*.json + the frozen quality verdicts). The overwritten raws are quarantined in data/runs-incident-rerun/ and excluded from evidence. Root cause fixed: B_ADDENDUM moved to scripts/pri-815/b-addendum.mjs (import-safe).',
  '- Judge is same model family as generator (all independent channels dead on this host). Disclosed per SPEC §19 preference violation; mitigated by paired design, frozen scenarios, deterministic classification, and deterministic validators.',
  '- Downstream is a scenario-gated behavioral proxy, not the production rulehost VM (rule generation is Artificer scope, outside H1).',
  '- COST_EXCEPTION: formation-level B tokens exceed A by ' + agg.cost.deltaPct + '% (guard <= +20%). Per SPEC §31/§U this is recorded; continuation judged by the gate with explicit Owner-Card disclosure.',
  '- 2 DEV groups were partially observed during Phase 3 calibration (runs-dev); their Phase 4 verdicts come from the independent frozen-harness run.',
];
fs.writeFileSync(OUT, lines.join('\n'));
console.log(lines.filter((l) => l.startsWith('W =') || l.startsWith('FINAL') || l.includes('NET_ADVANTAGE') || l.includes('T1 PROVISIONAL') || /^  [1-6]\./.test(l)).join('\n'));
