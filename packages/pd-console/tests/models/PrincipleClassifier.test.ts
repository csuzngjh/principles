import { describe, it, expect } from 'vitest';
import { classifyPrinciple, classifyPrinciples, filterOwnerActionable } from '../../src/server/models/PrincipleClassifier.js';
import type { PrincipleListItem } from '../../src/server/models/PrinciplesConsoleModel.js';

function makePrinciple(overrides: Partial<PrincipleListItem> = {}): PrincipleListItem {
  return {
    id: 'P_001',
    text: 'Test principle',
    triggerPattern: 'test pattern',
    action: 'test action',
    status: 'candidate',
    priority: 'P2',
    scope: 'general',
    domain: null,
    evaluability: 'manual_only',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    ruleCount: 0,
    conflictsWithCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('classifyPrinciple', () => {
  it('classifies registry ids T-01..T-10 as builtin', () => {
    expect(classifyPrinciple(makePrinciple({ id: 'T-01' }))).toBe('builtin');
    expect(classifyPrinciple(makePrinciple({ id: 'T-05' }))).toBe('builtin');
    expect(classifyPrinciple(makePrinciple({ id: 'T-07' }))).toBe('builtin');
    expect(classifyPrinciple(makePrinciple({ id: 'T-10' }))).toBe('builtin');
  });

  it('does NOT classify T-11, T-100, T-0 as builtin', () => {
    expect(classifyPrinciple(makePrinciple({ id: 'T-11', status: 'candidate' }))).toBe('owner_actionable');
    expect(classifyPrinciple(makePrinciple({ id: 'T-100', status: 'candidate' }))).toBe('owner_actionable');
    expect(classifyPrinciple(makePrinciple({ id: 'T-0', status: 'candidate' }))).toBe('owner_actionable');
  });

  it('classifies demo principles by keyword', () => {
    expect(classifyPrinciple(makePrinciple({ text: 'This is a [demo] principle' }))).toBe('demo');
    expect(classifyPrinciple(makePrinciple({ id: 'DEMO_001' }))).toBe('demo');
    expect(classifyPrinciple(makePrinciple({ id: 'demo_test' }))).toBe('demo');
    expect(classifyPrinciple(makePrinciple({ text: 'This is a [example] usage pattern' }))).toBe('demo');
  });

  it('does NOT misclassify real principles mentioning "sample" or "template" in text', () => {
    // These should be owner_actionable because text keywords are now bracket-only
    expect(classifyPrinciple(makePrinciple({ text: 'Use a sample to verify output' }))).toBe('owner_actionable');
    expect(classifyPrinciple(makePrinciple({ text: 'Follow the template pattern for consistency' }))).toBe('owner_actionable');
  });

  it('classifies smoke test principles by keyword', () => {
    expect(classifyPrinciple(makePrinciple({ text: 'This is a [smoke] test for CI' }))).toBe('smoke');
    expect(classifyPrinciple(makePrinciple({ id: 'SMOKE_001' }))).toBe('smoke');
    expect(classifyPrinciple(makePrinciple({ id: 'smoke_test_1' }))).toBe('smoke');
  });

  it('classifies story-a / dogfood principles as demo', () => {
    expect(classifyPrinciple(makePrinciple({ id: 'story-a_P_001' }))).toBe('demo');
    expect(classifyPrinciple(makePrinciple({ id: 'story_a_test' }))).toBe('demo');
    expect(classifyPrinciple(makePrinciple({ id: 'dogfood_001' }))).toBe('demo');
  });

  it('classifies probe / test_principle as smoke', () => {
    expect(classifyPrinciple(makePrinciple({ id: 'probe_001' }))).toBe('smoke');
    expect(classifyPrinciple(makePrinciple({ id: 'test_principle_check' }))).toBe('smoke');
  });

  it('classifies archived/deprecated as historical', () => {
    expect(classifyPrinciple(makePrinciple({ status: 'archived' }))).toBe('historical');
    expect(classifyPrinciple(makePrinciple({ status: 'deprecated' }))).toBe('historical');
  });

  it('classifies active as already_decided', () => {
    expect(classifyPrinciple(makePrinciple({ status: 'active' }))).toBe('already_decided');
  });

  it('classifies candidate/probation as owner_actionable', () => {
    expect(classifyPrinciple(makePrinciple({ status: 'candidate' }))).toBe('owner_actionable');
    expect(classifyPrinciple(makePrinciple({ status: 'probation' }))).toBe('owner_actionable');
  });

  it('prioritizes builtin over historical', () => {
    // T-01 with archived status should still be builtin
    expect(classifyPrinciple(makePrinciple({ id: 'T-01', status: 'archived' }))).toBe('builtin');
  });

  it('prioritizes demo over historical', () => {
    expect(classifyPrinciple(makePrinciple({ id: 'DEMO_old', text: '[demo] principle', status: 'archived' }))).toBe('demo');
  });

  it('classifies principle with decidedPrincipleIds as already_decided', () => {
    // A candidate principle that was rejected via approval queue
    const decidedIds = new Set(['P_REJECTED']);
    expect(classifyPrinciple(makePrinciple({ id: 'P_REJECTED', status: 'candidate' }), decidedIds)).toBe('already_decided');
  });

  it('classifies principle with decidedPrincipleIds as already_decided even if approved', () => {
    const decidedIds = new Set(['P_APPROVED']);
    expect(classifyPrinciple(makePrinciple({ id: 'P_APPROVED', status: 'candidate' }), decidedIds)).toBe('already_decided');
  });

  it('does not classify principle as already_decided when not in decidedPrincipleIds', () => {
    const decidedIds = new Set(['P_OTHER']);
    expect(classifyPrinciple(makePrinciple({ id: 'P_001', status: 'candidate' }), decidedIds)).toBe('owner_actionable');
  });

  it('builtin takes priority over decidedPrincipleIds', () => {
    // T-01 should still be builtin even if somehow in decidedPrincipleIds
    const decidedIds = new Set(['T-01']);
    expect(classifyPrinciple(makePrinciple({ id: 'T-01', status: 'active' }), decidedIds)).toBe('builtin');
  });
});

describe('classifyPrinciples', () => {
  it('classifies a batch of principles', () => {
    const principles = [
      makePrinciple({ id: 'T-01' }),
      makePrinciple({ id: 'P_001', text: '[demo] test' }),
      makePrinciple({ id: 'P_002', status: 'candidate' }),
      makePrinciple({ id: 'P_003', status: 'archived' }),
    ];
    const classified = classifyPrinciples(principles);
    expect(classified).toHaveLength(4);
    expect(classified[0].category).toBe('builtin');
    expect(classified[1].category).toBe('demo');
    expect(classified[2].category).toBe('owner_actionable');
    expect(classified[3].category).toBe('historical');
  });

  it('classifies a batch with decidedPrincipleIds', () => {
    const principles = [
      makePrinciple({ id: 'P_001', status: 'candidate' }),
      makePrinciple({ id: 'P_REJECTED', status: 'candidate' }),
      makePrinciple({ id: 'P_002', status: 'probation' }),
    ];
    const decidedIds = new Set(['P_REJECTED']);
    const classified = classifyPrinciples(principles, decidedIds);
    expect(classified[0].category).toBe('owner_actionable');
    expect(classified[1].category).toBe('already_decided');
    expect(classified[2].category).toBe('owner_actionable');
  });
});

describe('filterOwnerActionable', () => {
  it('filters to only owner_actionable principles', () => {
    const classified = classifyPrinciples([
      makePrinciple({ id: 'T-01' }),
      makePrinciple({ id: 'P_001', text: '[demo]' }),
      makePrinciple({ id: 'P_002', status: 'candidate' }),
      makePrinciple({ id: 'P_003', status: 'probation' }),
    ]);
    const filtered = filterOwnerActionable(classified);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((c) => c.category === 'owner_actionable')).toBe(true);
  });

  it('returns empty array when no actionable principles', () => {
    const classified = classifyPrinciples([
      makePrinciple({ id: 'T-01' }),
      makePrinciple({ id: 'P_001', text: '[smoke] test' }),
    ]);
    const filtered = filterOwnerActionable(classified);
    expect(filtered).toHaveLength(0);
  });

  it('filters out principles in decidedPrincipleIds', () => {
    const classified = classifyPrinciples(
      [
        makePrinciple({ id: 'P_001', status: 'candidate' }),
        makePrinciple({ id: 'P_REJECTED', status: 'candidate' }),
      ],
      new Set(['P_REJECTED']),
    );
    const filtered = filterOwnerActionable(classified);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].principle.id).toBe('P_001');
  });
});
