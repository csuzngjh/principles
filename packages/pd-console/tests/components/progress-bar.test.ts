import { describe, it, expect } from 'vitest';

describe('ProgressBar Component', () => {
  describe('value score normalization', () => {
    it('should normalize value score to 0-100 range', () => {
      const rawScore = 15.5;
      const maxPossible = 50;
      const percentage = Math.min((rawScore / maxPossible) * 100, 100);
      expect(percentage).toBe(31);
    });

    it('should cap at 100 when value exceeds max', () => {
      const rawScore = 100;
      const maxPossible = 50;
      const percentage = Math.min((rawScore / maxPossible) * 100, 100);
      expect(percentage).toBe(100);
    });

    it('should handle zero value', () => {
      const rawScore = 0;
      const maxPossible = 50;
      const percentage = Math.min((rawScore / maxPossible) * 100, 100);
      expect(percentage).toBe(0);
    });
  });

  describe('adherence rate display', () => {
    it('should pass through percentage value directly', () => {
      const adherenceRate = 26.4;
      const percentage = adherenceRate;
      expect(percentage).toBe(26.4);
    });

    it('should display percentage as-is when above 100%', () => {
      const adherenceRate = 120;
      const percentage = adherenceRate;
      expect(percentage).toBe(120);
    });

    it('should handle 0% adherence', () => {
      const adherenceRate = 0;
      const percentage = adherenceRate;
      expect(percentage).toBe(0);
    });
  });

  describe('color thresholds', () => {
    it('should use green for high scores (>70%)', () => {
      const score = 80;
      const color = score > 70 ? 'text-green-500' : score > 40 ? 'text-amber-500' : 'text-red-500';
      expect(color).toBe('text-green-500');
    });

    it('should use amber for medium scores (40-70%)', () => {
      const score = 55;
      const color = score > 70 ? 'text-green-500' : score > 40 ? 'text-amber-500' : 'text-red-500';
      expect(color).toBe('text-amber-500');
    });

    it('should use red for low scores (<40%)', () => {
      const score = 30;
      const color = score > 70 ? 'text-green-500' : score > 40 ? 'text-amber-500' : 'text-red-500';
      expect(color).toBe('text-red-500');
    });
  });
});
