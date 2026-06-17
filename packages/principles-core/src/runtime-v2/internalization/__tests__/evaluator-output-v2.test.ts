/**
 * EvaluatorOutputV2 validator tests (RuleHost MVP Activation, ADR-0014 Amendment 2026-06-17).
 *
 * TDD Phase 1.3 RED — asserts V2 schema behavior not yet implemented in
 * `evaluator-output.ts`. Will fail until V2 schema + validator are added.
 *
 * Coverage (PRD test module 2):
 *   - codeReview 3-dimension structure validation (each dimension required)
 *   - codeReview optional (V1 artificer output → no codeReview)
 *   - adversarialCases structure validation
 *   - adversarialResult structure validation
 *
 * ERR checklist (EP-01): ERR-001/005/013/009 — untrusted LLM output validated
 * field-by-field with runtime guards, never `as`-cast.
 */
import { describe, it, expect } from 'vitest';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import type { EvaluatorOutputV1, EvaluatorOutputV2 } from '../evaluator-output.js';

const EVALUATOR_TASK_ID = 'task-evaluator-001';
const ARTIFICER_ARTIFACT_ID = 'pi-art-artificer-001-run-001';

/** Minimal valid V1 evaluator output. */
function makeV1Output(): EvaluatorOutputV1 {
  return {
    taskId: EVALUATOR_TASK_ID,
    sourceArtificerArtifactId: ARTIFICER_ARTIFACT_ID,
    evaluation: {
      decision: 'approved',
      summary: 'Code matches principle intent.',
      score: 0.85,
      strengths: ['clean predicate'],
      concerns: [],
      requiredChanges: [],
    },
    sourceTrace: { artificerArtifactId: ARTIFICER_ARTIFACT_ID },
    risks: [],
    generatedAt: '2026-06-17T00:00:00.000Z',
  };
}

/** V2 output: V1 + codeReview + adversarialCases + adversarialResult (all optional). */
function makeV2Output(): EvaluatorOutputV2 {
  return {
    ...makeV1Output(),
    codeReview: {
      intentConsistency: { aligned: true, explanation: 'Logic matches principle.' },
      scopePrecision: { verdict: 'precise', explanation: 'No over/under-matching.' },
      traceCoverage: { sufficient: true, gaps: [], explanation: 'Covers key scenarios.' },
    },
    adversarialCases: [
      {
        caseId: 'adversarial-1',
        attackType: 'boundary',
        toolName: 'edit',
        params: { path: 'package.json' },
        expectedDecision: 'allow',
        rationale: 'package.json is not a system file',
      },
    ],
    adversarialResult: {
      passed: true,
      failedCases: [],
    },
  };
}

/** Mutable shallow copy for exercising validator rejection paths on untrusted input. */
function mutable(output: EvaluatorOutputV2): Record<string, unknown> {
  return { ...output, ...output };
}

