#!/usr/bin/env node
// PRI-815 — blind pairwise quality judge (SPEC §19/§20).
//
// Per group x repeat: judge sees the SAME source evidence (diagnosis summary +
// evidence + violatedPrinciples) and the two principle outputs labeled X/Y in
// a seeded-random order. The judge does NOT know which arm X/Y is. Fixed
// 10-dimension rubric; verdict in {X, Y, TIE, BOTH_BAD} + per-dim scores +
// reasons. Failures (unparseable judge output) stay recorded, never dropped.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chat, extractJson } from './llm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data');
const runsDirName = process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 'runs';
const runsDir = path.join(DATA, runsDirName);
const OUT = path.join(DATA, `judgments-quality-${runsDirName}.json`);

function seededBool(seed) {
  return parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) % 2 === 1;
}
// read-parse-or-default: avoids existsSync→readFileSync TOCTOU (CodeQL)
function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const SYSTEM = `You are an impartial quality judge for agent-behavior principles. You will see:
1. SOURCE EVIDENCE — the diagnosis (summary, rootCause, evidence, violatedPrinciples) a principle formation started from.
2. OUTPUT X and OUTPUT Y — two independently formed principle drafts (principleDraft + intentContract + risks), produced from that same source.

Judge ONLY against the fixed rubric below. Do not reward length; do not reward generic wisdom. Score each dimension 0-10 for X and for Y:

1. Intent fidelity — does the principle faithfully express what the source diagnosis actually wants prevented/achieved?
2. Evidence grounding — are concrete claims traceable to the source evidence? Penalize invented specifics AND evidence-free generalities.
3. Specificity — concrete enough to guide implementation (observable actions, not slogans).
4. Generalization without overreach — generalizes beyond the single incident WITHOUT covering cases the source pain does not support.
5. Boundary clarity — when it applies and when it does not (exceptions, scope limits).
6. Actionability — could an agent decide behavior from this today?
7. Contradiction avoidance — internal consistency (statement vs antiPatterns vs intentContract).
8. Anti-pattern quality — do the antiPatterns name the real failure family from the evidence?
9. Risk completeness — are the meaningful application risks named?
10. Unnecessary abstraction / padding — penalize filler, ceremonial breadth, restatements (higher score = less padding).

Return ONLY JSON:
{"scores":{"1":[x,y],"2":[x,y],"3":[x,y],"4":[x,y],"5":[x,y],"6":[x,y],"7":[x,y],"8":[x,y],"9":[x,y],"10":[x,y]},
 "verdict":"X"|"Y"|"TIE"|"BOTH_BAD",
 "reasons":"<=120 words, cite dimensions that decided it",
 "bothBadReason":"when verdict is BOTH_BAD, why both fail"}`;

const frozen = readJsonOr(path.join(DATA, 'frozen-inputs.json'), { groups: [] }).groups;
const diagByGroup = new Map(frozen.map((g) => [g.source_group_id, g.diagnosis]));
const judgments = readJsonOr(OUT, { pairs: {} });

for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json'))) {
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
  const diag = diagByGroup.get(run.group);
  if (!diag) continue;
  for (const r of run.repeats) {
    const key = `${run.group}#r${r.repeat}`;
    if (judgments.pairs[key]) continue;
    const a = r.scribe_A, b = r.scribe_B;
    // SPEC §30 hard gate: only outputs that PASSED the production validator
    // are eligible to be judged. A parseable-but-invalid output is a failure
    // for its arm — asymmetric failure awards the pair to the valid arm,
    // dual failure is BOTH_BAD. Never dropped (stays in the denominator).
    if (!a?.ok || !b?.ok) {
      const verdict = a?.ok ? 'A' : b?.ok ? 'B' : 'BOTH_BAD';
      judgments.pairs[key] = {
        key, skipped: a?.parsed || b?.parsed ? 'validator_failure' : 'generation_failure',
        aValid: !!a?.ok, bValid: !!b?.ok, verdict,
        reasons: 'arm output failed the deterministic production validator (SPEC §30): the valid arm wins; both invalid = BOTH_BAD',
      };
      continue;
    }
    const bIsX = seededBool(key);
    const X = bIsX ? b.parsed : a.parsed;
    const Y = bIsX ? a.parsed : b.parsed;
    const source = {
      summary: diag.summary, rootCause: diag.rootCause,
      evidence: diag.evidence, violatedPrinciples: diag.violatedPrinciples,
    };
    const res = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ SOURCE_EVIDENCE: source, OUTPUT_X: X, OUTPUT_Y: Y }) },
    ]);
    const parsed = extractJson(res.content);
    const valid = parsed && ['X', 'Y', 'TIE', 'BOTH_BAD'].includes(parsed.verdict)
      && parsed.scores && Object.keys(parsed.scores).length === 10;
    judgments.pairs[key] = {
      key, bIsX, judgeValid: !!valid,
      verdict: valid ? (parsed.verdict === 'X' ? (bIsX ? 'B' : 'A') : parsed.verdict === 'Y' ? (bIsX ? 'A' : 'B') : parsed.verdict) : 'JUDGE_INVALID',
      scores: valid ? parsed.scores : null,
      reasons: valid ? parsed.reasons : (res.content || '').slice(0, 400),
      usage: res.usage,
    };
    fs.writeFileSync(OUT, JSON.stringify(judgments, null, 1));
    console.log(`[ok] ${key} -> ${judgments.pairs[key].verdict}`);
  }
}
console.log('quality judgments done:', Object.keys(judgments.pairs).length);
