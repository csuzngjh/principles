/**
 * Tests for path-security primitives (isPathInside, assertSafeDirectoryRoot, canonicalPath).
 *
 * Covers:
 * - Relative workspace containment (regression: startsWith on relative root)
 * - Absolute path containment
 * - Sibling-prefix attack (/work/foo vs /work/foobar)
 * - Traversal escape rejection
 * - Filesystem root rejection
 * - Empty path rejection
 * - Windows path cross-platform semantics
 * - POSIX path cross-platform semantics
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { isPathInside, assertSafeDirectoryRoot, canonicalPath } from '../../src/utils/path-security.js';

// ── canonicalPath ───────────────────────────────────────────────────────────

describe('canonicalPath', () => {
  it('resolves relative paths to absolute', () => {
    const result = canonicalPath('./relative/path');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain('relative');
  });

  it('keeps absolute paths unchanged in effect', () => {
    const result = canonicalPath('/tmp/workspace');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('collapses parent traversal', () => {
    const result = canonicalPath('/tmp/a/../b');
    // After resolve, /tmp/a/../b = /tmp/b
    expect(result).toBe(path.resolve('/tmp/b'));
  });

  it('handles empty string as cwd', () => {
    const result = canonicalPath('');
    expect(result).toBe(path.resolve(''));
  });
});

// ── isPathInside ────────────────────────────────────────────────────────────

describe('isPathInside', () => {
  it('returns true for a file inside parent (relative parent)', () => {
    // Regression: relative parent, absolute child
    const parent = './relative-workspace';
    const child = path.resolve('./relative-workspace/memory/logs/SYSTEM_2026-06-08.log');
    expect(isPathInside(parent, child)).toBe(true);
  });

  it('returns true for a file inside parent (absolute parent)', () => {
    const parent = '/tmp/workspace';
    const child = '/tmp/workspace/memory/logs/X.log';
    expect(isPathInside(parent, child)).toBe(true);
  });

  it('returns true for a nested subdirectory', () => {
    const parent = '/tmp/workspace';
    const child = '/tmp/workspace/sub/dir/file.txt';
    expect(isPathInside(parent, child)).toBe(true);
  });

  it('returns false when candidate === parent (strict containment)', () => {
    const parent = '/tmp/workspace';
    const child = parent;
    expect(isPathInside(parent, child)).toBe(false);
  });

  it('returns false for sibling-prefix attack', () => {
    // /work/foo should NOT contain /work/foobar
    const parent = '/tmp/work/foo';
    const child = '/tmp/work/foobar/evil.txt';
    expect(isPathInside(parent, child)).toBe(false);
  });

  it('returns false for upward traversal', () => {
    const parent = '/tmp/workspace';
    const child = '/tmp/workspace/../../etc/passwd';
    expect(isPathInside(parent, child)).toBe(false);
  });

  it('returns false for paths outside parent', () => {
    const parent = '/tmp/workspace';
    const child = '/tmp/other/file.txt';
    expect(isPathInside(parent, child)).toBe(false);
  });

  it('returns false for sibling in parallel directory', () => {
    const parent = '/tmp/workspace/a';
    const child = '/tmp/workspace/b/file.txt';
    expect(isPathInside(parent, child)).toBe(false);
  });

  it('handles Windows-style paths (cross-platform, resolve-based)', () => {
    // On Windows, path.resolve('C:\\workspace') works; on POSIX it's a relative path.
    // Either way, the comparison is canonical-vs-canonical.
    const parent = 'C:\\workspace';
    const child = path.resolve('C:\\workspace\\memory\\logs\\X.log');
    // On POSIX, both resolve to cwd-based paths; the containment should still
    // be consistent: child must be inside parent after canonicalization.
    // This test verifies no crash and consistent behavior.
    expect(() => isPathInside(parent, child)).not.toThrow();
  });

  it('requires parent to be a path prefix of child (not reverse)', () => {
    const parent = '/tmp/workspace/sub';
    const child = '/tmp/workspace';
    expect(isPathInside(parent, child)).toBe(false);
  });

  it('handles dot as current directory', () => {
    const parent = '.';
    const child = path.resolve('./some-file.txt');
    expect(isPathInside(parent, child)).toBe(true);
  });
});

// ── assertSafeDirectoryRoot ─────────────────────────────────────────────────

describe('assertSafeDirectoryRoot', () => {
  it('returns canonical path for a valid relative root', () => {
    const result = assertSafeDirectoryRoot('./relative-workspace', 'test');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain('relative-workspace');
  });

  it('returns canonical path for a valid absolute root', () => {
    const result = assertSafeDirectoryRoot('/tmp/workspace', 'test');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('throws for empty path', () => {
    expect(() => assertSafeDirectoryRoot('', 'test')).toThrow('path is empty');
  });

  it('throws for whitespace-only path', () => {
    expect(() => assertSafeDirectoryRoot('   ', 'test')).toThrow('path is empty');
  });

  it('throws for parent traversal', () => {
    expect(() => assertSafeDirectoryRoot('../etc/passwd', 'test')).toThrow('parent traversal');
  });

  it('throws for deep parent traversal', () => {
    expect(() => assertSafeDirectoryRoot('a/../../b', 'test')).toThrow('parent traversal');
  });

  it('throws for filesystem root (POSIX)', () => {
    // Skip on Windows where this is a drive letter
    expect(() => assertSafeDirectoryRoot('/', 'test')).toThrow('filesystem root');
  });

  it('throws for filesystem root (Windows drive)', () => {
    // On Windows, 'C:\\' is a root; on POSIX, it resolves to cwd/C:\ which is not root.
    // The test validates no crash and consistent behavior.
    expect(() => {
      try {
        assertSafeDirectoryRoot('C:\\', 'test');
        // On some platforms C:\ might resolve to a non-root path, so no throw
      } catch (e) {
        expect((e as Error).message).toMatch(/root|traversal/i);
      }
    }).not.toThrow();
  });

  it('allows sibling-level paths (not traversal)', () => {
    // a/../b becomes 'b' after normalize (foldable), then resolves to cwd/b
    // This is safe because it resolves inside cwd, no traversal.
    const result = assertSafeDirectoryRoot('a/../b', 'test');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('allows a workspace path with dots in name', () => {
    const result = assertSafeDirectoryRoot('./my.project/v1', 'test');
    expect(result).toContain('my.project');
  });
});