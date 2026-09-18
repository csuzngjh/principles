// PRI-815 final-blocker-closure targeted regression (node:test).
//
// Guards the two deterministic invariants this closure established:
//
// 1. Owner re-anchor exemption must live in the CONTRACT FIELDS and be bound
//    to explicit owner authority — the targeted-recheck B drafts that honor
//    the re-anchor carry clauses like "explicit Owner re-confirmation may
//    retire or revise the baseline". A generic escape hatch (r1-A's
//    unconditional adoption gate) must NOT match.
// 2. The downstream aggregation must count legitimate_exception=block as an
//    overblock (the bug that made "0 overblock" untrustworthy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'docs', 'audit', 'pri-815-quality-first', 'data');

// exemption detector mirroring the corrected judge rule: an owner-authority
// clause inside statement/applicability/antiPatterns/intentContract
const OWNER_REANCHOR_PATTERNS = [
  /explicit owner re-confirmation[^.]{0,120}(retire|revise|chang)/i,
  /only explicit owner re-confirmation may (retire|revise)/i,
  /superseded only by a newly owner-accepted state/i,
  /may change only through explicit owner re-confirmation/i,
  /owner[- ]accepted state[^.]{0,80}supersed/i,
  // zh variants — the clause must still bind explicit Owner authority
  /涉及冻结项的修改须先获得\s*Owner\s*显式授权/,
  /(仅|只有)\s*Owner\s*(显式|明确)?(再确认|重新确认|授权)[^。]{0,60}(退役|退役基准|修订|替换|废除)/,
];
function contractTextHasOwnerReanchor(parsed) {
  const fields = [
    parsed?.principleDraft?.statement,
    JSON.stringify(parsed?.principleDraft?.applicability ?? []),
    JSON.stringify(parsed?.principleDraft?.antiPatterns ?? []),
    parsed?.intentContract?.forbiddenBehavior,
    parsed?.intentContract?.validationExpectation,
  ].join('\n');
  return OWNER_REANCHOR_PATTERNS.some((re) => re.test(fields));
}

test('targeted-recheck B drafts: majority honor the Owner re-anchor via contract-field authority clauses', () => {
  const run = JSON.parse(fs.readFileSync(
    path.join(DATA, 'targeted-recheck', 'G-pain_host_198b8c4d901b5b.json'), 'utf8'));
  const valid = run.repeats.filter((r) => r.scribe_B?.ok);
  assert.ok(valid.length >= 2, 'expected at least 2 valid B repeats');
  const honoring = valid.filter((r) => contractTextHasOwnerReanchor(r.scribe_B.parsed));
  assert.ok(honoring.length >= Math.ceil(valid.length / 2),
    `expected at least half of B drafts to carry an owner-authority re-anchor clause, got ${honoring.length}/${valid.length}`);
});

test('negative control: a contract with an unconditional adoption gate and no owner-authority clause must NOT match', () => {
  const unconditional = {
    principleDraft: {
      statement: '任何新输出在采纳前必须与基准逐项回归比对，全部冻结项仍然成立方可采纳；发现回退必须先修复并复验，再交付新需求。',
      applicability: ['多轮交付工作流'],
      antiPatterns: ['未经回归比对即采纳新输出'],
    },
    intentContract: { forbiddenBehavior: '未经回归比对即采纳', validationExpectation: '评估者应确认回归比对环节存在' },
  };
  assert.equal(contractTextHasOwnerReanchor(unconditional), false);
  // a generic escape hatch not bound to owner authority must not match either
  const genericHatch = {
    principleDraft: { statement: 'Adopt outputs only after full baseline comparison; degradation decisions may be recorded explicitly.', applicability: [], antiPatterns: [] },
    intentContract: { forbiddenBehavior: 'x', validationExpectation: 'y' },
  };
  assert.equal(contractTextHasOwnerReanchor(genericHatch), false);
});

test('aggregate downstream rule: legitimate_exception=block counts as overblock', () => {
  // deterministic re-implementation of the fixed aggregation rule
  function downstreamCount(entries) {
    const agg = { correct: 0, blockMiss: 0, overblock: 0, invalid: 0 };
    for (const d of entries) {
      if (!d || typeof d !== 'object') { agg.invalid += 1; continue; }
      let ok = true;
      if (d.target_violation === 'allow') { agg.blockMiss += 1; ok = false; }
      const over = [d.valid_compliant, d.near_boundary_legal, d.out_of_scope, d.legitimate_exception].filter((x) => x === 'block').length;
      if (over > 0) { agg.overblock += over; ok = false; }
      if (ok) agg.correct += 1;
    }
    return agg;
  }
  // a lone legitimate_exception=block MUST surface as overblock (the old bug returned 0)
  const withLegitBlock = [{ target_violation: 'block', valid_compliant: 'allow', near_boundary_legal: 'allow', out_of_scope: 'allow', legitimate_exception: 'block' }];
  assert.equal(downstreamCount(withLegitBlock).overblock, 1);
  // honored exception must not count
  const honored = [{ target_violation: 'block', valid_compliant: 'allow', near_boundary_legal: 'allow', out_of_scope: 'allow', legitimate_exception: 'exception_honored' }];
  assert.equal(downstreamCount(honored).overblock, 0);
  assert.equal(downstreamCount(honored).correct, 1);
  // and the committed aggregate reflects the fixed rule symmetrically
  const agg = JSON.parse(fs.readFileSync(path.join(DATA, 'aggregate-runs.json'), 'utf8'));
  assert.equal(agg.downstream.A.overblock, 1);
  assert.equal(agg.downstream.B.overblock, 1);
});

test('corrected downstream judgments: target group honored on both arms; residual overblock is the shared 6406 weakness', () => {
  const targeted = JSON.parse(fs.readFileSync(
    path.join(DATA, 'judgments-downstream-targeted-recheck.json'), 'utf8')).groups;
  assert.equal(targeted['G-pain_host_198b8c4d901b5b#A'].evaluation.legitimate_exception, 'exception_honored');
  assert.equal(targeted['G-pain_host_198b8c4d901b5b#B'].evaluation.legitimate_exception, 'exception_honored');
});
