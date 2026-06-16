import { describe, it, expect } from 'vitest';
import { DefaultPrincipleInjector } from '../src/principle-injector.js';
import type { InjectionContext } from '../src/principle-injector.js';
import type { InjectablePrinciple } from '../src/prompt-builder/principle-selection.js';

const injector = new DefaultPrincipleInjector();

function makePrinciple(overrides: Partial<InjectablePrinciple> = {}): InjectablePrinciple {
  return {
    id: overrides.id ?? 'P_001',
    text: overrides.text ?? 'Always verify file content before editing',
    priority: overrides.priority ?? 'P1',
    createdAt: overrides.createdAt ?? '2026-04-01T00:00:00.000Z',
  };
}

function makeContext(masked?: Set<string>): InjectionContext {
  return { domain: 'coding', sessionId: 's-1', budgetChars: 4000, maskedPrincipleIds: masked };
}

const allPrinciples = [
  makePrinciple({ id: 'P0-1', priority: 'P0', text: 'Critical safety rule' }),
  makePrinciple({ id: 'P1-1', priority: 'P1', text: 'Standard practice A' }),
  makePrinciple({ id: 'P1-2', priority: 'P1', text: 'Standard practice B' }),
  makePrinciple({ id: 'P2-1', priority: 'P2', text: 'Nice to have' }),
];

describe('DefaultPrincipleInjector masking', () => {
  it('filters out masked P1 principle', () => {
    const masked = new Set(['P1-1']);
    const result = injector.getRelevantPrinciples(allPrinciples, makeContext(masked));
    expect(result.some(p => p.id === 'P1-1')).toBe(false);
    expect(result.some(p => p.id === 'P0-1')).toBe(true);
    expect(result.some(p => p.id === 'P1-2')).toBe(true);
  });

  it('returns all principles when masked set is empty', () => {
    const result = injector.getRelevantPrinciples(allPrinciples, makeContext(new Set()));
    expect(result.length).toBe(4);
  });

  it('returns all principles when maskedPrincipleIds is undefined', () => {
    const result = injector.getRelevantPrinciples(allPrinciples, makeContext(undefined));
    expect(result.length).toBe(4);
  });

  it('filters out masked P0 principle', () => {
    const masked = new Set(['P0-1']);
    const result = injector.getRelevantPrinciples(allPrinciples, makeContext(masked));
    expect(result.some(p => p.id === 'P0-1')).toBe(false);
    expect(result.some(p => p.id === 'P1-1')).toBe(true);
  });

  it('returns empty array when all principles are masked', () => {
    const masked = new Set(allPrinciples.map(p => p.id));
    const result = injector.getRelevantPrinciples(allPrinciples, makeContext(masked));
    expect(result).toEqual([]);
  });

  it('ignores masked IDs that do not match any principle', () => {
    const masked = new Set(['nonexistent']);
    const result = injector.getRelevantPrinciples(allPrinciples, makeContext(masked));
    expect(result.length).toBe(4);
  });
});
