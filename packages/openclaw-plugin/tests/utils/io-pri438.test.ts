import { describe, it, expect } from 'vitest';
import { normalizePath, normalizeRiskPath, isRisky, parseKvLines, serializeKvLines, atomicWriteFileSync, normalizeCommandArgs } from '../../src/utils/io.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * PRI-438: normalizePath handles POSIX absolute paths on Windows
 *
 * Tests verify cross-platform path normalization behavior:
 *   - POSIX absolute paths on Windows projects
 *   - Windows/POSIX mixed path handling
 *   - WSL path conversion
 *   - Edge cases (empty, relative, etc.)
 *
 * ERR risk mitigation:
 *   - ERR-024: cross-platform path handling is critical for RuleHost execution
 *   - ERR-048: tests verify behavior equivalence across platforms
 */
describe('PRI-438: normalizePath cross-platform handling', () => {
  describe('POSIX absolute paths', () => {
    it('returns POSIX absolute path as-is when project is Windows (path outside project)', () => {
      // POSIX absolute path /etc/passwd on Windows project D:\project
      // Cannot resolve relative to project, return as-is
      const result = normalizePath('/etc/passwd', 'D:\\project');
      expect(result).toBe('/etc/passwd');
    });

    it('computes relative path when both project and file are POSIX', () => {
      const result = normalizePath('/project/src/file.ts', '/project');
      expect(result).toBe('src/file.ts');
    });

    it('handles POSIX absolute path with multiple ../ segments', () => {
      const result = normalizePath('/project/../outside/file.ts', '/project');
      // Path escapes project → return normalized absolute path
      expect(result).toBe('/project/../outside/file.ts');
    });
  });

  describe('Windows/POSIX mixed paths', () => {
    it('converts Windows path to WSL format when project is POSIX', () => {
      // Windows path D:\file.txt on POSIX project /mnt/d/project
      const result = normalizePath('D:\\file.txt', '/mnt/d/project');
      expect(result).toBe('/mnt/d/file.txt');
    });

    it('handles Windows project with POSIX relative file path', () => {
      const result = normalizePath('src/file.ts', 'D:\\project');
      expect(result).toBe('src/file.ts');
    });

    it('handles Windows absolute path on Windows project (platform-dependent)', () => {
      const result = normalizePath('D:\\project\\src\\file.ts', 'D:\\project');
      if (process.platform === 'win32') {
        expect(result).toBe('src/file.ts');
      } else {
        expect(result).toBe('D:/project/src/file.ts');
      }
    });
  });

  describe('Edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(normalizePath('', '/project')).toBe('');
      expect(normalizePath('', 'D:\\project')).toBe('');
    });

    it('handles relative path starting with ../ (escapes project)', () => {
      const result = normalizePath('../outside/file.ts', '/project');
      // Path escapes project → return original
      expect(result).toBe('../outside/file.ts');
    });

    it('handles path with mixed separators (platform-dependent)', () => {
      const result = normalizePath('src\\sub/file.ts', '/project');
      expect(result).toBe('/mnt/sc/sub/file.ts');
    });

    it('handles path with trailing slash', () => {
      const result = normalizePath('/project/src/', '/project');
      expect(result).toBe('src');
    });

    it('handles project path with trailing slash', () => {
      const result = normalizePath('/project/src/file.ts', '/project/');
      expect(result).toBe('src/file.ts');
    });

    it('handles path with ./ prefix', () => {
      const result = normalizePath('./src/file.ts', '/project');
      expect(result).toBe('src/file.ts');
    });

    it('handles deeply nested relative path', () => {
      const result = normalizePath('src/lib/utils/helpers/file.ts', '/project');
      expect(result).toBe('src/lib/utils/helpers/file.ts');
    });
  });

  describe('normalizeRiskPath edge cases', () => {
    it('handles empty string', () => {
      expect(normalizeRiskPath('')).toBe('');
    });

    it('handles path with multiple trailing slashes', () => {
      // Note: normalizeRiskPath only removes ONE trailing slash, not multiple
      expect(normalizeRiskPath('src/db//')).toBe('src/db/');
      expect(normalizeRiskPath('src/db///')).toBe('src/db//');
    });

    it('handles path with only slashes', () => {
      // Note: normalizeRiskPath removes one trailing slash
      expect(normalizeRiskPath('/')).toBe('');
      expect(normalizeRiskPath('//')).toBe('/');
    });
  });

  describe('isRisky edge cases', () => {
    it('returns false for empty relPath', () => {
      expect(isRisky('', ['src/db'])).toBe(false);
    });

    it('returns false for empty riskPaths array', () => {
      expect(isRisky('src/db/file.ts', [])).toBe(false);
    });

    it('returns false for undefined/null inputs', () => {
      expect(isRisky(undefined as unknown as string, ['src/db'])).toBe(false);
      expect(isRisky('src/db', null as unknown as string[])).toBe(false);
      expect(isRisky(null as unknown as string, undefined as unknown as string[])).toBe(false);
    });

    it('prevents false prefix match (src/db_backup should not match src/db)', () => {
      expect(isRisky('src/db_backup/file.ts', ['src/db'])).toBe(false);
    });

    it('matches exact path', () => {
      expect(isRisky('src/db', ['src/db'])).toBe(true);
    });

    it('matches path with subdirectory', () => {
      expect(isRisky('src/db/migrations/file.ts', ['src/db'])).toBe(true);
    });
  });

  describe('parseKvLines edge cases', () => {
    it('handles empty string', () => {
      expect(parseKvLines('')).toEqual({});
    });

    it('handles lines without colon', () => {
      const text = 'Key1: Value1\nInvalidLine\nKey2: Value2';
      expect(parseKvLines(text)).toEqual({ Key1: 'Value1', Key2: 'Value2' });
    });

    it('handles multiple colons in value', () => {
      const text = 'URL: https://example.com:8080/path';
      expect(parseKvLines(text)).toEqual({ URL: 'https://example.com:8080/path' });
    });

    it('handles empty value', () => {
      const text = 'Key: ';
      expect(parseKvLines(text)).toEqual({ Key: '' });
    });

    it('handles whitespace around key and value', () => {
      const text = '  Key  :  Value  ';
      expect(parseKvLines(text)).toEqual({ Key: 'Value' });
    });
  });

  describe('serializeKvLines edge cases', () => {
    it('skips empty values', () => {
      expect(serializeKvLines({ Key: '', Other: 'value' })).toBe('Other: value');
    });

    it('skips undefined values', () => {
      expect(serializeKvLines({ Key: undefined, Other: 'value' })).toBe('Other: value');
    });

    it('skips null values', () => {
      expect(serializeKvLines({ Key: null, Other: 'value' })).toBe('Other: value');
    });

    it('handles array values', () => {
      expect(serializeKvLines({ Items: ['a', 'b', 'c'] })).toBe('Items: a,b,c');
    });

    it('handles object values', () => {
      const result = serializeKvLines({ Config: { nested: true } });
      expect(result).toContain('Config:');
      expect(result).toContain('nested');
    });

    it('sorts keys alphabetically', () => {
      const result = serializeKvLines({ B: '2', A: '1', C: '3' });
      expect(result).toBe('A: 1\nB: 2\nC: 3');
    });
  });

  describe('normalizeCommandArgs edge cases', () => {
    it('returns empty string for undefined', () => {
      expect(normalizeCommandArgs(undefined)).toBe('');
    });

    it('returns empty string for null', () => {
      expect(normalizeCommandArgs(null)).toBe('');
    });

    it('joins array args with spaces', () => {
      expect(normalizeCommandArgs(['--flag', 'value'])).toBe('--flag value');
    });

    it('returns string args as-is', () => {
      expect(normalizeCommandArgs('--flag value')).toBe('--flag value');
    });

    it('handles empty array', () => {
      expect(normalizeCommandArgs([])).toBe('');
    });
  });
});

