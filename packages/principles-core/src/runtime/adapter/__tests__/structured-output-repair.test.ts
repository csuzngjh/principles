/**
 * Structured output repair module unit tests.
 *
 * Tests the reusable, runtime-agnostic schema repair loop:
 *   formatRepairPrompt — generates bounded repair prompts from schema errors
 *   attemptStructuredOutputRepair — bounded repair loop with LLM callback
 *
 * No pi-ai imports — the repair module is fully decoupled via callbacks.
 */
import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { TSchema } from '@sinclair/typebox';
import {
  formatRepairPrompt,
  attemptStructuredOutputRepair,
  DEFAULT_REPAIR_CONFIG,
  deriveSchemaSummary,
  describeObjectPropertyFields,
  describeArrayElementType,
} from '../structured-output-repair.js';
import type {
  SchemaValidationError,
  RepairConfig,
  RepairLLMCaller,
} from '../structured-output-repair.js';

// ── Fixtures ──

const SAMPLE_ERRORS: readonly SchemaValidationError[] = [
  { path: '/confidence', message: 'Expected number, got string', value: '85%' },
  { path: '/recommendations/0/kind', message: 'Expected "principle" | "rule" | "implementation" | "prompt" | "defer", got "Rule"', value: 'Rule' },
];

const SAMPLE_INVALID_JSON = {
  valid: true,
  diagnosisId: 'diag-1',
  taskId: 'task-1',
  summary: 'Test',
  rootCause: 'Test cause',
  violatedPrinciples: [],
  evidence: [],
  recommendations: [{ kind: 'Rule', description: 'Fix casing', confidence: '85%' }],
  confidence: '85%',
};

const VALID_REPAIRED_JSON = {
  valid: true,
  diagnosisId: 'diag-1',
  taskId: 'task-1',
  summary: 'Test',
  rootCause: 'Test cause',
  violatedPrinciples: [],
  evidence: [],
  recommendations: [{ kind: 'rule', description: 'Fix casing' }],
  confidence: 0.85,
};

// ── formatRepairPrompt ──

describe('formatRepairPrompt', () => {
  it('includes raw JSON and error list in the prompt', () => {
    const prompt = formatRepairPrompt(SAMPLE_INVALID_JSON, SAMPLE_ERRORS);

    expect(prompt).toContain('"confidence":"85%"');
    expect(prompt).toContain('/confidence');
    expect(prompt).toContain('Expected number, got string');
    expect(prompt).toContain('/recommendations/0/kind');
    expect(prompt).toMatch(/corrected.*JSON/i);
  });

  it('PRI-707: truncationNotice block appears when provided and stays absent otherwise', () => {
    const withNotice = formatRepairPrompt(SAMPLE_INVALID_JSON, SAMPLE_ERRORS, {
      truncationNotice: 'The previous output was cut off by the token limit (finish_reason=length).',
    });
    expect(withNotice).toContain('TRUNCATION NOTICE');
    expect(withNotice).toContain('finish_reason=length');

    const withoutNotice = formatRepairPrompt(SAMPLE_INVALID_JSON, SAMPLE_ERRORS);
    expect(withoutNotice).not.toContain('TRUNCATION NOTICE');
  });

  it('truncates raw JSON when exceeding maxRawOutputChars', () => {
    const largeJson = { data: 'x'.repeat(5000) };
    const config: RepairConfig = { maxRawOutputChars: 200 };
    const prompt = formatRepairPrompt(largeJson, SAMPLE_ERRORS, config);

    const jsonSection = (/PREVIOUS OUTPUT[\s\S]*?SCHEMA ERRORS/.exec(prompt))?.[0] ?? '';
    expect(jsonSection.length).toBeLessThan(5000);
  });

  it('limits error count to maxErrorsInPrompt', () => {
    const manyErrors: SchemaValidationError[] = Array.from({ length: 20 }, (_, i) => ({
      path: `/field/${i}`,
      message: `Error ${i}`,
      value: null,
    }));
    const config: RepairConfig = { maxErrorsInPrompt: 5 };
    const prompt = formatRepairPrompt({}, manyErrors, config);

    // Should include only first 5 errors
    for (let i = 0; i < 5; i++) {
      expect(prompt).toContain(`/field/${i}`);
    }
    expect(prompt).not.toContain('/field/5');
  });

  it('truncates individual error messages to maxErrorChars', () => {
    const longErrors: SchemaValidationError[] = [{
      path: '/test',
      message: 'x'.repeat(500),
      value: null,
    }];
    const config: RepairConfig = { maxErrorChars: 100 };
    const prompt = formatRepairPrompt({}, longErrors, config);

    // Error message should be truncated — the original 500-char string should not appear in full
    const errorLine = prompt.split('\n').find(l => l.includes('/test')) ?? '';
    expect(errorLine.length).toBeLessThan(500);
  });

  // ── PRI-621 RC2: complete schema in the repair prompt ──

  it('PRI-621: includes the complete serialized schema (nested enums, minItems) when schemaJson is provided', () => {
    const schemaJson = JSON.stringify({
      type: 'object',
      required: ['taskId', 'goldenTraceCases'],
      properties: {
        taskId: { type: 'string' },
        goldenTraceCases: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['positive', 'negative'] },
              expectedDecision: { type: 'string', enum: ['allow', 'block', 'propose_correction'] },
            },
          },
        },
      },
    });
    const prompt = formatRepairPrompt(SAMPLE_INVALID_JSON, SAMPLE_ERRORS, { schemaJson });

    // The repair LLM must see the nested constraints it previously had to guess.
    expect(prompt).toContain('complete JSON Schema');
    expect(prompt).toContain('"minItems":2');
    expect(prompt).toContain('positive');
    expect(prompt).toContain('propose_correction');
    // The top-level-only summary block must NOT also appear (schemaJson wins).
    expect(prompt).not.toContain('EXPECTED SCHEMA:\n  ');
  });

  it('PRI-621: falls back to schemaSummary when schemaJson is absent', () => {
    const prompt = formatRepairPrompt(SAMPLE_INVALID_JSON, SAMPLE_ERRORS, { schemaSummary: '  taskId: string (required)' });

    expect(prompt).toContain('EXPECTED SCHEMA:');
    expect(prompt).toContain('taskId: string (required)');
    expect(prompt).not.toContain('complete JSON Schema');
  });

  it('PRI-621: truncates oversized schemaJson at maxSchemaJsonChars', () => {
    const schemaJson = JSON.stringify({ type: 'object', properties: { big: { type: 'string', description: 'x'.repeat(20_000) } } });
    const prompt = formatRepairPrompt({}, SAMPLE_ERRORS, { schemaJson, maxSchemaJsonChars: 500 });

    expect(prompt).toContain('...[truncated]');
    expect(prompt.length).toBeLessThan(2_000);
  });
});

