/**
 * Evidence Sanitizer Tests — Core Package
 *
 * Direct tests for the shared evidence sanitizer module.
 * This module is security-critical and used by both core and plugin packages.
 *
 * Tests verify:
 * - Token redaction (sk-*, ghp_*, JWT, base64)
 * - PD tag stripping
 * - Path convergence (workspace-relative vs basename)
 * - Recursive sanitization with depth/key/array limits
 * - Platform-agnostic path handling (Windows/POSIX)
 *
 * ERR checklist:
 * - ERR-001: No `as` casts — input is `unknown`, narrowed with typeof guards
 * - ERR-055: ANY-segment sensitive field matching
 * - ERR-056: Token redaction runs on ALL strings
 * - EP-08: Platform-agnostic path basename
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeString,
  sanitizeValue,
  sanitizeToolParams,
  convergePath,
  MAX_EVIDENCE_VALUE_CHARS,
} from '../evidence-sanitizer.js';

// ── convergePath ─────────────────────────────────────────────────────────────

describe('convergePath', () => {
  it('returns relative path unchanged', () => {
    expect(convergePath('src/index.ts')).toBe('src/index.ts');
    expect(convergePath('./config.json')).toBe('./config.json');
  });

  it('returns basename for absolute path without workspaceDir', () => {
    expect(convergePath('/home/user/secrets/token.json')).toBe('token.json');
    expect(convergePath('D:\\Code\\secrets\\key.txt')).toBe('key.txt');
  });

  it('returns repo-relative for workspace-internal path', () => {
    expect(convergePath('/workspace/my-repo/src/index.ts', '/workspace/my-repo')).toBe('src/index.ts');
    expect(convergePath('D:\\Code\\principles\\src\\file.ts', 'D:\\Code\\principles')).toBe('src\\file.ts');
  });

  it('returns basename for workspace-external absolute path', () => {
    expect(convergePath('/etc/passwd', '/workspace/my-repo')).toBe('passwd');
    expect(convergePath('C:\\Windows\\System32\\config', '/workspace/my-repo')).toBe('config');
  });

  it('handles trailing separators in workspaceDir', () => {
    expect(convergePath('/workspace/repo/src/file.ts', '/workspace/repo/')).toBe('src/file.ts');
  });

  it('handles Windows drive case-insensitivity', () => {
    expect(convergePath('d:\\code\\repo\\src\\file.ts', 'D:\\Code\\repo')).toBe('src\\file.ts');
  });

  it('returns basename when workspaceDir matches exactly', () => {
    // When the path equals workspaceDir, return basename
    expect(convergePath('/workspace/repo', '/workspace/repo')).toBe('repo');
  });

  it('handles UNC paths', () => {
    expect(convergePath('\\\\server\\share\\file.txt')).toBe('file.txt');
  });
});

// ── sanitizeString ───────────────────────────────────────────────────────────

describe('sanitizeString', () => {
  // ── Token redaction ──

  it('redacts OpenAI-style keys (sk-*)', () => {
    const token = 'sk-proj-' + 'a'.repeat(30);
    const result = sanitizeString(`token is ${token}`);
    expect(result).toContain('___REDACTED___');
    expect(result).not.toContain(token);
  });

  it('redacts GitHub PATs (ghp_*)', () => {
    const token = 'ghp_' + 'a'.repeat(40);
    const result = sanitizeString(token);
    expect(result).toContain('___REDACTED___');
    expect(result).not.toContain(token);
  });

  it('redacts GitHub OAuth tokens (gho_*)', () => {
    const token = 'gho_' + 'a'.repeat(40);
    const result = sanitizeString(token);
    expect(result).toContain('___REDACTED___');
  });

  it('redacts Slack tokens (xoxb-*)', () => {
    const token = 'xoxb-' + 'a'.repeat(30);
    const result = sanitizeString(token);
    expect(result).toContain('___REDACTED___');
  });

  it('redacts JWT-like patterns (eyJ*)', () => {
    const jwt = 'eyJ' + 'a'.repeat(30) + '.bc';
    const result = sanitizeString(`Bearer ${jwt}`);
    expect(result).toContain('___REDACTED___');
    expect(result).not.toContain(jwt);
  });

  it('redacts long base64-like strings', () => {
    const token = 'A'.repeat(50);
    const result = sanitizeString(`hash: ${token}`);
    expect(result).toContain('___REDACTED___');
    expect(result).not.toContain(token);
  });

  it('preserves short strings without tokens', () => {
    const result = sanitizeString('normal text without secrets');
    expect(result).toBe('normal text without secrets');
  });

  // ── PD tag stripping ──

  it('strips EMOTIONAL_DAMAGE_DETECTED tags', () => {
    const result = sanitizeString('[EMOTIONAL_DAMAGE_DETECTED:severe] something went wrong');
    expect(result).not.toContain('EMOTIONAL_DAMAGE_DETECTED');
    expect(result).toContain('something went wrong');
  });

  it('strips EMPATHY_ROLLBACK_REQUEST tags', () => {
    const result = sanitizeString('[EMPATHY_ROLLBACK_REQUEST] rollback needed');
    expect(result).not.toContain('EMPATHY_ROLLBACK_REQUEST');
    expect(result).toContain('rollback needed');
  });

  it('strips empathy XML tags', () => {
    const result = sanitizeString('<empathy signal="damage" severity="moderate"/> text');
    expect(result).not.toContain('<empathy');
    expect(result).toContain('text');
  });

  // ── Path convergence ──

  it('converges absolute paths in string without workspaceDir', () => {
    const result = sanitizeString('error in /home/user/project/src/file.ts');
    expect(result).not.toContain('/home/user/project');
    expect(result).toContain('file.ts');
  });

  it('converges Windows absolute paths in string', () => {
    const result = sanitizeString('cd D:\\Code\\principles && git status');
    expect(result).not.toContain('D:\\Code\\principles');
    expect(result).toContain('principles');
  });

  it('converges workspace-internal paths to repo-relative', () => {
    const result = sanitizeString(
      'edit failed on D:\\Code\\principles\\src\\index.ts',
      'D:\\Code\\principles',
    );
    expect(result).not.toContain('D:\\Code\\principles');
    expect(result).toContain('src\\index.ts');
  });

  // ── Length bounding ──

  it('truncates long strings', () => {
    const long = ' data '.repeat(100);
    const result = sanitizeString(long);
    expect(result.length).toBeLessThanOrEqual(MAX_EVIDENCE_VALUE_CHARS + 20);
    expect(result).toMatch(/___TRUNCATED___$/);
  });

  it('preserves short strings intact', () => {
    const short = 'short text';
    expect(sanitizeString(short)).toBe(short);
  });

  // ── Combined operations ──

  it('applies all sanitization steps in order', () => {
    const token = 'sk-proj-' + 'a'.repeat(30);
    const input = `[EMOTIONAL_DAMAGE_DETECTED] ${token} at /home/user/secrets/key.json`;
    const result = sanitizeString(input);
    // PD tag stripped
    expect(result).not.toContain('EMOTIONAL_DAMAGE_DETECTED');
    // Token redacted
    expect(result).toContain('___REDACTED___');
    expect(result).not.toContain(token);
    // Path converged
    expect(result).not.toContain('/home/user/secrets');
    expect(result).toContain('key.json');
  });
});

// ── sanitizeValue ────────────────────────────────────────────────────────────

describe('sanitizeValue', () => {
  // ── Primitive handling ──

  it('returns null unchanged', () => {
    expect(sanitizeValue(null)).toBe(null);
  });

  it('returns undefined unchanged', () => {
    expect(sanitizeValue(undefined)).toBe(undefined);
  });

  it('returns numbers unchanged', () => {
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(3.14)).toBe(3.14);
  });

  it('returns booleans unchanged', () => {
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(false)).toBe(false);
  });

  it('sanitizes strings', () => {
    const token = 'sk-proj-' + 'a'.repeat(30);
    const result = sanitizeValue(token);
    expect(result).toContain('___REDACTED___');
  });

  // ── Array handling ──

  it('sanitizes arrays with item limit', () => {
    const arr = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    const result = sanitizeValue(arr) as unknown[];
    expect(result.length).toBeLessThanOrEqual(21); // MAX_ARRAY_ITEMS + overflow indicator
    expect(result[result.length - 1]).toMatch(/more items/);
  });

  it('sanitizes array elements recursively', () => {
    const token = 'sk-proj-' + 'a'.repeat(30);
    const arr = [token, 'safe-string', { nested: token }];
    const result = sanitizeValue(arr) as unknown[];
    expect(result[0]).toContain('___REDACTED___');
    expect(result[1]).toBe('safe-string');
    const nested = result[2] as Record<string, unknown>;
    expect(nested.nested).toContain('___REDACTED___');
  });

  // ── Object handling ──

  it('sanitizes objects with key limit', () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      obj[`key-${i}`] = `value-${i}`;
    }
    const result = sanitizeValue(obj) as Record<string, unknown>;
    expect(Object.keys(result).length).toBeLessThanOrEqual(51); // MAX_KEYS + overflow indicator
    expect(result['<truncated>']).toBeDefined();
  });

  it('sanitizes nested objects recursively', () => {
    const token = 'sk-proj-' + 'a'.repeat(30);
    const input = { a: { b: { c: token } } };
    const result = sanitizeValue(input) as Record<string, unknown>;
    const nested = ((result.a as Record<string, unknown>).b as Record<string, unknown>).c as string;
    expect(nested).toContain('___REDACTED___');
  });

  // ── Depth limit ──

  it('returns <max-depth> for deeply nested objects', () => {
    const deep: Record<string, unknown> = { a: { b: { c: { d: { e: 'too deep' } } } } };
    const result = sanitizeValue(deep) as Record<string, unknown>;
    const a = result.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    const c = b.c as Record<string, unknown>;
    const d = c.d as Record<string, unknown>;
    expect(d.e).toBe('<max-depth>');
  });

  it('respects depth parameter', () => {
    const input = { a: { b: { c: 'value' } } };
    // Starting at depth 3, b would be at depth 4 (exceeds MAX_DEPTH=4)
    const result = sanitizeValue(input, 3) as Record<string, unknown>;
    const a = result.a as Record<string, unknown>;
    // b is at depth 4 from the starting depth 3, so it gets max-depth
    expect(a.b).toBe('<max-depth>');
  });

  // ── Unsupported types ──

  it('returns <unsupported-type> for functions', () => {
    expect(sanitizeValue(() => undefined)).toBe('<unsupported-type>');
  });

  it('returns <unsupported-type> for symbols', () => {
    expect(sanitizeValue(Symbol('test'))).toBe('<unsupported-type>');
  });
});

// ── sanitizeToolParams ───────────────────────────────────────────────────────

describe('sanitizeToolParams', () => {
  it('returns {} for null input', () => {
    expect(sanitizeToolParams(null)).toEqual({});
  });

  it('returns {} for undefined input', () => {
    expect(sanitizeToolParams(undefined)).toEqual({});
  });

  it('returns {} for number input', () => {
    expect(sanitizeToolParams(42)).toEqual({});
  });

  it('returns {} for boolean input', () => {
    expect(sanitizeToolParams(true)).toEqual({});
  });

  it('wraps string input in <string-input> key', () => {
    const result = sanitizeToolParams('raw string input');
    expect(result['<string-input>']).toBeDefined();
    expect(typeof result['<string-input>']).toBe('string');
  });

  it('wraps array input in <array-input> key', () => {
    const result = sanitizeToolParams(['a', 'b', 'c']);
    expect(result['<array-input>']).toBeDefined();
  });

  it('sanitizes object params', () => {
    const token = 'sk-proj-' + 'a'.repeat(30);
    const params = {
      file_path: 'src/file.ts',
      content: `key is ${token}`,
    };
    const result = sanitizeToolParams(params);
    expect(result.file_path).toBe('src/file.ts');
    expect(result.content).toContain('___REDACTED___');
  });

  it('redacts sensitive fields at any nesting level', () => {
    expect(sanitizeToolParams({
      token: 'not-pattern-shaped-but-secret',
      nested: { authorization: 'Bearer owner-secret', apiKey: 'key-value' },
      file_path: 'src/auth.ts',
    })).toEqual({
      token: '<sensitive___REDACTED___field>',
      nested: { authorization: '<sensitive___REDACTED___field>', apiKey: '<sensitive___REDACTED___field>' },
      file_path: 'src/auth.ts',
    });
  });

  it('redacts combined sensitive keys but not lookalike ones', () => {
    expect(sanitizeToolParams({
      userApiKey: 'secret',
      openaiApiKey: 'secret',
      clientSecretId: 'secret',
      access_token: 'secret',
      tokenizer: 'not-a-secret',
      file_path: 'src/auth.ts',
    })).toEqual({
      userApiKey: '<sensitive___REDACTED___field>',
      openaiApiKey: '<sensitive___REDACTED___field>',
      clientSecretId: '<sensitive___REDACTED___field>',
      access_token: '<sensitive___REDACTED___field>',
      tokenizer: 'not-a-secret',
      file_path: 'src/auth.ts',
    });
  });

  it('converges paths with workspaceDir', () => {
    const params = {
      file_path: '/workspace/repo/src/config.ts',
    };
    const result = sanitizeToolParams(params, '/workspace/repo');
    expect(result.file_path).toBe('src/config.ts');
  });

  it('handles nested edits array', () => {
    const token = 'sk-proj-' + 'a'.repeat(30);
    const params = {
      file_path: '/repo/src/config.ts',
      edits: [
        { oldText: token, newText: 'safe-value' },
      ],
    };
    const result = sanitizeToolParams(params, '/repo');
    const edits = result.edits as Record<string, unknown>[];
    expect(edits[0]).toBeDefined();
    expect(edits[0]?.oldText).toContain('___REDACTED___');
    expect(edits[0]?.newText).toBe('safe-value');
    expect(result.file_path).toBe('src/config.ts');
  });

  it('truncates long content fields', () => {
    const params = {
      content: ' data '.repeat(100),
    };
    const result = sanitizeToolParams(params);
    expect(result.content).toMatch(/___TRUNCATED___$/);
  });
});

// ── Platform-agnostic path handling (EP-08) ───────────────────────────────────

describe('Platform-agnostic path handling', () => {
  it('handles Windows paths on POSIX runner', () => {
    // This test runs on Linux CI but should handle Windows paths
    const result = sanitizeString('error in D:\\Code\\principles\\src\\file.ts');
    // Should extract basename using platformAgnosticBasename
    expect(result).toContain('file.ts');
    expect(result).not.toContain('D:\\Code');
  });

  it('handles POSIX paths on Windows runner', () => {
    // This test runs on Windows but should handle POSIX paths
    const result = sanitizeString('error in /home/user/project/src/file.ts');
    expect(result).toContain('file.ts');
    expect(result).not.toContain('/home/user/project');
  });

  it('handles mixed separators in single string', () => {
    const result = sanitizeString('path1: C:\\Users\\admin\\file1.txt, path2: /etc/file2.conf');
    expect(result).toContain('file1.txt');
    expect(result).toContain('file2.conf');
    expect(result).not.toContain('C:\\Users\\admin');
    expect(result).not.toContain('/etc');
  });
});

// ── Security regression tests ────────────────────────────────────────────────

describe('Security regression tests', () => {
  it('redacts tokens in deeply nested structures', () => {
    const token = 'sk-proj-' + 'a'.repeat(30);
    // Use a structure that stays within MAX_DEPTH (4)
    const input = {
      level1: {
        level2: {
          level3: {
            secret: token,
          },
        },
      },
    };
    const result = sanitizeValue(input) as Record<string, unknown>;
    const l1 = result.level1 as Record<string, unknown>;
    const l2 = l1.level2 as Record<string, unknown>;
    const l3 = l2.level3 as Record<string, unknown>;
    expect(l3.secret).toContain('___REDACTED___');
  });

  it('does not reveal token prefix beyond safe limit', () => {
    const token = 'sk-proj-abcdefghijklmnopqrstuvwxy' + 'z'.repeat(20);
    const result = sanitizeString(token);
    // Prefix should be limited (8 chars for >50 length, 4 for shorter)
    expect(result).not.toContain(token.slice(10));
  });

  it('handles empty strings gracefully', () => {
    expect(sanitizeString('')).toBe('');
    expect(sanitizeValue('')).toBe('');
  });

  it('handles strings with only whitespace', () => {
    expect(sanitizeString('   ')).toBe('');
    expect(sanitizeString('\n\t')).toBe('');
  });
});

// ── ReDoS timing regressions (PRI-627) ──────────────────────────────────────
// CodeQL js/polynomial-redos: adversarial evidence strings reach convergePath
// and sanitizeString from uncontrolled tool output. These inputs are sized so
// a backtracking-prone implementation cannot finish inside the bound, while
// the linear implementations stay in milliseconds.

describe('ReDoS timing regressions', () => {
  const TIMING_BUDGET_MS = 5000;

  function expectBounded(run: () => void): number {
    const startedAt = performance.now();
    run();
    return performance.now() - startedAt;
  }

  it('convergePath strips a long separator run in bounded time', () => {
    // `[\\/]+$`-style regexes rescan from every start position on a run that
    // does not reach the end → O(n²). The linear end-scan must stay O(n).
    const adversarial = '/' + '/'.repeat(100_000) + 'x';
    let result = '';
    const elapsed = expectBounded(() => {
      result = convergePath(adversarial, '/workspace');
    });
    expect(elapsed).toBeLessThan(TIMING_BUDGET_MS);
    expect(result).toBe('x');
  });

  it('convergePath strips trailing separators from both operands in bounded time', () => {
    const value = '/workspace/src' + '/'.repeat(100_000);
    let result = '';
    const elapsed = expectBounded(() => {
      result = convergePath(value, '/workspace/');
    });
    expect(elapsed).toBeLessThan(TIMING_BUDGET_MS);
    expect(result).toBe('src');
  });

  it('sanitizeString handles repeated empathy-tag openings in bounded time', () => {
    // CodeQL example shape: many `<empathy` restart positions, each forcing a
    // full `[^>]*` unwind before the mandatory `>` fails.
    const adversarial = '<empathy'.repeat(2_500);
    let result = '';
    const elapsed = expectBounded(() => {
      result = sanitizeString(adversarial);
    });
    expect(elapsed).toBeLessThan(TIMING_BUDGET_MS);
    // No `>` anywhere → empathy tag pattern matches nothing; no token/path
    // pattern fires either, so the value just hits the length bound.
    expect(result).toBe('<empathy'.repeat(25) + '___TRUNCATED___');
  });

  it('sanitizeString strips empathy tags identically, including self-closing form', () => {
    // Greedy `[^>]*` stops at the first `>`; the optional close-tag group only
    // fires when `</empathy>` directly follows the open tag. Locks actual
    // (pre-existing) behavior — identical for the old and rewritten pattern.
    expect(sanitizeString('<empathy severity="high">hello</empathy>')).toBe('hello</empathy>');
    expect(sanitizeString('<empathy></empathy>payload')).toBe('payload');
    expect(sanitizeString('<empathy/>')).toBe('');
    expect(sanitizeString('<empathy>fragments remain')).toBe('fragments remain');
  });
});
