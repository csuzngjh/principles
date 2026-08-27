import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CORE_PRINCIPLES,
  CORE_PRINCIPLE_IDS,
  getFoundationalPrinciples,
  getOperatingPrinciples,
  isCorePrincipleId,
  getCorePrinciple,
  CorePrincipleSchema,
} from '../core-principle-registry.js';

describe('Core Principle Registry', () => {
  it('exports exactly 10 built-in principles', () => {
    expect(CORE_PRINCIPLES).toHaveLength(10);
    expect(CORE_PRINCIPLE_IDS).toHaveLength(10);
  });

  it('contains exactly T-01 through T-10', () => {
    expect(CORE_PRINCIPLES.map(p => p.id)).toEqual(
      ['T-01','T-02','T-03','T-04','T-05','T-06','T-07','T-08','T-09','T-10']
    );
  });

  it('layer helpers partition the registry: 6 foundational + 4 operating', () => {
    const foundational = getFoundationalPrinciples();
    const operating = getOperatingPrinciples();
    expect(foundational).toHaveLength(6);
    expect(operating).toHaveLength(4);
    expect([...foundational, ...operating].map(p => p.id).sort())
      .toEqual(CORE_PRINCIPLES.map(p => p.id).sort());
  });

  it('foundational set is exactly the <core_principles> injection set', () => {
    expect(getFoundationalPrinciples().map(p => p.id).sort())
      .toEqual(['T-01', 'T-02', 'T-03', 'T-04', 'T-06', 'T-08']);
  });

  it('operating set carries Safety Rails, Close the Loop, Divide And Conquer, Memory Externalization', () => {
    const byId = new Map(getOperatingPrinciples().map(p => [p.id, p.name]));
    expect(byId.get('T-05')).toBe('Safety Rails');
    expect(byId.get('T-07')).toBe('Close the Loop');
    expect(byId.get('T-09')).toBe('Divide And Conquer');
    expect(byId.get('T-10')).toBe('Memory Externalization');
  });

  it('T-07 is Close the Loop and no T-11 exists (pre-release reset)', () => {
    const t07 = getCorePrinciple('T-07');
    expect(t07?.name).toBe('Close the Loop');
    expect(t07?.nameZh).toBe('闭环验证');
    expect(isCorePrincipleId('T-11')).toBe(false);
  });

  it('isCorePrincipleId returns true for valid ids', () => {
    expect(isCorePrincipleId('T-01')).toBe(true);
    expect(isCorePrincipleId('T-07')).toBe(true);
    expect(isCorePrincipleId('T-10')).toBe(true);
  });

  it('isCorePrincipleId returns false for invalid ids', () => {
    expect(isCorePrincipleId('T-11')).toBe(false);
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
    expect(getCorePrinciple('T-11')).toBeUndefined();
    expect(getCorePrinciple('T-99')).toBeUndefined();
  });

  it('registry is frozen (immutable)', () => {
    expect(Object.isFrozen(CORE_PRINCIPLES)).toBe(true);
    expect(() => {
      (CORE_PRINCIPLES as typeof CORE_PRINCIPLES[number][]).push(
        Object.freeze({ id: 'T-99', layer: 'foundational', name: 'Fake', nameZh: '假', statement: 'Fake', statementZh: '假' })
      );
    }).toThrow();
  });

  it('each principle has required fields', () => {
    for (const p of CORE_PRINCIPLES) {
      expect(p.id).toMatch(/^T-\d{2}$/);
      expect(['foundational', 'operating']).toContain(p.layer);
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
      expect(p.nameZh.length).toBeGreaterThan(0);
      expect(p.statementZh.length).toBeGreaterThan(0);
      expect(p.nameZh).not.toEqual(p.name); // ZH should differ from EN
    }
  });

  it('CorePrincipleSchema validates a known principle', () => {
    const t01 = getCorePrinciple('T-01');
    expect(t01).toBeDefined();
    expect(Value.Check(CorePrincipleSchema, t01)).toBe(true);
  });

  it('CorePrincipleSchema rejects invalid data', () => {
    expect(Value.Check(CorePrincipleSchema, { id: 123, name: null })).toBe(false);
    expect(Value.Check(CorePrincipleSchema, { id: 'T-01', layer: 'mystery', name: 'X', nameZh: 'x', statement: 'Y', statementZh: 'y' })).toBe(false);
  });
});