// ── attemptStructuredOutputRepair ──

describe('attemptStructuredOutputRepair', () => {
  it('returns repaired=true when LLM returns valid fixed JSON', async () => {
    const llmCaller: RepairLLMCaller = async () => JSON.stringify(VALID_REPAIRED_JSON);
    const schemaCheck = (v: unknown): boolean => {
      // Minimal check: confidence must be number, recommendations[0].kind must be lowercase
      const obj = v as Record<string, unknown>;
      return typeof obj.confidence === 'number'
        && typeof obj.recommendations === 'object';
    };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck },
    );

    expect(result.repaired).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.attemptsUsed).toBe(1);
    expect((result.output as Record<string, unknown>).confidence).toBe(0.85);
  });

  it('returns repaired=false when LLM returns still-invalid JSON', async () => {
    const llmCaller: RepairLLMCaller = async () => JSON.stringify(SAMPLE_INVALID_JSON);
    const schemaCheck = (_v: unknown): boolean => false; // always invalid

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck },
      { maxRepairAttempts: 1, _testJitterMs: 0 },
    );

    expect(result.repaired).toBe(false);
    expect(result.output).toBeNull();
    expect(result.attemptsUsed).toBe(1);
  });

  it('returns repaired=false when LLM returns null (no JSON)', async () => {
    const llmCaller: RepairLLMCaller = async () => null;

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => true },
      { maxRepairAttempts: 1, _testJitterMs: 0 },
    );

    expect(result.repaired).toBe(false);
    expect(result.output).toBeNull();
    expect(result.attemptsUsed).toBe(1);
  });

  it('PRI-1189: an unsent request is not counted as an attempt', async () => {
    const llmCaller: RepairLLMCaller = async () => ({ sent: false, text: null });

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => true },
      { maxRepairAttempts: 2, _testJitterMs: 0 },
    );

    expect(result.repaired).toBe(false);
    expect(result.attemptsUsed).toBe(0);
    expect(result.repairAttempts).toHaveLength(0);
    expect(result.stoppedBeforeSend).toBe(true);
    expect(result.repairSummary).toContain('was not sent');
  });

  it('PRI-1189: attemptsUsed counts only requests that were actually sent', async () => {
    let calls = 0;
    const llmCaller: RepairLLMCaller = async () => {
      calls += 1;
      return calls === 1 ? { sent: true, text: '{}' } : { sent: false, text: null };
    };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => false },
      { maxRepairAttempts: 3, _testJitterMs: 0 },
    );

    expect(result.repaired).toBe(false);
    expect(result.attemptsUsed).toBe(1);
    expect(result.repairAttempts).toHaveLength(1);
    expect(result.stoppedBeforeSend).toBe(true);
  });

  it('returns repaired=false when llmCaller throws', async () => {
    const llmCaller: RepairLLMCaller = async () => { throw new Error('LLM unavailable'); };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => true },
    );

    expect(result.repaired).toBe(false);
    expect(result.output).toBeNull();
  });

  it('skips repair when maxRepairAttempts=0', async () => {
    let callerInvoked = false;
    const llmCaller: RepairLLMCaller = async () => { callerInvoked = true; return '{}'; };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => true },
      { maxRepairAttempts: 0 },
    );

    expect(result.repaired).toBe(false);
    expect(result.attemptsUsed).toBe(0);
    expect(callerInvoked).toBe(false);
  });

  it('uses default maxRepairAttempts=3 (three attempts)', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => { callCount++; return JSON.stringify(SAMPLE_INVALID_JSON); };

    await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => false },
      { _testJitterMs: 0 },
    );

    expect(callCount).toBe(3);
  });

  it('repairSummary contains bounded error information', async () => {
    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller: async () => null, schemaCheck: () => false },
    );

    expect(result.repairSummary).toContain('2 errors');
    expect(result.repairSummary).toContain('/confidence');
  });

  it('schemaCheck is called on repaired output before returning success', async () => {
    let schemaCheckCalled = false;
    const llmCaller: RepairLLMCaller = async () => JSON.stringify(VALID_REPAIRED_JSON);
    const schemaCheck = (v: unknown): boolean => {
      schemaCheckCalled = true;
      const obj = v as Record<string, unknown>;
      return typeof obj.confidence === 'number';
    };

    await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck },
    );

    expect(schemaCheckCalled).toBe(true);
  });

  it('does not call llmCaller when schemaErrors is empty', async () => {
    let callerInvoked = false;
    const llmCaller: RepairLLMCaller = async () => { callerInvoked = true; return '{}'; };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      [],
      { llmCaller, schemaCheck: () => true },
    );

    expect(result.repaired).toBe(false);
    expect(result.attemptsUsed).toBe(0);
    expect(callerInvoked).toBe(false);
  });

  it('respects maxRepairAttempts > 1 for multiple attempts', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      // Fail first, succeed second
      if (callCount < 2) return JSON.stringify(SAMPLE_INVALID_JSON);
      return JSON.stringify(VALID_REPAIRED_JSON);
    };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: (v) => {
        const obj = v as Record<string, unknown>;
        return typeof obj.confidence === 'number';
      } },
      { maxRepairAttempts: 2 },
    );

    expect(result.repaired).toBe(true);
    expect(result.attemptsUsed).toBe(2);
    expect(result.output).toBeDefined();
  });

  it('returns repairAttempts[] with attempt details (PRI-200)', async () => {
    const llmCaller: RepairLLMCaller = async () => JSON.stringify(VALID_REPAIRED_JSON);
    const schemaCheck = (v: unknown): boolean => {
      const obj = v as Record<string, unknown>;
      return typeof obj.confidence === 'number';
    };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck },
      { schemaRef: 'diagnostician-output' },
    );

    expect(result.repairAttempts).toHaveLength(1);
    expect(result.repairAttempts[0]?.schemaRef).toBe('diagnostician-output');
    expect(result.repairAttempts[0]?.attempt).toBe(1);
    expect(result.repairAttempts[0]?.repaired).toBe(true);
    expect(result.repairAttempts[0]?.repairPromptVersion).toBe('2'); // v2 = PRI-621 full-schema repair prompt
  });

  it('repairAttempts records failed attempts (PRI-200)', async () => {
    const llmCaller: RepairLLMCaller = async () => JSON.stringify(SAMPLE_INVALID_JSON);
    const schemaCheck = (_v: unknown): boolean => false;

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck },
      { schemaRef: 'diagnostician-output', maxRepairAttempts: 1, _testJitterMs: 0 },
    );

    expect(result.repairAttempts).toHaveLength(1);
    expect(result.repairAttempts[0]?.repaired).toBe(false);
  });

  it('repairAttempts defaults schemaRef to "unknown" when not provided (PRI-200)', async () => {
    const llmCaller: RepairLLMCaller = async () => null;

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => false },
      { maxRepairAttempts: 1, _testJitterMs: 0 },
    );

    expect(result.repairAttempts).toHaveLength(1);
    expect(result.repairAttempts[0]?.schemaRef).toBe('unknown');
  });

  it('preserves lineage fields when originalOutput is provided (PRI-200)', async () => {
    const originalWithLineage = {
      ...SAMPLE_INVALID_JSON,
      taskId: 'task-original',
      sourcePainId: 'pain-original',
    };
    const repairedWithChangedLineage = {
      ...VALID_REPAIRED_JSON,
      taskId: 'task-CHANGED',
      sourcePainId: 'pain-CHANGED',
    };

    const llmCaller: RepairLLMCaller = async () => JSON.stringify(repairedWithChangedLineage);
    const schemaCheck = (v: unknown): boolean => {
      const obj = v as Record<string, unknown>;
      return typeof obj.confidence === 'number';
    };

    const result = await attemptStructuredOutputRepair(
      originalWithLineage,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck },
      {
        schemaRef: 'diagnostician-output',
        originalOutput: originalWithLineage,
      },
    );

    expect(result.repaired).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.taskId).toBe('task-original');
    expect(output.sourcePainId).toBe('pain-original');
    expect(output.confidence).toBe(0.85);
  });

  it('formatRepairPrompt includes schemaRef when provided (PRI-200)', () => {
    const prompt = formatRepairPrompt(SAMPLE_INVALID_JSON, SAMPLE_ERRORS, {
      schemaRef: 'diagnostician-output',
    });

    expect(prompt).toContain('SCHEMA REF: diagnostician-output');
  });

  it('refreshes schema errors across repair attempts (PRI-200)', async () => {
    const callPrompts: string[] = [];
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async (prompt: string) => {
      callPrompts.push(prompt);
      callCount++;
      if (callCount < 2) return JSON.stringify(SAMPLE_INVALID_JSON);
      return JSON.stringify(VALID_REPAIRED_JSON);
    };

    const firstErrors = [{ path: '/confidence', message: 'Expected number got string', value: '85%' }];
    const secondErrors = [{ path: '/confidence', message: 'Expected number got string v2', value: '90%' }];

    await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      firstErrors,
      {
        llmCaller,
        schemaCheck: (v) => {
          const obj = v as Record<string, unknown>;
          return typeof obj.confidence === 'number';
        },
        schemaErrors: (_v: unknown) => secondErrors,
      },
      { maxRepairAttempts: 2 },
    );

    expect(callPrompts.length).toBe(2);
    expect(callPrompts[0]).toContain('Expected number got string');
    expect(callPrompts[1]).toContain('Expected number got string v2');
  });

  it('repairAttempts records per-attempt errors: attempt N records attempt N errors, not attempt N+1', async () => {
    const llmCaller: RepairLLMCaller = async () => {
      return JSON.stringify(SAMPLE_INVALID_JSON);
    };

    const firstErrors = [{ path: '/confidence', message: 'Expected number', value: '85%' }];
    const secondErrors = [{ path: '/summary', message: 'Expected string', value: 42 }];

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      firstErrors,
      {
        llmCaller,
        schemaCheck: () => false,
        schemaErrors: () => secondErrors,
      },
      { maxRepairAttempts: 2 },
    );

    expect(result.repaired).toBe(false);
    expect(result.repairAttempts).toHaveLength(2);
    const [attempt0, attempt1] = result.repairAttempts;
    expect(attempt0).toBeDefined();
    expect(attempt1).toBeDefined();
    const attempt0Paths = attempt0?.validationErrors.map(e => e.path) ?? [];
    const attempt1Paths = attempt1?.validationErrors.map(e => e.path) ?? [];
    expect(attempt0Paths).toContain('/confidence');
    expect(attempt0Paths).not.toContain('/summary');
    expect(attempt1Paths).toContain('/summary');
    expect(attempt1Paths).not.toContain('/confidence');
  });

  it('repairAttempts records per-attempt errors when attempt 2 succeeds', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      if (callCount < 2) return JSON.stringify(SAMPLE_INVALID_JSON);
      return JSON.stringify(VALID_REPAIRED_JSON);
    };

    const firstErrors = [{ path: '/confidence', message: 'Expected number', value: '85%' }];
    const secondErrors = [{ path: '/summary', message: 'Expected string', value: 42 }];

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      firstErrors,
      {
        llmCaller,
        schemaCheck: (v) => {
          const obj = v as Record<string, unknown>;
          return typeof obj.confidence === 'number';
        },
        schemaErrors: () => secondErrors,
      },
      { maxRepairAttempts: 2 },
    );

    expect(result.repaired).toBe(true);
    expect(result.repairAttempts).toHaveLength(2);
    const [attempt0, attempt1] = result.repairAttempts;
    expect(attempt0).toBeDefined();
    expect(attempt1).toBeDefined();
    const attempt0Paths = attempt0?.validationErrors.map(e => e.path) ?? [];
    const attempt1Paths = attempt1?.validationErrors.map(e => e.path) ?? [];
    expect(attempt0Paths).toContain('/confidence');
    expect(attempt0Paths).not.toContain('/summary');
    expect(attempt1Paths).toContain('/summary');
    expect(attempt1Paths).not.toContain('/confidence');
  });

  it('repairAttempts records per-attempt errors when attempt 2 llmCaller throws', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      if (callCount === 1) return JSON.stringify(SAMPLE_INVALID_JSON);
      throw new Error('LLM down');
    };

    const firstErrors = [{ path: '/confidence', message: 'Expected number', value: '85%' }];
    const secondErrors = [{ path: '/summary', message: 'Expected string', value: 42 }];

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      firstErrors,
      {
        llmCaller,
        schemaCheck: () => false,
        schemaErrors: () => secondErrors,
      },
      { maxRepairAttempts: 2 },
    );

    expect(result.repaired).toBe(false);
    expect(result.repairAttempts).toHaveLength(2);
    const [attempt0, attempt1] = result.repairAttempts;
    expect(attempt0).toBeDefined();
    expect(attempt1).toBeDefined();
    const attempt0Paths = attempt0?.validationErrors.map(e => e.path) ?? [];
    const attempt1Paths = attempt1?.validationErrors.map(e => e.path) ?? [];
    expect(attempt0Paths).toContain('/confidence');
    expect(attempt1Paths).toContain('/summary');
    expect(attempt0Paths).not.toContain('/summary');
    expect(attempt1Paths).not.toContain('/confidence');
  });

  it('repairAttempts records per-attempt errors when attempt 2 returns null', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      if (callCount === 1) return JSON.stringify(SAMPLE_INVALID_JSON);
      return null;
    };

    const firstErrors = [{ path: '/confidence', message: 'Expected number', value: '85%' }];
    const secondErrors = [{ path: '/summary', message: 'Expected string', value: 42 }];

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      firstErrors,
      {
        llmCaller,
        schemaCheck: () => false,
        schemaErrors: () => secondErrors,
      },
      { maxRepairAttempts: 2 },
    );

    expect(result.repaired).toBe(false);
    expect(result.repairAttempts).toHaveLength(2);
    const [attempt0, attempt1] = result.repairAttempts;
    expect(attempt0).toBeDefined();
    expect(attempt1).toBeDefined();
    const attempt0Paths = attempt0?.validationErrors.map(e => e.path) ?? [];
    const attempt1Paths = attempt1?.validationErrors.map(e => e.path) ?? [];
    expect(attempt0Paths).toContain('/confidence');
    expect(attempt1Paths).toContain('/summary');
    expect(attempt0Paths).not.toContain('/summary');
    expect(attempt1Paths).not.toContain('/confidence');
  });

  it('repairAttempts records per-attempt errors when attempt 2 returns no JSON', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      if (callCount === 1) return JSON.stringify(SAMPLE_INVALID_JSON);
      return 'not json at all';
    };

    const firstErrors = [{ path: '/confidence', message: 'Expected number', value: '85%' }];
    const secondErrors = [{ path: '/summary', message: 'Expected string', value: 42 }];

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      firstErrors,
      {
        llmCaller,
        schemaCheck: () => false,
        schemaErrors: () => secondErrors,
      },
      { maxRepairAttempts: 2 },
    );

    expect(result.repaired).toBe(false);
    expect(result.repairAttempts).toHaveLength(2);
    const [attempt0, attempt1] = result.repairAttempts;
    expect(attempt0).toBeDefined();
    expect(attempt1).toBeDefined();
    const attempt0Paths = attempt0?.validationErrors.map(e => e.path) ?? [];
    const attempt1Paths = attempt1?.validationErrors.map(e => e.path) ?? [];
    expect(attempt0Paths).toContain('/confidence');
    expect(attempt1Paths).toContain('/summary');
    expect(attempt0Paths).not.toContain('/summary');
    expect(attempt1Paths).not.toContain('/confidence');
  });

  it('repair prompt uses current errors per attempt: attempt 1 /confidence, attempt 2 /summary', async () => {
    const prompts: string[] = [];
    const llmCaller: RepairLLMCaller = async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify(SAMPLE_INVALID_JSON);
    };

    const firstErrors = [{ path: '/confidence', message: 'Expected number', value: '85%' }];
    const secondErrors = [{ path: '/summary', message: 'Expected string', value: 42 }];

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      firstErrors,
      {
        llmCaller,
        schemaCheck: () => false,
        schemaErrors: () => secondErrors,
      },
      { maxRepairAttempts: 2 },
    );

    expect(result.repaired).toBe(false);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('/confidence');
    expect(prompts[0]).not.toContain('/summary');
    expect(prompts[1]).toContain('/summary');
    expect(prompts[1]).not.toContain('/confidence');
  });
});

