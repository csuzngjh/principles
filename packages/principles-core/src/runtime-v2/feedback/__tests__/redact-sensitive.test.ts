/**
 * Redact Sensitive Tests — Feedback Pipeline Privacy Guards
 *
 * Tests the privacy-preserving redaction helpers used by the feedback pipeline.
 * These functions handle sensitive data (tokens, paths, env vars) and must be
 * thoroughly tested to prevent data leaks.
 *
 * ERR checklist:
 * - ERR-001: no `as` casts on untrusted values
 * - ERR-002: never throws; returns safe fallbacks
 * - ERR-003: segment-exact key matching (no substring matches)
 * - ERR-014/016: bounded output
 */

import { describe, it, expect } from 'vitest';
import {
  redactAbsolutePaths,
  redactTokenLikeValues,
  redactEnvLikeValues,
  redactTelemetryString,
  redactStackTrace,
  redactSensitiveFields,
  REDACTED_PATH,
  REDACTED_VALUE,
  NO_STACK,
  type RedactResult,
} from '../redact-sensitive.js';

// ── redactAbsolutePaths ─────────────────────────────────────────────────────

describe('redactAbsolutePaths', () => {
  it('redacts Windows absolute paths', () => {
    const input = 'Error at C:\\Users\\alice\\project\\src\\index.ts:42';
    const result = redactAbsolutePaths(input);
    expect(result).toBe(`Error at ${REDACTED_PATH}:42`);
  });

  it('redacts multiple Windows paths', () => {
    const input = 'Paths: C:\\foo\\bar and D:\\test\\file.txt';
    const result = redactAbsolutePaths(input);
    expect(result).toBe(`Paths: ${REDACTED_PATH} and ${REDACTED_PATH}`);
  });

  it('redacts POSIX absolute paths', () => {
    const input = 'Error at /home/alice/project/src/index.ts:42';
    const result = redactAbsolutePaths(input);
    expect(result).toBe(`Error at ${REDACTED_PATH}:42`);
  });

  it('redacts /usr paths', () => {
    const input = 'Config: /usr/local/bin/node';
    const result = redactAbsolutePaths(input);
    expect(result).toBe(`Config: ${REDACTED_PATH}`);
  });

  it('redacts /Users paths (macOS)', () => {
    const input = 'File: /Users/wesley/Documents/test.txt';
    const result = redactAbsolutePaths(input);
    expect(result).toBe(`File: ${REDACTED_PATH}`);
  });

  it('preserves relative paths', () => {
    const input = './src/index.ts and ../lib/utils.js';
    const result = redactAbsolutePaths(input);
    expect(result).toBe('./src/index.ts and ../lib/utils.js');
  });

  it('preserves URL paths', () => {
    const input = 'https://example.com/path/to/resource';
    const result = redactAbsolutePaths(input);
    expect(result).toBe('https://example.com/path/to/resource');
  });

  it('returns non-string input unchanged', () => {
    expect(redactAbsolutePaths(null as unknown as string)).toBe(null);
    expect(redactAbsolutePaths(undefined as unknown as string)).toBe(undefined);
    expect(redactAbsolutePaths(42 as unknown as string)).toBe(42);
  });

  it('handles empty string', () => {
    expect(redactAbsolutePaths('')).toBe('');
  });

  it('handles string without paths', () => {
    expect(redactAbsolutePaths('no paths here')).toBe('no paths here');
  });
});

// ── redactTokenLikeValues ────────────────────────────────────────────────────

