/**
 * PrincipleInjector Conformance Test Factory
 *
 * Validates that a PrincipleInjector implementation satisfies the interface contract.
 *
 * Usage:
 *   import { describeInjectorConformance } from './injector-conformance.js';
 *   import type { InjectorFactory } from './injector-conformance.ts';
 *
 *   const factory: InjectorFactory = () => new MyPrincipleInjector();
 *   describeInjectorConformance('MyPrincipleInjector', factory);
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PrincipleInjector, InjectionContext } from '../../src/principle-injector.js';
import type { InjectablePrinciple } from '../../src/types.js';

export type InjectorFactory = () => PrincipleInjector;

function createTestPrinciples(): InjectablePrinciple[] {
  return [
    {
      id: 'P0-1',
      text: 'P0: Always validate input before processing.',
      priority: 'P0',
      createdAt: '2026-04-17T00:00:00.000Z',
    },
    {
      id: 'P1-1',
      text: 'P1: Check file exists before writing.',
      priority: 'P1',
      createdAt: '2026-04-17T01:00:00.000Z',
    },
    {
      id: 'P1-2',
      text: 'P1: Use descriptive variable names.',
      priority: 'P1',
      createdAt: '2026-04-17T02:00:00.000Z',
    },
    {
      id: 'P2-1',
      text: 'P2: Add comments for complex logic.',
      priority: 'P2',
      createdAt: '2026-04-17T03:00:00.000Z',
    },
  ];
}

function createTestContext(overrides = {}): InjectionContext {
  return {
    domain: 'coding',
    sessionId: 'sess-test',
    budgetChars: 200,
    ...overrides,
  };
}

/**
 * Conformance test suite for PrincipleInjector implementations.
 *
 * Validates:
 * 1. getRelevantPrinciples returns array (possibly empty)
 * 2. getRelevantPrinciples respects budget
 * 3. P0 principles are forced-included when available
 * 4. formatForInjection returns "- [ID] text" format
 * 5. Empty input returns empty output
 * 6. Tight budget still includes P0
 */
export function describeInjectorConformance(
  name: string,
  factory: InjectorFactory,
): void {
  describe(`PrincipleInjector Conformance: ${name}`, () => {
    let injector: PrincipleInjector;

    beforeEach(() => {
      injector = factory();
    });

    it('getRelevantPrinciples returns an array', () => {
      const result = injector.getRelevantPrinciples([], createTestContext());
      expect(Array.isArray(result)).toBe(true);
    });

    it('getRelevantPrinciples returns empty array for empty input', () => {
      const result = injector.getRelevantPrinciples([], createTestContext());
      expect(result).toEqual([]);
    });

    it('getRelevantPrinciples respects character budget', () => {
      const principles = createTestPrinciples();
      const ctx = createTestContext({ budgetChars: 50 });
      const result = injector.getRelevantPrinciples(principles, ctx);

      const totalChars = result.reduce((sum, p) => {
        return sum + injector.formatForInjection(p).length;
      }, 0);
      expect(totalChars).toBeLessThanOrEqual(ctx.budgetChars);
    });

    it('formatForInjection returns "- [ID] text" format', () => {
      const principles = createTestPrinciples();
      const result = injector.getRelevantPrinciples(principles, createTestContext());
      if (result.length === 0) return;

      const formatted = injector.formatForInjection(result[0]);
      expect(formatted).toMatch(/^- \[.+\] .+/);
    });

    it('P0 principles are included even in tight budget', () => {
      const principles = createTestPrinciples();
      const ctx = createTestContext({ budgetChars: 10 }); // Very tight budget
      const result = injector.getRelevantPrinciples(principles, ctx);

      // P0 should still be included (forced inclusion)
      const hasP0 = result.some((p) => p.id === 'P0-1');
      expect(hasP0).toBe(true);
    });

    it('all returned principles have required fields', () => {
      const principles = createTestPrinciples();
      const result = injector.getRelevantPrinciples(principles, createTestContext());

      for (const p of result) {
        expect(typeof p.id).toBe('string');
        expect(typeof p.text).toBe('string');
        expect(typeof p.createdAt).toBe('string');
      }
    });
  });
}
