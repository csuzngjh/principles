import { describe, it, expect } from 'vitest';
import { stripFabricatedCorePrincipleIds } from '../strip-fabricated-ids.js';

describe('stripFabricatedCorePrincipleIds', () => {
  it('strips fabricated sourcePrincipleId (pri-unknown)', () => {
    const output = { sourcePrincipleId: 'pri-unknown', other: 'value' };
    stripFabricatedCorePrincipleIds(output);
    expect(Object.hasOwn(output, 'sourcePrincipleId')).toBe(false);
    expect(output.other).toBe('value');
  });

  it('strips fabricated sourcePrincipleId (pri-000)', () => {
    const output = { sourcePrincipleId: 'pri-000' };
    stripFabricatedCorePrincipleIds(output);
    expect(Object.hasOwn(output, 'sourcePrincipleId')).toBe(false);
  });

  it('strips fabricated sourcePrincipleId (pri-999)', () => {
    const output = { sourcePrincipleId: 'pri-999' };
    stripFabricatedCorePrincipleIds(output);
    expect(Object.hasOwn(output, 'sourcePrincipleId')).toBe(false);
  });

  it('strips fabricated sourcePrincipleId (T-99 — format-valid but not in registry)', () => {
    const output = { sourcePrincipleId: 'T-99' };
    stripFabricatedCorePrincipleIds(output);
    expect(Object.hasOwn(output, 'sourcePrincipleId')).toBe(false);
  });

  it('preserves valid sourcePrincipleId (T-01)', () => {
    const output = { sourcePrincipleId: 'T-01', other: 'value' };
    stripFabricatedCorePrincipleIds(output);
    expect(output.sourcePrincipleId).toBe('T-01');
  });

  it('preserves valid sourcePrincipleId (T-10)', () => {
    const output = { sourcePrincipleId: 'T-10' };
    stripFabricatedCorePrincipleIds(output);
    expect(output.sourcePrincipleId).toBe('T-10');
  });

  it('does nothing when sourcePrincipleId is absent', () => {
    const output = { other: 'value' };
    stripFabricatedCorePrincipleIds(output);
    expect(Object.hasOwn(output, 'sourcePrincipleId')).toBe(false);
    expect(output.other).toBe('value');
  });

  it('does not strip non-string sourcePrincipleId (lets validation handle it)', () => {
    const output = { sourcePrincipleId: 123 };
    stripFabricatedCorePrincipleIds(output);
    // Non-string values are left for validation to reject (Runtime Contract Rule 3)
    expect(output.sourcePrincipleId).toBe(123);
  });

  it('strips empty string sourcePrincipleId (not in registry)', () => {
    const output = { sourcePrincipleId: '' };
    stripFabricatedCorePrincipleIds(output);
    // Empty string is not a valid core principle ID — stripped so validation
    // can detect the missing field and fail loud (Runtime Contract Rule 3)
    expect(Object.hasOwn(output, 'sourcePrincipleId')).toBe(false);
  });

  it('is a no-op for null', () => {
    expect(() => stripFabricatedCorePrincipleIds(null)).not.toThrow();
  });

  it('is a no-op for undefined', () => {
    expect(() => stripFabricatedCorePrincipleIds(undefined)).not.toThrow();
  });

  it('is a no-op for primitives', () => {
    expect(() => stripFabricatedCorePrincipleIds('string')).not.toThrow();
    expect(() => stripFabricatedCorePrincipleIds(42)).not.toThrow();
    expect(() => stripFabricatedCorePrincipleIds(true)).not.toThrow();
  });

  it('is a no-op for arrays', () => {
    const arr = [{ sourcePrincipleId: 'pri-unknown' }];
    stripFabricatedCorePrincipleIds(arr);
    // Arrays are not LLM output objects — skip
    expect(arr[0]?.sourcePrincipleId).toBe('pri-unknown');
  });

  it('handles object with no own properties (prototype)', () => {
    const obj = Object.create({ sourcePrincipleId: 'pri-unknown' });
    stripFabricatedCorePrincipleIds(obj);
    // Object.hasOwn returns false for inherited properties — no stripping
    expect(Object.hasOwn(obj, 'sourcePrincipleId')).toBe(false);
  });
});
