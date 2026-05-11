import { describe, it, expect } from 'vitest';
import { extractJsonObject } from '../json-extractor.js';

describe('extractJsonObject', () => {
  it('parses pure JSON object', () => {
    const input = '{"taskId":"t1","score":0.85}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', score: 0.85 });
  });

  it('parses JSON in ```json code fence', () => {
    const input = '```json\n{"taskId":"t1","score":0.85}\n```';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', score: 0.85 });
  });

  it('parses JSON in ``` code fence without language tag', () => {
    const input = '```\n{"taskId":"t1","score":0.85}\n```';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', score: 0.85 });
  });

  it('parses prose-wrapped JSON', () => {
    const input = 'Here is the evaluation output:\n{"taskId":"t1","score":0.85}\nDone.';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', score: 0.85 });
  });

  it('parses JSON with leading and trailing whitespace', () => {
    const input = '   \n  {"taskId":"t1"}  \n  ';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1' });
  });

  it('returns first JSON object when multiple exist', () => {
    const input = '{"first":1} some text {"second":2}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ first: 1 });
  });

  it('returns null for pure prose with no JSON', () => {
    const input = 'This is just text with no JSON at all.';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON with unclosed brace', () => {
    const input = '{"taskId":"t1","score":0.85';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });

  it('returns outermost object for nested JSON', () => {
    const input = '{"outer":{"inner":1},"flag":true}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ outer: { inner: 1 }, flag: true });
  });

  it('returns null for JSON array at top level', () => {
    const input = '[1,2,3]';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = extractJsonObject('');
    expect(result).toBeNull();
  });

  it('parses code-fenced JSON with prose before and after', () => {
    const input = 'I have evaluated the plan.\n```json\n{"taskId":"t1","decision":"approved"}\n```\nHope this helps!';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', decision: 'approved' });
  });

  it('parses JSON with nested arrays and objects', () => {
    const input = '{"taskId":"t1","evaluation":{"strengths":["a","b"],"concerns":[]},"risks":[]}';
    const result = extractJsonObject(input);
    expect(result).toEqual({
      taskId: 't1',
      evaluation: { strengths: ['a', 'b'], concerns: [] },
      risks: [],
    });
  });

  it('returns null for string with only braces but no valid JSON', () => {
    const input = '{not valid json}';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });

  it('parses JSON with braces inside string values', () => {
    const input = '{"taskId":"t1","summary":"Use {braces} for objects","score":0.5}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', summary: 'Use {braces} for objects', score: 0.5 });
  });
});
