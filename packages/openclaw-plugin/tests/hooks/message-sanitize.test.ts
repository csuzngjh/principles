import { describe, it, expect } from 'vitest';
import { handleBeforeMessageWrite, sanitizeAssistantText, sanitizeForEvidence, sanitizeToolParamsForEvidence, MAX_EVIDENCE_VALUE_CHARS } from '../../src/hooks/message-sanitize';

describe('message-sanitize hook', () => {
  it('removes empathy control tags from assistant text', () => {
    const text = '抱歉 [EMOTIONAL_DAMAGE_DETECTED:moderate]\n<empathy signal="damage" severity="moderate"/>\n继续处理';
    expect(sanitizeAssistantText(text)).toBe('抱歉\n\n继续处理');
  });

  it('returns modified message for assistant role', () => {
    const result = handleBeforeMessageWrite({
      message: {
        role: 'assistant',
        content: 'hello [EMOTIONAL_DAMAGE_DETECTED] world'
      }
    } as any);

    expect(result).toEqual({
      message: {
        role: 'assistant',
        content: 'hello  world'
      }
    });
  });

  it('ignores non-assistant messages', () => {
    const result = handleBeforeMessageWrite({
      message: {
        role: 'user',
        content: '[EMOTIONAL_DAMAGE_DETECTED]'
      }
    } as any);

    expect(result).toBeUndefined();
  });

  // ── sanitizeForEvidence tests ──

  it('binds long string values to MAX_EVIDENCE_VALUE_CHARS', () => {
    // Use mixed repeating pattern; single-char repeats match the token regex
    const segment = ' data ';
    const long = segment.repeat(100); // ~600 chars, well over MAX
    const result = sanitizeForEvidence(long);
    expect(result).toMatch(/___TRUNCATED___$/);
    expect(result.length).toBeLessThanOrEqual(MAX_EVIDENCE_VALUE_CHARS + 20);
  });

  it('redacts token-like patterns (40+ alphanumeric consecutive chars)', () => {
    const sk = 'sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz';
    const result = sanitizeForEvidence(`my token is ${sk}`);
    expect(result).toContain('___REDACTED___');
    expect(result).not.toContain(sk);
  });

  it('redacts JWT-like patterns', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNqP72NoF6pTgzPfVa9Pv3TlwHB7VV3z8JuRsqY';
    const result = sanitizeForEvidence(`Bearer ${jwt}`);
    expect(result).toContain('___REDACTED___');
    expect(result).not.toContain(jwt);
  });

  it('redacts OpenAI-style secret keys', () => {
    const sk = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
    const result = sanitizeForEvidence(sk);
    expect(result).toContain('___REDACTED___');
  });

  it('strips internal PD tags from evidence', () => {
    const text = '[EMOTIONAL_DAMAGE_DETECTED:severe] something went wrong';
    const result = sanitizeForEvidence(text);
    expect(result).not.toContain('EMOTIONAL_DAMAGE_DETECTED');
    expect(result).toContain('something went wrong');
  });

  it('returns safe string for non-string values', () => {
    expect(sanitizeForEvidence(42)).toBe('42');
    expect(sanitizeForEvidence(null)).toBe('');
    expect(sanitizeForEvidence(undefined)).toBe('');
  });

  // ── sanitizeToolParamsForEvidence tests ──

  it('redacts long content/text/input/new_string fields', () => {
    const params = {
      file_path: '/safe/path/file.ts',
      content: ' data chunk '.repeat(60), // 780+ chars with spaces avoids token regex
      text: ' report line '.repeat(60),
    };
    const result = sanitizeToolParamsForEvidence(params);
    expect(result.file_path).toBe('/safe/path/file.ts');
    expect(result.content).toMatch(/___TRUNCATED___$/);
    expect(result.text).toMatch(/___TRUNCATED___$/);
    expect(result.content.length).toBeLessThan(500);
  });

  it('keeps short normal fields intact', () => {
    const params = {
      file_path: 'src/index.ts',
      content: 'short-content',
      query: 'SELECT * FROM users',
    };
    const result = sanitizeToolParamsForEvidence(params);
    expect(result.file_path).toBe('src/index.ts');
    expect(result.content).toBe('short-content');
    expect(result.query).toBe('SELECT * FROM users');
  });

  it('redacts token-like strings inside content/text fields', () => {
    const params = {
      content: 'key is sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz',
    };
    const result = sanitizeToolParamsForEvidence(params);
    expect(result.content).toContain('___REDACTED___');
    expect(result.content).not.toContain('sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz');
  });
});
