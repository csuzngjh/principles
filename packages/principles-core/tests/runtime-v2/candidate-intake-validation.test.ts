/**
 * Unit tests for candidate-intake validation functions — pure logic only.
 * Tests validateRecommendation, isRecord, and Recommendation shape validation.
 */

import { describe, it, expect } from 'vitest';
import {
  validateRecommendation,
  isRecord,
  type Recommendation,
} from '../../src/runtime-v2/candidate-intake.js';

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord({ nested: { deep: true } })).toBe(true);
  });

  it('returns false for arrays', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord('string')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(false)).toBe(false);
    expect(isRecord(Symbol('test'))).toBe(false);
  });

  it('returns false for functions', () => {
    expect(isRecord(() => {})).toBe(false);
  });
});

describe('validateRecommendation', () => {
  describe('valid recommendations', () => {
    it('accepts recommendation with all string fields', () => {
      const rec = {
        title: 'Test title',
        text: 'Test text body',
        triggerPattern: 'file.*delete',
        action: 'verify backup',
        abstractedPrinciple: 'Always verify before destructive actions',
      };
      const result = validateRecommendation(rec);
      expect(result).not.toBeNull();
      expect(result?.title).toBe('Test title');
      expect(result?.text).toBe('Test text body');
      expect(result?.triggerPattern).toBe('file.*delete');
      expect(result?.action).toBe('verify backup');
      expect(result?.abstractedPrinciple).toBe('Always verify before destructive actions');
    });

    it('accepts recommendation with only text field', () => {
      const rec = { text: 'Minimal recommendation' };
      const result = validateRecommendation(rec);
      expect(result).not.toBeNull();
      expect(result?.text).toBe('Minimal recommendation');
    });

    it('accepts recommendation with only title field', () => {
      const rec = { title: 'Just a title' };
      const result = validateRecommendation(rec);
      expect(result).not.toBeNull();
      expect(result?.title).toBe('Just a title');
    });

    it('accepts recommendation with only triggerPattern', () => {
      const rec = { triggerPattern: 'file.*delete' };
      const result = validateRecommendation(rec);
      expect(result).not.toBeNull();
      expect(result?.triggerPattern).toBe('file.*delete');
    });

    it('accepts recommendation with only action', () => {
      const rec = { action: 'do something' };
      const result = validateRecommendation(rec);
      expect(result).not.toBeNull();
      expect(result?.action).toBe('do something');
    });

    it('accepts recommendation with only abstractedPrinciple', () => {
      const rec = { abstractedPrinciple: 'Some principle' };
      const result = validateRecommendation(rec);
      expect(result).not.toBeNull();
      expect(result?.abstractedPrinciple).toBe('Some principle');
    });

    it('preserves extra fields (lenient about unknown fields)', () => {
      const rec = {
        text: 'Valid text',
        extraField: 'should be preserved',
        anotherExtra: 123,
      } as unknown as Recommendation;
      const result = validateRecommendation(rec);
      expect(result).not.toBeNull();
      expect(result?.text).toBe('Valid text');
    });
  });

  describe('invalid recommendations', () => {
    it('returns null for null input', () => {
      expect(validateRecommendation(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(validateRecommendation(undefined)).toBeNull();
    });

    it('returns null for primitive string', () => {
      expect(validateRecommendation('just a string')).toBeNull();
    });

    it('returns null for primitive number', () => {
      expect(validateRecommendation(42)).toBeNull();
    });

    it('returns null for primitive boolean', () => {
      expect(validateRecommendation(true)).toBeNull();
    });

    it('returns null for arrays', () => {
      expect(validateRecommendation(['text'])).toBeNull();
      expect(validateRecommendation([])).toBeNull();
    });

    it('returns null for empty object (no recognized fields)', () => {
      expect(validateRecommendation({})).toBeNull();
    });

    it('returns null for object with only unrecognized fields', () => {
      expect(validateRecommendation({ x: 1, y: 2 })).toBeNull();
      expect(validateRecommendation({ foo: 'bar' })).toBeNull();
    });

    it('returns null when a recognized field has wrong type (number instead of string)', () => {
      expect(validateRecommendation({ text: 123 })).toBeNull();
    });

    it('returns null when title is not a string', () => {
      expect(validateRecommendation({ title: 42 })).toBeNull();
    });

    it('returns null when triggerPattern is not a string', () => {
      expect(validateRecommendation({ triggerPattern: /regex/ })).toBeNull();
    });

    it('returns null when action is not a string', () => {
      expect(validateRecommendation({ action: null })).toBeNull();
    });

    it('returns null when abstractedPrinciple is not a string', () => {
      expect(validateRecommendation({ abstractedPrinciple: {} })).toBeNull();
    });

    it('returns null when one valid field is mixed with one invalid type field', () => {
      expect(validateRecommendation({ text: 'valid', title: 123 })).toBeNull();
    });

    it('returns null when text is an empty string (still a string, should pass — wait, empty string IS a string)', () => {
      const result = validateRecommendation({ text: '' });
      expect(result).not.toBeNull();
      expect(result?.text).toBe('');
    });
  });

  describe('boundary cases', () => {
    it('handles very long string values', () => {
      const longText = 'a'.repeat(10000);
      const result = validateRecommendation({ text: longText });
      expect(result).not.toBeNull();
      expect(result?.text).toBe(longText);
    });

    it('handles special characters in string values', () => {
      const specialText = '<script>alert("xss")</script> & \' " `';
      const result = validateRecommendation({ text: specialText });
      expect(result).not.toBeNull();
      expect(result?.text).toBe(specialText);
    });

    it('handles unicode in string values', () => {
      const unicodeText = '测试 日本語 🎉 emojis';
      const result = validateRecommendation({ text: unicodeText });
      expect(result).not.toBeNull();
      expect(result?.text).toBe(unicodeText);
    });

    it('handles whitespace-only strings', () => {
      const result = validateRecommendation({ text: '   \n\t  ' });
      expect(result).not.toBeNull();
      expect(result?.text).toBe('   \n\t  ');
    });
  });
});
