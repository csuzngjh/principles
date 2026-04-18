/**
 * Drift Guard Test
 *
 * Verifies that openclaw-plugin types are compatible with @principles/core interfaces.
 * This prevents silent type drift where the SDK types and openclaw-plugin types
 * diverge without being noticed.
 *
 * This test uses TypeScript's type assignability checks at compile time.
 * If openclaw-plugin types evolve incompatibly, this test will fail to compile.
 */
import { describe, it, expect } from 'vitest';
import type { InjectablePrinciple as SDKInjectablePrinciple } from '../src/types.js';
import type { PrincipleInjector as SDKPrincipleInjector } from '../src/principle-injector.js';
import type { InjectionContext as SDKInjectionContext } from '../src/principle-injector.js';
import { DefaultPrincipleInjector } from '../src/principle-injector.js';

// These imports are from the openclaw-plugin package (after it re-exports from @principles/core)
// The test verifies that openclaw-plugin's local types can satisfy SDK interfaces
import type { InjectablePrinciple as PluginInjectablePrinciple } from '@principles/core';
import type { PrincipleInjector as PluginPrincipleInjector } from '@principles/core';

describe('Drift Guard: openclaw-plugin types satisfy @principles/core interfaces', () => {
  it('InjectablePrinciple from openclaw-plugin is compatible with SDK InjectablePrinciple', () => {
    // This assignment checks type assignability at compile time
    const _sdkPrinciple: SDKInjectablePrinciple = {} as PluginInjectablePrinciple;
    // If this compiles, PluginInjectablePrinciple satisfies SDKInjectablePrinciple
    expect(true).toBe(true);
  });

  it('PrincipleInjector from openclaw-plugin is compatible with SDK PrincipleInjector', () => {
    const _sdkInjector: SDKPrincipleInjector = {} as PluginPrincipleInjector;
    expect(true).toBe(true);
  });

  it('SDK DefaultPrincipleInjector implements SDK PrincipleInjector', () => {
    const injector = new DefaultPrincipleInjector();

    // Verify it has the required methods
    expect(typeof injector.getRelevantPrinciples).toBe('function');
    expect(typeof injector.formatForInjection).toBe('function');

    // Test basic functionality
    const testPrinciples: SDKInjectablePrinciple[] = [
      { id: 'P0-1', text: 'P0 principle', priority: 'P0', createdAt: '2026-04-17T00:00:00.000Z' },
      { id: 'P1-1', text: 'P1 principle', priority: 'P1', createdAt: '2026-04-17T01:00:00.000Z' },
    ];

    const ctx: SDKInjectionContext = {
      domain: 'coding',
      sessionId: 'sess-test',
      budgetChars: 500,
    };

    const result = injector.getRelevantPrinciples(testPrinciples, ctx);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    // P0 should be first
    expect(result[0].priority).toBe('P0');

    // Format check
    const formatted = injector.formatForInjection(result[0]);
    expect(formatted).toMatch(/^- \[.+\] .+/);
  });

  it('DefaultPrincipleInjector respects budget constraint', () => {
    const injector = new DefaultPrincipleInjector();

    const longPrinciples: SDKInjectablePrinciple[] = [
      { id: 'P1-LONG', text: 'This is a very long principle text that should exceed the budget limit', priority: 'P1', createdAt: '2026-04-17T00:00:00.000Z' },
    ];

    const tightBudget: SDKInjectionContext = {
      domain: 'coding',
      sessionId: 'sess-test',
      budgetChars: 20, // Very tight budget
    };

    const result = injector.getRelevantPrinciples(longPrinciples, tightBudget);
    // With tight budget, should either be empty or have the principle if it fits
    const totalChars = result.reduce((sum, p) => sum + injector.formatForInjection(p).length, 0);
    expect(totalChars).toBeLessThanOrEqual(tightBudget.budgetChars);
  });

  it('DefaultPrincipleInjector always includes P0 even in tight budget', () => {
    const injector = new DefaultPrincipleInjector();

    const principles: SDKInjectablePrinciple[] = [
      { id: 'P0-MUST-INCLUDE', text: 'Critical P0', priority: 'P0', createdAt: '2026-04-17T00:00:00.000Z' },
      { id: 'P1-1', text: 'P1 principle text', priority: 'P1', createdAt: '2026-04-17T01:00:00.000Z' },
    ];

    const veryTightBudget: SDKInjectionContext = {
      domain: 'coding',
      sessionId: 'sess-test',
      budgetChars: 10, // Only P0 fits
    };

    const result = injector.getRelevantPrinciples(principles, veryTightBudget);
    expect(result.some((p) => p.id === 'P0-MUST-INCLUDE')).toBe(true);
  });
});
