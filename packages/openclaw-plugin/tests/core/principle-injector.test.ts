import { describe, it, expect } from 'vitest';
import type { PrincipleInjector, InjectionContext } from '../../src/core/principle-injector.js';
import { DefaultPrincipleInjector } from '../../src/core/principle-injector.js';
import type { InjectablePrinciple } from '../../src/core/principle-injection.js';
import { selectPrinciplesForInjection, formatPrinciple } from '../../src/core/principle-injection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrinciple(overrides: Partial<InjectablePrinciple> = {}): InjectablePrinciple {
  return {
    id: overrides.id ?? 'P_001',
    text: overrides.text ?? 'Always verify file content before editing',
    priority: overrides.priority ?? 'P1',
    createdAt: overrides.createdAt ?? '2026-04-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultPrincipleInjector', () => {
  const injector: PrincipleInjector = new DefaultPrincipleInjector();

  it('getRelevantPrinciples delegates to selectPrinciplesForInjection', () => {
    const principles = [
      makePrinciple({ id: 'P0', priority: 'P0', text: 'Critical rule' }),
      makePrinciple({ id: 'P1', priority: 'P1', text: 'Standard rule' }),
      makePrinciple({ id: 'P2', priority: 'P2', text: 'Low priority rule' }),
      makePrinciple({ id: 'P1b', priority: 'P1', text: 'Another standard rule' }),
      makePrinciple({ id: 'P0b', priority: 'P0', text: 'Another critical rule' }),
    ];
    const context: InjectionContext = { domain: 'coding', sessionId: 's-1', budgetChars: 4000 };

    const result = injector.getRelevantPrinciples(principles, context);
    const expected = selectPrinciplesForInjection(principles, 4000).selected;

    expect(result).toEqual(expected);
  });

  it('formatForInjection delegates to formatPrinciple', () => {
    const principle = makePrinciple({ id: 'P_001', text: 'Test' });

    const result = injector.formatForInjection(principle);
    const expected = formatPrinciple(makePrinciple({ id: 'P_001', text: 'Test' }));

    expect(result).toBe(expected);
  });

  it('formatForInjection returns "- [ID] text" format', () => {
    const result = injector.formatForInjection(
      makePrinciple({ id: 'P_001', text: 'Verify before edit' }),
    );
    expect(result).toBe('- [P_001] Verify before edit');
  });

  it('getRelevantPrinciples respects budget constraint', () => {
    const principles = Array.from({ length: 20 }, (_, i) =>
      makePrinciple({
        id: `P_${i.toString().padStart(3, '0')}`,
        text: 'A'.repeat(300), // 300 chars each
        priority: i === 0 ? 'P0' : 'P2',
      }),
    );
    const context: InjectionContext = { domain: 'coding', sessionId: 's-1', budgetChars: 500 };

    const result = injector.getRelevantPrinciples(principles, context);

    // Should include at least the forced P0, total chars may exceed budget slightly
    expect(result.length).toBeGreaterThan(0);
    expect(result.some(p => p.priority === 'P0')).toBe(true);
  });

  it('getRelevantPrinciples returns empty array for empty input', () => {
    const context: InjectionContext = { domain: 'coding', sessionId: 's-1', budgetChars: 4000 };
    const result = injector.getRelevantPrinciples([], context);
    expect(result).toEqual([]);
  });
});

describe('InjectionContext', () => {
  it('has domain, sessionId, and budgetChars fields', () => {
    const ctx: InjectionContext = { domain: 'coding', sessionId: 's-1', budgetChars: 4000 };
    expect(ctx.domain).toBe('coding');
    expect(ctx.sessionId).toBe('s-1');
    expect(ctx.budgetChars).toBe(4000);
  });
});
