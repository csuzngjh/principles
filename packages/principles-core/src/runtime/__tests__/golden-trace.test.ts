/**
 * GoldenTrace domain model and validation tests (PRI-113).
 *
 * TDD RED phase — tests for:
 *   - GoldenTraceCase / GoldenTrace types
 *   - TypeBox schema validation
 *   - validateGoldenTrace / validateGoldenTraceCase pure functions
 *   - createSyntheticRuleHostInput fixture builder
 *   - createGoldenTraceFixture helper
 */
import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  GoldenTraceCaseSchema,
  GoldenTraceSchema,
  validateGoldenTraceCase,
  validateGoldenTrace,
  createSyntheticRuleHostInput,
  createGoldenTraceFixture,
  buildGoldenTraceFromArtificer,
} from '../golden-trace.js';
import type {
  GoldenTraceCase,
  GoldenTrace,
} from '../golden-trace.js';
import type { RuleContextV2 } from '../internalization/rule-context-v2.js';

// ── PRI-481 Phase 2: ruleContext fixtures ────────────────────────────────────

const sampleRuleContextV2: RuleContextV2 = {
  version: 2,
  history: {
    status: 'available',
    truncated: false,
    calls: [
      {
        sequenceId: 1,
        toolName: 'read',
        canonicalKind: 'read',
        normalizedPath: 'src/a.ts',
        paramsSummary: {},
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

// ── GoldenTraceCase type tests ───────────────────────────────────────────────

describe('GoldenTraceCase', () => {
  const validNegativeCase: GoldenTraceCase = {
    caseId: 'case-001',
    kind: 'negative',
    toolName: 'Write',
    params: { file_path: '/etc/passwd', content: 'root::0:0' },
    expectedDecision: 'block',
  };

  const validPositiveCase: GoldenTraceCase = {
    caseId: 'case-002',
    kind: 'positive',
    toolName: 'Write',
    params: { file_path: '/home/user/project/src/main.ts', content: 'export {};' },
    expectedDecision: 'allow',
  };

  const validCorrectionCase: GoldenTraceCase = {
    caseId: 'case-003',
    kind: 'negative',
    toolName: 'Bash',
    params: { command: 'rm -rf /' },
    expectedDecision: 'propose_correction',
    expectedProposedParams: { command: 'rm -rf ./dist' },
    expectedApplicationMode: 'shadow',
  };

  it('accepts valid negative case', () => {
    const result = validateGoldenTraceCase(validNegativeCase);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts valid positive case', () => {
    const result = validateGoldenTraceCase(validPositiveCase);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts valid correction case with expectedProposedParams', () => {
    const result = validateGoldenTraceCase(validCorrectionCase);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects case missing caseId', () => {
    const invalid = { ...validNegativeCase, caseId: '' };
    const result = validateGoldenTraceCase(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('caseId'))).toBe(true);
  });

  it('rejects case with invalid kind', () => {
    const invalid = { ...validNegativeCase, kind: 'neutral' };
    const result = validateGoldenTraceCase(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('kind'))).toBe(true);
  });

  it('rejects case missing toolName', () => {
    const invalid = { ...validNegativeCase, toolName: '' };
    const result = validateGoldenTraceCase(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('toolName'))).toBe(true);
  });

  it('rejects case with invalid expectedDecision', () => {
    const invalid = { ...validNegativeCase, expectedDecision: 'maybe' };
    const result = validateGoldenTraceCase(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('expectedDecision'))).toBe(true);
  });

  it('rejects correction case without expectedProposedParams', () => {
    const invalid = { ...validCorrectionCase };
    delete (invalid as Record<string, unknown>).expectedProposedParams;
    const result = validateGoldenTraceCase(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('expectedProposedParams'))).toBe(true);
  });

  it('rejects correction case without expectedApplicationMode', () => {
    const invalid = { ...validCorrectionCase };
    delete (invalid as Record<string, unknown>).expectedApplicationMode;
    const result = validateGoldenTraceCase(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('expectedApplicationMode'))).toBe(true);
  });

  it('rejects case with non-object params', () => {
    const invalid = { ...validNegativeCase, params: 'not-an-object' };
    const result = validateGoldenTraceCase(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('params'))).toBe(true);
  });
});

