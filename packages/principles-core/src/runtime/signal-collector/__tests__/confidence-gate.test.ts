import { describe, it, expect } from 'vitest';
import {
  evaluateStage2ConfidenceGate,
  STAGE2_CONFIRM_THRESHOLD,
  STAGE2_NONE_THRESHOLD,
  STAGE2_MAX_ATTEMPTS,
  PENDING_CANDIDATE_TTL_MS,
} from '../confidence-gate.js';
import type { LlmClassificationResult } from '../types.js';

function result(overrides: Partial<LlmClassificationResult> = {}): LlmClassificationResult {
  return { is_feedback: true, type: 'correction', confidence: 0.9, reason: 'test', ...overrides };
}

describe('P-3 confidence gate (SPEC v0.3 §3.3/§4.4)', () => {
  it('correction at/above θ_confirm is a correction verdict', () => {
    expect(evaluateStage2ConfidenceGate(result({ confidence: STAGE2_CONFIRM_THRESHOLD })).verdict).toBe('correction');
    expect(evaluateStage2ConfidenceGate(result({ confidence: 1 })).verdict).toBe('correction');
  });

  it('correction below θ_confirm stays pending (never admitted, never NONE)', () => {
    const gate = evaluateStage2ConfidenceGate(result({ confidence: 0.69 }));
    expect(gate.verdict).toBe('pending_low_confidence');
    expect(gate.confidence).toBe(0.69);
  });

  it('none at/above θ_none is a terminal negative', () => {
    expect(evaluateStage2ConfidenceGate(result({ type: 'none', confidence: STAGE2_NONE_THRESHOLD })).verdict).toBe('none');
  });

  it('low-confidence none is pending, NOT resolved none', () => {
    const gate = evaluateStage2ConfidenceGate(result({ type: 'none', confidence: 0.6, reason: 'unsure' }));
    expect(gate.verdict).toBe('pending_low_confidence');
    expect(gate.verdict).not.toBe('none');
  });

  it('LLM timeout / exception / unusable payload is an error path, never NONE', () => {
    const gate = evaluateStage2ConfidenceGate(null);
    expect(gate.verdict).toBe('pending_llm_error');
    expect(gate.confidence).toBeNull();
    expect(gate.verdict).not.toBe('none');
  });

  it('is_feedback=false cannot be a correction verdict', () => {
    expect(evaluateStage2ConfidenceGate(result({ is_feedback: false, type: 'correction', confidence: 0.95 })).verdict).toBe('none');
  });

  it('thresholds are instance configurable', () => {
    const strictGate = evaluateStage2ConfidenceGate(result({ confidence: 0.75 }), { confirm: 0.8, none: 0.8 });
    expect(strictGate.verdict).toBe('pending_low_confidence');
  });

  it('state machine constants match the SPEC', () => {
    expect(STAGE2_MAX_ATTEMPTS).toBe(5);
    expect(PENDING_CANDIDATE_TTL_MS).toBe(72 * 60 * 60 * 1000);
    expect(STAGE2_CONFIRM_THRESHOLD).toBe(0.7);
    expect(STAGE2_NONE_THRESHOLD).toBe(0.7);
  });
});

// PD-BEHAVIOR-FIDELITY-001 Gate 3 — R3 misclassification replay:
// first user message of the session, no prior assistant turn, classified as a
// correction "of the AI's confirmation behaviour".
describe('Gate 3: no prior assistant behavior raises the confirmation bar', () => {
  const noPrior = { priorAssistantTurnCount: 0 } as const;

  it('a 0.85 correction with no prior assistant turn stays pending instead of being admitted', () => {
    const gate = evaluateStage2ConfidenceGate(result({ confidence: 0.85 }), undefined, noPrior);
    expect(gate.verdict).toBe('pending_low_confidence');
    expect(gate.reason).toContain('no prior assistant behavior');
  });

  it('a genuinely explicit cross-session correction (>= 0.9) is still admitted', () => {
    expect(evaluateStage2ConfidenceGate(result({ confidence: 0.92 }), undefined, noPrior).verdict).toBe('correction');
    expect(evaluateStage2ConfidenceGate(result({ confidence: 1 }), undefined, noPrior).verdict).toBe('correction');
  });

  it('unknown (null) and omitted context keep the pre-Gate-3 threshold', () => {
    expect(evaluateStage2ConfidenceGate(result({ confidence: 0.75 })).verdict).toBe('correction');
    expect(evaluateStage2ConfidenceGate(result({ confidence: 0.75 }), undefined, { priorAssistantTurnCount: null }).verdict).toBe('correction');
  });

  it('a non-zero prior-turn count keeps the normal threshold', () => {
    expect(evaluateStage2ConfidenceGate(result({ confidence: 0.75 }), undefined, { priorAssistantTurnCount: 2 }).verdict).toBe('correction');
  });
});
