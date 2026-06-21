/**
 * ArtificerRuleOutput unified validator tests (PRI-439).
 *
 * TDD RED — these tests assert the UNIFIED ArtificerRuleOutput behavior that
 * replaces the V1/V2 dual-version system. They will fail until the V1/V2
 * types, isArtificerOutputV2, degradeToV1, and the V1 compatibility path are
 * removed and the unified type + validator are in place.
 *
 * Key behavioral changes from V1/V2:
 *   - implementationCode is MANDATORY (no V1 plan-only acceptance)
 *   - implementationPlan field is REMOVED (no plan-only path)
 *   - isArtificerOutputV2 is DELETED (there is only one output type)
 *   - degradeToV1 is DELETED (exhaustion fails loud)
 *   - V1-shaped output (with implementationPlan but no implementationCode)
 *     is REJECTED, not accepted as backward-compatible
 *
 * ERR checklist (EP-01 Trust Boundary, EP-03 Fail Loud):
 *   - ERR-001/005/013: validator accepts `unknown`, uses Object.hasOwn, no `as`
 *   - ERR-009/010: missing implementationCode fails loud
 *   - ERR-002: no silent V1 degradation
 */
import { describe, it, expect } from 'vitest';
import { DefaultArtificerValidator } from '../artificer-output.js';

const ARTIFICER_TASK_ID = 'task-artificer-001';
const SCRIBE_ARTIFACT_ID = 'pi-art-scribe-001-run-001';

/**
 * Minimal valid ArtificerRuleOutput. Has implementationCode (mandatory),
 * goldenTraceCases (1 positive + 1 negative), affectedTools, and the lineage
 * fields. Does NOT have implementationPlan (removed in PRI-439).
 */
function makeRuleOutput(): Record<string, unknown> {
  return {
    taskId: ARTIFICER_TASK_ID,
    sourceScribeArtifactId: SCRIBE_ARTIFACT_ID,
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
    implementationSummary: 'Block writes to system directories',
    risks: ['false positive on symlinked paths'],
    sourceTrace: { scribeArtifactId: SCRIBE_ARTIFACT_ID },
    generatedAt: '2026-06-17T00:00:00.000Z',
  };
}