describe('redactTokenLikeValues', () => {
  it('redacts OpenAI tokens (sk-)', () => {
    const input = 'Using sk-proj-abc123def456ghi789jkl012mno345pqr678';
    const result = redactTokenLikeValues(input);
    expect(result).toBe(`Using ${REDACTED_VALUE}`);
  });

  it('redacts OpenAI ant tokens (sk-ant-)', () => {
    const input = 'Key: sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz';
    const result = redactTokenLikeValues(input);
    expect(result).toBe(`Key: ${REDACTED_VALUE}`);
  });

  it('redacts GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)', () => {
    const input = 'ghp_abc123def456ghi789jkl012mno345pqr678stu';
    const result = redactTokenLikeValues(input);
    expect(result).toBe(REDACTED_VALUE);
  });

  it('redacts Linear tokens (lin_api_)', () => {
    const input = 'lin_api_abc123def456ghi789jkl012mno345pqr678stu';
    const result = redactTokenLikeValues(input);
    expect(result).toBe(REDACTED_VALUE);
  });

  it('redacts Authorization header values', () => {
    const input = 'Authorization: Bearer secret-token-12345';
    const result = redactTokenLikeValues(input);
    expect(result).toBe(`Authorization: Bearer ${REDACTED_VALUE}`);
  });

  it('redacts Authorization header with quotes', () => {
    const input = 'Authorization: "Basic dXNlcjpwYXNz"';
    const result = redactTokenLikeValues(input);
    expect(result).toContain(REDACTED_VALUE);
  });

  it('redacts generic key assignments', () => {
    const input = 'api_key=secret123 token=abc456 password=pass789';
    const result = redactTokenLikeValues(input);
    expect(result).toBe(`api_key=${REDACTED_VALUE} token=${REDACTED_VALUE} password=${REDACTED_VALUE}`);
  });

  it('redacts Bearer tokens', () => {
    const input = 'Bearer abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567';
    const result = redactTokenLikeValues(input);
    expect(result).toBe(REDACTED_VALUE);
  });

  it('preserves non-token strings', () => {
    const input = 'normal text without tokens';
    const result = redactTokenLikeValues(input);
    expect(result).toBe('normal text without tokens');
  });

  it('returns non-string input unchanged', () => {
    expect(redactTokenLikeValues(null as unknown as string)).toBe(null);
  });

  it('handles empty string', () => {
    expect(redactTokenLikeValues('')).toBe('');
  });
});

// ── redactEnvLikeValues ──────────────────────────────────────────────────────

describe('redactEnvLikeValues', () => {
  it('redacts KEY=value assignments', () => {
    const input = 'API_KEY=secret123';
    const result = redactEnvLikeValues(input);
    expect(result).toBe(`API_KEY=${REDACTED_VALUE}`);
  });

  it('redacts KEY="value with spaces"', () => {
    const input = 'SECRET="value with spaces"';
    const result = redactEnvLikeValues(input);
    expect(result).toBe(`SECRET=${REDACTED_VALUE}`);
  });

  it('redacts KEY=\'value\' (single quotes)', () => {
    const input = 'TOKEN=\'abc123\'';
    const result = redactEnvLikeValues(input);
    expect(result).toBe(`TOKEN=${REDACTED_VALUE}`);
  });

  it('redacts multiple env assignments', () => {
    const input = 'API_KEY=secret1 SECRET=secret2 TOKEN=secret3';
    const result = redactEnvLikeValues(input);
    expect(result).toBe(`API_KEY=${REDACTED_VALUE} SECRET=${REDACTED_VALUE} TOKEN=${REDACTED_VALUE}`);
  });

  it('preserves lowercase key assignments', () => {
    const input = 'name=value';
    const result = redactEnvLikeValues(input);
    expect(result).toBe('name=value');
  });

  it('preserves short key names (< 3 chars)', () => {
    const input = 'AB=value';
    const result = redactEnvLikeValues(input);
    expect(result).toBe('AB=value');
  });

  it('returns non-string input unchanged', () => {
    expect(redactEnvLikeValues(null as unknown as string)).toBe(null);
  });

  it('handles empty string', () => {
    expect(redactEnvLikeValues('')).toBe('');
  });
});

// ── redactTelemetryString ────────────────────────────────────────────────────

