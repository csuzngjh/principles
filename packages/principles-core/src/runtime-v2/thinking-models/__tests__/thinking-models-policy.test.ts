import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PATTERNS,
  BUILTIN_PATTERN_MAP,
  getFallbackName,
  getFallbackDescription,
  getBuiltinBaselineScenarios,
} from '../thinking-models-policy.js';
import { CORE_PRINCIPLES, CORE_PRINCIPLE_IDS } from '../../core-principles/index.js';

describe('thinking-models-policy', () => {
  describe('BUILTIN_PATTERNS', () => {
    it('has exactly 10 entries (T-01..T-10)', () => {
      expect(BUILTIN_PATTERNS).toHaveLength(10);
      const ids = BUILTIN_PATTERNS.map(p => p.id).sort();
      expect(ids).toEqual([
        'T-01', 'T-02', 'T-03', 'T-04', 'T-05',
        'T-06', 'T-07', 'T-08', 'T-09', 'T-10',
      ]);
    });

    it('every entry has at least one pattern and at least one baselineScenario', () => {
      for (const entry of BUILTIN_PATTERNS) {
        expect(entry.patterns.length).toBeGreaterThan(0);
        expect(entry.baselineScenarios.length).toBeGreaterThan(0);
      }
    });

    it('BUILTIN_PATTERN_MAP mirrors BUILTIN_PATTERNS', () => {
      expect(BUILTIN_PATTERN_MAP.size).toBe(BUILTIN_PATTERNS.length);
      for (const entry of BUILTIN_PATTERNS) {
        expect(BUILTIN_PATTERN_MAP.get(entry.id)).toBe(entry);
      }
    });
  });

  describe('getFallbackName / getFallbackDescription', () => {
    it('returns name from CORE_PRINCIPLES for known id', () => {
      for (const principle of CORE_PRINCIPLES) {
        expect(getFallbackName(principle.id)).toBe(principle.name);
        expect(getFallbackDescription(principle.id)).toBe(principle.statement);
      }
    });

    it('returns the id itself for unknown id (no crash)', () => {
      expect(getFallbackName('T-UNKNOWN')).toBe('T-UNKNOWN');
      expect(getFallbackDescription('T-UNKNOWN')).toBe('');
    });

    it('covers every CORE_PRINCIPLE_ID', () => {
      for (const id of CORE_PRINCIPLE_IDS) {
        const name = getFallbackName(id);
        const desc = getFallbackDescription(id);
        expect(name).toBeTruthy();
        expect(desc).not.toBe('');
      }
    });
  });

  describe('getBuiltinBaselineScenarios', () => {
    it('returns baselineScenarios for known id', () => {
      expect(getBuiltinBaselineScenarios('T-01')).toEqual(['exploration', 'discovery']);
      expect(getBuiltinBaselineScenarios('T-08')).toEqual(['reflection', 'pain-response']);
    });

    it('returns empty array for unknown id', () => {
      expect(getBuiltinBaselineScenarios('T-UNKNOWN')).toEqual([]);
    });
  });


});
