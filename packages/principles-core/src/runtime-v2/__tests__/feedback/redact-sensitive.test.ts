// redact-sensitive.test.ts
// ERR-001/005: no `as` casts on untrusted input.
// ERR-002: structured return with reason/nextAction.
// ERR-003: segment-exact key matching, never substring.
// ERR-014/016/017: bounded output, BigInt-safe, no throws on non-string.

import { describe, it, expect } from 'vitest';
import {
  redactAbsolutePaths,
  redactTokenLikeValues,
  redactEnvLikeValues,
  redactStackTrace,
  redactSensitiveFields,
  redactTelemetryString,
  REDACTED_PATH,
  REDACTED_VALUE,
} from '../../feedback/redact-sensitive.js';

describe('redactAbsolutePaths', () => {
  it('replaces Windows-style absolute paths with <redacted-path>', () => {
    const text = 'See C:\\Users\\alice\\project\\file.ts for details';
    const result = redactAbsolutePaths(text);
    expect(result).toContain(REDACTED_PATH);
    expect(result).not.toContain('C:\\Users\\alice');
  });

  it('replaces POSIX absolute paths with <redacted-path>', () => {
    const text = 'Config at /home/alice/.config/app/settings.json';
    const result = redactAbsolutePaths(text);
    expect(result).toContain(REDACTED_PATH);
    expect(result).not.toContain('/home/alice');
  });

  it('leaves relative paths alone', () => {
    const text = 'Open src/index.ts and ./relative/path.ts please';
    const result = redactAbsolutePaths(text);
    expect(result).toBe(text);
  });

  it('handles multiple absolute paths in one string', () => {
    const text = 'From C:\\a\\b.ts to D:\\c\\d.ts works';
    const result = redactAbsolutePaths(text);
    const matches = result.match(new RegExp(REDACTED_PATH.replace(/[<>]/g, '\\$&'), 'g'));
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe('redactTokenLikeValues', () => {
  it('redacts OpenAI-style sk- tokens', () => {
    const text = 'My key is sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF and it works';
    const result = redactTokenLikeValues(text);
    expect(result).toContain(REDACTED_VALUE);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts GitHub-style ghp_ tokens', () => {
    const text = 'Token: ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD';
    const result = redactTokenLikeValues(text);
    expect(result).toContain(REDACTED_VALUE);
    expect(result).not.toContain('ghp_1234567890');
  });

  it('redacts "Bearer xxx" headers', () => {
    const text = 'Authorization: Bearer abc123.def456.ghi789';
    const result = redactTokenLikeValues(text);
    expect(result).toContain(REDACTED_VALUE);
    expect(result).not.toContain('abc123.def456.ghi789');
  });

  it('redacts api_key= and token= style assignments', () => {
    const text = 'config: api_key=mysecretvalue and token=othertokenvalue';
    const result = redactTokenLikeValues(text);
    expect(result).toContain(REDACTED_VALUE);
    expect(result).not.toContain('mysecretvalue');
    expect(result).not.toContain('othertokenvalue');
  });

  it('leaves normal text alone', () => {
    const text = 'This is a normal sentence with no tokens inside.';
    const result = redactTokenLikeValues(text);
    expect(result).toBe(text);
  });
});

describe('redactEnvLikeValues', () => {
  it('redacts KEY=value patterns', () => {
    const text = 'Run with API_KEY=verysecretvalue and continue';
    const result = redactEnvLikeValues(text);
    expect(result).toContain(REDACTED_VALUE);
    expect(result).not.toContain('verysecretvalue');
  });

  it('redacts KEY="value" quoted patterns', () => {
    const text = 'export DATABASE_URL="postgres://user:pass@host/db"';
    const result = redactEnvLikeValues(text);
    expect(result).toContain(REDACTED_VALUE);
    expect(result).not.toContain('user:pass@host');
  });

  it('leaves normal text alone', () => {
    const text = 'There is no env var assignment in this sentence.';
    const result = redactEnvLikeValues(text);
    expect(result).toBe(text);
  });
});

describe('redactStackTrace', () => {
  it('returns error name + bounded top frame for full stack', () => {
    const text = [
      'TypeError: cannot read property foo of undefined',
      '    at doWork (C:\\Users\\alice\\project\\src\\a.ts:10:5)',
      '    at callIt (C:\\Users\\alice\\project\\src\\b.ts:25:3)',
      '    at handle (C:\\Users\\alice\\project\\src\\c.ts:99:1)',
    ].join('\n');
    const result = redactStackTrace(text, 1);
    expect(result).toContain('TypeError');
    expect(result).toContain(REDACTED_PATH);
    expect(result).not.toContain('b.ts');
    expect(result).not.toContain('c.ts');
  });

  it('returns "<no-stack>" for empty input', () => {
    expect(redactStackTrace('', 3)).toBe('<no-stack>');
  });
});

describe('redactSensitiveFields', () => {
  it('redacts exact sensitive keys (password, token, secret, apiKey, authorization)', () => {
    const input = {
      username: 'alice',
      password: 'supersecret',
      token: 'tok_abc123',
      apiKey: 'ak_live_123',
      authorization: 'Bearer xyz',
    };
    const result = redactSensitiveFields(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const redacted = result.value as Record<string, unknown>;
    expect(redacted.username).toBe('alice');
    expect(redacted.password).toBe(REDACTED_VALUE);
    expect(redacted.token).toBe(REDACTED_VALUE);
    expect(redacted.apiKey).toBe(REDACTED_VALUE);
    expect(redacted.authorization).toBe(REDACTED_VALUE);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('uses segment-exact key matching (not substring) — "author" should NOT match "auth"', () => {
    const input = { author: 'alice', authenticated: true, authtoken: 'should-redact' };
    const result = redactSensitiveFields(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const redacted = result.value as Record<string, unknown>;
    expect(redacted.author).toBe('alice');
    expect(redacted.authenticated).toBe(true);
    // "authtoken" is not a sensitive segment; only exact "authorization" / "auth_token" / "authtoken" forms should match
    // We test that "author" (containing "auth") is NOT redacted (substring pattern is the bug)
    expect(redacted.author).not.toBe(REDACTED_VALUE);
  });

  it('handles circular references without throwing', () => {
    const input: Record<string, unknown> = { name: 'root' };
    input.self = input;
    const result = redactSensitiveFields(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const redacted = result.value as Record<string, unknown>;
    expect(redacted.name).toBe('root');
    // The circular self-reference should be marked as a redaction note
    expect(result.notes.some((n: string) => n.includes('circular') || n.includes('cycle'))).toBe(true);
  });

  it('does NOT throw on non-object input — returns structured error', () => {
    const result = redactSensitiveFields(42);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeDefined();
    expect(result.nextAction).toBeDefined();
  });

  it('does NOT throw on null — returns structured error', () => {
    const result = redactSensitiveFields(null);
    expect(result.ok).toBe(false);
  });

  it('handles arrays without throwing', () => {
    const input = [{ password: 'secret1' }, { name: 'safe' }];
    const result = redactSensitiveFields(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const arr = result.value as Record<string, unknown>[];
    expect(arr[0]?.password).toBe(REDACTED_VALUE);
    expect(arr[1]?.name).toBe('safe');
  });

  it('BigInt values are stringified safely, not thrown', () => {
    const input = { count: BigInt('9999999999999999'), password: 'secret' };
    const result = redactSensitiveFields(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const redacted = result.value as Record<string, unknown>;
    expect(redacted.password).toBe(REDACTED_VALUE);
    expect(typeof redacted.count).toBe('string');
  });

  it('records redaction note when string value contains token-like pattern', () => {
    const input = { buildLog: 'Build started. API key sk-ant-1234567890abcdef1234567890 used.' };
    const result = redactSensitiveFields(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const redacted = result.value as Record<string, unknown>;
    expect(redacted.buildLog).not.toContain('sk-ant-');
    expect(result.notes.some((n: string) => n.includes('redacted'))).toBe(true);
  });

  it('records redaction note when string value contains absolute path', () => {
    const input = { cwd: 'Working in C:\\Users\\alice\\secret-project\\src' };
    const result = redactSensitiveFields(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const redacted = result.value as Record<string, unknown>;
    expect(redacted.cwd).not.toContain('alice');
    expect(result.notes.some((n: string) => n.includes('redacted'))).toBe(true);
  });

  it('records redaction note when string value is truncated', () => {
    const longValue = 'x'.repeat(3000);
    const input = { bigField: longValue };
    const result = redactSensitiveFields(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const redacted = result.value as Record<string, unknown>;
    expect((redacted.bigField as string).length).toBeLessThan(longValue.length);
    expect(result.notes.some((n: string) => n.includes('truncated'))).toBe(true);
  });

  it('records redaction note when string value contains env-like assignment', () => {
    const input = { envDump: 'DATABASE_URL=postgres://user:pass@host:5432/db' };
    const result = redactSensitiveFields(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const redacted = result.value as Record<string, unknown>;
    expect(redacted.envDump).not.toContain('postgres://user:pass');
    expect(result.notes.some((n: string) => n.includes('redacted'))).toBe(true);
  });

  it('does NOT record redaction note for clean string values', () => {
    const input = { message: 'hello world', name: 'test' };
    const result = redactSensitiveFields(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes.some((n: string) => n.includes('string value redacted'))).toBe(false);
    expect(result.notes.some((n: string) => n.includes('truncated'))).toBe(false);
  });
});

describe('redactTokenLikeValues (extended)', () => {
  it('redacts lin_api_ tokens', () => {
    const text = 'lin_api_TEST_REDACT_ME_1234567890ABCDEF';
    const result = redactTokenLikeValues(text);
    expect(result).toBe('[REDACTED]');
  });

  it('redacts lin_api_ tokens in command context', () => {
    const text = 'curl -H "Authorization: lin_api_TEST_REDACT_ME_1234567890ABCDEF" https://api.linear.app';
    const result = redactTokenLikeValues(text);
    expect(result).not.toContain('lin_api_');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Authorization header value while preserving label', () => {
    const text = 'curl -H "Authorization: Bearer sk-TEST_REDACT_ME_1234567890" https://api.example.com';
    const result = redactTokenLikeValues(text);
    expect(result).toContain('Authorization:');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('sk-TEST_REDACT_ME');
  });

  it('redacts PowerShell env $env:LINEAR_API_KEY', () => {
    const text = '$env:LINEAR_API_KEY="lin_api_TEST_REDACT_ME_1234567890ABCDEF"';
    const result = redactTokenLikeValues(text);
    expect(result).toContain('$env:LINEAR_API_KEY');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('lin_api_TEST_REDACT_ME');
  });

  it('redacts inline env assignment LINEAR_API_KEY with redactEnvLikeValues', () => {
    const text = 'set LINEAR_API_KEY=lin_api_TEST_REDACT_ME_1234567890ABCDEF';
    const result = redactEnvLikeValues(text);
    expect(result).toContain('LINEAR_API_KEY');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('lin_api_TEST_REDACT_ME');
  });

  it('redacts ghp_ tokens', () => {
    const text = 'ghp_TEST_REDACT_ME_1234567890ABCDEFGHIJKLMN';
    const result = redactTokenLikeValues(text);
    expect(result).toBe('[REDACTED]');
  });
});

describe('redactTelemetryString', () => {
  it('redacts exec command containing lin_api_ token', () => {
    const cmd = 'curl -s -H "Authorization: lin_api_TEST_REDACT_ME_1234567890ABCDEF" https://api.linear.app/issues';
    const result = redactTelemetryString(cmd);
    expect(result).not.toContain('lin_api_TEST_REDACT_ME');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Authorization header in composite command', () => {
    const cmd = 'curl -X POST -H "Authorization: Bearer sk-TEST_REDACT_ME" -d "{}" https://api.example.com/data';
    const result = redactTelemetryString(cmd);
    expect(result).toContain('Authorization:');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('Bearer sk-TEST_REDACT_ME');
  });

  it('redacts Bearer token', () => {
    const cmd = 'curl -H "Authorization: Bearer TEST_REDACT_ME_TOKEN_VALUE_1234567890"';
    const result = redactTelemetryString(cmd);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('TEST_REDACT_ME_TOKEN_VALUE');
  });

  it('redacts env assignment in command', () => {
    const cmd = 'LINEAR_API_KEY=lin_api_TEST_REDACT_ME_1234567890ABCDEF curl -s https://api.linear.app';
    const result = redactTelemetryString(cmd);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('lin_api_TEST_REDACT_ME');
    expect(result).not.toContain('LINEAR_API_KEY=lin_api');
  });

  it('redacts PowerShell $env:LINEAR_API_KEY', () => {
    const cmd = '$env:LINEAR_API_KEY="lin_api_TEST_REDACT_ME_1234567890ABCDEF"';
    const result = redactTelemetryString(cmd);
    expect(result).toContain('$env:LINEAR_API_KEY');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('lin_api_TEST_REDACT_ME');
  });

  it('preserves normal file path', () => {
    const path = 'src/app.ts';
    const result = redactTelemetryString(path);
    expect(result).toBe('src/app.ts');
  });

  it('redacts sk- tokens in file path context', () => {
    const path = 'config/sk-TEST_REDACT_ME_1234567890file.json';
    const result = redactTelemetryString(path);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('sk-TEST_REDACT_ME');
  });

  it('returns original string when no secrets present', () => {
    const text = 'echo hello world';
    const result = redactTelemetryString(text);
    expect(result).toBe('echo hello world');
  });

  it('handles non-string input (fail safe)', () => {
    const result = redactTelemetryString(undefined as unknown as string);
    expect(result).toBe(undefined);
  });
});
