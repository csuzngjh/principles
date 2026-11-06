/**
 * Chaos JSON repair suite — adversarial tests for RuntimeAdapter structured output.
 *
 * PRI-207: Explicitly enumerates and verifies all 12 required chaos scenarios
 * for structured output extraction, validation, repair attempts, and evidence
 * reporting. Supplements existing tests with adversarial edge cases.
 *
 * All tests use deterministic fake runtime/provider output. No live LLM.
 * No production workspace mutation.
 */
import { describe, it, expect } from 'vitest';
import { extractJsonObject } from '../json-extractor.js';
import {
  preserveLineageFields,
  formatValidationErrorEntry,
  safeStringifyPreview,
  normalizeMaxRepairAttempts,
  MAX_REPAIR_ATTEMPTS,
  LINEAGE_FIELDS,
} from '../output-repair-contract.js';
import { attemptStructuredOutputRepair } from '../structured-output-repair.js';
import type { SchemaValidationError, RepairLLMCaller } from '../structured-output-repair.js';

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

// ── Scenario 1: Prose-wrapped valid JSON ──

describe('Chaos 1: Prose-wrapped valid JSON', () => {
  it('1a: nested braces inside string values do not confuse extraction', () => {
    const input = 'The output is: {"taskId":"t1","summary":"Uses {braces} inside a {nested} string","score":0.85}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', summary: 'Uses {braces} inside a {nested} string', score: 0.85 });
  });

  it('1b: unicode escape sequences inside prose-wrapped JSON', () => {
    const input = 'Result:\n{"taskId":"t-\\u0041","note":"line1\\nline2","accent":"\\u00e9"}\nDone.';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't-A', note: 'line1\nline2', accent: 'é' });
  });
});

// ── Scenario 2: Markdown code-fence JSON ──

describe('Chaos 2: Markdown code-fence JSON', () => {
  it('2a: code fence with language tag plus prose before and after', () => {
    const input = 'Here is the evaluation:\n```json\n{"taskId":"t1","decision":"approved"}\n```\nHope this helps!';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', decision: 'approved' });
  });

  it('2b: code fence with trailing whitespace and non-JSON after fence', () => {
    const input = '```json\n{"taskId":"t1","score":0.85}\n```\nSome trailing text\n```\n{"ignore":"this"}\n```';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', score: 0.85 });
  });
});

// ── Scenario 3: Leading debug text plus valid JSON ──

describe('Chaos 3: Leading debug text plus valid JSON', () => {
  it('3a: debug log lines before JSON', () => {
    const input = '[DEBUG] 2026-05-22T10:00:00.000Z Starting evaluation\n[INFO] Model: claude-sonnet-4\n{"taskId":"t1","summary":"evaluation complete","score":0.9}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', summary: 'evaluation complete', score: 0.9 });
  });

  it('3b: system message lines before valid JSON', () => {
    const input = 'System: Thinking complete.\nUser: Analyze this pain signal.\nAssistant: {"taskId":"t1","decision":"approved"}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', decision: 'approved' });
  });
});

// ── Scenario 4: Multiple JSON objects, only one matches expected schema ──

describe('Chaos 4: Multiple JSON objects', () => {
  it('4a: two valid JSON objects, extractor returns first', () => {
    const input = '{"first":1,"id":"a"} some text {"second":2,"id":"b"}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ first: 1, id: 'a' });
  });

  it('4b: multiple JSON objects, returns first object', () => {
    const input = '{"taskId":"t1","score":0.85} irrelevant {"taskId":"t2","score":0.5} extra';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', score: 0.85 });
  });

  it('4c: first JSON is malformed (unclosed), second is valid — extractor returns null', () => {
    const input = '{"unclosed": true {"valid":true}';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });
});

// ── Scenario 5: JSON with trailing commentary ──

describe('Chaos 5: JSON with trailing commentary', () => {
  it('5a: JSON followed by prose commentary', () => {
    const input = '{"taskId":"t1","score":0.85}\n\nThis output represents the evaluation result.';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', score: 0.85 });
  });

  it('5b: prose before, JSON, prose after — full wrap', () => {
    const input = 'I evaluated the plan.\n{"taskId":"t1","decision":"approved","rationale":"Meets all criteria"}\nPlease review the above.';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', decision: 'approved', rationale: 'Meets all criteria' });
  });
});

// ── Scenario 6: Malformed JSON that cannot be repaired ──

