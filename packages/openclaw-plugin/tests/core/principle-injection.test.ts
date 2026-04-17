import { describe, it, expect } from 'vitest';
import {
  selectPrinciplesForInjection,
  formatPrinciple,
  DEFAULT_PRINCIPLE_BUDGET,
  type InjectablePrinciple,
  type PrincipleSelectionResult,
} from '../../src/core/principle-injection.js';
import type { PrinciplePriority } from '../../src/types/principle-tree-schema.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makePrinciple(overrides: Partial<{
  id: string;
  text: string;
  priority: PrinciplePriority;
  createdAt: string;
}> = {}): InjectablePrinciple {
  return {
    id: overrides.id ?? 'P_001',
    text: overrides.text ?? 'Always verify file content before editing',
    priority: overrides.priority ?? 'P1',
    createdAt: overrides.createdAt ?? '2026-04-01T00:00:00.000Z',
  };
}

function makePrinciples(configs: Array<{ id: string; priority: PrinciplePriority; text?: string; createdAt?: string }>): InjectablePrinciple[] {
  return configs.map(c => makePrinciple({
    id: c.id,
    priority: c.priority,
    text: c.text ?? `Principle ${c.id}`,
    createdAt: c.createdAt ?? '2026-04-01T00:00:00.000Z',
  }));
}

// ---------------------------------------------------------------------------
// Tests: formatPrinciple
// ---------------------------------------------------------------------------

describe('formatPrinciple', () => {
  it('formats a principle as "- [ID] text"', () => {
    const p = makePrinciple({ id: 'P_001', text: 'Always verify before editing' });
    expect(formatPrinciple(p)).toBe('- [P_001] Always verify before editing');
  });

  it('includes the full text even when long', () => {
    const longText = 'A'.repeat(200);
    const p = makePrinciple({ id: 'P_100', text: longText });
    expect(formatPrinciple(p)).toBe(`- [P_100] ${longText}`);
  });
});

// ---------------------------------------------------------------------------
// Tests: selectPrinciplesForInjection — priority ordering
// ---------------------------------------------------------------------------

describe('selectPrinciplesForInjection — priority ordering', () => {
  it('selects P0 principles before P1 and P2', () => {
    const principles = makePrinciples([
      { id: 'P1', priority: 'P2' },
      { id: 'P2', priority: 'P0' },
      { id: 'P3', priority: 'P1' },
    ]);

    const result = selectPrinciplesForInjection(principles, 10000);

    expect(result.selected[0].id).toBe('P2'); // P0 first
    expect(result.selected[1].id).toBe('P3'); // P1 second
    expect(result.selected[2].id).toBe('P1'); // P2 third
  });

  it('selects newer principles first within same priority', () => {
    const principles = makePrinciples([
      { id: 'OLD', priority: 'P1', createdAt: '2026-03-01T00:00:00.000Z' },
      { id: 'NEW', priority: 'P1', createdAt: '2026-04-15T00:00:00.000Z' },
    ]);

    const result = selectPrinciplesForInjection(principles, 10000);

    expect(result.selected[0].id).toBe('NEW'); // Newer first
    expect(result.selected[1].id).toBe('OLD');
  });
});

// ---------------------------------------------------------------------------
// Tests: selectPrinciplesForInjection — budget enforcement
// ---------------------------------------------------------------------------

