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
  isLineageField,
  truncatePreview,
  formatValidationErrorEntry,
  LINEAGE_FIELDS,
  REPAIR_PROMPT_VERSION,
} from '../output-repair-contract.js';
import type {
  OutputEvidencePack,
  OutputFailureKind,
} from '../output-repair-contract.js';

describe('output-repair-contract', () => {
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
        schemaRef: 'diagnostician-output-v1',
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        promptContractVersion: '1',
        rawOutputPreview: '{"valid":true,...}',
        validationErrors: [
          { path: '/confidence', expected: 'Expected number', actualPreview: '"85%"' },
        ],
        repairAttempts: [
          {
            schemaRef: 'diagnostician-output-v1',
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

      expect(pack.schemaRef).toBe('diagnostician-output-v1');
      expect(pack.provider).toBe('openrouter');
      expect(pack.model).toBe('anthropic/claude-sonnet-4');
      expect(pack.finalFailureReason).toBe('repair_exhausted');
      expect(pack.repairAttempts).toHaveLength(1);
      expect(pack.repairAttempts[0]?.repaired).toBe(false);
    });

    it('all OutputFailureKind values are valid', () => {
      const kinds: OutputFailureKind[] = ['extraction_failed', 'schema_invalid', 'repair_exhausted'];
      expect(kinds).toHaveLength(3);
    });
  });
});
