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
    const [base] = output.goldenTraceCases as unknown[];
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
    const [firstCase] = cases;
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

describe('DefaultArtificerValidator — PRI-484 requiresContextVersion + ruleContext', () => {
  const validator = new DefaultArtificerValidator();

  /** A valid RuleContextV2 (available history, computed facts). */
  function makeValidRuleContext(): Record<string, unknown> {
    return {
      version: 2,
      history: {
        status: 'available',
        truncated: false,
        calls: [
          {
            sequenceId: 1,
            toolName: 'read_file',
            canonicalKind: 'read',
            normalizedPath: '/workspace/foo.txt',
            paramsSummary: { path: '/workspace/foo.txt' },
            outcome: 'success',
          },
        ],
      },
      facts: {
        priorReadOfTarget: 'yes',
        readCount: 1,
        writeCount: 0,
        uniqueWritePathCount: 0,
        sameActionBlockCount: 0,
      },
    };
  }

  /** Build a rule output with the given requiresContextVersion + per-case ruleContext. */
  function makeOutput(opts: {
    requiresContextVersion?: number;
    attachRuleContextTo?: number; // index of the case to attach ruleContext to
  }): Record<string, unknown> {
    const output: Record<string, unknown> = {
      taskId: ARTIFICER_TASK_ID,
      sourceScribeArtifactId: SCRIBE_ARTIFACT_ID,
      implementationCode:
        'function evaluate(input, helpers) { return helpers.getToolName(input) === "edit" ? { decision: "block", matched: true, reason: "x" } : { decision: "allow", matched: false, reason: "x" }; }',
      // PRI-490: v2 output requires evidenceRefs — include in fixture.
      evidenceRefs: ['pain:1', 'tool_call:abc'],
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
      risks: [],
      sourceTrace: { scribeArtifactId: SCRIBE_ARTIFACT_ID },
      generatedAt: '2026-06-17T00:00:00.000Z',
    };
    if (opts.requiresContextVersion !== undefined) {
      output.requiresContextVersion = opts.requiresContextVersion;
    }
    if (opts.attachRuleContextTo !== undefined) {
      const cases = output.goldenTraceCases as Record<string, unknown>[];
      const target = cases[opts.attachRuleContextTo];
      if (!target) throw new Error(`invalid attachRuleContextTo index ${opts.attachRuleContextTo}`);
      target.ruleContext = makeValidRuleContext();
    }
    return output;
  }

  // ── requiresContextVersion field is accepted ─────────────────────────────

  it('accepts output with requiresContextVersion: 2 when every case has context', async () => {
    const output = makeOutput({ requiresContextVersion: 2, attachRuleContextTo: 0 });
    const cases = output.goldenTraceCases as Record<string, unknown>[];
    const [, secondCase] = cases;
    if (!secondCase) throw new Error('fixture must have two cases');
    secondCase.ruleContext = makeValidRuleContext();
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects v2 output when any golden trace case omits ruleContext', async () => {
    const result = await validator.validate(
      makeOutput({ requiresContextVersion: 2, attachRuleContextTo: 0 }),
      ARTIFICER_TASK_ID,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('goldenTraceCases[1].ruleContext is required when requiresContextVersion: 2 is declared');
  });

  it('accepts output without requiresContextVersion (v1 rule, backward compatible)', async () => {
    const result = await validator.validate(makeOutput({}), ARTIFICER_TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects requiresContextVersion other than 2 (only v2 is supported)', async () => {
    const result = await validator.validate(makeOutput({ requiresContextVersion: 1 }), ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('requirescontextversion'))).toBe(true);
  });

  it('rejects non-number requiresContextVersion', async () => {
    const result = await validator.validate(makeOutput({ requiresContextVersion: '2' as unknown as number }), ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('requirescontextversion'))).toBe(true);
  });

  // ── ruleContext on golden trace cases ────────────────────────────────────

  it('rejects ruleContext on a case when requiresContextVersion is absent (v1 must not read context)', async () => {
    const result = await validator.validate(
      makeOutput({ attachRuleContextTo: 0 }),
      ARTIFICER_TASK_ID,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('rulecontext') || e.toLowerCase().includes('v1'))).toBe(true);
  });

  it('rejects malformed ruleContext when requiresContextVersion: 2 is set', async () => {
    const output = makeOutput({ requiresContextVersion: 2 });
    const cases = output.goldenTraceCases as Record<string, unknown>[];
    const [firstCase] = cases;
    if (!firstCase) throw new Error('fixture must have at least one case');
    firstCase.ruleContext = { version: 99, history: {}, facts: {} }; // malformed
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('rulecontext'))).toBe(true);
  });

  it('rejects ruleContext with __proto__ key (prototype pollution, ERR-076)', async () => {
    const output = makeOutput({ requiresContextVersion: 2 });
    const cases = output.goldenTraceCases as Record<string, unknown>[];
    const [firstCase] = cases;
    if (!firstCase) throw new Error('fixture must have at least one case');
    // JSON.parse is the only way to create a real own enumerable `__proto__`
    // property — an object literal `{ __proto__: x }` sets the prototype chain
    // instead, which Object.keys never sees. The host-realm independence guard
    // (ERR-076) checks Object.keys, so we must produce the hostile shape via
    // JSON to exercise the guard faithfully.
    const malicious = JSON.parse(
      '{"version":2,"history":{"status":"available","truncated":false,"calls":[]},"facts":{"priorReadOfTarget":"yes","readCount":1,"writeCount":0,"uniqueWritePathCount":0,"sameActionBlockCount":0},"__proto__":{"polluted":true}}',
    );
    firstCase.ruleContext = malicious;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('rulecontext'))).toBe(true);
  });
});

