import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { addPrincipleToLedger, loadLedger } from '../../../principle-tree-ledger.js';
import type { LedgerPrinciple } from '../../../principle-tree-ledger.js';
import {
  buildReuseShortlist,
  isReusablePrincipleStatus,
  readReusablePrinciples,
} from '../reuse-retrieval.js';
import { selectReuseShortlist, tokenizeForReuse } from '../reuse-shortlist.js';
import type { ReuseCandidateInput, ReusablePrinciple } from '../reuse-domain.js';

/**
 * PRI-917 Slice 1 — deterministic shortlist.
 *
 * These tests build a REAL ledger document through `addPrincipleToLedger`
 * (no mocked loader): the retrieval contract is "reads the canonical ledger",
 * so the test must exercise the canonical reader too.
 */

let stateDir: string;

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: randomUUID(),
    version: 1,
    text: 'Test principle',
    triggerPattern: 'always',
    action: 'enforce',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 0.5,
    adherenceRate: 0.8,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A candidate that is semantically the same problem as `text`. */
const CANDIDATE_ABOUT_EVIDENCE: ReuseCandidateInput = {
  text: '任何结论必须由可观察证据背书，无查验则显式降级为推断。',
  triggerPattern: '在没有外部证据就做出确定性结论时',
  action: '先核验可观察状态再断言',
};