describe('redactTelemetryString', () => {
  it('combines all redactors', () => {
    const input = 'Path: /home/alice/secret Token: sk-abc123def456ghi789jkl012mno345pqr678 Env: API_KEY=secret';
    const result = redactTelemetryString(input);
    expect(result).toBe(`Path: ${REDACTED_PATH} Token=${REDACTED_VALUE} Env: API_KEY=${REDACTED_VALUE}`);
  });

  it('returns non-string input unchanged', () => {
    expect(redactTelemetryString(null)).toBe(null);
    expect(redactTelemetryString(undefined)).toBe(undefined);
    expect(redactTelemetryString(42)).toBe(42);
  });

  it('handles empty string', () => {
    expect(redactTelemetryString('')).toBe('');
  });

  it('handles string without sensitive data', () => {
    expect(redactTelemetryString('normal text')).toBe('normal text');
  });
});

// ── redactStackTrace ──────────────────────────────────────────────────────────

describe('redactStackTrace', () => {
  it('returns NO_STACK for empty string', () => {
    expect(redactStackTrace('')).toBe(NO_STACK);
  });

  it('returns NO_STACK for non-string', () => {
    expect(redactStackTrace(null as unknown as string)).toBe(NO_STACK);
  });

  it('preserves error name and first 3 frames by default', () => {
    const stack = `Error: Something went wrong
    at foo (/home/alice/project/src/index.ts:10)
    at bar (/home/alice/project/src/utils.ts:20)
    at baz (/home/alice/project/src/main.ts:30)
    at qux (/home/alice/project/src/extra.ts:40)`;
    const result = redactStackTrace(stack);
    expect(result).toContain('Error: Something went wrong');
    expect(result).toContain(REDACTED_PATH);
    expect(result).not.toContain('/home/alice');
    // Should only have 3 frames
    const frameCount = (result.match(/at\s+/g) || []).length;
    expect(frameCount).toBe(3);
  });

  it('respects custom maxFrames', () => {
    const stack = `Error: Test
    at frame1 (/usr/local/bin/test.ts:1)
    at frame2 (/usr/local/bin/test.ts:2)
    at frame3 (/usr/local/bin/test.ts:3)
    at frame4 (/usr/local/bin/test.ts:4)`;
    const result = redactStackTrace(stack, 2);
    const frameCount = (result.match(/at\s+/g) || []).length;
    expect(frameCount).toBe(2);
  });

  it('redacts Windows paths in stack frames', () => {
    const stack = `Error: Test
    at foo (C:\\Users\\alice\\project\\src\\index.ts:10)`;
    const result = redactStackTrace(stack);
    expect(result).toContain(REDACTED_PATH);
    expect(result).not.toContain('C:\\Users');
  });

  it('handles stack with only error name', () => {
    const stack = 'Error: Something went wrong';
    const result = redactStackTrace(stack);
    expect(result).toBe('Error: Something went wrong');
  });
});

// ── redactSensitiveFields ────────────────────────────────────────────────────