describe('Chaos 6: Malformed JSON that cannot be repaired', () => {
  it('6a: entirely malformed JSON with unclosed braces returns null from extractor', () => {
    const result = extractJsonObject('{"taskId":"t1","score":0.85');
    expect(result).toBeNull();
  });

  it('6b: response is valid JSON but not an object (top-level array) — fail-closed, returns null', () => {
    const result = extractJsonObject('[{"taskId":"t1"},{"taskId":"t2"}]');
    expect(result).toBeNull();
  });

  it('6d: fenced array — fail-closed, returns null (no fall-through to brace scan)', () => {
    const result = extractJsonObject('```json\n[{"taskId":"t1"},{"taskId":"t2"}]\n```');
    expect(result).toBeNull();
  });

  it('6e: fenced null — fail-closed, returns null', () => {
    const result = extractJsonObject('```json\nnull\n```');
    expect(result).toBeNull();
  });

  it('6f: fenced string — fail-closed, returns null', () => {
    const result = extractJsonObject('```json\n"hello"\n```');
    expect(result).toBeNull();
  });

  it('6g: fenced valid object — returns object (regression)', () => {
    const result = extractJsonObject('```json\n{"taskId":"t1","confidence":0.9}\n```');
    expect(result).toEqual({ taskId: 't1', confidence: 0.9 });
  });

  it('6c: hybrid malformed: mixed brackets that cannot be balanced', () => {
    const input = '{"items": [1,2,3], "nested": {"a":[}]}';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });
});

// ── Scenario 7: Schema-invalid JSON that can be repaired ──

describe('Chaos 7: Schema-invalid JSON that can be repaired', () => {
  const SAMPLE_ERRORS: readonly SchemaValidationError[] = [
    { path: '/confidence', message: 'Expected number, got string', value: 'high' },
  ];

  const INVALID_INPUT = { confidence: 'high', summary: 'test' };

  const VALID_OUTPUT = { confidence: 0.95, summary: 'test' };

  it('7a: string-to-number repair succeeds on first attempt', async () => {
    const llmCaller: RepairLLMCaller = async () => JSON.stringify(VALID_OUTPUT);
    const schemaCheck = (v: unknown): boolean => {
      const obj = asRecord(v); if (!obj) return false;
      return typeof obj.confidence === 'number';
    };

    const result = await attemptStructuredOutputRepair(
      INVALID_INPUT,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck },
    );

    expect(result.repaired).toBe(true);
    expect(result.output).toEqual(VALID_OUTPUT);
    expect(result.attemptsUsed).toBe(1);
  });

  it('7b: repair succeeds on second attempt after first repair also invalid', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      if (callCount === 1) return JSON.stringify({ confidence: 'medium', summary: 'test' });
      return JSON.stringify(VALID_OUTPUT);
    };
    const schemaCheck = (v: unknown): boolean => {
      const obj = asRecord(v); if (!obj) return false;
      return typeof obj.confidence === 'number';
    };

    const result = await attemptStructuredOutputRepair(
      INVALID_INPUT,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck },
      { maxRepairAttempts: 2 },
    );

    expect(result.repaired).toBe(true);
    expect(result.attemptsUsed).toBe(2);
    expect(result.output).toEqual(VALID_OUTPUT);
  });

  it('7c: multiple schema errors fixed in a single repair attempt', async () => {
    const multiErrors: readonly SchemaValidationError[] = [
      { path: '/confidence', message: 'Expected number', value: 'high' },
      { path: '/score', message: 'Expected number', value: 'low' },
      { path: '/count', message: 'Expected number', value: 'many' },
    ];
    const invalidMulti = { confidence: 'high', score: 'low', count: 'many' };
    const validMulti = { confidence: 0.8, score: 0.9, count: 5 };

    const llmCaller: RepairLLMCaller = async () => JSON.stringify(validMulti);
    const schemaCheck = (v: unknown): boolean => {
      const obj = asRecord(v); if (!obj) return false;
      return typeof obj.confidence === 'number'
        && typeof obj.score === 'number'
        && typeof obj.count === 'number';
    };

    const result = await attemptStructuredOutputRepair(
      invalidMulti,
      multiErrors,
      { llmCaller, schemaCheck },
    );

    expect(result.repaired).toBe(true);
    expect(result.output).toEqual(validMulti);
    expect(result.attemptsUsed).toBe(1);
  });
});

// ── Scenario 8: Schema-invalid JSON that repair still fails ──