// ── DEFAULT_REPAIR_CONFIG ──

describe('DEFAULT_REPAIR_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_REPAIR_CONFIG.maxRepairAttempts).toBe(3);
    expect(DEFAULT_REPAIR_CONFIG.maxErrorsInPrompt).toBe(10);
    expect(DEFAULT_REPAIR_CONFIG.maxErrorChars).toBe(200);
    expect(DEFAULT_REPAIR_CONFIG.maxRawOutputChars).toBe(2000);
  });
});

// ── PRI-200 Finding 1: Bounded repair attempts ──

describe('PRI-200 Finding 1: maxRepairAttempts hard cap', () => {
  it('maxRepairAttempts: 999 only calls llmCaller 3 times (clamped to MAX_REPAIR_ATTEMPTS)', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      return JSON.stringify(SAMPLE_INVALID_JSON);
    };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => false },
      { maxRepairAttempts: 999, _testJitterMs: 0 },
    );

    expect(result.repaired).toBe(false);
    expect(callCount).toBe(3);
    expect(result.attemptsUsed).toBe(3);
  });

  it('maxRepairAttempts: Infinity falls back to default (3)', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      return JSON.stringify(SAMPLE_INVALID_JSON);
    };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => false },
      { maxRepairAttempts: Infinity, _testJitterMs: 0 },
    );

    expect(result.repaired).toBe(false);
    expect(callCount).toBe(3);
    expect(result.attemptsUsed).toBe(3);
  });

  it('maxRepairAttempts: NaN falls back to default (3)', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      return JSON.stringify(SAMPLE_INVALID_JSON);
    };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => false },
      { maxRepairAttempts: NaN, _testJitterMs: 0 },
    );

    expect(result.repaired).toBe(false);
    expect(callCount).toBe(3);
    expect(result.attemptsUsed).toBe(3);
  });

  it('maxRepairAttempts: -1 skips repair entirely', async () => {
    let callCount = 0;
    const llmCaller: RepairLLMCaller = async () => {
      callCount++;
      return JSON.stringify(SAMPLE_INVALID_JSON);
    };

    const result = await attemptStructuredOutputRepair(
      SAMPLE_INVALID_JSON,
      SAMPLE_ERRORS,
      { llmCaller, schemaCheck: () => false },
      { maxRepairAttempts: -1 },
    );

    expect(result.repaired).toBe(false);
    expect(callCount).toBe(0);
    expect(result.attemptsUsed).toBe(0);
    expect(result.repairSummary).toContain('maxRepairAttempts=0');
  });
});