describe('selectPrinciplesForInjection — budget enforcement', () => {
  it('respects the character budget', () => {
    const principles = makePrinciples(
      Array.from({ length: 20 }, (_, i) => ({
        id: `P_${String(i).padStart(3, '0')}`,
        priority: 'P1' as PrinciplePriority,
        text: `Principle with a reasonably long text description number ${i}`,
      }))
    );

    const budget = 500;
    const result = selectPrinciplesForInjection(principles, budget);

    expect(result.totalChars).toBeLessThanOrEqual(budget + 200); // Allow some slack for P0 force-include
    expect(result.selected.length).toBeLessThan(20);
    expect(result.wasTruncated).toBe(true);
  });

  it('includes all principles when budget is large enough', () => {
    const principles = makePrinciples([
      { id: 'P_001', priority: 'P0' },
      { id: 'P_002', priority: 'P1' },
      { id: 'P_003', priority: 'P2' },
    ]);

    const result = selectPrinciplesForInjection(principles, 10000);

    expect(result.selected).toHaveLength(3);
    expect(result.wasTruncated).toBe(false);
  });

  it('returns empty selection for empty principles array', () => {
    const result = selectPrinciplesForInjection([], 10000);

    expect(result.selected).toHaveLength(0);
    expect(result.totalChars).toBe(0);
    expect(result.hasP0).toBe(false);
    expect(result.wasTruncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: selectPrinciplesForInjection — P0 guarantee
// ---------------------------------------------------------------------------

describe('selectPrinciplesForInjection — P0 guarantee', () => {
  it('ensures at least one P0 principle is included even when over budget', () => {
    // Fill budget with P1 principles, then have a P0 that would exceed budget
    const principles: InjectablePrinciple[] = [];

    // Add many P1 principles that fill the budget
    for (let i = 0; i < 10; i++) {
      principles.push(makePrinciple({
        id: `P1_${i}`,
        priority: 'P1',
        text: `P1 principle with enough text to consume budget space ${i}`,
        createdAt: '2026-04-01T00:00:00.000Z',
      }));
    }

    // Add a P0 principle
    principles.push(makePrinciple({
      id: 'P0_CRITICAL',
      priority: 'P0',
      text: 'Critical P0 principle that must always be included',
      createdAt: '2026-04-01T00:00:00.000Z',
    }));

    const budget = 200; // Very small budget
    const result = selectPrinciplesForInjection(principles, budget);

    expect(result.hasP0).toBe(true);
    expect(result.selected.some(p => p.priority === 'P0')).toBe(true);
  });

  it('sets hasP0=true when P0 principles are naturally selected', () => {
    const principles = makePrinciples([
      { id: 'P0_1', priority: 'P0' },
      { id: 'P1_1', priority: 'P1' },
    ]);

    const result = selectPrinciplesForInjection(principles, 10000);

    expect(result.hasP0).toBe(true);
    expect(result.breakdown.p0).toBe(1);
  });

  it('sets hasP0=false when no P0 principles exist', () => {
    const principles = makePrinciples([
      { id: 'P1_1', priority: 'P1' },
      { id: 'P2_1', priority: 'P2' },
    ]);

    const result = selectPrinciplesForInjection(principles, 10000);

    expect(result.hasP0).toBe(false);
    expect(result.breakdown.p0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: selectPrinciplesForInjection — breakdown
// ---------------------------------------------------------------------------

describe('selectPrinciplesForInjection — breakdown', () => {
  it('counts principles by priority tier correctly', () => {
    const principles = makePrinciples([
      { id: 'P0_1', priority: 'P0' },
      { id: 'P0_2', priority: 'P0' },
      { id: 'P1_1', priority: 'P1' },
      { id: 'P1_2', priority: 'P1' },
      { id: 'P1_3', priority: 'P1' },
      { id: 'P2_1', priority: 'P2' },
    ]);

    const result = selectPrinciplesForInjection(principles, 10000);

    expect(result.breakdown.p0).toBe(2);
    expect(result.breakdown.p1).toBe(3);
    expect(result.breakdown.p2).toBe(1);
    expect(result.selected).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Tests: DEFAULT_PRINCIPLE_BUDGET
// ---------------------------------------------------------------------------

describe('DEFAULT_PRINCIPLE_BUDGET', () => {
  it('is set to 4000 characters', () => {
    expect(DEFAULT_PRINCIPLE_BUDGET).toBe(4000);
  });
});