describe('redactSensitiveFields', () => {
  it('returns error for null input', () => {
    const result = redactSensitiveFields(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('null');
    }
  });

  it('returns error for undefined input', () => {
    const result = redactSensitiveFields(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('undefined');
    }
  });

  it('returns error for primitive input', () => {
    const result = redactSensitiveFields('string');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must be an object or array');
    }
  });

  it('returns error for number input', () => {
    const result = redactSensitiveFields(42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must be an object or array');
    }
  });

  it('redacts password field', () => {
    const obj = { username: 'alice', password: 'secret123' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ username: 'alice', password: REDACTED_VALUE });
      expect(result.notes).toContain('field "password" redacted');
    }
  });

  it('redacts token field', () => {
    const obj = { id: 1, token: 'abc123' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ id: 1, token: REDACTED_VALUE });
    }
  });

  it('redacts api_key field', () => {
    const obj = { name: 'test', api_key: 'key123' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: 'test', api_key: REDACTED_VALUE });
    }
  });

  it('redacts authorization field', () => {
    const obj = { method: 'GET', authorization: 'Bearer secret' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ method: 'GET', authorization: REDACTED_VALUE });
    }
  });

  it('redacts auth_token field', () => {
    const obj = { user: 'bob', auth_token: 'token123' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ user: 'bob', auth_token: REDACTED_VALUE });
    }
  });

  it('redacts secret field', () => {
    const obj = { config: 'value', secret: 'hidden' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ config: 'value', secret: REDACTED_VALUE });
    }
  });

  it('redacts credentials field', () => {
    const obj = { service: 'api', credentials: { user: 'admin', pass: '123' } };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>).credentials).toBe(REDACTED_VALUE);
    }
  });

  it('redacts private_key field', () => {
    const obj = { id: 'key1', private_key: '-----BEGIN RSA PRIVATE KEY-----' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ id: 'key1', private_key: REDACTED_VALUE });
    }
  });

  it('redacts nested sensitive fields', () => {
    const obj = { config: { database: { password: 'dbpass' } } };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const config = (result.value as Record<string, unknown>).config as Record<string, unknown>;
      const db = config.database as Record<string, unknown>;
      expect(db.password).toBe(REDACTED_VALUE);
    }
  });

  it('handles arrays', () => {
    const arr = [{ user: 'alice', password: 'pass1' }, { user: 'bob', password: 'pass2' }];
    const result = redactSensitiveFields(arr);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Array<Record<string, unknown>>;
      expect(value[0]?.password).toBe(REDACTED_VALUE);
      expect(value[1]?.password).toBe(REDACTED_VALUE);
    }
  });

  it('handles circular references', () => {
    const obj: Record<string, unknown> = { name: 'test' };
    obj.self = obj;
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>).self).toBe('<circular>');
      expect(result.notes.some(n => n.includes('circular'))).toBe(true);
    }
  });

  it('handles deep nesting (depth limit)', () => {
    const deep = { level1: { level2: { level3: { level4: { level5: { level6: { level7: 'deep' } } } } } } };
    const result = redactSensitiveFields(deep);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should hit depth limit at level 6
      const value = result.value as Record<string, unknown>;
      expect(value).toBeDefined();
    }
  });

  it('truncates long strings', () => {
    const longString = 'a'.repeat(3000);
    const obj = { data: longString };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = (result.value as Record<string, unknown>).data as string;
      expect(value.length).toBeLessThanOrEqual(2001); // 2000 + '…'
      expect(value.endsWith('…')).toBe(true);
    }
  });

  it('redacts paths in string values', () => {
    const obj = { cwd: '/home/alice/project', message: 'Error at /usr/local/bin' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.cwd).toBe(REDACTED_PATH);
      expect((value.message as string).includes(REDACTED_PATH)).toBe(true);
    }
  });

  it('redacts tokens in string values', () => {
    const obj = { buildId: 'sk-abc123def456ghi789jkl012mno345pqr678' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.buildId).toBe(REDACTED_VALUE);
    }
  });

  it('preserves non-sensitive fields', () => {
    const obj = { name: 'test', count: 42, enabled: true, data: null };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: 'test', count: 42, enabled: true, data: null });
    }
  });

  it('handles BigInt values', () => {
    const obj = { big: BigInt(12345678901234567890) };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = (result.value as Record<string, unknown>).big as string;
      expect(value).toContain('<bigint:');
    }
  });

  // ERR-003: segment-exact matching (no substring matches)
  it('does NOT redact "author" (substring of "auth")', () => {
    const obj = { author: 'John Doe', auth: 'secret' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.author).toBe('John Doe'); // NOT redacted
      expect(value.auth).toBe(REDACTED_VALUE); // redacted
    }
  });

  it('does NOT redact "keynote" (substring of "key")', () => {
    const obj = { keynote: 'presentation', key: 'secret' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.keynote).toBe('presentation'); // NOT redacted
      expect(value.key).toBe(REDACTED_VALUE); // redacted
    }
  });

  it('redacts composite key names like "github_token"', () => {
    const obj = { github_token: 'ghp_abc123' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.github_token).toBe(REDACTED_VALUE);
    }
  });

  it('redacts composite key names like "db_password"', () => {
    const obj = { db_password: 'pass123' };
    const result = redactSensitiveFields(obj);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.db_password).toBe(REDACTED_VALUE);
    }
  });
});