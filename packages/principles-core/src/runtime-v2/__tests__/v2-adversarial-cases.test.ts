/**
 * PRI-485 Phase 6 — v2 adversarial case generator tests.
 *
 * TDD RED — asserts behavior not yet implemented in v2-adversarial-cases.ts.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md
 *   - §7.4 Evaluator: 5 adversarial categories (unavailable/truncation/
 *     alias/path/combination) auto-generated to defend against false-positive
 *     blocks.
 *   - §10.1 acceptance: 5 categories must pass.
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

  it('returns exactly 5 cases', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    expect(cases).toHaveLength(5);
  });

  it('returns the 5 canonical caseIds in stable order', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    expect(cases.map((c) => c.caseId)).toEqual([
      'v2-unavailable',
      'v2-truncated',
      'v2-alias',
      'v2-path-boundary',
      'v2-combination',
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

  // ── case 3: alias ────────────────────────────────────────────────────────

  it('case v2-alias: history shows read_file on targetPath, expects allow for write_file', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    const c = cases.find((x) => x.caseId === 'v2-alias');
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.toolName).toBe(SPEC.toolName);
    expect(c.expectedDecision).toBe('allow');
    expect(c.ruleContext?.history.status).toBe('available');
    expect(c.ruleContext?.history.truncated).toBe(false);
    expect(c.ruleContext?.facts.priorReadOfTarget).toBe('yes');
    // History contains a read_file call on the target path.
    const readCall = c.ruleContext?.history.calls.find(
      (call) => call.canonicalKind === 'read' && call.normalizedPath === SPEC.targetPath,
    );
    expect(readCall).toBeDefined();
  });

  // ── case 4: path-boundary ────────────────────────────────────────────────

  it('case v2-path-boundary: targetPath + .bak must not be treated as already-read, expects block', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    const c = cases.find((x) => x.caseId === 'v2-path-boundary');
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.expectedDecision).toBe('block');
    expect(c.params).toEqual({ path: `${SPEC.targetPath}.bak` });
    // History shows prior read on targetPath (NOT on targetPath.bak).
    expect(c.ruleContext?.facts.priorReadOfTarget).toBe('no');
    // Sanity: even though targetPath appears as a substring of targetPath.bak,
    // priorReadOfTarget must be 'no' — proving no substring matching.
    const bakPath = `${SPEC.targetPath}.bak`;
    const readOnBak = c.ruleContext?.history.calls.find(
      (call) => call.canonicalKind === 'read' && call.normalizedPath === bakPath,
    );
    expect(readOnBak).toBeUndefined();
  });

  // ── case 5: combination ──────────────────────────────────────────────────

  it('case v2-combination: v2 context says priorRead=yes but action path is risky, expects block (v1 dominates)', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    const c = cases.find((x) => x.caseId === 'v2-combination');
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.expectedDecision).toBe('block');
    // The action targets a risk path (/etc/passwd).
    expect(c.params).toEqual({ path: '/etc/passwd' });
    // v2 context fabricates priorRead=yes on /etc/passwd — but the rule must
    // still block because the v1 action-only risk-path check dominates.
    expect(c.ruleContext?.facts.priorReadOfTarget).toBe('yes');
  });

  // ── adversarialCasesToGoldenTrace preserves ruleContext ──────────────────

  it('adversarialCasesToGoldenTrace preserves ruleContext on converted GoldenTraceCase', () => {
    const cases = generateV2ContextAdversarialCases(SPEC);
    const result = adversarialCasesToGoldenTrace(cases);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.cases).toHaveLength(5);
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
