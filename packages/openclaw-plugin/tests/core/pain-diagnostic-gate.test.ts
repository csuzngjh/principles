import { beforeEach, describe, expect, it } from 'vitest';
import { evaluatePainDiagnosticGate, resetPainDiagnosticGateForTest } from '../../src/core/pain-diagnostic-gate.js';

describe('PainDiagnosticGate', () => {
  beforeEach(() => {
    resetPainDiagnosticGateForTest();
  });

  it('lets manual pain bypass automatic thresholds', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'manual',
      score: 1,
      currentGfi: 0,
      sessionId: 's1',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'manual',
    });
  });

  it('does not diagnose ordinary low-signal tool failures', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'tool_failure',
      score: 50,
      currentGfi: 15,
      consecutiveErrors: 1,
      sessionId: 's1',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: false,
      reason: 'below_gate',
    });
  });

  it('diagnoses repeated same failures', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'tool_failure',
      score: 50,
      currentGfi: 50,
      consecutiveErrors: 4,
      sessionId: 's1',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'repeated_failure',
    });
  });

  it('diagnoses high GFI episodes', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'tool_failure',
      score: 50,
      currentGfi: 72,
      consecutiveErrors: 2,
      sessionId: 's1',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'high_gfi',
    });
  });

  it('requires stronger score for generic semantic pain', () => {
    const low = evaluatePainDiagnosticGate({
      source: 'semantic',
      score: 45,
      currentGfi: 0,
      sessionId: 's1',
    });
    const high = evaluatePainDiagnosticGate({
      source: 'semantic',
      score: 60,
      currentGfi: 0,
      sessionId: 's2',
    });

    expect(low.shouldDiagnose).toBe(false);
    expect(high).toMatchObject({
      shouldDiagnose: true,
      reason: 'semantic_pain',
    });
  });

  it('deduplicates repeated diagnosis within cooldown', () => {
    const input = {
      source: 'tool_failure',
      score: 50,
      currentGfi: 72,
      sessionId: 's1',
      errorHash: 'same',
      nowMs: 1_000,
    };

    expect(evaluatePainDiagnosticGate(input).shouldDiagnose).toBe(true);
    expect(evaluatePainDiagnosticGate({ ...input, nowMs: 2_000 })).toMatchObject({
      shouldDiagnose: false,
      reason: 'cooldown',
    });
  });

  it('diagnoses subagent_error when score >= painTrigger', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'subagent_error',
      score: 40,
      currentGfi: 0,
      sessionId: 's1',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'subagent_error',
    });
  });

  it('skips subagent_error when score < painTrigger', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'subagent_error',
      score: 39,
      currentGfi: 0,
      sessionId: 's1',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: false,
      reason: 'below_gate',
    });
  });

  it('diagnoses llm_paralysis when score >= painTrigger', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'llm_paralysis',
      score: 40,
      currentGfi: 0,
      sessionId: 's1',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'llm_paralysis',
    });
  });

  it('diagnoses risky_high_score when isRisky=true and score >= highSeverity', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'tool_failure',
      score: 70,
      currentGfi: 0,
      isRisky: true,
      sessionId: 's1',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'risky_high_score',
    });
  });

  it('skips risky_high_score when isRisky=true but score < highSeverity', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'tool_failure',
      score: 69,
      currentGfi: 0,
      isRisky: true,
      sessionId: 's1',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: false,
      reason: 'below_gate',
    });
  });

  it('diagnoses user_empathy when score >= semanticPain threshold', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'user_empathy',
      score: 60,
      currentGfi: 0,
      sessionId: 's1',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'semantic_pain',
    });
  });

  it('uses custom threshold overrides', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'tool_failure',
      score: 50,
      currentGfi: 60,
      consecutiveErrors: 2,
      sessionId: 's1',
      thresholds: {
        painTrigger: 40,
        highSeverity: 70,
        highGfi: 55,
        repeatedFailure: 4,
        semanticPain: 60,
      },
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'high_gfi',
    });
  });

  it('handles exact threshold boundary (score === painTrigger)', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'subagent_error',
      score: 40,
      currentGfi: 0,
      sessionId: 's1',
      thresholds: { painTrigger: 40 },
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'subagent_error',
    });
  });
});
