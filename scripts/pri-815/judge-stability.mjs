#!/usr/bin/env node
// PRI-815 — behavioral-contract stability judge (SPEC §23–§26).
//
// Per group x arm: the judge sees the FROZEN scenarios (written from the
// diagnosis before any output existed) plus the arm's 3 repeat outputs, and
// classifies each output's stance on every scenario. Classification into
// STABLE / MATERIAL_DRIFT / CONTRADICTION is then computed DETERMINISTICALLY
// from the per-repeat stances (never by LLM fiat):
//   - same scenario "must_oblige" in one repeat and "must_forbid" in another
//     -> CONTRADICTION
//   - oblige/forbid flips to not_addressed (or key condition changes, as
//     flagged by the judge with concrete scenario + field) -> MATERIAL_DRIFT
//   - otherwise -> STABLE

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, extractJson } from './llm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data');
const runsDirName = process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 'runs';
const runsDir = path.join(DATA, runsDirName);
const OUT = path.join(DATA, `judgments-stability-${runsDirName}.json`);

const SYSTEM = `You are auditing BEHAVIORAL CONTRACT STABILITY across three independently generated drafts of the SAME principle (same source, three runs).
For each SCENARIO, decide for EVERY draft what the draft's behavioral contract implies:
- "must_oblige": this draft, read as an agent rule, obligates the scenario's compliant action (or forbids the violation the scenario describes, for target_violation scenarios)
- "must_forbid": this draft forbids behavior that the scenario describes as legitimate
- "allows_neutral": this draft permits the scenario without obligating anything about it
- "not_addressed": this draft does not cover this scenario's domain

Judge each draft SEPARATELY and only from its own text (statement, applicability, antiPatterns, intentContract). Do not average.

Return ONLY JSON:
{"drafts":[{"repeat":1,"stances":{"<scenario_kind>":"must_oblige|must_forbid|allows_neutral|not_addressed"}}],
 "driftFindings":[{"betweenRepeats":[1,2],"kind":"key_condition_change|exception_change|scope_change","detail":"...","scenarioKind":"...","field":"<contract field>"},{...}],
 "contradictionFindings":[{"betweenRepeats":[1,3],"scenarioKind":"...","detail":"repeat N obligates what repeat M forbids"}]}`;

const scenarios = JSON.parse(fs.readFileSync(path.join(DATA, 'scenarios.json'), 'utf8')).scenarios;
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { groups: {} };

for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json'))) {
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
  const sc = scenarios[run.group];
  if (!sc) { console.log(`[skip] ${run.group}: no frozen scenarios`); continue; }
  for (const arm of ['A', 'B']) {
    const key = `${run.group}#${arm}`;
    if (out.groups[key]) continue;
    const drafts = run.repeats.filter((r) => r[`scribe_${arm}`]?.parsed).map((r) => ({
      repeat: r.repeat,
      draft: r[`scribe_${arm}`].parsed,
    }));
    if (drafts.length < 2) { out.groups[key] = { key, classification: 'INSUFFICIENT_REPEATS', drafts: drafts.length }; continue; }
    const res = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ SCENARIOS: sc.scenarios, DRAFTS: drafts }) },
    ], { maxTokens: 4000, thinking: 'disabled' });
    const parsed = extractJson(res.content);
    const valid = parsed && Array.isArray(parsed.drafts) && parsed.drafts.length === drafts.length;
    let classification = 'JUDGE_INVALID';
    const stances = {};
    if (valid) {
      for (const d of parsed.drafts) stances[d.repeat] = d.stances ?? {};
      // deterministic classification
      const kinds = sc.scenarios.map((s) => s.kind);
      let contra = 0, drift = 0;
      const repeatIds = parsed.drafts.map((d) => d.repeat);
      for (const kind of kinds) {
        const vals = repeatIds.map((rid) => stances[rid]?.[kind] ?? 'not_addressed');
        const hasOblige = vals.includes('must_oblige');
        const hasForbid = vals.includes('must_forbid');
        if (hasOblige && hasForbid) contra += 1;
        else {
          const addressed = vals.filter((v) => v === 'must_oblige' || v === 'must_forbid').length;
          if (addressed > 0 && addressed < vals.length) drift += 1;
        }
      }
      const judgeContra = Array.isArray(parsed.contradictionFindings) ? parsed.contradictionFindings.length : 0;
      const judgeDrift = Array.isArray(parsed.driftFindings) ? parsed.driftFindings.length : 0;
      classification = (contra > 0 || judgeContra > 0) ? 'CONTRADICTION'
        : (drift > 0 || judgeDrift > 0) ? 'MATERIAL_DRIFT' : 'STABLE';
      out.groups[key] = { key, classification, stances, driftFindings: parsed.driftFindings ?? [], contradictionFindings: parsed.contradictionFindings ?? [] };
    } else {
      out.groups[key] = { key, classification: 'JUDGE_INVALID', raw: (res.content || '').slice(0, 400), usage: res.usage };
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(`[ok] ${key} -> ${classification}`);
  }
}
console.log('stability judgments done:', Object.keys(out.groups).length);
