#!/usr/bin/env node
// One-shot review fix (PR #1753 Codex P1): regrade cached quality judgments
// against the deterministic §30 hard gate. Deterministic — no LLM involved.
//
// Rule: a pair is judge-eligible ONLY when BOTH arms passed the production
// validator (scribe_*.ok). Previously the gate tested `parsed`, so a
// parseable-but-schema-invalid output could be judged and even win. This pass
// reclassifies every cached pair whose run data shows an arm validator
// failure: asymmetric -> valid arm wins; dual -> BOTH_BAD. Judge-issued
// results on fully-valid pairs are untouched.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data');
const runsDir = path.join(DATA, 'runs');
const J = path.join(DATA, 'judgments-quality-runs.json');

const judgments = JSON.parse(fs.readFileSync(J, 'utf8'));
let regraded = 0;
for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json'))) {
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
  for (const r of run.repeats) {
    const key = `${run.group}#r${r.repeat}`;
    const j = judgments.pairs[key];
    if (!j) continue;
    const aOk = r.scribe_A?.ok === true;
    const bOk = r.scribe_B?.ok === true;
    if (aOk && bOk) continue; // fully valid pair: judge verdict stands
    const verdict = aOk ? 'A' : bOk ? 'B' : 'BOTH_BAD';
    if (j.verdict === verdict && j.skipped) continue; // already correct
    judgments.pairs[key] = {
      key,
      skipped: r.scribe_A?.parsed || r.scribe_B?.parsed ? 'validator_failure' : 'generation_failure',
      aValid: aOk, bValid: bOk, verdict,
      reasons: 'regraded by deterministic §30 hard gate (review fix): arm output failed the production validator; judge-issued verdict superseded',
      priorVerdict: j.verdict, priorSkipped: j.skipped ?? null,
    };
    regraded += 1;
    console.log(`[regrade] ${key}: ${j.verdict} -> ${verdict}`);
  }
}
fs.writeFileSync(J, JSON.stringify(judgments, null, 1));
console.log(`regraded ${regraded} pair(s)`);
