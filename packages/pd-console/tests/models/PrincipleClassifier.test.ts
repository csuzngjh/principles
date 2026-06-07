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
  it('classifies T-01..T-10 as builtin', () => {
    expect(classifyPrinciple(makePrinciple({ id: 'T-01' }))).toBe('builtin');
    expect(classifyPrinciple(makePrinciple({ id: 'T-05' }))).toBe('builtin');
    expect(classifyPrinciple(makePrinciple({ id: 'T-10' }))).toBe('builtin');
  });

  it('classifies demo principles by keyword', () => {
    expect(classifyPrinciple(makePrinciple({ text: 'This is a demo principle' }))).toBe('demo');
    expect(classifyPrinciple(makePrinciple({ id: 'DEMO_001' }))).toBe('demo');
    expect(classifyPrinciple(makePrinciple({ text: 'Example usage pattern' }))).toBe('demo');
  });

  it('classifies smoke test principles by keyword', () => {
    expect(classifyPrinciple(makePrinciple({ text: 'Smoke test for CI' }))).toBe('smoke');
    expect(classifyPrinciple(makePrinciple({ id: 'SMOKE_001' }))).toBe('smoke');
  });

  it('classifies archived/deprecated as historical', () => {
    expect(classifyPrinciple(makePrinciple({ status: 'archived' }))).toBe('historical');
    expect(classifyPrinciple(makePrinciple({ status: 'deprecated' }))).toBe('historical');
  });

  it('classifies candidate/probation/active as owner_actionable', () => {
    expect(classifyPrinciple(makePrinciple({ status: 'candidate' }))).toBe('owner_actionable');
    expect(classifyPrinciple(makePrinciple({ status: 'probation' }))).toBe('owner_actionable');
    expect(classifyPrinciple(makePrinciple({ status: 'active' }))).toBe('owner_actionable');
  });

  it('prioritizes builtin over historical', () => {
    // T-01 with archived status should still be builtin
    expect(classifyPrinciple(makePrinciple({ id: 'T-01', status: 'archived' }))).toBe('builtin');
  });

  it('prioritizes demo over historical', () => {
    expect(classifyPrinciple(makePrinciple({ text: 'demo principle', status: 'archived' }))).toBe('demo');
  });
});

describe('classifyPrinciples', () => {
  it('classifies a batch of principles', () => {
    const principles = [
      makePrinciple({ id: 'T-01' }),
      makePrinciple({ id: 'P_001', text: 'demo test' }),
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
});

describe('filterOwnerActionable', () => {
  it('filters to only owner_actionable principles', () => {
    const classified = classifyPrinciples([
      makePrinciple({ id: 'T-01' }),
      makePrinciple({ id: 'P_001', text: 'demo' }),
      makePrinciple({ id: 'P_002', status: 'candidate' }),
      makePrinciple({ id: 'P_003', status: 'active' }),
    ]);
    const filtered = filterOwnerActionable(classified);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((c) => c.category === 'owner_actionable')).toBe(true);
  });

  it('returns empty array when no actionable principles', () => {
    const classified = classifyPrinciples([
      makePrinciple({ id: 'T-01' }),
      makePrinciple({ id: 'P_001', text: 'smoke test' }),
    ]);
    const filtered = filterOwnerActionable(classified);
    expect(filtered).toHaveLength(0);
  });
});