// ── GoldenTrace type tests ────────────────────────────────────────────────────

describe('GoldenTrace', () => {
  const validTrace: GoldenTrace = {
    traceId: 'trace-001',
    sourcePainId: 'pain-001',
    cases: [
      {
        caseId: 'case-001',
        kind: 'negative',
        toolName: 'Bash',
        params: { command: 'rm -rf /' },
        expectedDecision: 'block',
      },
      {
        caseId: 'case-002',
        kind: 'positive',
        toolName: 'Bash',
        params: { command: 'npm run build' },
        expectedDecision: 'allow',
      },
    ],
    createdAt: '2026-05-11T12:00:00.000Z',
    version: 1,
  };

  it('accepts valid trace with negative + positive cases', () => {
    const result = validateGoldenTrace(validTrace);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts trace with source refs', () => {
    const traceWithRefs: GoldenTrace = {
      ...validTrace,
      sourceCandidateId: 'cand-001',
      sourceArtifactId: 'artifact-001',
    };
    const result = validateGoldenTrace(traceWithRefs);
    expect(result.valid).toBe(true);
  });

  it('rejects trace missing traceId', () => {
    const invalid = { ...validTrace, traceId: '' };
    const result = validateGoldenTrace(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('traceId'))).toBe(true);
  });

  it('rejects trace with empty cases', () => {
    const invalid = { ...validTrace, cases: [] };
    const result = validateGoldenTrace(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('cases'))).toBe(true);
  });

  it('rejects trace with only positive cases (no negative)', () => {
    const invalid: GoldenTrace = {
      ...validTrace,
      cases: [
        {
          caseId: 'case-002',
          kind: 'positive',
          toolName: 'Bash',
          params: { command: 'npm run build' },
          expectedDecision: 'allow',
        },
      ],
    };
    const result = validateGoldenTrace(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('negative'))).toBe(true);
  });

  it('rejects trace with only negative cases (no positive)', () => {
    const invalid: GoldenTrace = {
      ...validTrace,
      cases: [
        {
          caseId: 'case-001',
          kind: 'negative',
          toolName: 'Bash',
          params: { command: 'rm -rf /' },
          expectedDecision: 'block',
        },
      ],
    };
    const result = validateGoldenTrace(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('positive'))).toBe(true);
  });

  it('rejects trace with wrong version', () => {
    const invalid = { ...validTrace, version: 2 };
    const result = validateGoldenTrace(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('rejects trace with missing createdAt', () => {
    const invalid = { ...validTrace, createdAt: '' };
    const result = validateGoldenTrace(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('createdAt'))).toBe(true);
  });

  it('rejects trace with unparseable createdAt', () => {
    const invalid = { ...validTrace, createdAt: 'not-a-date' };
    const result = validateGoldenTrace(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('createdAt') && e.includes('parseable'))).toBe(true);
  });

  it('rejects trace with invalid case inside', () => {
    const invalid: GoldenTrace = {
      ...validTrace,
      cases: [
        {
          caseId: '',
          kind: 'negative' as const,
          toolName: 'Bash',
          params: { command: 'rm -rf /' },
          expectedDecision: 'block' as const,
        },
        validTrace.cases[1] as GoldenTraceCase,
      ],
    };
    const result = validateGoldenTrace(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('cases[0]'))).toBe(true);
  });
});

// ── TypeBox schema validation ─────────────────────────────────────────────────