// ── PRI-200 Finding 2: Safe preview serialization ──

describe('PRI-200 Finding 2: safe preview serialization in repair loop', () => {
  it('circular invalidOutput does not throw from preview formatting', async () => {
    const circular: Record<string, unknown> = { confidence: '85%' };
    circular.self = circular;

    const llmCaller: RepairLLMCaller = async () => JSON.stringify(VALID_REPAIRED_JSON);

    const result = await attemptStructuredOutputRepair(
      circular,
      [{ path: '/confidence', message: 'Expected number', value: '85%' }],
      { llmCaller, schemaCheck: () => true },
    );

    expect(result.repaired).toBe(true);
  });

  it('circular invalidOutput + llmCaller throws does not throw from preview', async () => {
    const circular: Record<string, unknown> = { confidence: '85%' };
    circular.self = circular;

    const llmCaller: RepairLLMCaller = async () => { throw new Error('LLM down'); };

    const result = await attemptStructuredOutputRepair(
      circular,
      [{ path: '/confidence', message: 'Expected number', value: '85%' }],
      { llmCaller, schemaCheck: () => false },
      { _testJitterMs: 0 },
    );

    expect(result.repaired).toBe(false);
    expect(result.repairAttempts).toHaveLength(1);
    expect(typeof result.repairAttempts[0]?.rawOutputPreview).toBe('string');
  });

  it('BigInt value in invalidOutput does not throw from preview', async () => {
    const withBigInt = { confidence: '85%', count: 1n };

    const llmCaller: RepairLLMCaller = async () => JSON.stringify(VALID_REPAIRED_JSON);

    const result = await attemptStructuredOutputRepair(
      withBigInt,
      [{ path: '/confidence', message: 'Expected number', value: '85%' }],
      { llmCaller, schemaCheck: () => true },
    );

    expect(result.repaired).toBe(true);
  });
});

