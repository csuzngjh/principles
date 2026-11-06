/**
 * PRI-917 v0.3.2 Phase 3C-1 — ReuseEvaluationOutputV1 contract tests.
 *
 * The Semantic Reuse Evaluation Capability's proposal-only output: the
 * validator is the trust boundary for an UNTRUSTED LLM output (rc-1/2/3).
 * These tests pin the SPEC v0.3.2 §4.2/§11 contract:
 *   - valid outputs of all three recommendation values pass;
 *   - recommendation=reuse REQUIRES selectedPrincipleId;
 *   - recommendation=uncertain FORBIDS selectedPrincipleId;
 *   - ANY unknown field is fail-closed (closed field set) — including the
 *     persistence-ish keys a model must never smuggle (write / reuseEvidence /
 *     persist) — T7a;
 *   - malformed schema values (confidence out of range, empty rationale,
 *     empty selectedPrincipleId) fail with structured reasons.
 *
 * Pure function tests — no I/O, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  REUSE_EVALUATION_OUTPUT_SCHEMA_REF,
  ReuseEvaluationOutputV1Schema,
  validateReuseEvaluationOutput,
} from '../reuse-evaluation-output.js';
import { isValidReuseEvaluationOutput } from '../reuse-evaluation-runner.js';
import { Value } from '@sinclair/typebox/value';

const VALID_REUSE = {
  recommendation: 'reuse',
  selectedPrincipleId: 'a1b2c3d4-0000-4000-8000-000000000001',
  rationale: 'same experience, different wording',
  confidence: 0.86,
};

describe('reuse-evaluation-output schema (reuse-evaluation-output-v1)', () => {
  it('exposes the stable schema ref for OUTPUT_SCHEMA_REGISTRY', () => {
    expect(REUSE_EVALUATION_OUTPUT_SCHEMA_REF).toBe('reuse-evaluation-output-v1');
  });

  it('accepts a valid reuse output through the raw schema as well', () => {
    expect(Value.Check(ReuseEvaluationOutputV1Schema, VALID_REUSE)).toBe(true);
  });
});

describe('validateReuseEvaluationOutput — valid outputs (recommendation × 3)', () => {
  it('accepts recommendation=reuse with selectedPrincipleId (normalized output, no extra fields)', () => {
    const result = validateReuseEvaluationOutput(VALID_REUSE);
    expect(result).toEqual({
      ok: true,
      output: {
        recommendation: 'reuse',
        selectedPrincipleId: 'a1b2c3d4-0000-4000-8000-000000000001',
        rationale: 'same experience, different wording',
        confidence: 0.86,
      },
    });
  });

  it('accepts recommendation=create without selectedPrincipleId', () => {
    const result = validateReuseEvaluationOutput({
      recommendation: 'create',
      rationale: 'different behavioral demand, same wording family',
      confidence: 0.4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.output.recommendation).toBe('create');
    expect(result.output.selectedPrincipleId).toBeUndefined();
  });

  it('accepts recommendation=uncertain without selectedPrincipleId', () => {
    const result = validateReuseEvaluationOutput({
      recommendation: 'uncertain',
      rationale: 'overlapping vocabulary, unclear coverage',
      confidence: 0.5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.output.recommendation).toBe('uncertain');
    expect(result.output.selectedPrincipleId).toBeUndefined();
  });
});

describe('validateReuseEvaluationOutput — cross-field rules', () => {
  it('recommendation=reuse WITHOUT selectedPrincipleId is rejected (reuse_without_principle_id)', () => {
    const result = validateReuseEvaluationOutput({
      recommendation: 'reuse',
      rationale: 'wants to reuse but names nothing',
      confidence: 0.9,
    });
    expect(result).toEqual({ ok: false, reason: 'reuse_without_principle_id' });
  });

  it('recommendation=uncertain WITH selectedPrincipleId is rejected (uncertain_with_principle_id)', () => {
    const result = validateReuseEvaluationOutput({
      recommendation: 'uncertain',
      selectedPrincipleId: 'a1b2c3d4-0000-4000-8000-000000000002',
      rationale: 'hedging while naming a principle',
      confidence: 0.5,
    });
    expect(result).toEqual({ ok: false, reason: 'uncertain_with_principle_id' });
  });

  it('recommendation=reuse with an EMPTY selectedPrincipleId is rejected', () => {
    const result = validateReuseEvaluationOutput({
      recommendation: 'reuse',
      selectedPrincipleId: '',
      rationale: 'r',
      confidence: 0.5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/reuse_without_principle_id|schema_validation_failed/);
  });
});

describe('validateReuseEvaluationOutput — closed field set (T7a)', () => {
  it('rejects persistence-ish fields a model must never smuggle: write / reuseEvidence / persist', () => {
    const cases: Record<string, unknown>[] = [
      { ...VALID_REUSE, write: { principleId: 'x' } },
      { ...VALID_REUSE, reuseEvidence: [{ painId: 'p', candidateId: 'c' }] },
      { ...VALID_REUSE, persist: true },
    ];
    for (const entry of cases) {
      const result = validateReuseEvaluationOutput(entry);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toMatch(/^unknown_field:(write|reuseEvidence|persist)$/);
    }
  });

  it('rejects ANY other unknown field and reports its name', () => {
    const result = validateReuseEvaluationOutput({ ...VALID_REUSE, decision: 'reuse' });
    expect(result).toEqual({ ok: false, reason: 'unknown_field:decision' });
  });
});

describe('validateReuseEvaluationOutput — malformed schema values (rc-3)', () => {
  it('rejects non-object input (null / string / array)', () => {
    for (const raw of [null, 'reuse', [], 42, undefined]) {
      expect(validateReuseEvaluationOutput(raw)).toEqual({ ok: false, reason: 'evaluation_is_not_an_object' });
    }
  });

  it('rejects an invalid recommendation value', () => {
    const result = validateReuseEvaluationOutput({
      recommendation: 'DECISION',
      rationale: 'r',
      confidence: 0.5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('schema_validation_failed');
  });

  it('rejects confidence outside [0,1] and non-number confidence', () => {
    for (const confidence of [1.5, -0.1, '0.5', null]) {
      const result = validateReuseEvaluationOutput({
        recommendation: 'create',
        rationale: 'r',
        confidence,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toContain('schema_validation_failed');
    }
  });

  it('isValidReuseEvaluationOutput delegates to the FULL trust boundary (P2 review fix)', () => {
    // The bare schema is an open field set — the boolean helper must apply the
    // same closed-field-set + cross-field rules as the validator (T7a).
    expect(isValidReuseEvaluationOutput(VALID_REUSE)).toBe(true);
    expect(isValidReuseEvaluationOutput({ ...VALID_REUSE, write: true })).toBe(false);
    expect(isValidReuseEvaluationOutput({ recommendation: 'reuse', rationale: 'r', confidence: 0.9 })).toBe(false);
  });

  it('rejects empty rationale', () => {
    const result = validateReuseEvaluationOutput({
      recommendation: 'create',
      rationale: '',
      confidence: 0.5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('schema_validation_failed');
  });
});
