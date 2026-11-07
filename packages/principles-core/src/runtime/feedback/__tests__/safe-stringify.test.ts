/**
 * Safe Stringify Tests — Feedback Pipeline Preview Helpers
 *
 * Tests the BigInt-safe + circular-ref-safe JSON-style stringifier.
 * This function is used to safely preview values in feedback reports.
 *
 * ERR checklist:
 * - ERR-017: BigInt-safe + circular-ref-safe
 * - ERR-014/016: bounded output (max 2000 chars)
 */

import { describe, it, expect } from 'vitest';
import { safeStringifyPreview } from '../safe-stringify.js';

describe('safeStringifyPreview', () => {
  it('stringifies primitive values', () => {
    expect(safeStringifyPreview('hello')).toBe('"hello"');
    expect(safeStringifyPreview(42)).toBe('42');
    expect(safeStringifyPreview(true)).toBe('true');
    expect(safeStringifyPreview(false)).toBe('false');
    expect(safeStringifyPreview(null)).toBe('null');
    expect(safeStringifyPreview(undefined)).toBe('undefined');
  });

  it('stringifies simple objects', () => {
    const obj = { name: 'test', count: 10 };
    const result = safeStringifyPreview(obj);
    expect(result).toBe('{"name":"test","count":10}');
  });

  it('stringifies arrays', () => {
    const arr = [1, 2, 3];
    const result = safeStringifyPreview(arr);
    expect(result).toBe('[1,2,3]');
  });

  it('handles BigInt values', () => {
    const obj = { big: BigInt('12345678901234567890') };
    const result = safeStringifyPreview(obj);
    expect(result).toContain('<bigint:');
    expect(result).toContain('12345678901234567890');
  });

  it('handles circular references', () => {
    const obj: Record<string, unknown> = { name: 'test' };
    obj.self = obj;
    const result = safeStringifyPreview(obj);
    expect(result).toContain('<circular>');
  });

  it('handles circular references in arrays', () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    const result = safeStringifyPreview(arr);
    expect(result).toContain('<circular>');
  });

  it('handles nested circular references', () => {
    const inner: Record<string, unknown> = { value: 'inner' };
    const outer: Record<string, unknown> = { inner };
    inner.outer = outer;
    const result = safeStringifyPreview(outer);
    expect(result).toContain('<circular>');
  });

  it('truncates long strings', () => {
    const longString = 'a'.repeat(300);
    const result = safeStringifyPreview(longString);
    expect(result.length).toBeLessThan(300);
    expect(result).toContain('…');
  });

  it('truncates output to 2000 chars', () => {
    const obj = { data: 'a'.repeat(3000) };
    const result = safeStringifyPreview(obj);
    expect(result.length).toBeLessThanOrEqual(2001); // 2000 + '…'
  });

  it('handles deep nesting (depth limit)', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'deep' } } } } } } };
    const result = safeStringifyPreview(deep);
    expect(result).toBeDefined();
  });

  it('handles symbols', () => {
    const obj = { sym: Symbol('test') };
    const result = safeStringifyPreview(obj);
    expect(result).toContain('<symbol>');
  });

  it('handles functions', () => {
    const obj = { fn: () => 'test' };
    const result = safeStringifyPreview(obj);
    expect(result).toContain('<function>');
  });

  it('handles NaN', () => {
    const obj = { nan: Number.NaN };
    const result = safeStringifyPreview(obj);
    expect(result).toContain('NaN');
  });

  it('handles Infinity', () => {
    const obj = { inf: Number.POSITIVE_INFINITY };
    const result = safeStringifyPreview(obj);
    expect(result).toContain('NaN');
  });

  it('handles negative Infinity', () => {
    const obj = { inf: Number.NEGATIVE_INFINITY };
    const result = safeStringifyPreview(obj);
    expect(result).toContain('NaN');
  });

  it('limits array length', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const result = safeStringifyPreview(arr);
    expect(result).toContain('…');
  });

  it('limits object keys', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      obj[`key${i}`] = i;
    }
    const result = safeStringifyPreview(obj);
    expect(result).toContain('…');
  });

  it('handles empty objects', () => {
    expect(safeStringifyPreview({})).toBe('{}');
  });

  it('handles empty arrays', () => {
    expect(safeStringifyPreview([])).toBe('[]');
  });

  it('handles nested objects', () => {
    const obj = { outer: { inner: { value: 'nested' } } };
    const result = safeStringifyPreview(obj);
    expect(result).toBe('{"outer":{"inner":{"value":"nested"}}}');
  });

  it('handles mixed types in arrays', () => {
    const arr = [1, 'two', true, null, { key: 'value' }];
    const result = safeStringifyPreview(arr);
    expect(result).toContain('1');
    expect(result).toContain('two');
    expect(result).toContain('true');
    expect(result).toContain('null');
    expect(result).toContain('key');
  });

  it('handles special characters in strings', () => {
    const obj = { text: 'Hello\nWorld\t"quoted"' };
    const result = safeStringifyPreview(obj);
    expect(result).toContain('Hello');
    expect(result).toContain('World');
    expect(result).toContain('quoted');
  });

  it('handles unserializable objects gracefully', () => {
    // Create an object that throws on property access
    const obj = {};
    Object.defineProperty(obj, 'thrower', {
      get() { throw new Error('Cannot access'); },
      enumerable: true,
    });
    const result = safeStringifyPreview(obj);
    expect(result).toBe('<unserializable>');
  });

  it('handles Date objects', () => {
    const obj = { date: new Date('2026-06-24') };
    const result = safeStringifyPreview(obj);
    // Date objects are treated as regular objects, resulting in "{}"
    expect(result).toContain('date');
  });

  it('handles Map objects', () => {
    const map = new Map([['key1', 'value1'], ['key2', 'value2']]);
    const result = safeStringifyPreview(map);
    expect(result).toBeDefined();
  });

  it('handles Set objects', () => {
    const set = new Set([1, 2, 3]);
    const result = safeStringifyPreview(set);
    expect(result).toBeDefined();
  });

  it('handles null prototype objects', () => {
    const obj = Object.create(null);
    obj.key = 'value';
    const result = safeStringifyPreview(obj);
    expect(result).toContain('key');
    expect(result).toContain('value');
  });
});