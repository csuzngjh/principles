#!/usr/bin/env node
// PRI-815 — OWNER_BLIND_PAIRS.md generator (SPEC §S / §22).
//
// Async Owner calibration package: 8 seeded-random pairs + up to 4 targeted
// (high-risk / judge-disagreement) pairs. The backend does NOT wait for
// answers; this file lets the Owner spot-check blind, post-PR.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data');
const runsDirName = process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 'runs';
const runsDir = path.join(DATA, runsDirName);
const frozen = JSON.parse(fs.readFileSync(path.join(DATA, 'frozen-inputs.json'), 'utf8')).groups;
const qual = JSON.parse(fs.readFileSync(path.join(DATA, `judgments-quality-${runsDirName}.json`), 'utf8')).pairs;

const pairs = [];
for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json'))) {
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
  for (const r of run.repeats) {
    if (!r.scribe_A?.parsed || !r.scribe_B?.parsed) continue;
    pairs.push({ group: run.group, cls: run.class, repeat: r.repeat, A: r.scribe_A.parsed, B: r.scribe_B.parsed });
  }
}
// seeded shuffle, take 8
const seed = 'pri815-owner-calibration';
const rnd = (i) => parseInt(createHash('sha256').update(seed + i).digest('hex').slice(0, 8), 16);
const shuffled = pairs.map((p, i) => ({ p, k: rnd(i) })).sort((a, b) => a.k - b.k).map((x) => x.p);
const random8 = shuffled.slice(0, 8);
// targeted: judge disagreement (TIE or judge-invalid on non-tie groups) + one CLEAN subset
const targeted = [];
for (const p of pairs) {
  if (targeted.length >= 4) break;
  const j = qual[`${p.group}#r${p.repeat}`];
  if (!j || j.skipped) continue;
  if (j.verdict === 'TIE' || j.verdict === 'JUDGE_INVALID') targeted.push({ p, why: `judge=${j.verdict}` });
}
if (targeted.length < 4) {
  for (const p of pairs.filter((x) => x.cls === 'CLEAN')) {
    if (targeted.length >= 4) break;
    if (targeted.some((t) => t.p.group === p.group && t.p.repeat === p.repeat)) continue;
    targeted.push({ p, why: 'clean-holdout subset' });
  }
}

const lines = [
  '# PRI-815 — Owner Blind Calibration Pairs (async, non-blocking)',
  '',
  '> 每个 pair 里 X/Y 的臂归属已随机打乱且记录在文末封存行。Owner 只需对每个 pair 回答：**X 更好 / Y 更好 / 无实质差异 / 两者都不好**。',
  '> 此包不阻塞后端结论；用于 Owner 复核 automated judge 的 calibration（SPEC §22）。',
  '',
];
let seal = [];
const emit = (p, label, why) => {
  const xIsB = parseInt(createHash('sha256').update(label).digest('hex').slice(0, 8), 16) % 2 === 1;
  const X = xIsB ? p.B : p.A;
  const Y = xIsB ? p.A : p.B;
  lines.push(`## ${label}（${p.group} r${p.repeat}${why ? ' · ' + why : ''}）`, '', '### X', '```json', JSON.stringify({ principleDraft: X.principleDraft, intentContract: X.intentContract, risks: X.risks }, null, 1), '```', '', '### Y', '```json', JSON.stringify({ principleDraft: Y.principleDraft, intentContract: Y.intentContract, risks: Y.risks }, null, 1), '```', '');
  seal.push(`${label}: X=${xIsB ? 'B' : 'A'}, Y=${xIsB ? 'A' : 'B'}`);
};
random8.forEach((p, i) => emit(p, `R${i + 1}`, ''));
targeted.forEach((t, i) => emit(t.p, `T${i + 1}`, t.why));
lines.push('---', '', '## 臂归属封存（Owner 回答后核对）', '', '```', ...seal, '```', '');
fs.writeFileSync(path.join(DATA, '..', 'OWNER_BLIND_PAIRS.md'), lines.join('\n'));
console.log(`wrote OWNER_BLIND_PAIRS.md (${random8.length} random + ${targeted.length} targeted)`);
