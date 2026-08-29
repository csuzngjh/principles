import { describe, it, expect } from 'vitest';
import { extractJsonObject, extractJsonObjects, selectBestJsonObject, extractJsonObjectForSchema, repairMalformedJson } from '../json-extractor.js';

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

  it('parses JSON with escaped quotes inside string values', () => {
    const input = '{"taskId":"t1","message":"He said \\"hello\\""}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', message: 'He said "hello"' });
  });

  it('parses JSON with null values', () => {
    const input = '{"taskId":"t1","optional":null}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', optional: null });
  });

  it('parses JSON with boolean and number values', () => {
    const input = '{"active":true,"count":42,"ratio":3.14,"negative":-1}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ active: true, count: 42, ratio: 3.14, negative: -1 });
  });

  it('returns null for array containing objects at top level', () => {
    const input = '[{"a":1},{"b":2}]';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });

  it('parses JSON with Unicode characters', () => {
    const input = '{"taskId":"t1","label":"\\u4f60\\u597d"}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', label: '\u4f60\u597d' });
  });

  it('parses JSON with escaped backslash in string', () => {
    const input = '{"path":"C:\\\\Users\\\\test"}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ path: 'C:\\Users\\test' });
  });

  it('parses deeply nested JSON object', () => {
    const input = '{"a":{"b":{"c":{"d":"deep"}}}}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ a: { b: { c: { d: 'deep' } } } });
  });

  it('returns null for string with unmatched opening brace', () => {
    const input = 'some text { "key": "value" no close';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });

  it('parses JSON object after prose prefix', () => {
    const input = 'Result: {"found":true}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ found: true });
  });

  it('handles code fence with extra whitespace', () => {
    const input = '```  json  \n  {"taskId":"t1"}  \n```';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1' });
  });

  it('returns null for bracket-scanned array starting with [ that contains an object with escaped quotes', () => {
    const input = '[{"msg":"He said \\"hello\\""}]';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });

  it('returns null for bracket-scanned array with escaped backslash inside string', () => {
    const input = '[{"path":"C:\\\\Users"}]';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });

  it('returns null for bracket-scanned array with nested braces inside strings', () => {
    const input = '[{"template":"Use {braces} here"}]';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });
});

// ── repairMalformedJson ──────────────────────────────────────────────────────

describe('repairMalformedJson', () => {
  it('returns valid JSON unchanged', () => {
    const input = '{"diagnosisId":"d1","summary":"ok"}';
    const result = repairMalformedJson(input);
    expect(result).toEqual({ diagnosisId: 'd1', summary: 'ok' });
  });

  it('repairs unescaped double quotes inside string values', () => {
    // This is the real failure case: LLM outputs "wrong" inside a string value
    const input = '{"rootCause":"Design: the "wrong" approach caused failure"}';
    const result = repairMalformedJson(input);
    expect(result).not.toBeNull();
    expect(result?.rootCause).toContain('wrong');
  });

  it('repairs multiple unescaped quotes in different fields', () => {
    const input = '{"summary":"He said "hello" and "goodbye"","rootCause":"the "bug" was here"}';
    const result = repairMalformedJson(input);
    expect(result).not.toBeNull();
    expect(result?.summary).toContain('hello');
    expect(result?.rootCause).toContain('bug');
  });

  it('handles already-escaped quotes correctly (no double-escaping)', () => {
    const input = '{"msg":"He said \\"hello\\""}';
    const result = repairMalformedJson(input);
    expect(result).not.toBeNull();
    expect(result?.msg).toBe('He said "hello"');
  });

  it('extracts from prose-wrapped malformed JSON', () => {
    const input = 'Here is the result:\n{"diagnosisId":"d1","rootCause":"the "bug" was here"}\nEnd.';
    const result = repairMalformedJson(input);
    expect(result).not.toBeNull();
    expect(result?.diagnosisId).toBe('d1');
  });

  it('returns null for completely unparseable text', () => {
    const result = repairMalformedJson('no json here at all');
    expect(result).toBeNull();
  });

  it('returns null for text with no opening brace', () => {
    const result = repairMalformedJson('just some text "with quotes"');
    expect(result).toBeNull();
  });

  it('repairs DiagnosticianOutputV1-like malformed JSON', () => {
    const input = '{"diagnosisId":"diag-1","summary":"test","rootCause":"the "primary" issue","violatedPrinciples":[],"evidence":[],"recommendations":[],"confidence":0.8}';
    const result = repairMalformedJson(input);
    expect(result).not.toBeNull();
    expect(result?.diagnosisId).toBe('diag-1');
    expect(result?.rootCause).toContain('primary');
    expect(result?.confidence).toBe(0.8);
  });
});

