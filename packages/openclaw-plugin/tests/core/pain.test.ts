import { describe, it, expect } from 'vitest';
import {
  computePainScore,
  painSeverityLabel,
} from '../../src/core/pain';

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

  describe('painSeverityLabel', () => {
    it('should return correct severity labels', () => {
      expect(painSeverityLabel(0, true)).toBe('critical');
      expect(painSeverityLabel(80)).toBe('high');
      expect(painSeverityLabel(50)).toBe('medium');
      expect(painSeverityLabel(25)).toBe('low');
      expect(painSeverityLabel(10)).toBe('info');
    });
  });
});
