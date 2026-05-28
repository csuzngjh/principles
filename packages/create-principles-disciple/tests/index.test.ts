import { describe, it, expect } from 'vitest';
import { isLanguage } from '../src/index.js';

describe('isLanguage type guard', () => {
  it('returns true for valid languages', () => {
    expect(isLanguage('zh')).toBe(true);
    expect(isLanguage('en')).toBe(true);
  });

  it('returns false for invalid languages', () => {
    expect(isLanguage('zh-CN')).toBe(false);
    expect(isLanguage('english')).toBe(false);
    expect(isLanguage('chinese')).toBe(false);
    expect(isLanguage('ja')).toBe(false);
    expect(isLanguage('ko')).toBe(false);
    expect(isLanguage('fr')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isLanguage(null)).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
    expect(isLanguage(42)).toBe(false);
    expect(isLanguage({})).toBe(false);
    expect(isLanguage([])).toBe(false);
    expect(isLanguage(true)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isLanguage('')).toBe(false);
  });
});

describe('Language validation edge cases', () => {
  it('rejects case variations', () => {
    expect(isLanguage('ZH')).toBe(false);
    expect(isLanguage('EN')).toBe(false);
    expect(isLanguage('Zh')).toBe(false);
    expect(isLanguage('En')).toBe(false);
  });

  it('rejects whitespace-padded values', () => {
    expect(isLanguage(' zh')).toBe(false);
    expect(isLanguage('zh ')).toBe(false);
    expect(isLanguage(' zh ')).toBe(false);
  });
});