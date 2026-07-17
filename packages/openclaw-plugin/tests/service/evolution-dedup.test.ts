import { describe, it, expect, vi } from 'vitest';
import {
  findRecentDuplicateTask,
  hasRecentDuplicateTask,
  hasEquivalentPromotedRule,
  PAIN_QUEUE_DEDUP_WINDOW_MS,
} from '../../src/service/evolution-dedup.js';
import type { EvolutionQueueItem } from '../../src/core/evolution-types.js';

describe('EvolutionDedup', () => {
  const createQueueItem = (
    source: string,
    preview: string,
    enqueuedAt: number,
    status: 'pending' | 'completed' = 'pending',
    reason?: string,
  ): EvolutionQueueItem => ({
    id: `task-${Date.now()}-${Math.random()}`,
    source,
    trigger_text_preview: preview,
    enqueued_at: new Date(enqueuedAt).toISOString(),
    timestamp: new Date(enqueuedAt).toISOString(),
    status,
    ...(reason ? { reason } : {}),
  } as EvolutionQueueItem);

  describe('findRecentDuplicateTask', () => {
    it('should find duplicate task within dedup window', () => {
      const now = Date.now();
      const source = 'code_review';
      const preview = 'fix bug in auth';
      const queue: EvolutionQueueItem[] = [
        createQueueItem(source, preview, now - 1000),
      ];
      const duplicate = findRecentDuplicateTask(queue, source, preview, now);
      expect(duplicate).toBeDefined();
      expect(duplicate?.source).toBe(source);
      expect(duplicate?.trigger_text_preview).toBe(preview);
    });

    it('should not find duplicate task outside dedup window', () => {
      const now = Date.now();
      const source = 'code_review';
      const preview = 'fix bug in auth';
      const queue: EvolutionQueueItem[] = [
        createQueueItem(source, preview, now - PAIN_QUEUE_DEDUP_WINDOW_MS - 1000),
      ];
      const duplicate = findRecentDuplicateTask(queue, source, preview, now);
      expect(duplicate).toBeUndefined();
    });

    it('should not match completed tasks', () => {
      const now = Date.now();
      const source = 'code_review';
      const preview = 'fix bug in auth';
      const queue: EvolutionQueueItem[] = [
        createQueueItem(source, preview, now - 1000, 'completed'),
      ];
      const duplicate = findRecentDuplicateTask(queue, source, preview, now);
      expect(duplicate).toBeUndefined();
    });

    it('should match tasks with different casing', () => {
      const now = Date.now();
      const queue: EvolutionQueueItem[] = [
        createQueueItem('CODE_REVIEW', 'FIX BUG IN AUTH', now - 1000),
      ];
      const duplicate = findRecentDuplicateTask(queue, 'code_review', 'fix bug in auth', now);
      expect(duplicate).toBeDefined();
    });

    it('should ignore extra whitespace when matching', () => {
      const now = Date.now();
      const queue: EvolutionQueueItem[] = [
        createQueueItem(' code_review ', '  fix bug in auth  ', now - 1000),
      ];
      const duplicate = findRecentDuplicateTask(queue, 'code_review', 'fix bug in auth', now);
      expect(duplicate).toBeDefined();
    });

    it('should consider reason in deduplication', () => {
      const now = Date.now();
      const source = 'code_review';
      const preview = 'fix bug in auth';
      const queue: EvolutionQueueItem[] = [
        createQueueItem(source, preview, now - 1000, 'pending', 'manual'),
      ];
      const duplicateWithSameReason = findRecentDuplicateTask(queue, source, preview, now, 'manual');
      const duplicateWithDifferentReason = findRecentDuplicateTask(queue, source, preview, now, 'auto');
      expect(duplicateWithSameReason).toBeDefined();
      expect(duplicateWithDifferentReason).toBeUndefined();
    });

    it('should truncate long source and preview strings', () => {
      const now = Date.now();
      const longString = 'a'.repeat(500);
      const queue: EvolutionQueueItem[] = [
        createQueueItem(longString, longString, now - 1000),
      ];
      const duplicate = findRecentDuplicateTask(queue, longString, longString, now);
      expect(duplicate).toBeDefined();
    });

    it('should handle tasks with missing enqueued_at', () => {
      const now = Date.now();
      const source = 'code_review';
      const preview = 'fix bug';
      const queue: EvolutionQueueItem[] = [
        {
          ...createQueueItem(source, preview, now - 1000),
          enqueued_at: undefined,
        } as EvolutionQueueItem,
      ];
      const duplicate = findRecentDuplicateTask(queue, source, preview, now);
      expect(duplicate).toBeDefined();
    });
  });

  describe('hasRecentDuplicateTask', () => {
    it('should return true when duplicate exists', () => {
      const now = Date.now();
      const queue: EvolutionQueueItem[] = [
        createQueueItem('code_review', 'fix bug', now - 1000),
      ];
      const result = hasRecentDuplicateTask(queue, 'code_review', 'fix bug', now);
      expect(result).toBe(true);
    });

    it('should return false when no duplicate exists', () => {
      const now = Date.now();
      const queue: EvolutionQueueItem[] = [
        createQueueItem('code_review', 'different task', now - 1000),
      ];
      const result = hasRecentDuplicateTask(queue, 'code_review', 'fix bug', now);
      expect(result).toBe(false);
    });
  });

  describe('hasEquivalentPromotedRule', () => {
    const createMockDictionary = (rules: Record<string, { type: string; phrases?: string[]; pattern?: string; status: string }>) => ({
      getAllRules: () => rules,
    });

    it('should match exact phrase rule', () => {
      const dictionary = createMockDictionary({
        rule1: { type: 'exact_match', phrases: ['fix bug', 'update config'], status: 'active' },
      });
      const result = hasEquivalentPromotedRule(dictionary, 'fix bug');
      expect(result).toBe(true);
    });

    it('should not match inactive rule', () => {
      const dictionary = createMockDictionary({
        rule1: { type: 'exact_match', phrases: ['fix bug'], status: 'disabled' },
      });
      const result = hasEquivalentPromotedRule(dictionary, 'fix bug');
      expect(result).toBe(false);
    });

    it('should match exact phrase with different casing', () => {
      const dictionary = createMockDictionary({
        rule1: { type: 'exact_match', phrases: ['FIX BUG'], status: 'active' },
      });
      const result = hasEquivalentPromotedRule(dictionary, 'fix bug');
      expect(result).toBe(true);
    });

    it('should not match non-existent phrase', () => {
      const dictionary = createMockDictionary({
        rule1: { type: 'exact_match', phrases: ['update config'], status: 'active' },
      });
      const result = hasEquivalentPromotedRule(dictionary, 'fix bug');
      expect(result).toBe(false);
    });

    it('should match regex pattern rule', () => {
      const dictionary = createMockDictionary({
        rule1: { type: 'regex', pattern: '/fix.*/', status: 'active' },
      });
      const result = hasEquivalentPromotedRule(dictionary, '/fix.*/');
      expect(result).toBe(true);
    });

    it('should not match when pattern format differs', () => {
      const dictionary = createMockDictionary({
        rule1: { type: 'regex', pattern: '/fix.*/', status: 'active' },
      });
      const result = hasEquivalentPromotedRule(dictionary, 'fix.*');
      expect(result).toBe(false);
    });

    it('should handle empty phrases array', () => {
      const dictionary = createMockDictionary({
        rule1: { type: 'exact_match', phrases: [], status: 'active' },
      });
      const result = hasEquivalentPromotedRule(dictionary, 'fix bug');
      expect(result).toBe(false);
    });

    it('should handle missing phrases for exact_match rule', () => {
      const dictionary = createMockDictionary({
        rule1: { type: 'exact_match', status: 'active' },
      });
      const result = hasEquivalentPromotedRule(dictionary, 'fix bug');
      expect(result).toBe(false);
    });

    it('should handle missing pattern for regex rule', () => {
      const dictionary = createMockDictionary({
        rule1: { type: 'regex', status: 'active' },
      });
      const result = hasEquivalentPromotedRule(dictionary, 'fix bug');
      expect(result).toBe(false);
    });
  });
});