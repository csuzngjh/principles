/**
 * adversarialCasesToGoldenTrace() tests (RuleHost MVP Activation, ADR-0014
 * Amendment 2026-06-17, PRD Decision 11d).
 *
 * TDD Phase 3.1 RED — asserts behavior not yet implemented in adversarial-case.ts.
 *
 * Coverage (PRD Phase 3):
 *   - 3 adversarial cases → GoldenTrace with kind='negative' for all
 *   - caseId preserved (adversarial-N prefix)
 *   - empty array → error
 *   - converted trace does NOT pass validateGoldenTrace() on its own (no
 *     positive case) — caller must add a positive case before validation
 *
 * ERR checklist (EP-01): unknown input validated field-by-field.
 */
import { describe, it, expect } from 'vitest';
import { adversarialCasesToGoldenTrace } from '../adversarial-case.js';
import { validateGoldenTrace } from '../../golden-trace.js';
import type { AdversarialCase } from '../evaluator-output.js';

function makeAdversarial(overrides: Partial<AdversarialCase> = {}): AdversarialCase {
  return {
    caseId: 'adversarial-1',
    attackType: 'boundary',
    toolName: 'edit',
    params: { path: 'package.json' },
    expectedDecision: 'allow',
    rationale: 'package.json is not a system file',
    ...overrides,
  };
}

describe('adversarialCasesToGoldenTrace (RuleHost MVP Activation)', () => {
  // ── happy path ────────────────────────────────────────────────────────────

  it('converts 3 adversarial cases into a GoldenTrace', () => {
    const cases: AdversarialCase[] = [
      makeAdversarial({ caseId: 'adversarial-1', attackType: 'boundary' }),
      makeAdversarial({ caseId: 'adversarial-2', attackType: 'omission', expectedDecision: 'block' }),
      makeAdversarial({ caseId: 'adversarial-3', attackType: 'inversion', expectedDecision: 'block' }),
    ];
    const result = adversarialCasesToGoldenTrace(cases);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.cases).toHaveLength(3);
  });

  it('sets kind=negative for every converted case', () => {
    const cases = [makeAdversarial({ caseId: 'adversarial-1' })];
    const result = adversarialCasesToGoldenTrace(cases);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.cases.every((c) => c.kind === 'negative')).toBe(true);
  });

  it('preserves adversarial-N caseId prefix', () => {
    const cases = [
      makeAdversarial({ caseId: 'adversarial-1' }),
      makeAdversarial({ caseId: 'adversarial-2' }),
    ];
    const result = adversarialCasesToGoldenTrace(cases);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.cases.map((c) => c.caseId)).toEqual(['adversarial-1', 'adversarial-2']);
  });

  it('carries toolName, params, expectedDecision through conversion', () => {
    const cases = [
      makeAdversarial({
        caseId: 'adversarial-1',
        toolName: 'write_file',
        params: { path: '/etc/shadow' },
        expectedDecision: 'block',
      }),
    ];
    const result = adversarialCasesToGoldenTrace(cases);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [only] = result.trace.cases;
    expect(only).toBeDefined();
    if (!only) return;
    expect(only.toolName).toBe('write_file');
    expect(only.params).toEqual({ path: '/etc/shadow' });
    expect(only.expectedDecision).toBe('block');
  });

  it('fills GoldenTrace metadata (traceId, createdAt, version)', () => {
    const result = adversarialCasesToGoldenTrace([makeAdversarial()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { trace } = result;
    expect(typeof trace.traceId).toBe('string');
    expect(trace.traceId.length).toBeGreaterThan(0);
    expect(trace.version).toBe(1);
    expect(trace.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  });

  // ── the design contract: adversarial-only trace lacks positive case ───────

  it('converted trace does NOT pass validateGoldenTrace() on its own (no positive)', () => {
    // Per PRD Decision 11d: adversarial cases are all negative (attacks). The
    // caller (Evaluator succeedTask) must append a positive case before
    // validateGoldenTrace() will accept the combined trace. This test pins
    // that contract so a future refactor doesn't silently synthesize a fake
    // positive case.
    const cases = [makeAdversarial({ caseId: 'adversarial-1' })];
    const result = adversarialCasesToGoldenTrace(cases);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const validation = validateGoldenTrace(result.trace);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e: string) => e.toLowerCase().includes('positive'))).toBe(true);
  });

  // ── error paths ────────────────────────────────────────────────────────────

  it('rejects empty array with structured error', () => {
    const result = adversarialCasesToGoldenTrace([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBeTruthy();
  });

  it('rejects non-array input with structured error', () => {
    const result = adversarialCasesToGoldenTrace('not-an-array');
    expect(result.ok).toBe(false);
  });

  it('rejects element missing rationale', () => {
    const malformed: unknown = [{ caseId: 'x', attackType: 'boundary', toolName: 'edit', params: {}, expectedDecision: 'allow' }];
    const result = adversarialCasesToGoldenTrace(malformed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.toLowerCase()).toContain('rationale');
  });

  it('rejects element with invalid expectedDecision', () => {
    const malformed: unknown = [
      { caseId: 'x', attackType: 'boundary', toolName: 'edit', params: {}, expectedDecision: 'requireApproval', rationale: 'r' },
    ];
    const result = adversarialCasesToGoldenTrace(malformed);
    expect(result.ok).toBe(false);
  });
});