// ── PRI-490: v2 seed rules allow/block-only + evidenceRefs ──────────────

describe('DefaultArtificerValidator — PRI-490 v2 seed rules allow/block-only + evidenceRefs', () => {
  const validator = new DefaultArtificerValidator();

  function makeValidRuleContext(): Record<string, unknown> {
    return {
      version: 2,
      history: {
        status: 'available',
        truncated: false,
        calls: [
          {
            sequenceId: 1,
            toolName: 'read_file',
            canonicalKind: 'read',
            normalizedPath: '/workspace/foo.txt',
            paramsSummary: { path: '/workspace/foo.txt' },
            outcome: 'success',
          },
        ],
      },
      facts: {
        priorReadOfTarget: 'yes',
        readCount: 1,
        writeCount: 0,
        uniqueWritePathCount: 0,
        sameActionBlockCount: 0,
      },
    };
  }

  function makeV2Output(): Record<string, unknown> {
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
          ruleContext: makeValidRuleContext(),
        },
        {
          caseId: 'positive-1',
          kind: 'positive',
          toolName: 'read',
          params: { path: '/etc/passwd' },
          expectedDecision: 'allow',
          ruleContext: makeValidRuleContext(),
        },
      ],
      affectedTools: ['edit'],
      implementationSummary: 'Block writes to system directories',
      risks: [],
      sourceTrace: { scribeArtifactId: SCRIBE_ARTIFACT_ID },
      generatedAt: '2026-06-17T00:00:00.000Z',
      requiresContextVersion: 2,
      evidenceRefs: ['pain:1', 'tool_call:abc'],
    };
  }

  // ── propose_correction is forbidden in v2 ──

  it('rejects v2 output with propose_correction in goldenTraceCases', async () => {
    const output = makeV2Output();
    const cases = output.goldenTraceCases as Record<string, unknown>[];
    cases[0] = {
      ...cases[0],
      expectedDecision: 'propose_correction',
      expectedProposedParams: { path: '/safe/path' },
      expectedApplicationMode: 'shadow',
    };
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('propose_correction') && e.includes('forbidden'))).toBe(true);
  });

  // ── evidenceRefs is required for v2 ──

  it('rejects v2 output missing evidenceRefs', async () => {
    const output = makeV2Output();
    delete output.evidenceRefs;
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('evidencerefs'))).toBe(true);
  });

  it('rejects v2 output with empty evidenceRefs array', async () => {
    const output = makeV2Output();
    output.evidenceRefs = [];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('evidencerefs'))).toBe(true);
  });

  it('rejects v2 output with non-array evidenceRefs', async () => {
    const output = makeV2Output();
    output.evidenceRefs = 'pain:1';
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('evidencerefs'))).toBe(true);
  });

  it('rejects v2 output with evidenceRefs containing non-string elements', async () => {
    const output = makeV2Output();
    output.evidenceRefs = ['pain:1', 42];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('evidencerefs'))).toBe(true);
  });

  it('rejects v2 output with evidenceRefs containing empty strings', async () => {
    const output = makeV2Output();
    output.evidenceRefs = ['pain:1', '  '];
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('evidencerefs'))).toBe(true);
  });

  // ── v1 does not require evidenceRefs (backward compatible) ──

  it('accepts v1 output without evidenceRefs (v1 zero-change)', async () => {
    const output: Record<string, unknown> = {
      taskId: ARTIFICER_TASK_ID,
      sourceScribeArtifactId: SCRIBE_ARTIFACT_ID,
      implementationCode:
        'function evaluate(input, helpers) { return helpers.getToolName(input) === "edit" ? { decision: "block", matched: true, reason: "x" } : { decision: "allow", matched: false, reason: "x" }; }',
      goldenTraceCases: [
        { caseId: 'negative-1', kind: 'negative', toolName: 'edit', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        { caseId: 'positive-1', kind: 'positive', toolName: 'read', params: { path: '/etc/passwd' }, expectedDecision: 'allow' },
      ],
      affectedTools: ['edit'],
      implementationSummary: 'Block writes to system directories',
      risks: [],
      sourceTrace: { scribeArtifactId: SCRIBE_ARTIFACT_ID },
      generatedAt: '2026-06-17T00:00:00.000Z',
    };
    const result = await validator.validate(output, ARTIFICER_TASK_ID);
    expect(result.valid).toBe(true);
  });

  // ── v2 output with valid evidenceRefs is accepted ──

  it('accepts valid v2 output with evidenceRefs', async () => {
    const result = await validator.validate(makeV2Output(), ARTIFICER_TASK_ID);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
