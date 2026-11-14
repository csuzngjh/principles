/**
 * Output repair contract unit tests — PRI-200.
 *
 * Tests the types and utilities for the bounded structured-output repair loop:
 *   - preserveLineageFields — protects lineage fields during repair
 *   - isLineageField — identifies lineage fields
 *   - truncatePreview — bounds preview strings
 *   - formatValidationErrorEntry — formats TypeBox errors for evidence pack
 *   - OutputEvidencePack shape validation
 */
import { describe, it, expect } from 'vitest';
import {
  preserveLineageFields,
  stripLineageFields,
  isLineageField,
  truncatePreview,
  formatValidationErrorEntry,
  explainUnionValidationFailure,
  LINEAGE_FIELDS,
  REPAIR_PROMPT_VERSION,
  MAX_REPAIR_ATTEMPTS,
  normalizeMaxRepairAttempts,
  safeStringifyPreview,
} from '../output-repair-contract.js';
import type {
  OutputEvidencePack,
  OutputFailureKind,
} from '../output-repair-contract.js';

describe('output-repair-contract', () => {
  // P1-3: TypeBox reports a failed discriminated union as "Expected union value"
  // — no field name. Repair feedback depends on naming the missing per-kind
  // field, so this formatter resolves the variant selected by `kind`.
  describe('explainUnionValidationFailure', () => {
    const schema = {
      type: 'object',
      properties: {
        recommendations: {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'object',
                properties: { kind: { const: 'rule' }, description: { type: 'string' }, triggerPattern: { type: 'string' } },
                required: ['kind', 'description', 'triggerPattern'],
              },
              {
                type: 'object',
                properties: { kind: { const: 'principle' }, description: { type: 'string' }, abstractedPrinciple: { type: 'string' } },
                required: ['kind', 'description'],
              },
            ],
          },
        },
      },
    };

    const explain = (value: unknown, message = 'Expected union value'): string =>
      explainUnionValidationFailure({ schema, rootValue: value, path: '/recommendations/0', message });

    it('passes non-union messages through unchanged', () => {
      expect(explain({ kind: 'principle' }, 'Expected string')).toBe('Expected string');
    });

    it('names the missing required field of the variant selected by kind', () => {
      const message = explain({ recommendations: [{ kind: 'rule', description: 'x' }] });
      expect(message).toBe('Expected union value: kind "rule" requires triggerPattern');
    });

    it('reports an unknown kind with the allowed kinds', () => {
      const message = explain({ recommendations: [{ kind: 'nope', description: 'x' }] });
      expect(message).toContain('kind "nope" is not one of');
      expect(message).toContain('"rule"');
      expect(message).toContain('"principle"');
    });

    it('returns the original message when the value has no kind', () => {
      expect(explain({ recommendations: [{ description: 'x' }] })).toBe('Expected union value');
    });

    it('returns the original message when the value or schema path cannot be resolved', () => {
      expect(explain({ other: [] })).toBe('Expected union value');
      expect(explain('not-an-object')).toBe('Expected union value');
    });

    it('returns the original message when no required field is missing', () => {
      expect(explain({ recommendations: [{ kind: 'principle', description: 'x', abstractedPrinciple: 'y' }] }))
        .toBe('Expected union value');
    });
  });

  describe('isLineageField', () => {
    it('returns true for known lineage fields', () => {
      expect(isLineageField('taskId')).toBe(true);
      expect(isLineageField('sourcePainId')).toBe(true);
      expect(isLineageField('sourceTaskId')).toBe(true);
      expect(isLineageField('sourceRunIds')).toBe(true);
      expect(isLineageField('sourceArtifactId')).toBe(true);
      expect(isLineageField('sourceRefs')).toBe(true);
    });

    it('returns false for non-lineage fields', () => {
      expect(isLineageField('confidence')).toBe(false);
      expect(isLineageField('summary')).toBe(false);
      expect(isLineageField('toString')).toBe(false);
      expect(isLineageField('constructor')).toBe(false);
    });
  });

  describe('preserveLineageFields', () => {
    it('preserves lineage fields from original when repaired output changes them', () => {
      const original = {
        taskId: 'task-1',
        sourcePainId: 'pain-1',
        confidence: 0.85,
        summary: 'original',
      };
      const repaired = {
        taskId: 'task-CHANGED',
        sourcePainId: 'pain-CHANGED',
        confidence: 0.9,
        summary: 'repaired',
      };

      const result = preserveLineageFields(original, repaired);

      expect(result.taskId).toBe('task-1');
      expect(result.sourcePainId).toBe('pain-1');
      expect(result.confidence).toBe(0.9);
      expect(result.summary).toBe('repaired');
    });

    it('does not add lineage fields that were absent in original', () => {
      const original: Record<string, unknown> = { confidence: 0.85 };
      const repaired: Record<string, unknown> = { confidence: 0.9 };

      const result = preserveLineageFields(original, repaired);

      expect(result.confidence).toBe(0.9);
      for (const field of LINEAGE_FIELDS) {
        expect(Object.hasOwn(result, field)).toBe(false);
      }
    });

    it('preserves all LINEAGE_FIELDS from original', () => {
      const original: Record<string, unknown> = {};
      for (const field of LINEAGE_FIELDS) {
        original[field] = `original-${field}`;
      }
      const repaired: Record<string, unknown> = {};
      for (const field of LINEAGE_FIELDS) {
        repaired[field] = `changed-${field}`;
      }

      const result = preserveLineageFields(original, repaired);

      for (const field of LINEAGE_FIELDS) {
        expect(result[field]).toBe(`original-${field}`);
      }
    });
  });

  describe('stripLineageFields', () => {
    it('strips taskId from LLM output with wrong taskId (PRI-272)', () => {
      const llmOutput: Record<string, unknown> = {
        valid: true,
        diagnosisId: 'diag-001',
        taskId: 'WRONG-task-id-from-llm',
        summary: 'Something broke',
        confidence: 0.8,
      };

      const result = stripLineageFields(llmOutput);

      expect(Object.hasOwn(result, 'taskId')).toBe(false);
      expect(result.valid).toBe(true);
      expect(result.diagnosisId).toBe('diag-001');
      expect(result.summary).toBe('Something broke');
    });

    it('preserves all non-lineage fields when taskId is absent (PRI-272)', () => {
      const llmOutput: Record<string, unknown> = {
        valid: true,
        diagnosisId: 'diag-002',
        summary: 'No taskId in output',
        confidence: 0.9,
      };

      const result = stripLineageFields(llmOutput);

      expect(Object.hasOwn(result, 'taskId')).toBe(false);
      expect(result.valid).toBe(true);
      expect(result.diagnosisId).toBe('diag-002');
      expect(result.summary).toBe('No taskId in output');
      expect(result.confidence).toBe(0.9);
    });

    it('strips taskId set to undefined (PRI-272)', () => {
      const llmOutput: Record<string, unknown> = {
        valid: true,
        diagnosisId: 'diag-003',
        taskId: undefined,
        summary: 'Undefined taskId',
        confidence: 0.7,
      };

      const result = stripLineageFields(llmOutput);

      expect(Object.hasOwn(result, 'taskId')).toBe(false);
      expect(result.valid).toBe(true);
    });

    it('strips all lineage fields, not just taskId (PRI-272)', () => {
      const llmOutput: Record<string, unknown> = {
        valid: true,
        diagnosisId: 'diag-004',
        taskId: 'wrong-task',
        sourcePainId: 'wrong-pain',
        sourceTaskId: 'wrong-source',
        sourceRunIds: ['wrong-run'],
        sourceArtifactId: 'wrong-artifact',
        sourceRefs: ['wrong-ref'],
        summary: 'All lineage wrong',
        confidence: 0.6,
      };

      const result = stripLineageFields(llmOutput);

      for (const field of LINEAGE_FIELDS) {
        expect(Object.hasOwn(result, field)).toBe(false);
      }
      expect(result.valid).toBe(true);
      expect(result.summary).toBe('All lineage wrong');
    });

    it('does not mutate the original object (PRI-272)', () => {
      const llmOutput: Record<string, unknown> = {
        taskId: 'task-1',
        summary: 'test',
      };

      const result = stripLineageFields(llmOutput);

      expect(Object.hasOwn(llmOutput, 'taskId')).toBe(true);
      expect(llmOutput.taskId).toBe('task-1');
      expect(Object.hasOwn(result, 'taskId')).toBe(false);
    });
  });

  describe('truncatePreview', () => {
    it('returns short strings unchanged', () => {
      expect(truncatePreview('hello')).toBe('hello');
    });

    it('truncates long strings with ellipsis', () => {
      const long = 'x'.repeat(600);
      const result = truncatePreview(long);
      expect(result.length).toBeLessThan(long.length);
      expect(result.endsWith('...')).toBe(true);
    });

    it('respects custom maxLen', () => {
      const result = truncatePreview('hello world', 5);
      expect(result).toBe('he...');
    });
  });

  describe('formatValidationErrorEntry', () => {
    it('formats short string values as-is', () => {
      const entry = formatValidationErrorEntry('/confidence', 'Expected number', '85%');
      expect(entry.path).toBe('/confidence');
      expect(entry.expected).toBe('Expected number');
      expect(entry.actualPreview).toBe('85%');
    });

    it('truncates long string values', () => {
      const longString = 'x'.repeat(200);
      const entry = formatValidationErrorEntry('/field', 'Expected number', longString);
      expect(entry.actualPreview.length).toBeLessThan(longString.length);
      expect(entry.actualPreview.endsWith('...')).toBe(true);
    });

    it('formats non-string values as JSON', () => {
      const entry = formatValidationErrorEntry('/items', 'Expected array', 42);
      expect(entry.actualPreview).toBe('42');
    });

    it('truncates long JSON values', () => {
      const longObj = { data: 'x'.repeat(200) };
      const entry = formatValidationErrorEntry('/field', 'Expected string', longObj);
      expect(entry.actualPreview.length).toBeLessThan(200);
    });
  });

  describe('OutputEvidencePack shape', () => {
    it('can construct a valid evidence pack', () => {
      const pack: OutputEvidencePack = {
        schemaRef: 'diagnostician-output',
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        promptContractVersion: '1',
        rawOutputPreview: '{"valid":true,...}',
        validationErrors: [
          { path: '/confidence', expected: 'Expected number', actualPreview: '"85%"' },
        ],
        repairAttempts: [
          {
            schemaRef: 'diagnostician-output',
            attempt: 1,
            rawOutputPreview: '{"valid":true,...}',
            validationErrors: [
              { path: '/confidence', expected: 'Expected number', actualPreview: '"85%"' },
            ],
            repairPromptVersion: REPAIR_PROMPT_VERSION,
            repaired: false,
          },
        ],
        finalFailureReason: 'repair_exhausted',
      };

      expect(pack.schemaRef).toBe('diagnostician-output');
      expect(pack.provider).toBe('openrouter');
      expect(pack.model).toBe('anthropic/claude-sonnet-4');
      expect(pack.finalFailureReason).toBe('repair_exhausted');
      expect(pack.repairAttempts).toHaveLength(1);
      expect(pack.repairAttempts[0]?.repaired).toBe(false);
    });

    it('all OutputFailureKind values are valid', () => {
      // D-01: `repair_skipped` is a distinct kind — "repair never ran" must not
      // be reported as `repair_exhausted` ("ran and failed").
      const kinds: OutputFailureKind[] = ['extraction_failed', 'schema_invalid', 'repair_exhausted', 'repair_skipped'];
      expect(kinds).toHaveLength(4);
    });
  });

  describe('normalizeMaxRepairAttempts', () => {
    it('returns default for undefined', () => {
      expect(normalizeMaxRepairAttempts(undefined, 1)).toBe(1);
    });

    it('returns default for Infinity', () => {
      expect(normalizeMaxRepairAttempts(Infinity, 1)).toBe(1);
    });

    it('returns default for -Infinity', () => {
      expect(normalizeMaxRepairAttempts(-Infinity, 1)).toBe(1);
    });

    it('returns default for NaN', () => {
      expect(normalizeMaxRepairAttempts(NaN, 1)).toBe(1);
    });

    it('returns 0 for negative', () => {
      expect(normalizeMaxRepairAttempts(-1, 1)).toBe(0);
    });

    it('floors decimal values', () => {
      expect(normalizeMaxRepairAttempts(1.9, 1)).toBe(1);
    });

    it('clamps to MAX_REPAIR_ATTEMPTS', () => {
      expect(normalizeMaxRepairAttempts(999, 1)).toBe(MAX_REPAIR_ATTEMPTS);
    });

    it('passes through valid values within range', () => {
      expect(normalizeMaxRepairAttempts(0, 1)).toBe(0);
      expect(normalizeMaxRepairAttempts(1, 1)).toBe(1);
      expect(normalizeMaxRepairAttempts(2, 1)).toBe(2);
    });
  });

  describe('safeStringifyPreview', () => {
    it('serializes plain objects', () => {
      expect(safeStringifyPreview({ a: 1 })).toBe('{"a":1}');
    });

    it('serializes arrays', () => {
      expect(safeStringifyPreview([1, 2])).toBe('[1,2]');
    });

    it('handles undefined', () => {
      expect(safeStringifyPreview(undefined)).toBe('undefined');
    });

    it('handles null', () => {
      expect(safeStringifyPreview(null)).toBe('null');
    });

    it('handles BigInt without throwing', () => {
      const result = safeStringifyPreview(1n);
      expect(result).toBe('1n');
    });

    it('handles circular objects without throwing', () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      const result = safeStringifyPreview(obj);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles Object.create(null) without throwing', () => {
      const obj = Object.create(null) as Record<string, unknown>;
      obj.key = 'value';
      const result = safeStringifyPreview(obj);
      expect(result).toContain('key');
    });

    it('truncates long output', () => {
      const obj = { data: 'x'.repeat(1000) };
      const result = safeStringifyPreview(obj, 50);
      expect(result.length).toBeLessThanOrEqual(53);
    });
  });

  describe('formatValidationErrorEntry with safe serialization', () => {
    it('handles BigInt values without throwing', () => {
      const entry = formatValidationErrorEntry('/x', 'Expected string', 1n);
      expect(entry.actualPreview).toBe('1n');
    });

    it('handles circular objects without throwing', () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      const entry = formatValidationErrorEntry('/x', 'Expected string', obj);
      expect(typeof entry.actualPreview).toBe('string');
      expect(entry.actualPreview.length).toBeGreaterThan(0);
    });

    it('handles Object.create(null) without throwing', () => {
      const obj = Object.create(null) as Record<string, unknown>;
      obj.key = 'value';
      const entry = formatValidationErrorEntry('/x', 'Expected string', obj);
      expect(typeof entry.actualPreview).toBe('string');
    });
  });
});