// ── D-01 schema descriptor contract (supported boundary) ──
//
// These tests pin what the descriptor SUPPORTS and what it deliberately leaves
// unexpanded. The point is not to grow the descriptor: an unexpanded shape must
// still be actionable through field-level repair feedback, and any place where
// the descriptor stops must say so instead of implying a shape it never printed.

describe('D-01 schema descriptor: supported boundary', () => {
  it('1. expands multi-level nested required objects down to the depth bound', () => {
    const schema = Type.Object({
      level1: Type.Object({
        level2: Type.Object({
          shallow: Type.String({ minLength: 1 }),
          deeper: Type.Object({ hidden: Type.Number() }),
        }),
      }),
    });

    const summary = deriveSchemaSummary(schema);

    expect(summary).toContain('level1: object (required)');
    expect(summary).toContain('.level2: object (required)');
    expect(summary).toContain('.shallow: string {minLength: 1} (required)');
    // Boundary: the third nested level is intentionally not described.
    expect(summary).toContain('.deeper: object (required)');
    expect(summary).not.toContain('hidden');
  });

  it('2. renders mixed-type unions as unions and all-literal unions as enums', () => {
    // All-literal → exact allowed values.
    expect(describeArrayElementType(Type.Union([Type.Literal('a'), Type.Literal('b')]))).toBe('enum(a | b)');
    // Mixed types → a type union, not an enum of the literal members.
    expect(describeArrayElementType(Type.Union([Type.String(), Type.Number()]))).toBe('(string | number)');
    // Mixed literal + non-literal must NOT collapse to `enum(a)`; that would
    // advertise a constraint the validator does not enforce.
    expect(describeArrayElementType(Type.Union([Type.Literal('a'), Type.Number()]))).toBe('(string | number)');
    // Non-union, non-array items fall back to the declared type.
    expect(describeArrayElementType(Type.Boolean())).toBe('boolean');
    expect(describeArrayElementType(undefined)).toBe('unknown');

    const summary = deriveSchemaSummary(Type.Object({
      mixedList: Type.Array(Type.Union([Type.String(), Type.Number()])),
      literalList: Type.Array(Type.Union([Type.Literal('x'), Type.Literal('y')])),
    }));
    expect(summary).toContain('mixedList: (string | number)[] (required)');
    expect(summary).toContain('literalList: enum(x | y)[] (required)');
  });

  it('3. marks an object array without required fields as not expanded', () => {
    const schema = Type.Object({
      optionalItems: Type.Array(Type.Object({ maybe: Type.Optional(Type.String()) })),
    });

    const summary = deriveSchemaSummary(schema);

    expect(summary).toContain('optionalItems: object[] (required)');
    // Unexpanded is stated, not implied.
    expect(summary).toContain('each item shape is not expanded here; field paths appear in validation errors');
    expect(summary).not.toContain('maybe');
  });

  it('4. expands an optional nested object shape, but not optional sub-fields inside an expanded object', () => {
    // Renderer level: an optional object property still advertises its shape,
    // because the validator enforces that shape whenever the property exists.
    const summary = deriveSchemaSummary(Type.Object({
      requiredNode: Type.Object({ kept: Type.String() }),
      optionalNode: Type.Optional(Type.Object({ inner: Type.String() })),
    }));
    expect(summary).toContain('optionalNode: object (optional)');
    expect(summary).toContain('inner: string (required)');

    // Sub-field level: describeObjectPropertyFields walks REQUIRED keys only,
    // so an optional sub-object inside an expanded object is not expanded.
    const nested = describeObjectPropertyFields(Type.Object({
      maybeNested: Type.Optional(Type.Object({ neverShown: Type.String() })),
      shown: Type.String(),
    }));
    expect(nested.join('\n')).toContain('.shown: string (required)');
    expect(nested.join('\n')).not.toContain('neverShown');

    // No required fields at all → nothing to expand, callers get an empty list
    // and the renderer prints the explicit "not expanded" note (case 3).
    expect(describeObjectPropertyFields(Type.Object({
      onlyOptional: Type.Optional(Type.String()),
    }))).toEqual([]);
  });

  it('5. stops at the depth bound and still repairs through field-level feedback', async () => {
    const deep = Type.Object({
      l1: Type.Object({ l2: Type.Object({ l3: Type.Object({ leaf: Type.String() }) }) }),
    });

    const summary = deriveSchemaSummary(deep);
    expect(summary).toContain('.l2: object (required)');
    expect(summary).toContain('.l3: object (required)');
    expect(summary).not.toContain('leaf');

    const prompts: string[] = [];
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null;

    const result = await attemptStructuredOutputRepair(
      { l1: { l2: { l3: { leaf: 42 } } } },
      [{ path: '/l1/l2/l3/leaf', message: 'Expected string', value: 42 }],
      {
        llmCaller: async (prompt) => {
          prompts.push(prompt);
          return JSON.stringify({ l1: { l2: { l3: { leaf: 'ok' } } } });
        },
        schemaCheck: (value) => {
          if (!isRecord(value)) return false;
          const { l1 } = value;
          if (!isRecord(l1)) return false;
          const { l2 } = l1;
          if (!isRecord(l2)) return false;
          const { l3 } = l2;
          if (!isRecord(l3)) return false;
          return l3.leaf === 'ok';
        },
      },
      { maxRepairAttempts: 1, _testJitterMs: 0 },
    );

    expect(result.repaired).toBe(true);
    // The descriptor stopped above the leaf, but the repair prompt still names
    // the exact field path — the boundary is observable, not silent.
    expect(prompts[0]).toContain('- /l1/l2/l3/leaf: Expected string');
  });

  it('6. describes every supported collection/enum/number form inside an object, including nested objects in arrays', () => {
    const lines = describeObjectPropertyFields(Type.Object({
      entries: Type.Array(
        Type.Object({ id: Type.String(), score: Type.Number({ minimum: 0 }) }),
        { minItems: 1, maxItems: 5 },
      ),
      tags: Type.Array(Type.Enum({ A: 'a', B: 'b' })),
      matrix: Type.Array(Type.Array(Type.String())),
      status: Type.Enum({ OPEN: 'open', CLOSED: 'closed' }),
      anything: Type.Union([Type.Any(), Type.String()]),
      emptyItems: Type.Array(Type.Object({ maybe: Type.Optional(Type.String()) })),
    })).join('\n');

    expect(lines).toContain('.entries: object[] {minItems: 1, maxItems: 5} (required)');
    expect(lines).toContain('(each item requires:)');
    expect(lines).toContain('.id: string (required)');
    expect(lines).toContain('.score: number {min: 0} (required)');
    expect(lines).toContain('.tags: enum(a | b)[] (required)');
    expect(lines).toContain('.matrix: array[] (required)');
    expect(lines).toContain('.status: enum(open | closed) (required)');
    // A union containing a typeless variant cannot be described by type; it is
    // labelled `union` rather than guessed.
    expect(lines).toContain('.anything: union (required)');
    // Array-of-object with no required item fields: unexpanded and stated.
    expect(lines).toContain('.emptyItems: object[] (required)');
    expect(lines).toContain('each item shape is not expanded here; field paths appear in validation errors');

    // Same degradation at the element-type helper level.
    expect(describeArrayElementType(Type.Unsafe({ anyOf: [{}, { type: 'string' }] }))).toBe('union');
    // Raw `enum` on array items (TypeBox's Type.Enum serializes as a union).
    expect(describeArrayElementType(Type.Unsafe({ type: 'string', enum: ['x', 'y'] }))).toBe('enum(x | y)');
  });

  it('7. degrades explicitly for malformed or empty schemas instead of throwing', () => {
    // Guards: a missing/wrong schema and an object without properties.
    expect(describeObjectPropertyFields(null as unknown as TSchema)).toEqual([]);
    expect(describeObjectPropertyFields(Type.Any())).toEqual([]);
    expect(deriveSchemaSummary(null as unknown as TSchema)).toBe('(unknown schema)');
    expect(deriveSchemaSummary(Type.String())).toBe('type: string');

    // Raw schema shape (not a TypeBuilder fixture): a non-object property is
    // skipped, while enum/number/union/array forms still render.
    const edge = Type.Unsafe({
      type: 'object',
      properties: {
        bad: null,
        status: { type: 'string', enum: ['a', 'b'] },
        score: { type: 'number', minimum: 0 },
        mixed: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        entries: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
        emptyItems: { type: 'array', items: { type: 'object', properties: {}, required: [] } },
      },
      required: ['status', 'score', 'mixed', 'entries', 'emptyItems'],
    });

    const summary = deriveSchemaSummary(edge);
    expect(summary).toContain('status: enum(a | b) (required)');
    expect(summary).toContain('score: number {min: 0} (required)');
    expect(summary).toContain('mixed: union (required)');
    expect(summary).toContain('entries: object[] {minItems: 1, maxItems: 5} (required)');
    expect(summary).toContain('(each item requires:)');
    expect(summary).toContain('.id: string (required)');
    expect(summary).toContain('emptyItems: object[] (required)');
    expect(summary).toContain('each item shape is not expanded here; field paths appear in validation errors');
    expect(summary).not.toContain('bad');

    // Optional object properties are expanded by the renderer (shape is
    // enforced whenever present), while describeObjectPropertyFields itself
    // only walks required keys.
    const rawObject = Type.Unsafe({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['on', 'off'] },
        range: { type: 'number', minimum: 0, maximum: 10 },
      },
      required: ['mode', 'range'],
    });
    const rawLines = describeObjectPropertyFields(rawObject).join('\n');
    expect(rawLines).toContain('.mode: enum(on | off) (required)');
    expect(rawLines).toContain('.range: number {min: 0, max: 10} (required)');
  });
});