describe('Chaos 8: Schema-invalid JSON that repair still fails', () => {
  const SAMPLE_ERRORS: readonly SchemaValidationError[] = [
    { path: '/confidence', message: 'Expected number, got string', value: 'high' },
  ];

  it('8a: repair fails all attempts — returns repaired=false, output=null', async () => {
    const llmCaller: RepairLLMCaller = async () => JSON.stringify({ confidence: 'still-string', summary: 'test' });
    const schemaCheck = (v: unknown): boolean => {
      const obj = asRecord(v); if (!obj) return false;
      return typeof obj.confidence === 'number';
    };

    const result = await attemptStructuredOutputRepair(
      { confidence: 'high', summary: 'test' },
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck },
      { maxRepairAttempts: 1 },
    );

    expect(result.repaired).toBe(false);
    expect(result.output).toBeNull();
    expect(result.attemptsUsed).toBe(1);
  });

  it('8b: repair returns prose (not JSON) — extraction fails — repaired=false', async () => {
    const llmCaller: RepairLLMCaller = async () => 'The confidence value should be a number like 0.85.';
    const schemaCheck = (v: unknown): boolean => {
      const obj = asRecord(v); if (!obj) return false;
      return typeof obj.confidence === 'number';
    };

    const result = await attemptStructuredOutputRepair(
      { confidence: 'high', summary: 'test' },
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck },
      { maxRepairAttempts: 1 },
    );

    expect(result.repaired).toBe(false);
    expect(result.output).toBeNull();
    expect(result.attemptsUsed).toBe(1);
  });

  it('8c: repair attempt returns null (llmCaller returns null) — repaired=false', async () => {
    const llmCaller: RepairLLMCaller = async () => null;

    const result = await attemptStructuredOutputRepair(
      { confidence: 'high' },
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => false },
      { maxRepairAttempts: 1 },
    );

    expect(result.repaired).toBe(false);
    expect(result.output).toBeNull();
    expect(result.attemptsUsed).toBe(1);
  });

  it('8d: schemaErrors callback returns updated errors across attempts — repair succeeds when all fixed', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      // First attempt fixes confidence but not summary
      if (callCount === 1) return JSON.stringify({ confidence: 0.5, summary: 42 });
      // Second attempt fixes both
      return JSON.stringify({ confidence: 0.5, summary: 'ok' });
    };

    const schemaCheck = (v: unknown): boolean => {
      const obj = asRecord(v); if (!obj) return false;
      return typeof obj.confidence === 'number' && typeof obj.summary === 'string';
    };

    const schemaErrorsFn = (v: unknown): SchemaValidationError[] => {
      const obj = asRecord(v); if (!obj) return [];
      const errs: SchemaValidationError[] = [];
      if (typeof obj.confidence !== 'number') {
        errs.push({ path: '/confidence', message: 'Expected number', value: obj.confidence });
      }
      if (typeof obj.summary !== 'string') {
        errs.push({ path: '/summary', message: 'Expected string', value: obj.summary });
      }
      return errs;
    };

    const result = await attemptStructuredOutputRepair(
      { confidence: 'high', summary: 42 },
      [
        { path: '/confidence', message: 'Expected number', value: 'high' },
        { path: '/summary', message: 'Expected string', value: 42 },
      ],
      { llmCaller, schemaCheck, schemaErrors: schemaErrorsFn },
      { maxRepairAttempts: 2 },
    );

    // Second attempt fixes both errors → repair succeeds
    expect(result.repaired).toBe(true);
    expect(callCount).toBe(2);
    expect(result.attemptsUsed).toBe(2);
  });
});

// ── Scenario 9: Lineage fields preserved during repair ──

