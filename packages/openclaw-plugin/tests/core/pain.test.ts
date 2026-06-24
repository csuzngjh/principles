import { describe, it, expect } from 'vitest';
import { computePainScore } from '../../src/core/pain';

describe('Pain Detection Module', () => {
  describe('computePainScore', () => {
    it('should compute score correctly', () => {
      expect(computePainScore(0, false, false, 0)).toBe(0);
      expect(computePainScore(1, false, false, 0)).toBe(70);
      expect(computePainScore(0, true, false, 0)).toBe(40);
      expect(computePainScore(0, false, true, 0)).toBe(30);
      expect(computePainScore(1, true, true, 20)).toBe(100); // capped at 100
    });
  });
});
