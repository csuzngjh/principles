import { describe, it, expect } from 'vitest';
import { normalizePath, normalizeRiskPath, isRisky, parseKvLines, serializeKvLines, planStatus } from '../../src/utils/io';

describe('IO Utilities', () => {
  describe('Path Normalization', () => {
    it('should normalize posix paths', () => {
      expect(normalizePath('/project/src/index.ts', '/project')).toBe('src/index.ts');
      expect(normalizePath('src/index.ts', '/project')).toBe('src/index.ts');
      expect(normalizePath('./src/index.ts', '/project')).toBe('src/index.ts');
    });

    it('should normalize risk paths', () => {
      expect(normalizeRiskPath('src/db/')).toBe('src/db');
      expect(normalizeRiskPath('src\\db\\')).toBe('src/db');
    });

    it('should correctly identify risky paths', () => {
      const riskPaths = ['src/db', 'secrets'];
      expect(isRisky('src/db/user.ts', riskPaths)).toBe(true);
      expect(isRisky('secrets/api.key', riskPaths)).toBe(true);
      expect(isRisky('src/api/user.ts', riskPaths)).toBe(false);
      expect(isRisky('tests/src/db.ts', riskPaths)).toBe(false);
    });
  });

  describe('KV Parsing and Serialization', () => {
    it('should parse kv lines', () => {
      const text = `Key1: Value1\nKey2: Value2`;
      const result = parseKvLines(text);
      expect(result).toEqual({ Key1: 'Value1', Key2: 'Value2' });
    });

    it('should serialize kv lines', () => {
      const data = { Key1: 'Value1', Key2: 'Value2' };
      const result = serializeKvLines(data);
      expect(result).toBe('Key1: Value1\nKey2: Value2');
    });
  });
});