describe('Chaos 9: Lineage field preservation', () => {
  it('9a: all 6 LINEAGE_FIELDS changed by repair — all preserved', () => {
    const original: Record<string, unknown> = {
      taskId: 'orig-task',
      sourcePainId: 'orig-pain',
      sourceTaskId: 'orig-source-task',
      sourceRunIds: ['run-1'],
      sourceArtifactId: 'orig-artifact',
      sourceRefs: ['ref-1'],
      confidence: 0.85,
    };
    const repaired: Record<string, unknown> = {
      taskId: 'changed-task',
      sourcePainId: 'changed-pain',
      sourceTaskId: 'changed-source-task',
      sourceRunIds: ['changed-run'],
      sourceArtifactId: 'changed-artifact',
      sourceRefs: ['changed-ref'],
      confidence: 0.95,
    };

    const result = preserveLineageFields(original, repaired);

    for (const field of LINEAGE_FIELDS) {
      expect(result[field]).toBe(original[field]);
    }
    expect(result.confidence).toBe(0.95);
  });

  it('9b: original has null/undefined lineage fields — does not add nulls', () => {
    const original: Record<string, unknown> = {
      taskId: undefined,
      sourcePainId: null,
      confidence: 0.85,
    };
    const repaired: Record<string, unknown> = {
      taskId: 'should-not-appear',
      sourcePainId: 'also-should-not',
      confidence: 0.95,
    };

    const result = preserveLineageFields(original, repaired);

    // hasOwn reports true for both explicit undefined and null
    expect(result.taskId).toBeUndefined();
    expect(result.sourcePainId).toBeNull();
    expect(result.confidence).toBe(0.95);
  });

  it('9c: Object.create(null) repaired output — preserveLineageFields still works', () => {
    const original: Record<string, unknown> = { taskId: 'orig', confidence: 0.85 };
    const repaired = Object.create(null) as Record<string, unknown>;
    repaired.taskId = 'changed';
    repaired.confidence = 0.95;

    const result = preserveLineageFields(original, repaired);

    expect(result.taskId).toBe('orig');
    expect(result.confidence).toBe(0.95);
  });

  it('9d: preserveLineageFields via repair loop integration', async () => {
    const originalOutput = {
      taskId: 'protected-task',
      sourcePainId: 'protected-pain',
      confidence: 'high',
      summary: 'test',
    };
    const llmAttempts = [
      JSON.stringify({ taskId: 'hacker-changed', sourcePainId: 'hacker-changed', confidence: 0.9, summary: 'test' }),
    ];
    let attemptIdx = 0;
    const llmCaller: RepairLLMCaller = async () => llmAttempts[attemptIdx++] ?? null;
    const schemaCheck = (v: unknown): boolean => {
      const obj = asRecord(v); if (!obj) return false;
      return typeof obj.confidence === 'number';
    };

    const result = await attemptStructuredOutputRepair(
      originalOutput,
      [{ path: '/confidence', message: 'Expected number', value: 'high' }],
      { llmCaller, schemaCheck },
      { originalOutput, schemaRef: 'test-v1' },
    );

    expect(result.repaired).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.taskId).toBe('protected-task');
    expect(output.sourcePainId).toBe('protected-pain');
    expect(output.confidence).toBe(0.9);
  });

  it('9e: mismatch between sourceTaskId/sourceRunIds/sourcePainId — original values preserved (consistent overwrite policy)', () => {
    const original: Record<string, unknown> = {
      taskId: 'task-1',
      sourceTaskId: 'source-A',
      sourceRunIds: ['run-from-B'],
      sourcePainId: 'pain-from-C',
      confidence: 0.85,
    };
    const repaired: Record<string, unknown> = {
      taskId: 'task-1',
      sourceTaskId: 'source-X',
      sourceRunIds: ['run-from-Y'],
      sourcePainId: 'pain-from-Z',
      confidence: 0.95,
    };

    const result = preserveLineageFields(original, repaired);

    expect(result.sourceTaskId).toBe('source-A');
    expect(result.sourceRunIds).toEqual(['run-from-B']);
    expect(result.sourcePainId).toBe('pain-from-C');
    expect(result.confidence).toBe(0.95);
  });

  it('9f: lineage mismatch in original preserved through repair loop — consistent overwrite policy', async () => {
    const originalOutput = {
      taskId: 'task-1',
      sourceTaskId: 'source-A',
      sourceRunIds: ['run-from-B'],
      sourcePainId: 'pain-from-C',
      confidence: 'high',
      summary: 'test',
    };
    const llmCaller: RepairLLMCaller = async () =>
      JSON.stringify({
        taskId: 'task-1',
        sourceTaskId: 'source-X',
        sourceRunIds: ['run-from-Y'],
        sourcePainId: 'pain-from-Z',
        confidence: 0.9,
        summary: 'test',
      });
    const schemaCheck = (v: unknown): boolean => {
      const obj = asRecord(v); if (!obj) return false;
      return typeof obj.confidence === 'number';
    };

    const result = await attemptStructuredOutputRepair(
      originalOutput,
      [{ path: '/confidence', message: 'Expected number', value: 'high' }],
      { llmCaller, schemaCheck },
      { originalOutput, schemaRef: 'test-v1' },
    );

    expect(result.repaired).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.sourceTaskId).toBe('source-A');
    expect(output.sourceRunIds).toEqual(['run-from-B']);
    expect(output.sourcePainId).toBe('pain-from-C');
    expect(output.confidence).toBe(0.9);
  });
});