/**
 * atomicWriteFileSync tests
 *
 * Tests verify atomic write behavior:
 *   - Basic write and rename
 *   - Retry on Windows transient lock errors (EPERM, EBUSY, EACCES)
 *   - Cleanup on failure
 *
 * Note: Cannot fully simulate Windows lock errors in Linux environment,
 * but tests verify the basic write behavior and cleanup logic.
 */
describe('atomicWriteFileSync', () => {
  it('writes file atomically (write to temp then rename)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-write-'));
    try {
      const filePath = path.join(tmpDir, 'test.txt');
      const content = 'test content';

      atomicWriteFileSync(filePath, content);

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
      expect(fs.existsSync(filePath + '.tmp')).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('overwrites existing file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-write-'));
    try {
      const filePath = path.join(tmpDir, 'test.txt');

      atomicWriteFileSync(filePath, 'original');
      atomicWriteFileSync(filePath, 'updated');

      expect(fs.readFileSync(filePath, 'utf8')).toBe('updated');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on non-retryable error (e.g., permission denied on parent dir)', () => {
    // This test verifies that non-retryable errors are thrown immediately
    // We can't easily simulate permission errors in a temp dir, so we test
    // with an invalid path that will fail
    expect(() => atomicWriteFileSync('/nonexistent/path/test.txt', 'content')).toThrow();
  });
});