describe('TypeBox schema validation', () => {
  it('GoldenTraceCaseSchema validates a valid case', () => {
    const validCase = {
      caseId: 'case-001',
      kind: 'negative',
      toolName: 'Write',
      params: { file_path: '/etc/passwd', content: 'root::0:0' },
      expectedDecision: 'block',
    };
    expect(Value.Check(GoldenTraceCaseSchema, validCase)).toBe(true);
  });

  it('GoldenTraceCaseSchema rejects missing caseId', () => {
    const invalidCase = {
      caseId: '',
      kind: 'negative',
      toolName: 'Write',
      params: {},
      expectedDecision: 'block',
    };
    expect(Value.Check(GoldenTraceCaseSchema, invalidCase)).toBe(false);
  });

  it('GoldenTraceSchema validates a valid trace', () => {
    const validTrace = {
      traceId: 'trace-001',
      cases: [
        {
          caseId: 'case-001',
          kind: 'negative',
          toolName: 'Bash',
          params: { command: 'rm -rf /' },
          expectedDecision: 'block',
        },
        {
          caseId: 'case-002',
          kind: 'positive',
          toolName: 'Bash',
          params: { command: 'npm run build' },
          expectedDecision: 'allow',
        },
      ],
      createdAt: '2026-05-11T12:00:00.000Z',
      version: 1,
    };
    expect(Value.Check(GoldenTraceSchema, validTrace)).toBe(true);
  });
});

// ── Fixture builder tests ─────────────────────────────────────────────────────

describe('createSyntheticRuleHostInput', () => {
  it('creates a valid RuleHostInput from tool call snapshot', () => {
    const input = createSyntheticRuleHostInput({
      toolName: 'Bash',
      params: { command: 'rm -rf /' },
    });

    expect(input.action.toolName).toBe('Bash');
    expect(input.action.paramsSummary).toEqual({ command: 'rm -rf /' });
    expect(input.workspace).toBeDefined();
    expect(input.session).toBeDefined();
    expect(input.evolution).toBeDefined();
    expect(input.derived).toBeDefined();
  });

  it('accepts optional overrides', () => {
    const input = createSyntheticRuleHostInput(
      { toolName: 'Write', params: { file_path: '/tmp/x', content: '' } },
      {
        workspace: { isRiskPath: true },
        derived: { estimatedLineChanges: 50, bashRisk: 'dangerous' },
      },
    );

    expect(input.workspace.isRiskPath).toBe(true);
    expect(input.derived.bashRisk).toBe('dangerous');
  });
});

describe('createGoldenTraceFixture', () => {
  it('creates a valid GoldenTrace with one negative and one positive case', () => {
    const trace = createGoldenTraceFixture({
      toolName: 'Bash',
      negativeParams: { command: 'rm -rf /' },
      positiveParams: { command: 'npm run build' },
      expectedDecision: 'block',
    });

    expect(trace.traceId).toBeTruthy();
    expect(trace.version).toBe(1);
    expect(trace.cases).toHaveLength(2);
    const negativeCase = trace.cases[0] as GoldenTraceCase;
    const positiveCase = trace.cases[1] as GoldenTraceCase;
    expect(negativeCase.kind).toBe('negative');
    expect(positiveCase.kind).toBe('positive');

    // Validate the fixture is itself valid
    const result = validateGoldenTrace(trace);
    expect(result.valid).toBe(true);
  });

  it('creates a fixture with propose_correction decision', () => {
    const trace = createGoldenTraceFixture({
      toolName: 'Bash',
      negativeParams: { command: 'rm -rf /' },
      positiveParams: { command: 'npm run build' },
      expectedDecision: 'propose_correction',
      expectedProposedParams: { command: 'rm -rf ./dist' },
    });

    const negativeCase = trace.cases[0] as GoldenTraceCase;
    expect(negativeCase.expectedDecision).toBe('propose_correction');
    expect(negativeCase.expectedProposedParams).toEqual({ command: 'rm -rf ./dist' });
    expect(negativeCase.expectedApplicationMode).toBe('shadow');
  });

  it('accepts source refs', () => {
    const trace = createGoldenTraceFixture({
      toolName: 'Bash',
      negativeParams: { command: 'rm -rf /' },
      positiveParams: { command: 'npm run build' },
      expectedDecision: 'block',
      sourcePainId: 'pain-001',
      sourceCandidateId: 'cand-001',
    });

    expect(trace.sourcePainId).toBe('pain-001');
    expect(trace.sourceCandidateId).toBe('cand-001');
  });
});

// ── PRI-481 Phase 2: ruleContext through Golden Trace ABI ─────────────────────