// ── Scenario 10: BigInt/circular/unstringifiable preview values ──

describe('Chaos 10: Safe preview serialization', () => {
  it('10a: Object.create(null) through safeStringifyPreview', () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj.key = 'value';
    const result = safeStringifyPreview(obj);
    expect(result).toContain('key');
    expect(result).toContain('value');
  });

  it('10b: very deeply nested object does not crash safeStringifyPreview', () => {
    let nested: Record<string, unknown> = {};
    let current = nested;
    for (let i = 0; i < 1000; i++) {
      current.child = {};
      current = current.child as Record<string, unknown>;
    }
    const result = safeStringifyPreview(nested);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('10c: BigInt array elements in formatValidationErrorEntry', () => {
    const entry = formatValidationErrorEntry('/items', 'Expected string array', [1n, 2n, 3n]);
    expect(typeof entry.actualPreview).toBe('string');
    expect(entry.actualPreview.length).toBeGreaterThan(0);
  });

  it('10d: Symbol keys in value (JSON.stringify skips them, no crash)', () => {
    const obj = { [Symbol('secret')]: 'hidden', visible: 'yes' };
    const result = safeStringifyPreview(obj);
    expect(result).toContain('visible');
    expect(result).not.toContain('secret');
  });

  it('10e: safeStringifyPreview with very long output truncates by default', () => {
    const obj = { data: 'x'.repeat(10000) };
    const result = safeStringifyPreview(obj);
    expect(result.length).toBeLessThan(600);
  });

  it('10f: formatValidationErrorEntry with very long nested object does not crash', () => {
    const deep: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      deep[`k${i}`] = { nested: true, value: 'x'.repeat(50) };
    }
    const entry = formatValidationErrorEntry('/deep', 'Expected something simpler', deep);
    expect(typeof entry.actualPreview).toBe('string');
    expect(entry.actualPreview.length).toBeGreaterThan(0);
    expect(entry.actualPreview.length).toBeLessThan(150);
  });
});

// ── Scenario 11: maxRepairAttempts bounded ──

describe('Chaos 11: maxRepairAttempts bounded', () => {
  it('11a: normalizeMaxRepairAttempts with absurd values', () => {
    expect(normalizeMaxRepairAttempts(1e10, 1)).toBe(MAX_REPAIR_ATTEMPTS);
    expect(normalizeMaxRepairAttempts(Number.MAX_VALUE, 1)).toBe(MAX_REPAIR_ATTEMPTS); // finite → clamped
    expect(normalizeMaxRepairAttempts(7.999999999, 1)).toBe(3); // floors to 7, cap at MAX_REPAIR_ATTEMPTS=3
    expect(normalizeMaxRepairAttempts(-0, 1)).toBe(-0); // -0 is not < 0, so it passes through
  });

  it('11b: absurd maxRepairAttempts in repair loop still bounded', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      return JSON.stringify({ confidence: 'still-string' });
    };

    const result = await attemptStructuredOutputRepair(
      { confidence: 'high' },
      [{ path: '/confidence', message: 'Expected number', value: 'high' }],
      { llmCaller, schemaCheck: () => false },
      { maxRepairAttempts: 9_999 },
    );

    expect(callCount).toBe(MAX_REPAIR_ATTEMPTS);
    expect(result.attemptsUsed).toBe(MAX_REPAIR_ATTEMPTS);
  });
});

// ── Scenario 12: Telemetry and evidence pack completeness ──

