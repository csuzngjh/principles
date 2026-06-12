/**
 * Triage Adapter Tests — PEAT-B1
 *
 * Tests the plugin-side adapter that maps hook context to SourceKind
 * and calls the pure triage policy from principles-core.
 *
 * ERR checklist:
 * - ERR-001: Source kind resolved from runtime values, not `as` casts.
 * - ERR-002: Every triage result has reason + nextAction.
 * - ERR-024/025/048: Production-path tests for the adapter.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSourceKind,
  type RawObservation,
  evaluateEvidenceTriage,
  isHighConfidenceUnsafeAction,
} from '../../src/hooks/triage-adapter.js';

// ── resolveSourceKindFromToolFailure ────────────────────────────────────────

describe('resolveSourceKindFromToolFailure', () => {
  it('maps pain tool to agent_on_owner_request with openclaw_context_bound', () => {
    expect(resolveSourceKindFromToolFailure('pain', 'tool_failure', 'openclaw_context_bound')).toBe('agent_on_owner_request');
  });

  it('maps pain tool to owner_reported without openclaw_context_bound', () => {
    expect(resolveSourceKindFromToolFailure('pain', 'tool_failure')).toBe('owner_reported');
    expect(resolveSourceKindFromToolFailure('pain', 'tool_failure', 'automatic_hook')).toBe('owner_reported');
  });

  it('maps skill:pain to agent_on_owner_request with openclaw_context_bound', () => {
    expect(resolveSourceKindFromToolFailure('skill:pain', 'tool_failure', 'openclaw_context_bound')).toBe('agent_on_owner_request');
  });

  it('maps dispatch_error to dispatch_error', () => {
    expect(resolveSourceKindFromToolFailure('read', 'dispatch_error')).toBe('dispatch_error');
  });

  it('maps regular tool failure to tool_failure', () => {
    expect(resolveSourceKindFromToolFailure('write', 'tool_failure')).toBe('tool_failure');
    expect(resolveSourceKindFromToolFailure('exec', 'tool_failure')).toBe('tool_failure');
  });

  it('maps undefined tool name with tool_failure to tool_failure', () => {
    expect(resolveSourceKindFromToolFailure(undefined, 'tool_failure')).toBe('tool_failure');
  });
});

// ── resolveSourceKindFromLlmDetection ───────────────────────────────────────

describe('resolveSourceKindFromLlmDetection', () => {
  it('maps gfi triggered to gfi_threshold', () => {
    expect(resolveSourceKindFromLlmDetection('llm_some_rule', true)).toBe('gfi_threshold');
  });

  it('maps llm_paralysis to llm_paralysis', () => {
    expect(resolveSourceKindFromLlmDetection('llm_paralysis', false)).toBe('llm_paralysis');
  });

  it('maps llm_* detection rules to semantic', () => {
    expect(resolveSourceKindFromLlmDetection('llm_repetition', false)).toBe('semantic');
    expect(resolveSourceKindFromLlmDetection('llm_loop', false)).toBe('semantic');
  });

  it('maps user_empathy to empathy_inferred', () => {
    expect(resolveSourceKindFromLlmDetection('user_empathy', false)).toBe('empathy_inferred');
  });

  it('maps unknown source to unknown', () => {
    expect(resolveSourceKindFromLlmDetection('something_else', false)).toBe('unknown');
  });
});

// ── Other resolve functions ─────────────────────────────────────────────────

describe('resolveSourceKindFromGateBlock', () => {
  it('returns rulehost_block', () => {
    expect(resolveSourceKindFromGateBlock()).toBe('rulehost_block');
  });
});

describe('resolveSourceKindFromCommand', () => {
  it('returns owner_reported', () => {
    expect(resolveSourceKindFromCommand()).toBe('owner_reported');
  });
});

describe('resolveSourceKindFromProvider', () => {
  it('returns provider_failure for non-rate-limit', () => {
    expect(resolveSourceKindFromProvider(false)).toBe('provider_failure');
  });

  it('returns rate_limit for rate-limit', () => {
    expect(resolveSourceKindFromProvider(true)).toBe('rate_limit');
  });
});

describe('resolveSourceKindFromSubagent', () => {
  it('returns subagent_error', () => {
    expect(resolveSourceKindFromSubagent()).toBe('subagent_error');
  });
});

// ── evaluateEvidenceTriage ──────────────────────────────────────────────────

describe('evaluateEvidenceTriage', () => {
  it('admits owner_reported regardless of score', () => {
    const result = evaluateEvidenceTriage('owner_reported', 100);
    expect(result.decision).toBe('admit');
    expect(result.reason).toBeTruthy();
    expect(result.nextAction).toBeTruthy();
  });

  it('returns evidence_only for tool_failure', () => {
    const result = evaluateEvidenceTriage('tool_failure', 70);
    expect(result.decision).toBe('evidence_only');
    expect(result.reason).toBeTruthy();
    expect(result.nextAction).toBeTruthy();
  });

  it('returns health_only for provider_failure', () => {
    const result = evaluateEvidenceTriage('provider_failure', 60);
    expect(result.decision).toBe('health_only');
  });

  it('returns owner_confirm for empathy_inferred', () => {
    const result = evaluateEvidenceTriage('empathy_inferred', 80);
    expect(result.decision).toBe('owner_confirm');
  });

  it('admits rulehost_block when isUnsafeHighConfidence is true', () => {
    const result = evaluateEvidenceTriage('rulehost_block', 80, { isUnsafeHighConfidence: true });
    expect(result.decision).toBe('admit');
  });

  it('returns evidence_only for rulehost_block when isUnsafeHighConfidence is false', () => {
    const result = evaluateEvidenceTriage('rulehost_block', 80, { isUnsafeHighConfidence: false });
    expect(result.decision).toBe('evidence_only');
  });
});

// ── isHighConfidenceUnsafeAction ─────────────────────────────────────────────

describe('isHighConfidenceUnsafeAction', () => {
  it('returns true when isRisky and score >= 70', () => {
    expect(isHighConfidenceUnsafeAction(70, true)).toBe(true);
    expect(isHighConfidenceUnsafeAction(90, true)).toBe(true);
  });

  it('returns false when score < 70', () => {
    expect(isHighConfidenceUnsafeAction(45, true)).toBe(false);
    expect(isHighConfidenceUnsafeAction(69, true)).toBe(false);
  });

  it('returns false when not risky', () => {
    expect(isHighConfidenceUnsafeAction(90, false)).toBe(false);
  });
});

// ── Evidence-Only Cooldown Contract ──────────────────────────────────────────
//
// Core contract: when triage returns evidence_only/owner_confirm/health_only,
// the caller (hook) MUST NOT proceed to evaluatePainDiagnosticGate, which writes
// cooldown. These tests verify the adapter-level guarantee: non-admit decisions
// are surfaced clearly with the right nextAction, so the caller can distinguish
// evidence-only from admit.

describe('evidence-only cooldown contract', () => {
  it('tool_failure returns evidence_only — no admit, caller must skip gate', () => {
    const result = evaluateEvidenceTriage('tool_failure', 70);
    expect(result.decision).toBe('evidence_only');
    expect(result.decision).not.toBe('admit');
    expect(result.nextAction).toContain('evidence');
  });

  it('dispatch_error returns evidence_only — no admit', () => {
    const result = evaluateEvidenceTriage('dispatch_error', 50);
    expect(result.decision).toBe('evidence_only');
    expect(result.decision).not.toBe('admit');
  });

  it('semantic (LLM detection) returns evidence_only — no admit', () => {
    const result = evaluateEvidenceTriage('semantic', 55);
    expect(result.decision).toBe('evidence_only');
    expect(result.decision).not.toBe('admit');
  });

  it('llm_paralysis returns evidence_only — no admit', () => {
    const result = evaluateEvidenceTriage('llm_paralysis', 40);
    expect(result.decision).toBe('evidence_only');
    expect(result.decision).not.toBe('admit');
  });

  it('gfi_threshold returns evidence_only — no admit', () => {
    const result = evaluateEvidenceTriage('gfi_threshold', 70);
    expect(result.decision).toBe('evidence_only');
    expect(result.decision).not.toBe('admit');
  });

  it('empathy_inferred returns owner_confirm — no admit', () => {
    const result = evaluateEvidenceTriage('empathy_inferred', 80);
    expect(result.decision).toBe('owner_confirm');
    expect(result.decision).not.toBe('admit');
  });

  it('provider_failure returns health_only — no admit', () => {
    const result = evaluateEvidenceTriage('provider_failure', 60);
    expect(result.decision).toBe('health_only');
    expect(result.decision).not.toBe('admit');
  });

  it('rulehost_block WITHOUT isUnsafeHighConfidence returns evidence_only — no admit', () => {
    const result = evaluateEvidenceTriage('rulehost_block', 45);
    expect(result.decision).toBe('evidence_only');
    expect(result.decision).not.toBe('admit');
  });

  it('rulehost_block WITH isUnsafeHighConfidence=true upgrades to admit', () => {
    // This is the ONLY path where rulehost_block reaches the gate
    const result = evaluateEvidenceTriage('rulehost_block', 80, { isUnsafeHighConfidence: true });
    expect(result.decision).toBe('admit');
    expect(result.reason).toContain('unsafe');
  });

  it('every LLM-typical source kind produces non-admit decision (cooldown-safe)', () => {
    // These are the source kinds that handleLlmOutput produces
    const llmSources = [
      { kind: 'semantic' as const, score: 55 },
      { kind: 'llm_paralysis' as const, score: 40 },
      { kind: 'gfi_threshold' as const, score: 70 },
      { kind: 'empathy_inferred' as const, score: 80 },
    ];
    for (const { kind, score } of llmSources) {
      const result = evaluateEvidenceTriage(kind, score);
      expect(result.decision).not.toBe('admit');
      expect(result.reason).toBeTruthy();
      expect(result.nextAction).toBeTruthy();
    }
  });

  it('every after_tool_call-typical source kind produces non-admit decision (cooldown-safe)', () => {
    // These are the source kinds that handleAfterToolCall produces
    const toolSources = [
      { kind: 'tool_failure' as const, score: 70 },
      { kind: 'dispatch_error' as const, score: 50 },
    ];
    for (const { kind, score } of toolSources) {
      const result = evaluateEvidenceTriage(kind, score);
      expect(result.decision).not.toBe('admit');
      expect(result.reason).toBeTruthy();
      expect(result.nextAction).toBeTruthy();
    }
  });
});
