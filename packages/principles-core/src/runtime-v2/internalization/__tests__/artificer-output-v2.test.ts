/**
 * ArtificerOutputV2 validator tests (RuleHost MVP Activation, ADR-0014 Amendment 2026-06-17).
 *
 * TDD Phase 1.1 RED — these tests assert V2 schema behavior that is NOT yet
 * implemented in `artificer-output.ts`. They will fail until the V2 schema +
 * validator are added.
 *
 * Coverage (PRD test module 1):
 *   - V2 field completeness (implementationCode non-empty, goldenTraceCases
 *     ≥2 with 1 positive + 1 negative, affectedTools non-empty)
 *   - V1 backward compatibility (output without code fields still validates)
 *   - Boundary: empty implementationCode, only 1 case, >10 cases, empty
 *     affectedTools, case missing required fields, wrong expectedDecision
 *     for positive case
 *
 * ERR checklist (EP-01 Trust Boundary):
 *   - ERR-001 / ERR-005: validator accepts `unknown`, never `as`-casts; every
 *     field is checked with `typeof` / `Array.isArray` / element-wise guard.
 *   - ERR-013: uses `Object.hasOwn()`, not `in`, for untrusted keys.
 *   - ERR-009 / ERR-010: required V2 fields fail loud when missing/malformed.
 *   - ERR-007: goldenTraceCases array elements validated individually.
 */
import { describe, it, expect } from 'vitest';
import { DefaultArtificerValidator } from '../artificer-output.js';
import type { ArtificerOutputV1, ArtificerOutputV2 } from '../artificer-output.js';

const ARTIFICER_TASK_ID = 'task-artificer-001';
const SCRIBE_ARTIFACT_ID = 'pi-art-scribe-001-run-001';

/**
 * Minimal valid V1 artificer output. V2 extends this with code fields.
 * Mirrors the factory in artificer-runner-vslice.test.ts so V1 baseline
 * behavior is exercised identically.
 */
function makeV1Output(): ArtificerOutputV1 {
  return {
    taskId: ARTIFICER_TASK_ID,
    sourceScribeArtifactId: SCRIBE_ARTIFACT_ID,
    implementationPlan: {
      summary: 'Block writes to system directories',
      targetSurface: 'edit tool gate',
      changes: ['add path-prefix check'],
      tests: ['golden trace replay passes'],
      rolloutNotes: ['shadow mode first'],
      confidence: 0.8,
    },
    sourceTrace: { scribeArtifactId: SCRIBE_ARTIFACT_ID },
    risks: ['false positive on symlinked paths'],
    generatedAt: '2026-06-17T00:00:00.000Z',
  };
}

/** Minimal valid V2 output: V1 + code fields with 1 positive + 1 negative case. */
function makeV2Output(): ArtificerOutputV2 {
  return {
    ...makeV1Output(),
    implementationCode:
      'function evaluate(input, helpers) { return helpers.getToolName(input) === "edit" ? { decision: "block", matched: true, reason: "x" } : { decision: "allow", matched: false, reason: "x" }; }',
    goldenTraceCases: [
      {
        caseId: 'negative-1',
        kind: 'negative',
        toolName: 'edit',
        params: { path: '/etc/passwd' },
        expectedDecision: 'block',
      },
      {
        caseId: 'positive-1',
        kind: 'positive',
        toolName: 'read',
        params: { path: '/etc/passwd' },
        expectedDecision: 'allow',
      },
    ],
    affectedTools: ['edit'],
  };
}

/**
 * Produce a mutable shallow copy as an untrusted record. Tests mutate fields
 * to exercise validator rejection paths; the validator itself receives these
 * as `unknown` and never `as`-casts (Runtime Contract Rule 1/2, ERR-001).
 * Using a typed mutable clone keeps test code readable without weakening
 * the readonly contract on the production interface.
 */
function mutable(output: ArtificerOutputV2): Record<string, unknown> {
  return { ...output, ...output };
}