describe('Chaos 12: Telemetry and evidence pack completeness', () => {
  it('12a: repairAttempts rawOutputPreview bounded to 500 chars', async () => {
    const veryLongResponse = 'x'.repeat(5000);
    const llmCaller: RepairLLMCaller = async () => veryLongResponse;

    const result = await attemptStructuredOutputRepair(
      { confidence: 'high' },
      [{ path: '/confidence', message: 'Expected number', value: 'high' }],
      { llmCaller, schemaCheck: () => false },
      { maxRepairAttempts: 1 },
    );

    expect(result.repairAttempts).toHaveLength(1);
    const preview = result.repairAttempts[0]?.rawOutputPreview ?? '';
    expect(preview.length).toBeLessThanOrEqual(503);
  });

  it('12b: repairAttempts record with schemaRef when provided', async () => {
    const llmCaller: RepairLLMCaller = async () => JSON.stringify({ confidence: 'wrong' });

    const result = await attemptStructuredOutputRepair(
      { confidence: 'high' },
      [{ path: '/confidence', message: 'Expected number', value: 'high' }],
      { llmCaller, schemaCheck: () => false },
      { schemaRef: 'chaos-test-output-v1', maxRepairAttempts: 1 },
    );

    expect(result.repairAttempts).toHaveLength(1);
    expect(result.repairAttempts[0]?.schemaRef).toBe('chaos-test-output-v1');
    expect(result.repairAttempts[0]?.repairPromptVersion).toBe('2'); // v2 = PRI-621 full-schema repair prompt
  });

  it('12c: repairSummary contains structured failure information', async () => {
    const llmCaller: RepairLLMCaller = async () => null;

    const result = await attemptStructuredOutputRepair(
      { confidence: 'high' },
      [{ path: '/confidence', message: 'Expected number', value: 'high' }],
      { llmCaller, schemaCheck: () => false },
    );

    expect(result.repairSummary).toContain('1 errors');
    expect(result.repairSummary).toContain('/confidence');
    expect(result.repairSummary.length).toBeLessThan(300);
  });

  it('12d: empty schemaErrors returns early with repairSummary containing reason', async () => {
    let callerInvoked = false;
    const llmCaller: RepairLLMCaller = async () => { callerInvoked = true; return '{}'; };

    const result = await attemptStructuredOutputRepair(
      { confidence: 0.85 },
      [],
      { llmCaller, schemaCheck: () => true },
    );

    expect(result.repaired).toBe(false);
    expect(result.attemptsUsed).toBe(0);
    expect(callerInvoked).toBe(false);
    expect(result.repairSummary).toContain('no errors');
  });

  it('12e: repairAttempts includes validationErrors with expected and actualPreview', async () => {
    const llmCaller: RepairLLMCaller = async () => JSON.stringify({ confidence: 'wrong' });

    const result = await attemptStructuredOutputRepair(
      { confidence: 'high' },
      [{ path: '/confidence', message: 'Expected number', value: 'high' }],
      { llmCaller, schemaCheck: () => false },
      { maxRepairAttempts: 1 },
    );

    expect(result.repairAttempts).toHaveLength(1);
    const errors = result.repairAttempts[0]?.validationErrors ?? [];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.path).toBe('/confidence');
    expect(typeof errors[0]?.expected).toBe('string');
    expect(typeof errors[0]?.actualPreview).toBe('string');
  });
});

// ── Additional edge cases ──

describe('Chaos edge cases: non-object JSON responses', () => {
  it('extractJsonObject returns null for a bare number', () => {
    expect(extractJsonObject('42')).toBeNull();
  });

  it('extractJsonObject returns null for a bare boolean true', () => {
    expect(extractJsonObject('true')).toBeNull();
  });

  it('extractJsonObject returns null for a bare string', () => {
    expect(extractJsonObject('"just a string"')).toBeNull();
  });

  it('extractJsonObject returns null for a bare null literal', () => {
    expect(extractJsonObject('null')).toBeNull();
  });

  it('extractJsonObject returns null for empty string', () => {
    expect(extractJsonObject('')).toBeNull();
  });

  it('extractJsonObject returns null for pure whitespace', () => {
    expect(extractJsonObject('   \n  \t  ')).toBeNull();
  });

  it('extractJsonObject returns null for string with only balanced braces but invalid content', () => {
    expect(extractJsonObject('{invalid}')).toBeNull();
  });

  it('extractJsonObject returns null for deeply nested unclosed braces', () => {
    const input = '{"a":{"b":{"c":{"d":{"e":1';
    const result = extractJsonObject(input);
    expect(result).toBeNull();
  });
});

describe('Chaos edge cases: extractor boundary conditions', () => {
  it('JSON with BOM prefix is extracted correctly', () => {
    const input = '﻿{"taskId":"t1","score":0.85}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', score: 0.85 });
  });

  it('JSON with escaped quotes inside string values', () => {
    const input = '{"taskId":"t1","note":"He said \\"hello\\" to me"}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', note: 'He said "hello" to me' });
  });

  it('JSON with newlines inside string values', () => {
    const input = '{"taskId":"t1","multiline":"line1\\nline2\\nline3"}';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', multiline: 'line1\nline2\nline3' });
  });

  it('code fence with no newline after opening marker', () => {
    const input = '```json{"taskId":"t1","score":0.85}```';
    const result = extractJsonObject(input);
    expect(result).toEqual({ taskId: 't1', score: 0.85 });
  });
});