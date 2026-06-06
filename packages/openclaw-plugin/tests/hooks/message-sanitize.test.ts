import { describe, it, expect } from 'vitest';
import {
  handleBeforeMessageWrite,
  sanitizeAssistantText,
  sanitizeForEvidence,
  sanitizeToolParamsForEvidence,
  sanitizeValueForEvidence,
  MAX_EVIDENCE_VALUE_CHARS,
} from '../../src/hooks/message-sanitize';

describe('message-sanitize hook', () => {
  it('removes empathy control tags from assistant text', () => {
    const text = '抱歉 [EMOTIONAL_DAMAGE_DETECTED:moderate]\n<empathy signal="damage" severity="moderate"/>\n继续处理';
    expect(sanitizeAssistantText(text)).toBe('抱歉\n\n继续处理');
  });

  it('returns modified message for assistant role', () => {
    const result = handleBeforeMessageWrite({
      message: { role: 'assistant', content: 'hello [EMOTIONAL_DAMAGE_DETECTED] world' }
    } as any);
    expect(result).toEqual({
      message: { role: 'assistant', content: 'hello  world' }
    });
  });

  it('ignores non-assistant messages', () => {
    const result = handleBeforeMessageWrite({
      message: { role: 'user', content: '[EMOTIONAL_DAMAGE_DETECTED]' }
    } as any);
    expect(result).toBeUndefined();
  });

  // ── sanitizeForEvidence ──

  it('binds long string values to MAX_EVIDENCE_VALUE_CHARS', () => {
    const segment = ' data ';
    const long = segment.repeat(100);
    const result = sanitizeForEvidence(long);
    expect(result).toMatch(/___TRUNCATED___$/);
    expect(result.length).toBeLessThanOrEqual(MAX_EVIDENCE_VALUE_CHARS + 20);
  });

  it('redacts OpenAI-style secret keys (sk-*)', () => {
    const token = 'sk-proj-' + 'a'.repeat(30); // 38 chars after sk-
    const result = sanitizeForEvidence(`token is ${token}`);
    expect(result).toContain('___REDACTED___');
    expect(result).not.toContain(token);
  });

  it('redacts JWT-like patterns (eyJ*)', () => {
    const jwt = 'eyJ' + 'a'.repeat(30) + '.bc'; // 34 chars after eyJ + dot
    const result = sanitizeForEvidence(`Bearer ${jwt}`);
    expect(result).toContain('___REDACTED___');
    expect(result).not.toContain(jwt);
  });

  it('redacts long base64-like strings', () => {
    const token = 'A'.repeat(50); // ≥40 alphanumeric
    const result = sanitizeForEvidence(`hash: ${token}`);
    expect(result).toContain('___REDACTED___');
    expect(result).not.toContain(token);
  });

  it('redacts GitHub PATs (ghp_*)', () => {
    const token = 'ghp_' + 'a'.repeat(40);
    const result = sanitizeForEvidence(token);
    expect(result).toContain('___REDACTED___');
  });

  it('strips internal PD tags from evidence', () => {
    const result = sanitizeForEvidence('[EMOTIONAL_DAMAGE_DETECTED:severe] something went wrong');
    expect(result).not.toContain('EMOTIONAL_DAMAGE_DETECTED');
    expect(result).toContain('something went wrong');
  });

  it('returns safe string for non-string values', () => {
    expect(sanitizeForEvidence(42)).toBe('42');
    expect(sanitizeForEvidence(null)).toBe('');
    expect(sanitizeForEvidence(undefined)).toBe('');
  });

  it('converges absolute paths to basename when no workspaceDir', () => {
    const result = sanitizeForEvidence('/home/user/secrets/token.json');
    expect(result).toBe('token.json');
    expect(result).not.toContain('/home/');
  });

  it('converges absolute paths to repo-relative when workspaceDir matches', () => {
    const result = sanitizeForEvidence('/workspace/my-repo/src/index.ts', '/workspace/my-repo');
    expect(result).toBe('src/index.ts');
  });

  // ── sanitizeToolParamsForEvidence ──

  it('redacts long content/text/input/new_string fields', () => {
    const params = {
      file_path: 'src/file.ts',
      content: ' data chunk '.repeat(60),
      text: ' report line '.repeat(60),
    };
    const result = sanitizeToolParamsForEvidence(params);
    expect(result.file_path).toBe('src/file.ts');
    expect(result.content).toMatch(/___TRUNCATED___$/);
    expect(result.text).toMatch(/___TRUNCATED___$/);
    expect(result.content.length).toBeLessThan(500);
  });

  it('keeps short normal fields intact', () => {
    const params = { file_path: 'src/index.ts', content: 'short-content', query: 'SELECT * FROM users' };
    const result = sanitizeToolParamsForEvidence(params);
    expect(result.file_path).toBe('src/index.ts');
    expect(result.content).toBe('short-content');
    expect(result.query).toBe('SELECT * FROM users');
  });

  it('redacts token-like strings inside content/text fields', () => {
    const token = 'sk-proj-' + 'a'.repeat(30);
    const params = { content: `key is ${token}` };
    const result = sanitizeToolParamsForEvidence(params);
    expect(result.content).toContain('___REDACTED___');
    expect(result.content).not.toContain(token);
  });

  // ── edit params: nested edits array ──

  it('sanitizes edit params with nested edits[].oldText/newText', () => {
    const secretToken = 'sk-proj-' + 'a'.repeat(30);
    const params = {
      file_path: '/repo/src/config.ts',
      edits: [
        { oldText: secretToken, newText: 'safe-value' },
        { oldText: 'const x = 1;', newText: ' data '.repeat(200) },
      ],
    };
    const result = sanitizeToolParamsForEvidence(params, '/repo') as Record<string, unknown>;
    const edits = result.edits as Array<Record<string, unknown>>;
    // Token in oldText redacted
    expect(edits[0].oldText).toContain('___REDACTED___');
    expect(edits[0].oldText).not.toContain(secretToken);
    // Short value preserved
    expect(edits[0].newText).toBe('safe-value');
    // Long newText truncated
    expect(edits[1].newText).toMatch(/___TRUNCATED___$/);
    // file_path converged to relative (workspaceDir provided)
    expect(result.file_path).toBe('src/config.ts');
  });

  // ── command/query: token redaction ──

  it('redacts tokens in command and query fields', () => {
    const jwt = 'eyJ' + 'a'.repeat(30) + '.bc';
    const skToken = 'sk-proj-' + 'a'.repeat(30);
    const params = {
      command: `curl -H "Authorization: Bearer ${jwt}" https://api.example.com`,
      query: `SELECT * FROM users WHERE api_key = "${skToken}"`,
    };
    const result = sanitizeToolParamsForEvidence(params);
    expect(result.command).toContain('___REDACTED___');
    expect(result.command).not.toContain(jwt);
    expect(result.query).toContain('___REDACTED___');
    expect(result.query).not.toContain(skToken);
  });

  // ── null/array/string input: no throw ──

  it('handles null input without throwing', () => {
    expect(() => sanitizeToolParamsForEvidence(null)).not.toThrow();
    expect(sanitizeToolParamsForEvidence(null)).toEqual({});
  });

  it('handles array input without throwing', () => {
    const result = sanitizeToolParamsForEvidence(['a', 'b', 'c']);
    expect(result['<array-input>']).toBeDefined();
  });

  it('handles string input without throwing', () => {
    const result = sanitizeToolParamsForEvidence('raw string input');
    expect(result['<string-input>']).toBeDefined();
  });

  it('handles undefined input without throwing', () => {
    expect(sanitizeToolParamsForEvidence(undefined)).toEqual({});
  });

  it('handles number input without throwing', () => {
    expect(sanitizeToolParamsForEvidence(42)).toEqual({});
  });

  // ── sanitizeValueForEvidence: recursive ──

  it('recursively sanitizes nested objects', () => {
    const token = 'sk-proj-' + 'a'.repeat(30);
    const input = { a: { b: { c: token } } };
    const result = sanitizeValueForEvidence(input) as Record<string, unknown>;
    const nested = (result.a as Record<string, unknown>).b as Record<string, unknown>;
    expect(nested.c).toContain('___REDACTED___');
  });

  it('respects max array items limit', () => {
    const input = { items: Array.from({ length: 100 }, (_, i) => `item-${i}`) };
    const result = sanitizeValueForEvidence(input) as Record<string, unknown>;
    const items = result.items as unknown[];
    expect(items.length).toBeLessThanOrEqual(22);
  });

  it('respects max depth limit', () => {
    const deep: any = { a: { b: { c: { d: { e: 'too deep' } } } } };
    const result = sanitizeValueForEvidence(deep, 0) as Record<string, unknown>;
    const a = result.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    const c = b.c as Record<string, unknown>;
    const d = c.d as Record<string, unknown>;
    expect(d.e).toBe('<max-depth>');
  });
});
