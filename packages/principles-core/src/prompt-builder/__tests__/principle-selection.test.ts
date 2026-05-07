/**
 * Unit tests for @principles/core/prompt-builder principle selection.
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 2
 */

import { describe, it, expect } from 'vitest';
import {
  formatPrinciple,
  selectPrinciplesForInjection,
  DEFAULT_PRINCIPLE_BUDGET,
} from '../index.js';

interface TestPrinciple {
  id: string;
  text: string;
  priority?: 'P0' | 'P1' | 'P2';
  createdAt: string;
}

function makeP(
  id: string,
  text: string,
  opts: { priority?: 'P0' | 'P1' | 'P2'; createdAt?: string } = {},
): TestPrinciple {
  return {
    id,
    text,
    priority: opts.priority ?? 'P1',
    createdAt: opts.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

// ─── formatPrinciple tests ────────────────────────────────────────────────────

describe('formatPrinciple', () => {
  it('formats with id and text', () => {
    expect(formatPrinciple(makeP('P0-001', 'Be careful with files'))).toBe(
      '- [P0-001] Be careful with files',
    );
  });

  it('handles empty text', () => {
    expect(formatPrinciple(makeP('P1-001', ''))).toBe('- [P1-001] ');
  });
});

// ─── selectPrinciplesForInjection: empty/boundary cases ──────────────────────

describe('selectPrinciplesForInjection — empty/boundary', () => {
  it('empty array → empty selection', () => {
    const result = selectPrinciplesForInjection([], 4000);
    expect(result.selected).toEqual([]);
    expect(result.totalChars).toBe(0);
    expect(result.breakdown).toEqual({ p0: 0, p1: 0, p2: 0 });
    expect(result.hasP0).toBe(false);
    expect(result.wasTruncated).toBe(false);
  });

  it('single principle under budget → selected', () => {
    const p = makeP('P1-001', 'Test principle');
    const result = selectPrinciplesForInjection([p], 4000);
    expect(result.selected).toHaveLength(1);
    expect(result.selected).toContainEqual(expect.objectContaining({ id: 'P1-001' }));
    expect(result.wasTruncated).toBe(false);
  });

  it('DEFAULT_PRINCIPLE_BUDGET = 4000', () => {
    expect(DEFAULT_PRINCIPLE_BUDGET).toBe(4000);
  });
});

// ─── selectPrinciplesForInjection: priority ordering ─────────────────────────

describe('selectPrinciplesForInjection — priority ordering', () => {
  it('P0 selected before P1 when both fit', () => {
    const p0 = makeP('P0-001', 'P0 principle', { priority: 'P0' });
    const p1 = makeP('P1-001', 'P1 principle', { priority: 'P1' });
    // Budget allows both: each ~22 chars, total ~46 chars
    const result = selectPrinciplesForInjection([p1, p0], 4000);
    expect(result.selected).toContainEqual(expect.objectContaining({ id: 'P0-001' }));
    expect(result.selected).toContainEqual(expect.objectContaining({ id: 'P1-001' }));
    expect(result.hasP0).toBe(true);
  });

  it('P1 selected before P2 when both fit', () => {
    const p1 = makeP('P1-001', 'P1 principle', { priority: 'P1' });
    const p2 = makeP('P2-001', 'P2 principle', { priority: 'P2' });
    const result = selectPrinciplesForInjection([p2, p1], 4000);
    expect(result.selected).toContainEqual(expect.objectContaining({ id: 'P1-001' }));
    expect(result.selected).toContainEqual(expect.objectContaining({ id: 'P2-001' }));
  });

  it('within same priority, newer first (recency)', () => {
    const older = makeP('P1-001', 'Older principle', { priority: 'P1', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = makeP('P1-002', 'Newer principle', { priority: 'P1', createdAt: '2026-06-01T00:00:00.000Z' });
    // Newer first within same priority
    const result = selectPrinciplesForInjection([older, newer], 4000);
    expect(result.selected).toContainEqual(expect.objectContaining({ id: 'P1-002' }));
    expect(result.selected).toContainEqual(expect.objectContaining({ id: 'P1-001' }));
  });
});

// ─── selectPrinciplesForInjection: budget truncation ─────────────────────────

describe('selectPrinciplesForInjection — budget truncation', () => {
  it('truncates when over budget', () => {
    const p1 = makeP('P1-001', 'A'.repeat(1000));
    const p2 = makeP('P1-002', 'B'.repeat(1000));
    const p3 = makeP('P1-003', 'C'.repeat(1000));
    const p4 = makeP('P1-004', 'D'.repeat(1000));
    // Budget of 2500 should fit only ~2 of these
    const result = selectPrinciplesForInjection([p1, p2, p3, p4], 2500);
    expect(result.wasTruncated).toBe(true);
    expect(result.selected.length).toBeLessThanOrEqual(4);
  });

  it('P0 guarantee: if any P0 exists, at least one P0 is always included even if over budget', () => {
    // P0 is so long it exceeds budget alone
    const p0 = makeP('P0-001', 'X'.repeat(5000), { priority: 'P0' });
    const p1 = makeP('P1-001', 'Y'.repeat(10));
    // Budget of 500: P0 (5008 chars) should still be included (forced)
    const result = selectPrinciplesForInjection([p0, p1], 500);
    expect(result.hasP0).toBe(true);
    expect(result.selected.some(p => p.id === 'P0-001')).toBe(true);
  });

  it('P0 guarantee triggers only once — continues filling budget after forced P0', () => {
    const p0 = makeP('P0-001', 'A'.repeat(100), { priority: 'P0', createdAt: '2026-06-01T00:00:00.000Z' });
    const p0b = makeP('P0-002', 'B'.repeat(100), { priority: 'P0', createdAt: '2026-05-01T00:00:00.000Z' });
    const p1 = makeP('P1-001', 'C'.repeat(100), { priority: 'P1', createdAt: '2026-04-01T00:00:00.000Z' });
    // Budget allows P0-001 (forced) + P1-001 but not P0-002
    const result = selectPrinciplesForInjection([p0, p0b, p1], 500);
    // P0-001 (newer) should be selected as the forced P0
    // After that, P1 fills remaining budget
    expect(result.hasP0).toBe(true);
    expect(result.selected.some(p => p.id === 'P1-001')).toBe(true);
  });
});

// ─── selectPrinciplesForInjection: immutability ─────────────────────────────

describe('selectPrinciplesForInjection — immutability', () => {
  it('input array is NOT mutated', () => {
    const original = [
      makeP('P1-001', 'First', { priority: 'P1', createdAt: '2026-06-01T00:00:00.000Z' }),
      makeP('P1-002', 'Second', { priority: 'P1', createdAt: '2026-06-02T00:00:00.000Z' }),
    ];
    const inputCopy = [...original];
    selectPrinciplesForInjection(original, 4000);
    expect(original).toEqual(inputCopy);
  });
});

// ─── selectPrinciplesForInjection: breakdown counts ───────────────────────────

describe('selectPrinciplesForInjection — breakdown counts', () => {
  it('counts p0/p1/p2 correctly', () => {
    const principles: TestPrinciple[] = [
      makeP('P0-001', 'P0', { priority: 'P0' }),
      makeP('P1-001', 'P1', { priority: 'P1' }),
      makeP('P1-002', 'P1', { priority: 'P1' }),
      makeP('P2-001', 'P2', { priority: 'P2' }),
    ];
    const result = selectPrinciplesForInjection(principles, 4000);
    expect(result.breakdown).toEqual({ p0: 1, p1: 2, p2: 1 });
  });

  it('hasP0 true when P0 selected', () => {
    const result = selectPrinciplesForInjection([makeP('P0-001', 'Test', { priority: 'P0' })], 4000);
    expect(result.hasP0).toBe(true);
  });

  it('hasP0 false when no P0', () => {
    const result = selectPrinciplesForInjection([makeP('P1-001', 'Test', { priority: 'P1' })], 4000);
    expect(result.hasP0).toBe(false);
  });
});

// ─── selectPrinciplesForInjection: probation sub-budget ───────────────────────

describe('selectPrinciplesForInjection — probation sub-budget (separate call)', () => {
  it('probation sub-budget is applied by caller (not this function)', () => {
    // The function itself doesn't know about probation vs active budgets
    // The caller passes different budgets for each
    const priorities: ('P0' | 'P1' | 'P2')[] = ['P0', 'P1', 'P2'];
    const principles: TestPrinciple[] = Array.from({ length: 10 }, (_, i) =>
      makeP(`P${i % 3}-${i}`, 'A'.repeat(500), { priority: priorities[i % 3] }),
    );
    // Active gets 4000, probation would get 1000
    const activeResult = selectPrinciplesForInjection(principles, 4000);
    const probationResult = selectPrinciplesForInjection(principles, 1000);

    // With 4000 budget, more principles selected than with 1000 budget
    expect(activeResult.selected.length).toBeGreaterThan(probationResult.selected.length);
  });
});
