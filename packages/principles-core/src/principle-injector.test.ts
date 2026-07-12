import { describe, it, expect } from 'vitest';
import { DefaultPrincipleInjector, InjectionContext } from './principle-injector.js';

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

describe('DefaultPrincipleInjector', () => {
  describe('formatForInjection', () => {
    it('formats principle with id and text', () => {
      const injector = new DefaultPrincipleInjector();
      expect(injector.formatForInjection(makeP('P0-001', 'Be careful'))).toBe(
        '- [P0-001] Be careful',
      );
    });

    it('handles empty text', () => {
      const injector = new DefaultPrincipleInjector();
      expect(injector.formatForInjection(makeP('P1-001', ''))).toBe('- [P1-001] ');
    });
  });

  describe('getRelevantPrinciples', () => {
    it('returns empty array for empty input', () => {
      const injector = new DefaultPrincipleInjector();
      const context: InjectionContext = { domain: 'test', sessionId: 's1', budgetChars: 4000 };
      const result = injector.getRelevantPrinciples([], context);
      expect(result).toEqual([]);
    });

    it('returns empty array for null input', () => {
      const injector = new DefaultPrincipleInjector();
      const context: InjectionContext = { domain: 'test', sessionId: 's1', budgetChars: 4000 };
      const result = injector.getRelevantPrinciples(null as unknown as TestPrinciple[], context);
      expect(result).toEqual([]);
    });

    it('P0 principles are always included (forced)', () => {
      const injector = new DefaultPrincipleInjector();
      const p0 = makeP('P0-001', 'Critical principle', { priority: 'P0' });
      const p1 = makeP('P1-001', 'Normal principle', { priority: 'P1' });
      const context: InjectionContext = { domain: 'test', sessionId: 's1', budgetChars: 4000 };
      const result = injector.getRelevantPrinciples([p0, p1], context);
      expect(result).toContainEqual(expect.objectContaining({ id: 'P0-001' }));
    });

    it('P0 included even when exceeding budget', () => {
      const injector = new DefaultPrincipleInjector();
      const p0 = makeP('P0-001', 'X'.repeat(5000), { priority: 'P0' });
      const context: InjectionContext = { domain: 'test', sessionId: 's1', budgetChars: 100 };
      const result = injector.getRelevantPrinciples([p0], context);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('P0-001');
    });

    it('P0 principles sorted by createdAt (oldest first)', () => {
      const injector = new DefaultPrincipleInjector();
      const p0Old = makeP('P0-001', 'Old', { priority: 'P0', createdAt: '2026-01-01T00:00:00.000Z' });
      const p0New = makeP('P0-002', 'New', { priority: 'P0', createdAt: '2026-06-01T00:00:00.000Z' });
      const context: InjectionContext = { domain: 'test', sessionId: 's1', budgetChars: 4000 };
      const result = injector.getRelevantPrinciples([p0New, p0Old], context);
      expect(result[0].id).toBe('P0-001');
      expect(result[1].id).toBe('P0-002');
    });

    it('P1 principles sorted by priority then createdAt', () => {
      const injector = new DefaultPrincipleInjector();
      const p1Old = makeP('P1-001', 'Old', { priority: 'P1', createdAt: '2026-01-01T00:00:00.000Z' });
      const p1New = makeP('P1-002', 'New', { priority: 'P1', createdAt: '2026-06-01T00:00:00.000Z' });
      const context: InjectionContext = { domain: 'test', sessionId: 's1', budgetChars: 4000 };
      const result = injector.getRelevantPrinciples([p1New, p1Old], context);
      expect(result[0].id).toBe('P1-001');
      expect(result[1].id).toBe('P1-002');
    });

    it('maskedPrincipleIds filters out excluded principles', () => {
      const injector = new DefaultPrincipleInjector();
      const p0 = makeP('P0-001', 'Critical', { priority: 'P0' });
      const p1 = makeP('P1-001', 'Masked', { priority: 'P1' });
      const context: InjectionContext = {
        domain: 'test',
        sessionId: 's1',
        budgetChars: 4000,
        maskedPrincipleIds: new Set(['P1-001']),
      };
      const result = injector.getRelevantPrinciples([p0, p1], context);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('P0-001');
    });

    it('maskedPrincipleIds empty set has no effect', () => {
      const injector = new DefaultPrincipleInjector();
      const p0 = makeP('P0-001', 'Critical', { priority: 'P0' });
      const p1 = makeP('P1-001', 'Normal', { priority: 'P1' });
      const context: InjectionContext = {
        domain: 'test',
        sessionId: 's1',
        budgetChars: 4000,
        maskedPrincipleIds: new Set(),
      };
      const result = injector.getRelevantPrinciples([p0, p1], context);
      expect(result).toHaveLength(2);
    });

    it('all masked principles returns empty', () => {
      const injector = new DefaultPrincipleInjector();
      const p0 = makeP('P0-001', 'Critical', { priority: 'P0' });
      const context: InjectionContext = {
        domain: 'test',
        sessionId: 's1',
        budgetChars: 4000,
        maskedPrincipleIds: new Set(['P0-001']),
      };
      const result = injector.getRelevantPrinciples([p0], context);
      expect(result).toEqual([]);
    });

    it('throws on unknown priority', () => {
      const injector = new DefaultPrincipleInjector();
      const invalidP = { id: 'P9-001', text: 'Invalid', priority: 'P9' as 'P0', createdAt: '2026-01-01T00:00:00.000Z' };
      const context: InjectionContext = { domain: 'test', sessionId: 's1', budgetChars: 4000 };
      expect(() => injector.getRelevantPrinciples([invalidP], context)).toThrow('Unknown principle priority: P9');
    });

    it('undefined priority defaults to P1', () => {
      const injector = new DefaultPrincipleInjector();
      const p = makeP('P-001', 'Default', {});
      const context: InjectionContext = { domain: 'test', sessionId: 's1', budgetChars: 4000 };
      const result = injector.getRelevantPrinciples([p], context);
      expect(result).toHaveLength(1);
    });

    it('P1 before P2 in priority order', () => {
      const injector = new DefaultPrincipleInjector();
      const p1 = makeP('P1-001', 'P1', { priority: 'P1' });
      const p2 = makeP('P2-001', 'P2', { priority: 'P2' });
      const context: InjectionContext = { domain: 'test', sessionId: 's1', budgetChars: 4000 };
      const result = injector.getRelevantPrinciples([p2, p1], context);
      expect(result[0].id).toBe('P1-001');
      expect(result[1].id).toBe('P2-001');
    });

    it('P0 fills budget first, then P1/P2', () => {
      const injector = new DefaultPrincipleInjector();
      const p0 = makeP('P0-001', 'Critical', { priority: 'P0' });
      const p1a = makeP('P1-001', 'A'.repeat(100), { priority: 'P1' });
      const p1b = makeP('P1-002', 'B'.repeat(100), { priority: 'P1' });
      const context: InjectionContext = { domain: 'test', sessionId: 's1', budgetChars: 300 };
      const result = injector.getRelevantPrinciples([p1a, p0, p1b], context);
      expect(result[0].id).toBe('P0-001');
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('returns empty when all principles are masked', () => {
      const injector = new DefaultPrincipleInjector();
      const p0 = makeP('P0-001', 'P0', { priority: 'P0' });
      const p1 = makeP('P1-001', 'P1', { priority: 'P1' });
      const context: InjectionContext = {
        domain: 'test',
        sessionId: 's1',
        budgetChars: 4000,
        maskedPrincipleIds: new Set(['P0-001', 'P1-001']),
      };
      const result = injector.getRelevantPrinciples([p0, p1], context);
      expect(result).toEqual([]);
    });
  });
});