describe('PRI-481 Phase 2 — GoldenTraceCaseSchema accepts ruleContext', () => {
  it('accepts a case carrying ruleContext', () => {
    const caseWithCtx = {
      caseId: 'case-ctx-001',
      kind: 'negative',
      toolName: 'Write',
      params: { file_path: 'src/a.ts', content: 'x' },
      expectedDecision: 'block',
      ruleContext: sampleRuleContextV2,
    };
    expect(Value.Check(GoldenTraceCaseSchema, caseWithCtx)).toBe(true);
  });

  it('still accepts a v1 case without ruleContext', () => {
    const v1Case = {
      caseId: 'case-v1-001',
      kind: 'negative',
      toolName: 'Write',
      params: { file_path: 'src/a.ts', content: 'x' },
      expectedDecision: 'block',
    };
    expect(Value.Check(GoldenTraceCaseSchema, v1Case)).toBe(true);
  });

  it('validateGoldenTraceCase accepts ruleContext-bearing input', () => {
    const result = validateGoldenTraceCase({
      caseId: 'case-ctx-002',
      kind: 'positive',
      toolName: 'Write',
      params: { file_path: 'src/b.ts', content: 'y' },
      expectedDecision: 'allow',
      ruleContext: sampleRuleContextV2,
    });
    expect(result.valid).toBe(true);
  });
});

describe('PRI-481 Phase 2 — createSyntheticRuleHostInput context propagation', () => {
  it('sets input.context when overrides.context provided (case has ruleContext)', () => {
    const input = createSyntheticRuleHostInput(
      { toolName: 'Write', params: { file_path: 'src/a.ts', content: 'x' } },
      { context: sampleRuleContextV2 },
    );
    expect(input.context).toBeDefined();
    expect(input.context).toBe(sampleRuleContextV2);
    expect(input.context?.history.calls).toHaveLength(1);
  });

  it('omits input.context when no overrides.context (v1 case compatibility)', () => {
    const input = createSyntheticRuleHostInput(
      { toolName: 'Write', params: { file_path: 'src/a.ts', content: 'x' } },
    );
    expect(input.context).toBeUndefined();
  });

  it('keeps other overrides working alongside context', () => {
    const input = createSyntheticRuleHostInput(
      { toolName: 'Write', params: { file_path: 'src/a.ts', content: 'x' } },
      {
        context: sampleRuleContextV2,
        workspace: { isRiskPath: true },
      },
    );
    expect(input.context).toBe(sampleRuleContextV2);
    expect(input.workspace.isRiskPath).toBe(true);
  });
});

describe('PRI-481 Phase 2 — buildGoldenTraceFromArtificer preserves ruleContext', () => {
  it('preserves ruleContext on mapped cases (does not drop it)', () => {
    const result = buildGoldenTraceFromArtificer({
      cases: [
        {
          caseId: 'neg-ctx',
          kind: 'negative',
          toolName: 'Write',
          params: { file_path: 'src/a.ts', content: 'bad' },
          expectedDecision: 'block',
          ruleContext: sampleRuleContextV2,
        },
        {
          caseId: 'pos-ctx',
          kind: 'positive',
          toolName: 'Write',
          params: { file_path: 'src/a.ts', content: 'good' },
          expectedDecision: 'allow',
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.cases[0]?.ruleContext).toEqual(sampleRuleContextV2);
    expect(result.trace.cases[1]?.ruleContext).toBeUndefined();
  });

  it('validates a ruleContext-bearing trace end-to-end', () => {
    const result = buildGoldenTraceFromArtificer({
      cases: [
        {
          caseId: 'neg-ctx-2',
          kind: 'negative',
          toolName: 'Write',
          params: { file_path: 'src/a.ts', content: 'bad' },
          expectedDecision: 'block',
          ruleContext: sampleRuleContextV2,
        },
        {
          caseId: 'pos-ctx-2',
          kind: 'positive',
          toolName: 'Write',
          params: { file_path: 'src/a.ts', content: 'good' },
          expectedDecision: 'allow',
          ruleContext: sampleRuleContextV2,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const validateResult = validateGoldenTrace(result.trace);
    expect(validateResult.valid).toBe(true);
  });
});