beforeEach(() => {
  stateDir = join(process.env.TEMP ?? '.', `pd-reuse-test-${randomUUID()}`);
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// T1 — empty ledger
// ---------------------------------------------------------------------------

describe('T1 — empty ledger returns an empty shortlist', () => {
  it('produces no candidates when no principle exists', () => {
    const result = buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir);
    expect(result.candidates).toEqual([]);
    expect(result.eligibleCount).toBe(0);
    expect(result.consideredCount).toBe(0);
  });

  it('produces no candidates when every principle is filtered out by status', () => {
    addPrincipleToLedger(stateDir, makePrinciple({ text: CANDIDATE_ABOUT_EVIDENCE.text, status: 'archived' }));
    addPrincipleToLedger(stateDir, makePrinciple({ text: CANDIDATE_ABOUT_EVIDENCE.text, status: 'deprecated' }));
    const result = buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir);
    expect(result.candidates).toEqual([]);
    expect(result.eligibleCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T2 — a matching existing principle is surfaced, deterministically
// ---------------------------------------------------------------------------

describe('T2 — existing matching principle is returned', () => {
  it('surfaces the same-problem principle with explainable evidence', () => {
    const exact = makePrinciple({
      text: '任何结论必须由可观察证据背书，无查验则显式降级为推断。',
      triggerPattern: '在没有外部证据就做出确定性结论时',
      action: '先核验可观察状态再断言',
    });
    addPrincipleToLedger(stateDir, exact);
    addPrincipleToLedger(stateDir, makePrinciple({ text: 'MV 素材导出后必须核对帧数与音轨对齐。' }));

    const result = buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir);

    expect(result.candidates).toHaveLength(1);
    const [top] = result.candidates;
    if (!top) throw new Error('expected exactly one shortlist candidate');
    expect(top.principleId).toBe(exact.id);
    // A full three-field match scores high but not 1.0: the cross-field pairs
    // (text↔action) contribute their own coverage, so the weighted mean lands
    // below the ceiling even when every same-field pair is a perfect match.
    expect(top.score).toBeGreaterThan(0.8);
    expect(top.evidence.length).toBeGreaterThan(0);
    const [firstEvidence] = top.evidence;
    expect(firstEvidence?.sharedTerms.length ?? 0).toBeGreaterThan(0);
    // Explainable: a human-readable reason names terms and a field.
    expect(top.similarityReason).toContain('coverage');
    // The unrelated principle must not outrank the exact match.
    expect(result.eligibleCount).toBe(2);
  });

  it('returns nothing when nothing is semantically close', () => {
    addPrincipleToLedger(stateDir, makePrinciple({ text: 'MV 素材导出后必须核对帧数与音轨对齐。' }));
    addPrincipleToLedger(stateDir, makePrinciple({ text: '提交前运行完整回归测试并留存证据。' }));
    const result = buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir);
    expect(result.candidates).toEqual([]);
    expect(result.eligibleCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T3 — determinism
// ---------------------------------------------------------------------------

describe('T3 — same input produces the same ordering', () => {
  const corpus: ReusablePrinciple[] = [
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', text: '任何结论必须由可观察证据背书，无查验则显式降级为推断。', triggerPattern: '在没有外部证据就做出确定性结论时', action: '先核验可观察状态再断言', status: 'active' },
    { id: 'bbbbbbbb-0000-0000-0000-000000000002', text: '结论必须由可观察证据背书，不得在无查验时断言。', triggerPattern: '证据缺失时', action: '先核验可观察状态再断言', status: 'candidate' },
    { id: 'cccccccc-0000-0000-0000-000000000003', text: '完全无关的原则：素材导出后核对帧数。', triggerPattern: '导出后', action: '核对帧数', status: 'active' },
  ];

  it('is stable across repeated calls', () => {
    const first = selectReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, corpus);
    const second = selectReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, corpus);
    expect(second.candidates.map((c) => c.principleId)).toEqual(first.candidates.map((c) => c.principleId));
    expect(second.candidates.map((c) => c.score)).toEqual(first.candidates.map((c) => c.score));
  });

  it('is independent of ledger insertion order (total order: score desc, id asc)', () => {
    const forward = selectReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, corpus);
    const reversed = selectReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, [...corpus].reverse());
    expect(reversed.candidates.map((c) => c.principleId)).toEqual(forward.candidates.map((c) => c.principleId));
  });

  it('breaks exact score ties by principleId so ordering is total', () => {
    const tied: ReusablePrinciple[] = [
      { id: 'zzzzzzzz-0000-0000-0000-000000000009', text: '共同文本甲', triggerPattern: '', action: '', status: 'active' },
      { id: 'aaaaaaaaaaaaaaaa-0000-0000-0000-000000000001', text: '共同文本甲', triggerPattern: '', action: '', status: 'active' },
    ];
    const result = selectReuseShortlist({ text: '共同文本甲', triggerPattern: '', action: '' }, tied);
    expect(result.candidates.map((c) => c.principleId)).toEqual([
      'aaaaaaaaaaaaaaaa-0000-0000-0000-000000000001',
      'zzzzzzzz-0000-0000-0000-000000000009',
    ]);
  });

  it('tokenizer is deterministic and CJK-aware (bigrams, not one blob)', () => {
    const tokens = tokenizeForReuse('结论必须由证据背书');
    expect(tokens).toEqual(tokenizeForReuse('结论必须由证据背书'));
    expect(tokens.length).toBeGreaterThan(3);
    expect(tokens).toContain('结论');
  });
});

// ---------------------------------------------------------------------------
// T4 — realistic corpus size stays cheap
// ---------------------------------------------------------------------------

describe('T4 — realistic corpus size performs acceptably', () => {
  it('scores 127 principles well within an interactive budget', () => {
    const seeds = [
      '任何结论必须由可观察证据背书，无查验则显式降级为推断。',
      '先核查既有资产再执行变更，避免基于自身推断行动。',
      '交付前对照可观察输出核查，不把已执行等同于已达标。',
      '路径内失效只支持路径内结论，不得表述为系统能力上限。',
      '任何能力判定前先穷尽既有正确路径并核实测量手段有效。',
    ];
    const stateBefore = loadLedger(stateDir);
    for (let i = 0; i < 127; i++) {
      addPrincipleToLedger(stateDir, makePrinciple({
        text: `${seeds[i % seeds.length]}（变体 ${i}）`,
        triggerPattern: `触发条件 ${i}`,
        action: `执行动作 ${i}`,
      }));
    }
    expect(Object.keys(stateBefore.tree.principles).length).toBe(0);

    const started = process.hrtime.bigint();
    const result = buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(result.eligibleCount).toBe(127);
    expect(result.candidates.length).toBeLessThanOrEqual(3); // Top-K bounded
    // Generous ceiling: this is a guard against an accidental O(n^2) or
    // per-call indexing, not a performance benchmark.
    expect(elapsedMs).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// T5 — non-principle kinds must never enter the reuse path
// ---------------------------------------------------------------------------

describe('T5 — non-principle candidate kinds are refused', () => {
  it.each(['rule', 'prompt', 'implementation', 'defer', 'unknown_kind', null, 42, { toString: () => 'rule' }])(
    'refuses recommendationKind=%s with an ineligible shortlist',
    (kind) => {
      addPrincipleToLedger(stateDir, makePrinciple({ text: CANDIDATE_ABOUT_EVIDENCE.text }));
      const result = buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir, { recommendationKind: kind });
      expect(result.candidateKindEligible).toBe(false);
      expect(result.candidates).toEqual([]);
      expect(result.eligibleCount).toBe(0);
    },
  );

  it('treats an ABSENT kind as "not restricted" — the caller supplies the kind to get the guarantee', () => {
    addPrincipleToLedger(stateDir, makePrinciple({ text: CANDIDATE_ABOUT_EVIDENCE.text }));
    // `undefined` means the caller did not supply a kind. That is allowed here
    // (read-side proposal); Slice 2 always passes the raw persisted kind so
    // the refusal above is what production actually gets.
    const absent = buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir, {});
    expect(absent.candidateKindEligible).toBe(true);
    expect(absent.candidates).toHaveLength(1);
  });

  it('accepts the principle kind and an absent kind', () => {
    addPrincipleToLedger(stateDir, makePrinciple({ text: CANDIDATE_ABOUT_EVIDENCE.text }));
    expect(buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir, { recommendationKind: 'principle' }).candidateKindEligible).toBe(true);
    expect(buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir, {}).candidateKindEligible).toBe(true);
  });

  it('only reusable statuses are read back', () => {
    addPrincipleToLedger(stateDir, makePrinciple({ status: 'active' }));
    addPrincipleToLedger(stateDir, makePrinciple({ status: 'candidate' }));
    addPrincipleToLedger(stateDir, makePrinciple({ status: 'probation' }));
    addPrincipleToLedger(stateDir, makePrinciple({ status: 'archived' }));
    addPrincipleToLedger(stateDir, makePrinciple({ status: 'deprecated' }));

    const read = readReusablePrinciples(stateDir);
    expect(read).toHaveLength(3);
    expect(read.every((p) => isReusablePrincipleStatus(p.status))).toBe(true);
  });

  it('fails closed on an unrecognised status', () => {
    expect(isReusablePrincipleStatus('totally_made_up')).toBe(false);
    expect(isReusablePrincipleStatus(undefined)).toBe(false);
    expect(isReusablePrincipleStatus('archived')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-regression: the ledger read path is untouched
// ---------------------------------------------------------------------------

describe('reuse retrieval is read-only', () => {
  it('does not mutate the ledger document', () => {
    const original = makePrinciple({ text: CANDIDATE_ABOUT_EVIDENCE.text, derivedFromPainIds: ['cand-1'] });
    addPrincipleToLedger(stateDir, original);
    const before = JSON.stringify(loadLedger(stateDir));

    buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir);

    expect(JSON.stringify(loadLedger(stateDir))).toBe(before);
  });

  it('never writes into derivedFromPainIds', () => {
    const original = makePrinciple({ text: CANDIDATE_ABOUT_EVIDENCE.text, derivedFromPainIds: ['cand-1'] });
    addPrincipleToLedger(stateDir, original);
    buildReuseShortlist(CANDIDATE_ABOUT_EVIDENCE, stateDir);
    const stored = loadLedger(stateDir).tree.principles[original.id];
    expect(stored?.derivedFromPainIds).toEqual(['cand-1']);
  });
});
