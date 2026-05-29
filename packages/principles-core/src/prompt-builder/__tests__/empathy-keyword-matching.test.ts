import { describe, it, expect } from 'vitest';
import {
  matchEmpathyKeywords,
  createDefaultKeywordStore,
  applyKeywordUpdates,
  shouldTriggerOptimization,
  getKeywordStoreSummary,
} from '../empathy-keyword-matching.js';
import {
  scoreToSeverity,
  severityToPenalty,
  normalizeSeverity,
  DEFAULT_EMPATHY_KEYWORD_CONFIG,
} from '../empathy-types.js';

describe('Empathy Keyword Matching (core)', () => {
  describe('createDefaultKeywordStore', () => {
    it('should create store with Chinese keywords', () => {
      const store = createDefaultKeywordStore('zh');

      expect(store.version).toBe(1);
      expect(Object.keys(store.terms).length).toBeGreaterThan(0);

      const chineseTerms = Object.keys(store.terms).filter(t => /[\u4e00-\u9fa5]/.test(t));
      expect(chineseTerms.length).toBeGreaterThan(0);
    });

    it('should create store with only English keywords', () => {
      const store = createDefaultKeywordStore('en');

      const chineseTerms = Object.keys(store.terms).filter(t => /[\u4e00-\u9fa5]/.test(t));
      expect(chineseTerms.length).toBe(0);
    });

    it('should differentiate FPR based on keyword specificity', () => {
      const store = createDefaultKeywordStore('zh');

      expect(store.terms['垃圾']?.falsePositiveRate).toBe(0.05);
      expect(store.terms['废物']?.falsePositiveRate).toBe(0.05);

      expect(store.terms['不对']?.falsePositiveRate).toBe(0.3);
      expect(store.terms['不行']?.falsePositiveRate).toBe(0.35);

      for (const entry of Object.values(store.terms)) {
        expect(entry.falsePositiveRate).toBeGreaterThanOrEqual(0.05);
        expect(entry.falsePositiveRate).toBeLessThanOrEqual(0.35);
      }
    });
  });

  describe('matchEmpathyKeywords', () => {
    it('should detect keywords in Chinese text', () => {
      const store = createDefaultKeywordStore('zh');
      const result = matchEmpathyKeywords('这个不对，你搞错了', store);

      expect(result.matched).toBe(true);
      expect(result.matchedTerms.length).toBeGreaterThan(0);
    });

    it('should detect keywords in English text', () => {
      const store = createDefaultKeywordStore('en');
      const result = matchEmpathyKeywords('This is garbage', store);

      expect(result.matched).toBe(true);
      expect(result.matchedTerms).toContain('garbage');
    });

    it('should return no match for empty text', () => {
      const store = createDefaultKeywordStore('zh');
      const result = matchEmpathyKeywords('', store);

      expect(result.matched).toBe(false);
      expect(result.score).toBe(0);
      expect(result.matchedTerms).toEqual([]);
      expect(result.severity).toBe('mild');
      expect(result.confidence).toBe(0);
    });

    it('should calculate severity correctly', () => {
      const store = createDefaultKeywordStore('zh');
      const result = matchEmpathyKeywords('垃圾 蠢 废物', store);

      expect(result.severity).toBe('severe');
    });

    it('should respect matchThreshold', () => {
      const store = createDefaultKeywordStore('zh');
      const strictConfig = { ...DEFAULT_EMPATHY_KEYWORD_CONFIG, matchThreshold: 0.95 };
      const result = matchEmpathyKeywords('不行啊', store, strictConfig);

      expect(result.matched).toBe(false);
    });

    it('should cap score at 1.0', () => {
      const store = createDefaultKeywordStore('zh');
      const result = matchEmpathyKeywords('垃圾 蠢 废物 白做 浪费时间', store);

      expect(result.score).toBeLessThanOrEqual(1);
    });

    it('should handle null/undefined gracefully with full result shape', () => {
      const store = createDefaultKeywordStore('zh');

      const nullResult = matchEmpathyKeywords(null as unknown as string, store);
      expect(nullResult.matched).toBe(false);
      expect(nullResult.score).toBe(0);
      expect(nullResult.matchedTerms).toEqual([]);
      expect(nullResult.severity).toBe('mild');
      expect(nullResult.confidence).toBe(0);

      const undefinedResult = matchEmpathyKeywords(undefined as unknown as string, store);
      expect(undefinedResult.matched).toBe(false);
      expect(undefinedResult.score).toBe(0);
      expect(undefinedResult.matchedTerms).toEqual([]);
    });

    it('should mutate store hitCount and lastHitAt on match', () => {
      const store = createDefaultKeywordStore('zh');
      const term = '垃圾';
      const beforeEntry = store.terms[term];
      expect(beforeEntry).toBeDefined();
      const beforeHitCount = beforeEntry?.hitCount ?? 0;

      matchEmpathyKeywords(term, store);

      expect(store.terms[term]?.hitCount).toBe(beforeHitCount + 1);
      expect(store.terms[term]?.lastHitAt).toBeDefined();
    });

    it('should increment store.stats.totalHits on match', () => {
      const store = createDefaultKeywordStore('zh');
      const beforeTotal = store.stats.totalHits;

      const result = matchEmpathyKeywords('垃圾', store);

      if (result.matched) {
        expect(store.stats.totalHits).toBeGreaterThan(beforeTotal);
      }
    });
  });

  describe('applyKeywordUpdates', () => {
    it('should add new keywords', () => {
      const store = createDefaultKeywordStore('zh');
      const updates = {
        'newKeyword': {
          action: 'add' as const,
          weight: 0.7,
          falsePositiveRate: 0.15,
        },
      };

      const result = applyKeywordUpdates(store, updates);

      expect(result.added).toBe(1);
      expect(store.terms.newKeyword).toBeDefined();
    });

    it('should remove keywords', () => {
      const store = createDefaultKeywordStore('zh');
      const allTerms = Object.keys(store.terms);
      const firstTerm = allTerms[0] ?? '';
      const updates: Record<string, { action: 'remove' }> = {
        [firstTerm]: { action: 'remove' },
      };

      const result = applyKeywordUpdates(store, updates);

      expect(result.removed).toBe(1);
      expect(store.terms[firstTerm]).toBeUndefined();
    });

    it('should update existing keyword weight and falsePositiveRate', () => {
      const store = createDefaultKeywordStore('zh');
      const term = '垃圾';
      const updates = {
        [term]: {
          action: 'update' as const,
          weight: 0.95,
          falsePositiveRate: 0.01,
        },
      };

      const result = applyKeywordUpdates(store, updates);

      expect(result.updated).toBe(1);
      expect(store.terms[term]?.weight).toBe(0.95);
      expect(store.terms[term]?.falsePositiveRate).toBe(0.01);
    });

    it('should update existing keyword examples', () => {
      const store = createDefaultKeywordStore('zh');
      const term = '垃圾';
      const updates = {
        [term]: {
          action: 'update' as const,
          examples: ['这个代码是垃圾'],
        },
      };

      const result = applyKeywordUpdates(store, updates);

      expect(result.updated).toBe(1);
      expect(store.terms[term]?.examples).toEqual(['这个代码是垃圾']);
    });

    it('should not add keyword on update if term does not exist', () => {
      const store = createDefaultKeywordStore('zh');
      const updates = {
        'nonExistentTerm': {
          action: 'update' as const,
          weight: 0.5,
        },
      };

      const result = applyKeywordUpdates(store, updates);

      expect(result.updated).toBe(0);
      expect(store.terms.nonExistentTerm).toBeUndefined();
    });

    it('should not add keyword on add if term already exists', () => {
      const store = createDefaultKeywordStore('zh');
      const term = '垃圾';
      const originalWeight = store.terms[term]?.weight;
      const updates = {
        [term]: {
          action: 'add' as const,
          weight: 0.99,
        },
      };

      const result = applyKeywordUpdates(store, updates);

      expect(result.added).toBe(0);
      expect(store.terms[term]?.weight).toBe(originalWeight);
    });

    it('should update store.lastOptimizedAt and stats.optimizationCount', () => {
      const store = createDefaultKeywordStore('zh');
      const beforeCount = store.stats.optimizationCount;

      applyKeywordUpdates(store, { 'newKw': { action: 'add' as const, weight: 0.5 } });

      expect(store.stats.optimizationCount).toBe(beforeCount + 1);
      expect(store.lastOptimizedAt).toBeDefined();
    });
  });

  describe('shouldTriggerOptimization', () => {
    it('should return true when turns exceed interval', () => {
      const store = createDefaultKeywordStore('zh');
      expect(shouldTriggerOptimization(store, 150)).toBe(true);
    });

    it('should return false when turns are below interval', () => {
      const store = createDefaultKeywordStore('zh');
      expect(shouldTriggerOptimization(store, 10)).toBe(false);
    });
  });

  describe('getKeywordStoreSummary', () => {
    it('should return correct counts', () => {
      const store = createDefaultKeywordStore('zh');
      const summary = getKeywordStoreSummary(store);

      expect(summary.totalTerms).toBe(Object.keys(store.terms).length);
      expect(summary.seedTerms).toBeGreaterThan(0);
    });

    it('should return top hit terms sorted with correct hitCount values', () => {
      const store = createDefaultKeywordStore('zh');

      for (let i = 0; i < 5; i++) matchEmpathyKeywords('垃圾', store);
      for (let i = 0; i < 3; i++) matchEmpathyKeywords('不对', store);

      const summary = getKeywordStoreSummary(store);

      expect(summary.topHitTerms.length).toBeGreaterThan(0);

      const garbageEntry = summary.topHitTerms.find(t => t.term === '垃圾');
      expect(garbageEntry?.hitCount).toBe(5);

      const wrongEntry = summary.topHitTerms.find(t => t.term === '不对');
      expect(wrongEntry?.hitCount).toBe(3);

      for (let i = 0; i < summary.topHitTerms.length - 1; i++) {
        const current = summary.topHitTerms[i];
        const next = summary.topHitTerms[i + 1];
        if (current && next) {
          expect(current.hitCount).toBeGreaterThanOrEqual(next.hitCount);
        }
      }
    });
  });

  describe('Utility Functions', () => {
    it('scoreToSeverity should map correctly', () => {
      expect(scoreToSeverity(0.1)).toBe('mild');
      expect(scoreToSeverity(0.4)).toBe('moderate');
      expect(scoreToSeverity(0.8)).toBe('severe');
    });

    it('severityToPenalty should return correct values', () => {
      expect(severityToPenalty('mild')).toBe(10);
      expect(severityToPenalty('moderate')).toBe(25);
      expect(severityToPenalty('severe')).toBe(40);
    });

    it('severityToPenalty should return mild penalty for invalid input via default', () => {
      expect(severityToPenalty('invalid' as 'mild')).toBe(10);
    });

    it('normalizeSeverity should map severity aliases', () => {
      expect(normalizeSeverity('severe')).toBe('severe');
      expect(normalizeSeverity('high')).toBe('severe');
      expect(normalizeSeverity('moderate')).toBe('moderate');
      expect(normalizeSeverity('medium')).toBe('moderate');
      expect(normalizeSeverity('mild')).toBe('mild');
      expect(normalizeSeverity('low')).toBe('mild');
    });

    it('normalizeSeverity should handle empty and undefined input', () => {
      expect(normalizeSeverity('')).toBe('mild');
      expect(normalizeSeverity(undefined)).toBe('mild');
    });

    it('normalizeSeverity should be case-insensitive', () => {
      expect(normalizeSeverity('SEVERE')).toBe('severe');
      expect(normalizeSeverity('High')).toBe('severe');
      expect(normalizeSeverity('MODERATE')).toBe('moderate');
    });
  });

  describe('scoreToSeverity boundary values', () => {
    it('score exactly 0.3 is moderate', () => {
      expect(scoreToSeverity(0.3)).toBe('moderate');
    });

    it('score exactly 0.6 is severe', () => {
      expect(scoreToSeverity(0.6)).toBe('severe');
    });

    it('score just below 0.3 is mild', () => {
      expect(scoreToSeverity(0.29)).toBe('mild');
    });

    it('score just below 0.6 is moderate', () => {
      expect(scoreToSeverity(0.59)).toBe('moderate');
    });

    it('score 0 is mild', () => {
      expect(scoreToSeverity(0)).toBe('mild');
    });

    it('score 1 is severe', () => {
      expect(scoreToSeverity(1)).toBe('severe');
    });
  });

  describe('severityToPenalty with custom config', () => {
    it('uses custom penalty values', () => {
      const customConfig = {
        ...DEFAULT_EMPATHY_KEYWORD_CONFIG,
        penaltyMild: 5,
        penaltyModerate: 15,
        penaltySevere: 50,
      };
      expect(severityToPenalty('mild', customConfig)).toBe(5);
      expect(severityToPenalty('moderate', customConfig)).toBe(15);
      expect(severityToPenalty('severe', customConfig)).toBe(50);
    });
  });

  describe('matchEmpathyKeywords edge cases', () => {
    it('whitespace-only text returns no match', () => {
      const store = createDefaultKeywordStore('zh');
      const result = matchEmpathyKeywords('   \t\n  ', store);

      expect(result.matched).toBe(false);
      expect(result.score).toBe(0);
    });

    it('maxTermsPerMessage limits matched terms', () => {
      const store = createDefaultKeywordStore('zh');
      const config = { ...DEFAULT_EMPATHY_KEYWORD_CONFIG, maxTermsPerMessage: 2 };
      const result = matchEmpathyKeywords('不对 错了 搞错了', store, config);

      expect(result.matchedTerms.length).toBeLessThanOrEqual(2);
    });

    it('adjusted weight accounts for falsePositiveRate', () => {
      const store = createDefaultKeywordStore('zh');
      const term = '垃圾';
      const entry = store.terms[term];
      expect(entry).toBeDefined();
      if (!entry) return;
      const expectedWeight = entry.weight * (1 - entry.falsePositiveRate);

      const result = matchEmpathyKeywords(term, store);

      expect(result.score).toBeCloseTo(expectedWeight, 2);
    });
  });

  describe('applyKeywordUpdates edge cases', () => {
    it('remove non-existent term is no-op', () => {
      const store = createDefaultKeywordStore('zh');
      const result = applyKeywordUpdates(store, { 'nonexistent': { action: 'remove' } });

      expect(result.removed).toBe(0);
    });

    it('add with default weight and falsePositiveRate', () => {
      const store = createDefaultKeywordStore('zh');
      const result = applyKeywordUpdates(store, { 'testTerm': { action: 'add' } });

      expect(result.added).toBe(1);
      expect(store.terms.testTerm?.weight).toBe(0.5);
      expect(store.terms.testTerm?.falsePositiveRate).toBe(0.2);
      expect(store.terms.testTerm?.source).toBe('llm_discovered');
    });

    it('add with examples', () => {
      const store = createDefaultKeywordStore('zh');
      applyKeywordUpdates(store, {
        'testTerm': { action: 'add', examples: ['example 1', 'example 2'] },
      });

      expect(store.terms.testTerm?.examples).toEqual(['example 1', 'example 2']);
    });

    it('empty updates object returns zeros', () => {
      const store = createDefaultKeywordStore('zh');
      const result = applyKeywordUpdates(store, {});

      expect(result).toEqual({ added: 0, updated: 0, removed: 0 });
    });
  });
});
