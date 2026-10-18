/**
 * PRI-485 Phase 6 — v2 adversarial case generator tests.
 *
 * TDD RED — asserts behavior not yet implemented in v2-adversarial-cases.ts.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md
 *   - §7.4 Evaluator: generic generation is limited to context-availability
 *     boundaries. Principle-specific action outcomes come from Owner evidence.
 *
 * ERR checklist:
 *   - ERR-069: generated cases share the AdversarialCase schema; validate
 *     each via validateAdversarialCases.
 *   - ERR-001 / rc-1 / rc-2: ruleContext is typed RuleContextV2 (not `as`);
 *     every case's ruleContext must pass validateRuleContextV2.
 *   - rc-9: each case's rationale is non-empty (no silent default).
 */
import { describe, it, expect } from 'vitest';
import {
  generateV2ContextAdversarialCases,
  type V2AdversarialCaseSpec,
} from '../internalization/v2-adversarial-cases.js';
import { validateRuleContextV2, UNAVAILABLE_RULE_CONTEXT } from '../internalization/rule-context-v2.js';
import { adversarialCasesToGoldenTrace } from '../internalization/adversarial-case.js';
import { DefaultEvaluatorValidator } from '../internalization/evaluator-output.js';
import type { AdversarialCase } from '../internalization/evaluator-output.js';

const SPEC: V2AdversarialCaseSpec = {
  toolName: 'write_file',
  targetPath: 'src/a.ts',
  canonicalKind: 'write',
};

const EVALUATOR_TASK_ID = 'evaluator-test';

async function validateCases(cases: readonly AdversarialCase[]): Promise<string[]> {
  const validator = new DefaultEvaluatorValidator();
  // Wrap into a minimal V1 evaluator output so the V2 validator path fires
  // on the adversarialCases field.
  const wrapped = {
    taskId: EVALUATOR_TASK_ID,
    sourceArtificerArtifactId: 'artificer-001',
    evaluation: {
      decision: 'approved' as const,
      summary: 'placeholder',
      score: 0.9,
      strengths: [],
      concerns: [],
      requiredChanges: [],
    },
    sourceTrace: { artificerArtifactId: 'artificer-001' },
    risks: [],
    generatedAt: new Date().toISOString(),
    adversarialCases: cases,
  };
  const result = await validator.validate(wrapped, EVALUATOR_TASK_ID);
  return [...result.errors];
}

describe('generateV2ContextAdversarialCases (PRI-485 Phase 6)', () => {
  // ── shape & count ─────────────────────────────────────────────────────────

  it('returns exactly the two principle-neutral context availability cases', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    expect(cases).toHaveLength(2);
  });

  it('returns the two current caseIds in stable order', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    expect(cases.map((c) => c.caseId)).toEqual([
      'v2-unavailable',
      'v2-truncated',
    ]);
  });

  // ── each case passes schema + ruleContext validation ─────────────────────

  it('every generated case passes validateAdversarialCases (shared schema, ERR-069)', async () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    const errors = await validateCases(cases);
    expect(errors).toEqual([]);
  });

  it('every case.ruleContext passes validateRuleContextV2 (rc-1/rc-2)', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    for (const c of cases) {
      expect(c.ruleContext).toBeDefined();
      const result = validateRuleContextV2(c.ruleContext);
      expect(result.valid, `case ${c.caseId}: ${result.errors.join('; ')}`).toBe(true);
    }
  });

  it('every case has non-empty rationale (rc-9)', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    for (const c of cases) {
      expect(typeof c.rationale).toBe('string');
      expect(c.rationale.trim().length).toBeGreaterThan(0);
    }
  });

  // ── case 1: unavailable ──────────────────────────────────────────────────

  it('case v2-unavailable uses UNAVAILABLE_RULE_CONTEXT and expects allow', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    const c = cases.find((x) => x.caseId === 'v2-unavailable');
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.expectedDecision).toBe('allow');
    expect(c.ruleContext).toBe(UNAVAILABLE_RULE_CONTEXT);
    expect(c.params).toEqual({ path: SPEC.targetPath });
  });

  // ── case 2: truncated ────────────────────────────────────────────────────

  it('case v2-truncated has status=available, truncated=true, empty calls, all-null facts, expects allow', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    const c = cases.find((x) => x.caseId === 'v2-truncated');
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.expectedDecision).toBe('allow');
    expect(c.ruleContext?.history.status).toBe('available');
    expect(c.ruleContext?.history.truncated).toBe(true);
    expect(c.ruleContext?.history.calls).toEqual([]);
    // Conservative posture: facts all null/unknown when no calls observed.
    expect(c.ruleContext?.facts.priorReadOfTarget).toBe('unknown');
    expect(c.ruleContext?.facts.readCount).toBeNull();
    expect(c.ruleContext?.facts.writeCount).toBeNull();
    expect(c.ruleContext?.facts.uniqueWritePathCount).toBeNull();
  });

  it('does not invent alias, sibling-path, or risk-combination decisions without Owner-labelled evidence', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    expect(cases.map((c) => c.caseId)).not.toContain('v2-alias');
    expect(cases.map((c) => c.caseId)).not.toContain('v2-path-boundary');
    expect(cases.map((c) => c.caseId)).not.toContain('v2-combination');
    expect(cases.every((c) => c.params.path === SPEC.targetPath)).toBe(true);
  });

  // ── adversarialCasesToGoldenTrace preserves ruleContext ──────────────────

  it('adversarialCasesToGoldenTrace preserves ruleContext on converted GoldenTraceCase', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    const result = adversarialCasesToGoldenTrace(cases);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.cases).toHaveLength(2);
    for (const original of cases) {
      const converted = result.trace.cases.find((c) => c.caseId === original.caseId);
      expect(converted, `converted case ${original.caseId} missing`).toBeDefined();
      if (!converted) continue;
      expect(converted.kind).toBe('negative');
      expect(converted.ruleContext).toEqual(original.ruleContext);
    }
  });

  // ── backward compat: cases without ruleContext still validate ────────────

  it('validateAdversarialCases still accepts cases WITHOUT ruleContext (backward compat)', async () => {
    const legacyCase: AdversarialCase = {
      caseId: 'legacy-1',
      attackType: 'boundary',
      toolName: 'edit',
      params: { path: 'package.json' },
      expectedDecision: 'allow',
      rationale: 'legacy case has no ruleContext',
    };
    const errors = await validateCases([legacyCase]);
    expect(errors).toEqual([]);
  });

  // ── invalid ruleContext is rejected ──────────────────────────────────────

  it('validateAdversarialCases rejects cases with malformed ruleContext (rc-2: no as bypass)', async () => {
    const malformed: unknown = {
      caseId: 'bad-ctx',
      attackType: 'boundary',
      toolName: 'edit',
      params: { path: 'x' },
      expectedDecision: 'allow',
      rationale: 'bad context',
      ruleContext: { version: 99, history: {}, facts: {} }, // wrong version + missing fields
    };
    const errors = await validateCases([malformed as AdversarialCase]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('ruleContext'))).toBe(true);
  });
});
