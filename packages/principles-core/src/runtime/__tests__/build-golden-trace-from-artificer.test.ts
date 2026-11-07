/**
 * buildGoldenTraceFromArtificer() tests (RuleHost MVP Activation, ADR-0014
 * Amendment 2026-06-17, PRD Decision 5).
 *
 * TDD Phase 2.1 RED — asserts behavior not yet implemented in golden-trace.ts.
 *
 * Coverage (PRD Phase 2):
 *   - 2 cases → valid GoldenTrace (1 positive + 1 negative)
 *   - 10 cases → all preserved
 *   - 0 cases → returns error (never produces an invalid GoldenTrace)
 *   - 1 case → returns error (must have ≥1 positive + ≥1 negative)
 *   - metadata filled: traceId, createdAt (ISO-8601 UTC), version=1
 *   - output passes validateGoldenTrace()
 *   - preserves sourceArtifactId linkage when provided
 *
 * ERR checklist (EP-01, EP-07): unknown input validated; lineage field
 * (sourceArtifactId) carried through consistently.
 */
import { describe, it, expect } from 'vitest';
import { validateGoldenTrace, buildGoldenTraceFromArtificer } from '../golden-trace.js';
import type { GoldenTraceCaseInput } from '../internalization/artificer-output.js';

function makeCase(overrides: Partial<GoldenTraceCaseInput> = {}): GoldenTraceCaseInput {
  return {
    caseId: 'negative-1',
    kind: 'negative',
    toolName: 'edit',
    params: { path: '/etc/passwd' },
    expectedDecision: 'block',
    ...overrides,
  };
}

function makeValidPair(): GoldenTraceCaseInput[] {
  return [
    makeCase({ caseId: 'negative-1', kind: 'negative', expectedDecision: 'block' }),
    makeCase({
      caseId: 'positive-1',
      kind: 'positive',
      toolName: 'read',
      params: { path: '/tmp/safe.txt' },
      expectedDecision: 'allow',
    }),
  ];
}

describe('buildGoldenTraceFromArtificer (RuleHost MVP Activation)', () => {
  // ── happy path ────────────────────────────────────────────────────────────

  it('builds a valid GoldenTrace from 2 cases (1 positive + 1 negative)', () => {
    const result = buildGoldenTraceFromArtificer({
      cases: makeValidPair(),
      sourceArtifactId: 'pi-art-artificer-001-run-001',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const {trace} = result;
    expect(trace.cases).toHaveLength(2);
    expect(validateGoldenTrace(trace).valid).toBe(true);
  });

  it('preserves all 10 cases', () => {
    const cases: GoldenTraceCaseInput[] = [
      makeCase({ caseId: 'negative-1', kind: 'negative' }),
      makeCase({ caseId: 'positive-1', kind: 'positive', toolName: 'read', expectedDecision: 'allow' }),
    ];
    for (let i = 2; i < 10; i++) {
      cases.push(makeCase({ caseId: `negative-${i}`, kind: i % 2 === 0 ? 'negative' : 'positive', toolName: i % 2 === 0 ? 'edit' : 'read', expectedDecision: i % 2 === 0 ? 'block' : 'allow' }));
    }
    const result = buildGoldenTraceFromArtificer({ cases });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.cases).toHaveLength(10);
  });

  // ── metadata ───────────────────────────────────────────────────────────────

  it('fills traceId as non-empty string', () => {
    const result = buildGoldenTraceFromArtificer({ cases: makeValidPair() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.trace.traceId).toBe('string');
    expect(result.trace.traceId.length).toBeGreaterThan(0);
  });

  it('fills createdAt as a parseable ISO-8601 UTC timestamp', () => {
    const result = buildGoldenTraceFromArtificer({ cases: makeValidPair() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ts = result.trace.createdAt;
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(Number.isFinite(Date.parse(ts))).toBe(true);
  });

  it('sets version = 1', () => {
    const result = buildGoldenTraceFromArtificer({ cases: makeValidPair() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.version).toBe(1);
  });

  it('carries sourceArtifactId into sourceArtifactId field', () => {
    const result = buildGoldenTraceFromArtificer({
      cases: makeValidPair(),
      sourceArtifactId: 'pi-art-artificer-001-run-001',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.sourceArtifactId).toBe('pi-art-artificer-001-run-001');
  });

  // ── compatibility with validateGoldenTrace ─────────────────────────────────

  it('output passes validateGoldenTrace (full structural check)', () => {
    const result = buildGoldenTraceFromArtificer({ cases: makeValidPair() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = validateGoldenTrace(result.trace);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('preserves propose_correction fields (expectedProposedParams + expectedApplicationMode)', () => {
    const cases: GoldenTraceCaseInput[] = [
      makeCase({
        caseId: 'negative-1',
        kind: 'negative',
        expectedDecision: 'propose_correction',
        expectedProposedParams: { path: '/tmp/safe.txt' },
        expectedApplicationMode: 'shadow',
      }),
      makeCase({ caseId: 'positive-1', kind: 'positive', toolName: 'read', expectedDecision: 'allow' }),
    ];
    const result = buildGoldenTraceFromArtificer({ cases });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateGoldenTrace(result.trace).valid).toBe(true);
    const neg = result.trace.cases.find((c) => c.kind === 'negative');
    expect(neg?.expectedProposedParams).toEqual({ path: '/tmp/safe.txt' });
    expect(neg?.expectedApplicationMode).toBe('shadow');
  });

  // ── error paths ────────────────────────────────────────────────────────────

  it('rejects 0 cases with a structured error (never produces invalid GoldenTrace)', () => {
    const result = buildGoldenTraceFromArtificer({ cases: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBeTruthy();
  });

  it('rejects 1 case (missing positive/negative partner)', () => {
    const result = buildGoldenTraceFromArtificer({
      cases: [makeCase({ caseId: 'negative-1', kind: 'negative' })],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects all-positive cases (no negative)', () => {
    const result = buildGoldenTraceFromArtificer({
      cases: [
        makeCase({ caseId: 'p1', kind: 'positive', toolName: 'read', expectedDecision: 'allow' }),
        makeCase({ caseId: 'p2', kind: 'positive', toolName: 'read', expectedDecision: 'allow' }),
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects all-negative cases (no positive)', () => {
    const result = buildGoldenTraceFromArtificer({
      cases: [
        makeCase({ caseId: 'n1', kind: 'negative', expectedDecision: 'block' }),
        makeCase({ caseId: 'n2', kind: 'negative', expectedDecision: 'block' }),
      ],
    });
    expect(result.ok).toBe(false);
  });
});
