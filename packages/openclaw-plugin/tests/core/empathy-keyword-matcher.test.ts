import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  matchEmpathyKeywords,
  loadKeywordStore,
  saveKeywordStore,
  shouldTriggerOptimization,
  createDefaultKeywordStore,
  applyKeywordUpdates,
  getKeywordStoreSummary,
} from '../../src/core/empathy-keyword-matcher.js';
import {
  EMPATHY_SEED_KEYWORDS,
  DEFAULT_EMPATHY_KEYWORD_CONFIG,
  scoreToSeverity,
  severityToPenalty,
} from '../../src/core/empathy-types.js';

// Mock fs to avoid file system dependencies
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

describe('Empathy Keyword Matcher', () => {
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

    it('should handle null/undefined gracefully', () => {
      const store = createDefaultKeywordStore('zh');
      
      expect(matchEmpathyKeywords(null as any, store).matched).toBe(false);
      expect(matchEmpathyKeywords(undefined as any, store).matched).toBe(false);
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
      expect(store.terms['newKeyword']).toBeDefined();
    });

    it('should remove keywords', () => {
      const store = createDefaultKeywordStore('zh');
      const firstTerm = Object.keys(store.terms)[0];
      const updates = {
        [firstTerm]: {
          action: 'remove' as const,
        },
      };

      const result = applyKeywordUpdates(store, updates);
      
      expect(result.removed).toBe(1);
      expect(store.terms[firstTerm]).toBeUndefined();
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

    it('should return top hit terms sorted', () => {
      const store = createDefaultKeywordStore('zh');
      
      // Simulate hits
      for (let i = 0; i < 5; i++) matchEmpathyKeywords('垃圾', store);
      for (let i = 0; i < 3; i++) matchEmpathyKeywords('不对', store);
      
      const summary = getKeywordStoreSummary(store);
      
      expect(summary.topHitTerms.length).toBeGreaterThan(0);
      // Verify sorted order
      for (let i = 0; i < summary.topHitTerms.length - 1; i++) {
        expect(summary.topHitTerms[i].hitCount).toBeGreaterThanOrEqual(
          summary.topHitTerms[i + 1].hitCount
        );
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
  });
});