// ── PRI-621 RC3: multi-candidate collection + schema-aware selection ────────

describe('extractJsonObjects', () => {
  it('collects every top-level object (fenced first, then brace-scanned)', () => {
    const input = 'Fragment {"a":1} prose {"taskId":"t1","score":0.5} more text';
    const result = extractJsonObjects(input);
    expect(result).toEqual([{ a: 1 }, { taskId: 't1', score: 0.5 }]);
  });

  it('includes fenced content as the first candidate', () => {
    const input = '```\n{"fenced":true}\n```\nand loose {"loose":true}';
    const result = extractJsonObjects(input);
    // Fenced content leads; the brace scan also sees the fenced object again
    // (duplicate by design — scoring treats duplicates identically).
    expect(result[0]).toEqual({ fenced: true });
    expect(result).toContainEqual({ loose: true });
  });

  it('skips unparseable spans', () => {
    const input = '{not json} {"ok":true}';
    const result = extractJsonObjects(input);
    expect(result).toEqual([{ ok: true }]);
  });

  it('CodeRabbit: braces inside JSON string values do not terminate the span early', () => {
    const input = '{"summary":"literal }"} {"taskId":"t1"}';
    const result = extractJsonObjects(input);
    expect(result).toEqual([
      { summary: 'literal }' },
      { taskId: 't1' },
    ]);
  });

  it('CodeRabbit: escaped quotes inside strings are honored while scanning', () => {
    const input = '{"msg":"ends with escaped \\" and brace }"} {"after":1}';
    const result = extractJsonObjects(input);
    expect(result).toEqual([
      { msg: 'ends with escaped " and brace }' },
      { after: 1 },
    ]);
  });
});

describe('selectBestJsonObject', () => {
  const required = ['taskId', 'implementationCode', 'goldenTraceCases'] as const;

  it('prefers the candidate with more required keys even when it appears later (PRI-621 recurrence)', () => {
    // 2026-08-28 recurrence: inner lineage fragment parsed first, complete
    // artificer output came after — first-object extraction validated the fragment.
    const fragment = { scribeArtifactId: 'pi-art-scribe-x', dreamerArtifactId: 'pi-art-dreamer-y' };
    const complete = { taskId: 't1', implementationCode: 'function evaluate(){}', goldenTraceCases: [{}, {}] };
    const selected = selectBestJsonObject([fragment, complete], required);
    expect(selected).toBe(complete);
  });

  it('breaks ties toward more own keys, then larger size', () => {
    const small = { taskId: 't1' };
    const large = { taskId: 't1', extra: 'x'.repeat(50) };
    expect(selectBestJsonObject([small, large], ['taskId'])).toBe(large);
  });

  it('returns the first candidate when no required keys are known (legacy semantics)', () => {
    const first = { a: 1 };
    const second = { b: 2 };
    expect(selectBestJsonObject([first, second], undefined)).toBe(first);
  });

  it('CodeRabbit: falls back to the FIRST candidate when all candidates score zero', () => {
    // Zero-score tie-breaking must not promote an unrelated fragment.
    const first = { a: 1 };
    const second = { b: 2, c: 3 };
    expect(selectBestJsonObject([first, second], ['taskId'])).toBe(first);
  });

  it('returns null for an empty candidate list', () => {
    expect(selectBestJsonObject([], ['taskId'])).toBeNull();
  });
});

describe('extractJsonObjectForSchema', () => {
  it('extracts the schema-matching object out of a multi-object answer', () => {
    const input = 'trace {"scribeArtifactId":"x"}\nfinal {"taskId":"t1","implementationCode":"code","goldenTraceCases":[{},{}]}';
    const result = extractJsonObjectForSchema(input, ['taskId', 'implementationCode', 'goldenTraceCases']);
    expect(result).toMatchObject({ taskId: 't1' });
  });

  it('degrades to first-object behavior without required keys', () => {
    const input = '{"first":true} {"second":true}';
    expect(extractJsonObjectForSchema(input, undefined)).toEqual({ first: true });
  });
});
