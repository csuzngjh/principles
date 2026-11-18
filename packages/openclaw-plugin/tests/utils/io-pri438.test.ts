import { describe, it, expect, vi, beforeEach } from 'vitest';
// ESM-compatible partial fs mock (P2-3): the three primitives the atomic
// writer uses delegate to the REAL fs by default, so every pre-existing test
// keeps true filesystem behavior; individual tests re-arm fault/attack
// injections per call. (Module namespaces cannot be vi.spyOn'd in ESM.)
const fsMocks = vi.hoisted(() => ({
  openSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdtempSync: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  fsMocks.openSync.mockImplementation(
    ((p: fs.PathLike, ...rest: unknown[]) =>
      (actual.openSync as unknown as (...a: unknown[]) => number)(p, ...rest)) as typeof actual.openSync,
  );
  fsMocks.writeFileSync.mockImplementation(
    ((fd: number | fs.PathLike, ...rest: unknown[]) =>
      (actual.writeFileSync as unknown as (...a: unknown[]) => void)(fd, ...rest)) as typeof actual.writeFileSync,
  );
  fsMocks.renameSync.mockImplementation(
    ((from: fs.PathLike, to: fs.PathLike) =>
      (actual.renameSync as unknown as (...a: unknown[]) => void)(from, to)) as typeof actual.renameSync,
  );
  fsMocks.mkdtempSync.mockImplementation(
    ((prefix: string, ...rest: unknown[]) =>
      (actual.mkdtempSync as unknown as (...a: unknown[]) => string)(prefix, ...rest)) as typeof actual.mkdtempSync,
  );
  return {
    ...actual,
    openSync: fsMocks.openSync,
    writeFileSync: fsMocks.writeFileSync,
    renameSync: fsMocks.renameSync,
    mkdtempSync: fsMocks.mkdtempSync,
  };
});
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

describe('atomicWriteFileSync temp-file safety (P2-3)', () => {
  beforeEach(() => {
    // restore the real-fs delegation armed by the vi.mock factory
    vi.clearAllMocks();
  });

  it('staging directory is unique and unpredictable; no fixed <name>.tmp is ever created at the target level', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-safe-'));
    try {
      const filePath = path.join(tmpDir, 'target.txt');
      atomicWriteFileSync(filePath, 'payload');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('payload');
      expect(fs.existsSync(filePath + '.tmp')).toBe(false);
      // No *.tmp files and no leftover staging dirs at the target level.
      expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(fs.readdirSync(tmpDir).filter((f) => f.includes('.staging.'))).toEqual([]);

      atomicWriteFileSync(filePath, 'again-1');
      atomicWriteFileSync(filePath, 'again-2');
      // The DETERMINISTIC prefix is shared by design; the unpredictable part
      // is mkdtemp's own random suffix — asserted via the RESULT values.
      const stagingDirs = fsMocks.mkdtempSync.mock.results
        .map((r) => (r.type === 'return' ? String(r.value) : ''))
        .filter((dir) => dir.includes('target.txt.staging.'));
      expect(stagingDirs.length).toBe(3);
      expect(new Set(stagingDirs).size).toBe(stagingDirs.length); // every draw unique
      for (const dir of stagingDirs) {
        expect(dir.startsWith(tmpDir)).toBe(true); // same directory (atomic rename)
      }
      // The deterministic prefix must never equal the legacy fixed temp name.
      const prefix = String(fsMocks.mkdtempSync.mock.calls[0]![0]);
      expect(prefix.endsWith('target.txt.tmp')).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a PRE-PLANTED staging-like directory cannot cause a follow: mkdtemp redraws a unique suffix', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-plant-'));
    try {
      const filePath = path.join(tmpDir, 'target.txt');
      // The attacker's best guess is the deterministic prefix — plant a
      // directory under it. mkdtemp only ever CREATES, never follows: it
      // retries internal random suffixes until it finds a free name, so the
      // planted directory stays untouched as a foreign entry.
      const planted = path.join(tmpDir, 'target.txt.staging.attacker');
      fs.mkdirSync(planted, { recursive: true });
      fs.writeFileSync(path.join(planted, 'ATTACKER-CONTROLLED'), 'x');
      atomicWriteFileSync(filePath, 'mine');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('mine');
      // The planted directory survived untouched (never followed, never
      // renamed, never deleted by the writer).
      expect(fs.existsSync(path.join(planted, 'ATTACKER-CONTROLLED'))).toBe(true);
      // And the writer left no residue of its own.
      const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.staging.') && f !== 'target.txt.staging.attacker');
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a pre-planted SYMLINK under the staging prefix cannot divert the writer (platform-permitting)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-sym-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-sym-out-'));
    try {
      const filePath = path.join(tmpDir, 'target.txt');
      const canSymlink = (() => {
        try {
          // Probe FILE-symlink privilege (stricter than junction): Windows
          // needs SeCreateSymbolicLinkPrivilege; sandboxed runners may lack
          // it. CI Linux and Owner machines have it; the contract this pins
          // is "a planted link near the staging prefix is never followed".
          const probe = path.join(tmpDir, 'probe-file-link');
          fs.symlinkSync(path.join(outside, 'probe-target'), probe, 'file');
          fs.rmSync(probe, { force: true });
          return true;
        } catch {
          return false;
        }
      })();
      if (!canSymlink) return;
      // Plant a symlink at a GUESSED staging path. mkdtemp only ever CREATES
      // its own random suffix — it never follows an existing entry, so the
      // writer's staging dir is a fresh directory, not the link.
      fs.symlinkSync(outside, path.join(tmpDir, 'target.txt.staging.guess'), 'dir');
      atomicWriteFileSync(filePath, 'mine');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('mine');
      // Nothing was ever written through the planted link to the outside.
      expect(fs.readdirSync(outside)).toEqual([]);
      // The planted link is a FOREIGN entry the writer deliberately leaves
      // alone; assert the writer's OWN staging residue is zero (any staging
      // entry other than the attacker's planted one).
      const writerResidue = fs.readdirSync(tmpDir).filter((f) => f.includes('.staging.') && f !== 'target.txt.staging.guess');
      expect(writerResidue).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('write failure inside the temp file cleans it up and leaves the original intact', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-wfail-'));
    try {
      const filePath = path.join(tmpDir, 'target.txt');
      fs.writeFileSync(filePath, 'original-bytes', 'utf8');
      const before = fs.readFileSync(filePath, 'utf8');
      fsMocks.writeFileSync.mockImplementationOnce(((fd: number | fs.PathLike, ...rest: unknown[]) => {
        if (typeof fd === 'number') throw new Error('EIO test injection');
        throw new Error('unreachable: path-based write is not the temp writer');
      }) as typeof fs.writeFileSync);
      expect(() => atomicWriteFileSync(filePath, 'new')).toThrow('EIO test injection');
      expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
      expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rename failure throws, leaves the ORIGINAL file intact, and removes the temp file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-rfail-'));
    try {
      const filePath = path.join(tmpDir, 'target.txt');
      fs.writeFileSync(filePath, 'original-bytes', 'utf8');
      const before = fs.readFileSync(filePath, 'utf8');
      // EINVAL is NON-retryable per the retry policy — the single Once hook
      // aborts immediately (an EACCES/EBUSY first hit would be retried against
      // the delegated real rename and succeed, so it must not be used here).
      fsMocks.renameSync.mockImplementationOnce((() => {
        const err = new Error('EINVAL test injection') as NodeJS.ErrnoException;
        err.code = 'EINVAL';
        throw err;
      }) as typeof fs.renameSync);
      expect(() => atomicWriteFileSync(filePath, 'new')).toThrow('EINVAL test injection');
      expect(fsMocks.renameSync.mock.calls.length).toBe(1); // failed fast, no retries
      expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
      expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a missing target DIRECTORY rethrows instead of spinning', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-nodir-'));
    try {
      const filePath = path.join(tmpDir, 'missing-dir', 'target.txt');
      expect(() => atomicWriteFileSync(filePath, 'x')).toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
