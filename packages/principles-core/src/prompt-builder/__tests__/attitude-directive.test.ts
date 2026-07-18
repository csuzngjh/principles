import { describe, it, expect } from 'vitest';
import { buildAttitudeDirective } from '../attitude-directive.js';

describe('attitude-directive', () => {
  describe('buildAttitudeDirective', () => {
    it('returns HUMBLE_RECOVERY mode when GFI >= 70', () => {
      const result = buildAttitudeDirective(70);
      expect(result).toContain('SYSTEM_MODE: HUMBLE_RECOVERY');
      expect(result).toContain('Severe system friction');
      expect(result).toContain('GFI: 70');
      expect(result).toContain('HUMBLE_RECOVERY');
    });

    it('returns HUMBLE_RECOVERY mode for high GFI values', () => {
      const result = buildAttitudeDirective(95);
      expect(result).toContain('SYSTEM_MODE: HUMBLE_RECOVERY');
      expect(result).toContain('GFI: 95');
    });

    it('returns CONCILIATORY mode when GFI >= 40 and < 70', () => {
      const result = buildAttitudeDirective(40);
      expect(result).toContain('SYSTEM_MODE: CONCILIATORY');
      expect(result).toContain('Moderate friction');
      expect(result).toContain('GFI: 40');
    });

    it('returns CONCILIATORY mode for mid-range GFI values', () => {
      const result = buildAttitudeDirective(55);
      expect(result).toContain('SYSTEM_MODE: CONCILIATORY');
      expect(result).toContain('GFI: 55');
    });

    it('returns EFFICIENT mode when GFI < 40', () => {
      const result = buildAttitudeDirective(39);
      expect(result).toContain('SYSTEM_MODE: EFFICIENT');
      expect(result).toContain('System healthy');
      expect(result).toContain('GFI: 39');
    });

    it('returns EFFICIENT mode for low GFI values', () => {
      const result = buildAttitudeDirective(0);
      expect(result).toContain('SYSTEM_MODE: EFFICIENT');
      expect(result).toContain('GFI: 0');
    });

    it('returns EFFICIENT mode for zero GFI', () => {
      const result = buildAttitudeDirective(0);
      expect(result).toContain('SYSTEM_MODE: EFFICIENT');
    });

    it('formats GFI as integer', () => {
      const result = buildAttitudeDirective(42.5);
      expect(result).toContain('GFI: 43');
    });
  });
});