describe('DefaultArtificerValidator — unified ArtificerRuleOutput (PRI-439)', () => {
  const validator = new DefaultArtificerValidator();

  // ── Happy path ──────────────────────────────────────────────────────────

  it('accepts a valid ArtificerRuleOutput with mandatory implementationCode', async () => {
    const result = await validator.validate(makeRuleOutput(), ARTIFICER_TASK_ID);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // ── implementationCode is mandatory (no V1 acceptance) ──────────────────

  it('rejects output missing implementationCode (no V1 plan-only acceptance)', async () => {
    const output = makeRuleOutput();
    delete output.implementationCode;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('implementationcode'))).toBe(true);
  });

  it('rejects output with empty implementationCode', async () => {
    const output = makeRuleOutput();
    output.implementationCode = '   ';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('implementationcode'))).toBe(true);
  });

  it('rejects output with non-string implementationCode', async () => {
    const output = makeRuleOutput();
    output.implementationCode = 42;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('implementationcode'))).toBe(true);
  });

  // ── V1-shaped output is rejected (implementationPlan no longer accepted) ─

  it('rejects V1-shaped output that has implementationPlan but no implementationCode', async () => {
    const v1Shaped: Record<string, unknown> = {
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
    const result = await validator.validate(v1Shaped, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('implementationcode'))).toBe(true);
  });

  // ── implementationSummary is mandatory ───────────────────────────────────

  it('rejects output missing implementationSummary', async () => {
    const output = makeRuleOutput();
    delete output.implementationSummary;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('implementationsummary'))).toBe(true);
  });

  it('rejects output with empty implementationSummary', async () => {
    const output = makeRuleOutput();
    output.implementationSummary = '  ';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('implementationsummary'))).toBe(true);
  });

  // ── goldenTraceCases ─────────────────────────────────────────────────────

  it('rejects output with fewer than 2 goldenTraceCases', async () => {
    const output = makeRuleOutput();
    const cases = output.goldenTraceCases as unknown[];
    output.goldenTraceCases = [cases[0]];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('goldentrace'))).toBe(true);
  });

  it('rejects output with more than 10 goldenTraceCases', async () => {
    const output = makeRuleOutput();
    const base = (output.goldenTraceCases as unknown[])[0];
    output.goldenTraceCases = Array.from({ length: 11 }, (_, i) => ({ ...(base as Record<string, unknown>), caseId: `case-${i}` }));
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('goldentrace'))).toBe(true);
  });

  it('rejects output with no positive case', async () => {
    const output = makeRuleOutput();
    output.goldenTraceCases = [
      { caseId: 'n1', kind: 'negative', toolName: 'edit', params: {}, expectedDecision: 'block' },
      { caseId: 'n2', kind: 'negative', toolName: 'edit', params: {}, expectedDecision: 'block' },
    ];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('positive'))).toBe(true);
  });

  it('rejects output with no negative case', async () => {
    const output = makeRuleOutput();
    output.goldenTraceCases = [
      { caseId: 'p1', kind: 'positive', toolName: 'read', params: {}, expectedDecision: 'allow' },
      { caseId: 'p2', kind: 'positive', toolName: 'read', params: {}, expectedDecision: 'allow' },
    ];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('negative'))).toBe(true);
  });

  it('rejects positive case with expectedDecision other than allow', async () => {
    const output = makeRuleOutput();
    output.goldenTraceCases = (output.goldenTraceCases as unknown[]).map((c) => {
      const rec = c as Record<string, unknown>;
      return rec.kind === 'positive' ? { ...rec, expectedDecision: 'block' } : rec;
    });
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects goldenTraceCase with invalid expectedDecision enum', async () => {
    const output = makeRuleOutput();
    const cases = output.goldenTraceCases as Record<string, unknown>[];
    const firstCase = cases[0];
    if (!firstCase) throw new Error('fixture must have at least one case');
    firstCase.expectedDecision = 'requireApproval';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('expecteddecision'))).toBe(true);
  });

  it('rejects propose_correction without expectedApplicationMode', async () => {
    const output = makeRuleOutput();
    const cases = output.goldenTraceCases as Record<string, unknown>[];
    cases[0] = {
      ...cases[0],
      expectedDecision: 'propose_correction',
      expectedProposedParams: { path: '/safe/path' },
    };
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('expectedapplicationmode'))).toBe(true);
  });

  // ── affectedTools ─────────────────────────────────────────────────────────

  it('rejects output with empty affectedTools', async () => {
    const output = makeRuleOutput();
    output.affectedTools = [];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('affectedtools'))).toBe(true);
  });

  it('rejects blank affectedTools entries', async () => {
    const output = makeRuleOutput();
    output.affectedTools = ['edit', '   '];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('affectedtools'))).toBe(true);
  });

  it('rejects non-array affectedTools', async () => {
    const output = makeRuleOutput();
    output.affectedTools = 'edit';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('affectedtools'))).toBe(true);
  });

  // ── lineage ───────────────────────────────────────────────────────────────

  it('rejects output with taskId mismatch', async () => {
    const result = await validator.validate(makeRuleOutput(), 'wrong-task-id');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('taskId'))).toBe(true);
  });

  it('rejects output with mismatched sourceScribeArtifactId', async () => {
    const output = makeRuleOutput();
    output.sourceScribeArtifactId = 'wrong';
    const result = await validator.validate(output, ARTIFICER_TASK_ID, SCRIBE_ARTIFACT_ID);
    expect(result.valid).toBe(false);
  });

  it('rejects output with mismatched sourceTrace.scribeArtifactId', async () => {
    const output = makeRuleOutput();
    (output.sourceTrace as Record<string, unknown>).scribeArtifactId = 'wrong';
    const result = await validator.validate(output, ARTIFICER_TASK_ID, SCRIBE_ARTIFACT_ID);
    expect(result.valid).toBe(false);
  });

  // ── V1/V2 symbols are removed ─────────────────────────────────────────────

  it('does not export isArtificerOutputV2 (V1/V2 dual-version removed)', async () => {
    const mod = await import('../artificer-output.js');
    expect((mod as Record<string, unknown>).isArtificerOutputV2).toBeUndefined();
  });

  it('does not export ArtificerOutputV1Schema (V1 schema removed)', async () => {
    const mod = await import('../artificer-output.js');
    expect((mod as Record<string, unknown>).ArtificerOutputV1Schema).toBeUndefined();
  });

  it('does not export ArtificerImplementationPlanSchema (plan field removed)', async () => {
    const mod = await import('../artificer-output.js');
    expect((mod as Record<string, unknown>).ArtificerImplementationPlanSchema).toBeUndefined();
  });
});
