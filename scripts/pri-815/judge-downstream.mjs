#!/usr/bin/env node
// PRI-815 — downstream behavioral evaluation (SPEC §28, exploratory proxy).
//
// The production rulehost VM requires Artificer-generated rules, which is
// outside H1's variable (Scribe information flow). Downstream utility is
// therefore measured as a scenario-gated behavioral judgment over the frozen
// scenarios — an APPROXIMATION, explicitly reported as such:
//   target_violation  -> principle must BLOCK (forbid/oblige stop)
//   valid_compliant   -> must stay ALLOWED
//   near_boundary_legal -> must stay ALLOWED (false-positive check)
//   out_of_scope      -> must stay ALLOWED (overblocking check)
//   legitimate_exception -> exception must be honored (allowed or explicitly bounded)
// Scored per arm on the arm's consensus behavior across repeats.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, extractJson } from './llm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data');
const runsDirName = process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 'runs';
const runsDir = path.join(DATA, runsDirName);
const OUT = path.join(DATA, `judgments-downstream-${runsDirName}.json`);

const SYSTEM = `You are evaluating whether a principle draft, used as an agent BEHAVIOR GATE, handles concrete scenarios correctly.
For each scenario, decide what this principle (statement + applicability + antiPatterns + intentContract) would do:
- "block": the principle forbids/intercepts the scenario's behavior
- "allow": the principle permits it (including simply not covering it)
- "exception_honored": for legitimate_exception scenarios where the principle explicitly bounds its obligation
Return ONLY JSON:
{"results":{"target_violation":"block|allow","valid_compliant":"block|allow","near_boundary_legal":"block|allow","out_of_scope":"block|allow","legitimate_exception":"block|allow|exception_honored"},
 "notes":"<=80 words on the most consequential misjudgment if any"}`;

const scenarios = JSON.parse(fs.readFileSync(path.join(DATA, 'scenarios.json'), 'utf8')).scenarios;
const frozen = JSON.parse(fs.readFileSync(path.join(DATA, 'frozen-inputs.json'), 'utf8')).groups;
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { groups: {} };

for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json'))) {
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
  const sc = scenarios[run.group];
  if (!sc) continue;
  for (const arm of ['A', 'B']) {
    const key = `${run.group}#${arm}`;
    if (out.groups[key]) continue;
    const drafts = run.repeats.filter((r) => r[`scribe_${arm}`]?.parsed);
    if (drafts.length === 0) { out.groups[key] = { key, evaluation: 'NO_VALID_OUTPUT' }; continue; }
    const res = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ SCENARIOS: sc.scenarios, PRINCIPLE_DRAFTS_ALL_REPEATS: drafts.map((d) => d[`scribe_${arm}`].parsed) }) },
    ]);
    const parsed = extractJson(res.content);
    const valid = parsed?.results && typeof parsed.results.target_violation === 'string';
    out.groups[key] = valid
      ? { key, evaluation: parsed.results, notes: parsed.notes ?? '' }
      : { key, evaluation: 'JUDGE_INVALID', raw: (res.content || '').slice(0, 300) };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(`[ok] ${key} -> ${valid ? JSON.stringify(parsed.results) : 'JUDGE_INVALID'}`);
  }
}
console.log('downstream judgments done:', Object.keys(out.groups).length);
