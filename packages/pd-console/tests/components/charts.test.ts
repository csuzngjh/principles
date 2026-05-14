import { describe, it, expect } from 'vitest';
import { computeValueBuckets } from '../../src/ui/components/ui/charts.js';

describe('Charts utilities', () => {
  describe('computeValueBuckets', () => {
    it('should return empty buckets for empty input', () => {
      const result = computeValueBuckets([]);
      expect(result).toHaveLength(5);
      expect(result.every((b) => b.count === 0)).toBe(true);
    });

    it('should distribute values into correct buckets', () => {
      const principles = [
        { valueScore: 10 },
        { valueScore: 25 },
        { valueScore: 50 },
        { valueScore: 75 },
        { valueScore: 100 },
      ];
      const result = computeValueBuckets(principles, 5);
      expect(result).toHaveLength(5);
      const totalCount = result.reduce((sum, b) => sum + b.count, 0);
      expect(totalCount).toBe(5);
    });

    it('should handle all zero values', () => {
      const principles = [
        { valueScore: 0 },
        { valueScore: 0 },
        { valueScore: 0 },
      ];
      const result = computeValueBuckets(principles, 5);
      const totalCount = result.reduce((sum, b) => sum + b.count, 0);
      expect(totalCount).toBe(3);
    });

    it('should handle custom bucket count', () => {
      const principles = [
        { valueScore: 10 },
        { valueScore: 30 },
        { valueScore: 50 },
      ];
      const result = computeValueBuckets(principles, 3);
      expect(result).toHaveLength(3);
    });

    it('should handle single principle', () => {
      const principles = [{ valueScore: 42 }];
      const result = computeValueBuckets(principles, 5);
      const totalCount = result.reduce((sum, b) => sum + b.count, 0);
      expect(totalCount).toBe(1);
    });
  });
});
