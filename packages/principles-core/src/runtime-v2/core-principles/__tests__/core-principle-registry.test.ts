import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CORE_PRINCIPLES,
  CORE_PRINCIPLE_IDS,
  isCorePrincipleId,
  getCorePrinciple,
  CorePrincipleSchema,
} from '../core-principle-registry.js';

describe('Core Principle Registry', () => {
  it('exports exactly 10 core principles', () => {
    expect(CORE_PRINCIPLES).toHaveLength(10);
  });

  it('contains T-01 through T-10', () => {
    const ids = CORE_PRINCIPLES.map(p => p.id);
    expect(ids).toEqual(['T-01','T-02','T-03','T-04','T-05','T-06','T-07','T-08','T-09','T-10']);
  });

  it('CORE_PRINCIPLE_IDS matches principle ids', () => {
    expect(CORE_PRINCIPLE_IDS).toEqual(CORE_PRINCIPLES.map(p => p.id));
  });

  it('isCorePrincipleId returns true for valid ids', () => {
    expect(isCorePrincipleId('T-01')).toBe(true);
    expect(isCorePrincipleId('T-10')).toBe(true);
  });

  it('isCorePrincipleId returns false for invalid ids', () => {
    expect(isCorePrincipleId('T-99')).toBe(false);
    expect(isCorePrincipleId('')).toBe(false);
    expect(isCorePrincipleId('t-01')).toBe(false); // case-sensitive
  });

  it('getCorePrinciple returns principle for valid id', () => {
    const p = getCorePrinciple('T-01');
    expect(p).toBeDefined();
    expect(p?.id).toBe('T-01');
    expect(p?.name).toBe('Survey Before Acting');
  });

  it('getCorePrinciple returns undefined for invalid id', () => {
    expect(getCorePrinciple('T-99')).toBeUndefined();
  });

  it('registry is frozen (immutable)', () => {
    expect(Object.isFrozen(CORE_PRINCIPLES)).toBe(true);
    // Attempting mutation should not change the value
    expect(() => {
      (CORE_PRINCIPLES as typeof CORE_PRINCIPLES[number][]).push(
        Object.freeze({ id: 'T-99', name: 'Fake', nameZh: '假', statement: 'Fake', statementZh: '假' })
      );
    }).toThrow();
  });

  it('each principle has required fields', () => {
    for (const p of CORE_PRINCIPLES) {
      expect(p.id).toMatch(/^T-\d{2}$/);
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
      expect(typeof p.nameZh).toBe('string');
      expect(p.nameZh.length).toBeGreaterThan(0);
      expect(typeof p.statement).toBe('string');
      expect(p.statement.length).toBeGreaterThan(0);
      expect(typeof p.statementZh).toBe('string');
      expect(p.statementZh.length).toBeGreaterThan(0);
    }
  });

  it('each principle has bilingual (EN+ZH) fields', () => {
    for (const p of CORE_PRINCIPLES) {
      // ZH fields must be non-empty
      expect(p.nameZh.length).toBeGreaterThan(0);
      expect(p.statementZh.length).toBeGreaterThan(0);
      // ZH should differ from EN (not just a copy)
      expect(p.nameZh).not.toEqual(p.name);
    }
  });

  it('CorePrincipleSchema validates a known principle', () => {
    const t01 = getCorePrinciple('T-01');
    expect(t01).toBeDefined();
    expect(Value.Check(CorePrincipleSchema, t01)).toBe(true);
  });

  it('CorePrincipleSchema rejects invalid data', () => {
    expect(Value.Check(CorePrincipleSchema, { id: 123, name: null })).toBe(false);
  });
});