describe('DefaultArtificerValidator — V2 (RuleHost MVP Activation)', () => {
  const validator = new DefaultArtificerValidator();

  // ── V1 backward compatibility ────────────────────────────────────────────

  it('accepts V1 output (no code fields) for backward compatibility', async () => {
    const result = await validator.validate(makeV1Output(), ARTIFICER_TASK_ID);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // ── V2 happy path ─────────────────────────────────────────────────────────

  it('accepts valid V2 output with code fields', async () => {
    const result = await validator.validate(makeV2Output(), ARTIFICER_TASK_ID);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // ── implementationCode ────────────────────────────────────────────────────

  it('rejects V2 output with empty implementationCode', async () => {
    const output = mutable(makeV2Output());
    output.implementationCode = '   ';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('implementationCode'))).toBe(true);
  });

  it('rejects V2 output with non-string implementationCode', async () => {
    const output = mutable(makeV2Output());
    output.implementationCode = 42;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('implementationCode'))).toBe(true);
  });

  it('rejects propose_correction without expectedApplicationMode', async () => {
    const output = mutable(makeV2Output());
    const cases = Array.isArray(output.goldenTraceCases) ? output.goldenTraceCases : [];
    const [first, ...remainingCases] = cases;
    if (typeof first !== 'object' || first === null || Array.isArray(first)) throw new Error('invalid fixture');
    output.goldenTraceCases = [{
      ...first,
      expectedDecision: 'propose_correction',
      expectedProposedParams: { path: '/safe/path' },
    }, ...remainingCases];

    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('expectedapplicationmode'))).toBe(true);
  });

  // ── goldenTraceCases ──────────────────────────────────────────────────────

  it('rejects V2 output with fewer than 2 goldenTraceCases', async () => {
    const output = mutable(makeV2Output());
    const cases = output.goldenTraceCases as unknown[];
    output.goldenTraceCases = [(cases[0] as Record<string, unknown>)];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('goldentrace'))).toBe(true);
  });

  it('rejects V2 output with more than 10 goldenTraceCases', async () => {
    const output = mutable(makeV2Output());
    const base = (output.goldenTraceCases as unknown[])[0] as Record<string, unknown>;
    output.goldenTraceCases = Array.from({ length: 11 }, (_, i) => ({
      ...base,
      caseId: `case-${i}`,
    }));
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('goldentrace'))).toBe(true);
  });

  it('rejects V2 output with no positive case', async () => {
    const output = mutable(makeV2Output());
    output.goldenTraceCases = [
      { caseId: 'n1', kind: 'negative', toolName: 'edit', params: {}, expectedDecision: 'block' },
      { caseId: 'n2', kind: 'negative', toolName: 'edit', params: {}, expectedDecision: 'block' },
    ];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('positive'))).toBe(true);
  });

  it('rejects V2 output with no negative case', async () => {
    const output = mutable(makeV2Output());
    output.goldenTraceCases = [
      { caseId: 'p1', kind: 'positive', toolName: 'read', params: {}, expectedDecision: 'allow' },
      { caseId: 'p2', kind: 'positive', toolName: 'read', params: {}, expectedDecision: 'allow' },
    ];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('negative'))).toBe(true);
  });

  it('rejects positive case with expectedDecision other than allow', async () => {
    const output = mutable(makeV2Output());
    output.goldenTraceCases = (output.goldenTraceCases as unknown[]).map((c) => {
      const rec = c as Record<string, unknown>;
      return rec.kind === 'positive' ? { ...rec, expectedDecision: 'block' } : rec;
    });
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects goldenTraceCase with invalid expectedDecision enum', async () => {
    const output = mutable(makeV2Output());
    const cases = output.goldenTraceCases as Record<string, unknown>[];
    (cases[0] as Record<string, unknown>).expectedDecision = 'requireApproval';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('expecteddecision'))).toBe(true);
  });

  it('rejects goldenTraceCase missing required caseId', async () => {
    const output = mutable(makeV2Output());
    const cases = output.goldenTraceCases as Record<string, unknown>[];
    delete (cases[0] as Record<string, unknown>).caseId;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('caseid'))).toBe(true);
  });

  it('rejects goldenTraceCases that is not an array', async () => {
    const output = mutable(makeV2Output());
    output.goldenTraceCases = 'not-an-array';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('goldentrace'))).toBe(true);
  });

  // ── affectedTools ─────────────────────────────────────────────────────────

  it('rejects V2 output with empty affectedTools', async () => {
    const output = mutable(makeV2Output());
    output.affectedTools = [];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('affectedtools'))).toBe(true);
  });

  it('rejects blank affectedTools entries', async () => {
    const output = mutable(makeV2Output());
    output.affectedTools = ['edit', '   '];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('affectedtools'))).toBe(true);
  });

  it('rejects V2 output with non-string affectedTools element', async () => {
    const output = mutable(makeV2Output());
    output.affectedTools = ['edit', 42];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('affectedtools'))).toBe(true);
  });

  it('rejects V2 output with non-array affectedTools', async () => {
    const output = mutable(makeV2Output());
    output.affectedTools = 'edit';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('affectedtools'))).toBe(true);
  });

  // ── V2 must still reject all V1 errors (lineage, taskId, plan) ────────────

  it('rejects V2 output with taskId mismatch', async () => {
    const result = await validator.validate(makeV2Output(), 'wrong-task-id');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('taskId'))).toBe(true);
  });

  it('rejects V2 output with mismatched sourceScribeArtifactId', async () => {
    const output = mutable(makeV2Output());
    output.sourceScribeArtifactId = 'wrong';
    const result = await validator.validate(output, ARTIFICER_TASK_ID, SCRIBE_ARTIFACT_ID);
    expect(result.valid).toBe(false);
  });

  // ── detectV2 helper ───────────────────────────────────────────────────────

  it('exposes isArtificerOutputV2() that distinguishes V1 from V2', async () => {
    // Importing dynamically to avoid breaking compile if not yet exported.
    const mod = await import('../artificer-output.js');
    expect(typeof mod.isArtificerOutputV2).toBe('function');
    expect(mod.isArtificerOutputV2(makeV1Output())).toBe(false);
    expect(mod.isArtificerOutputV2(makeV2Output())).toBe(true);
  });
});