describe('DefaultEvaluatorValidator — V2 (RuleHost MVP Activation)', () => {
  const validator = new DefaultEvaluatorValidator();

  // ── V1 backward compatibility ────────────────────────────────────────────

  it('accepts V1 output (no codeReview/adversarial fields)', async () => {
    const result = await validator.validate(makeV1Output(), EVALUATOR_TASK_ID);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // ── V2 happy path ─────────────────────────────────────────────────────────

  it('accepts valid V2 output with codeReview + adversarial fields', async () => {
    const result = await validator.validate(makeV2Output(), EVALUATOR_TASK_ID);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts V2 output with codeReview but no adversarial fields (short-circuit case)', async () => {
    const output = mutable(makeV2Output());
    delete output.adversarialCases;
    delete output.adversarialResult;
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(true);
  });

  // ── codeReview structure ──────────────────────────────────────────────────

  it('rejects codeReview missing intentConsistency', async () => {
    const output = mutable(makeV2Output());
    const cr = output.codeReview as Record<string, unknown>;
    delete cr.intentConsistency;
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('intentconsistency'))).toBe(true);
  });

  it('rejects codeReview.intentConsistency missing aligned', async () => {
    const output = mutable(makeV2Output());
    const cr = output.codeReview as Record<string, unknown>;
    const ic = cr.intentConsistency as Record<string, unknown>;
    delete ic.aligned;
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('aligned'))).toBe(true);
  });

  it('rejects codeReview.intentConsistency.aligned as non-boolean', async () => {
    const output = makeV2Output() as unknown as Record<string, unknown>;
    const cr = output.codeReview as Record<string, unknown>;
    const ic = cr.intentConsistency as Record<string, unknown>;
    ic.aligned = 'yes';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects codeReview.scopePrecision with invalid verdict', async () => {
    const output = makeV2Output() as unknown as Record<string, unknown>;
    const cr = output.codeReview as Record<string, unknown>;
    const sp = cr.scopePrecision as Record<string, unknown>;
    sp.verdict = 'mostly_ok';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('verdict'))).toBe(true);
  });

  it('rejects codeReview.traceCoverage with non-array gaps', async () => {
    const output = makeV2Output() as unknown as Record<string, unknown>;
    const cr = output.codeReview as Record<string, unknown>;
    const tc = cr.traceCoverage as Record<string, unknown>;
    tc.gaps = 'missing-scenario';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('gaps'))).toBe(true);
  });

  // ── adversarialCases structure ────────────────────────────────────────────

  it('rejects adversarialCases element missing rationale', async () => {
    const output = makeV2Output() as unknown as Record<string, unknown>;
    const cases = output.adversarialCases as Record<string, unknown>[];
    delete (cases[0] as Record<string, unknown>).rationale;
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('rationale'))).toBe(true);
  });

  it('rejects adversarialCases element with invalid attackType', async () => {
    const output = makeV2Output() as unknown as Record<string, unknown>;
    const cases = output.adversarialCases as Record<string, unknown>[];
    (cases[0] as Record<string, unknown>).attackType = 'fuzzing';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('attacktype'))).toBe(true);
  });

  it('rejects adversarialCases element with invalid expectedDecision', async () => {
    const output = makeV2Output() as unknown as Record<string, unknown>;
    const cases = output.adversarialCases as Record<string, unknown>[];
    (cases[0] as Record<string, unknown>).expectedDecision = 'requireApproval';
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('expecteddecision'))).toBe(true);
  });

  it('rejects adversarialCases that is not an array', async () => {
    const output = makeV2Output() as unknown as Record<string, unknown>;
    output.adversarialCases = {};
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
  });

  // ── adversarialResult structure ───────────────────────────────────────────

  it('rejects adversarialResult missing passed', async () => {
    const output = mutable(makeV2Output());
    const ar = output.adversarialResult as Record<string, unknown>;
    delete ar.passed;
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('passed'))).toBe(true);
  });

  it('rejects adversarialResult.failedCases element missing caseId', async () => {
    const output = mutable(makeV2Output());
    output.adversarialResult = {
      passed: false,
      failedCases: [
        {
          attackType: 'boundary',
          actualDecision: 'block',
          expectedDecision: 'allow',
          rationale: 'wrong',
        },
      ],
    };
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('caseid'))).toBe(true);
  });

  it('rejects adversarialResult.failedCases element with invalid attackType', async () => {
    const output = makeV2Output() as unknown as Record<string, unknown>;
    const ar = output.adversarialResult as Record<string, unknown>;
    ar.failedCases = [
      { caseId: 'f1', attackType: 'dos', actualDecision: 'block', expectedDecision: 'allow', rationale: 'x' },
    ];
    const result = await validator.validate(output, EVALUATOR_TASK_ID);
    expect(result.valid).toBe(false);
  });

  // ── detectV2 helper ───────────────────────────────────────────────────────

  it('exposes isEvaluatorOutputV2() that distinguishes V1 from V2', async () => {
    const mod = await import('../evaluator-output.js');
    expect(typeof mod.isEvaluatorOutputV2).toBe('function');
    expect(mod.isEvaluatorOutputV2(makeV1Output())).toBe(false);
    expect(mod.isEvaluatorOutputV2(makeV2Output())).toBe(true);
  });
});
