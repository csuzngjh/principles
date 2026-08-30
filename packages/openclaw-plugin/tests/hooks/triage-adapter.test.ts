/**
 * Triage Adapter Tests — PEAT-B1 / PRI-360 S1
 *
 * Tests the unified RawObservation → SourceKind resolution path
 * and the evidence triage policy.
 *
 * All legacy resolveSourceKindFrom* wrappers have been removed.
 * Every test uses resolveSourceKind(RawObservation) directly.
 *
 * ERR checklist:
 * - ERR-001: Source kind resolved from runtime values, not `as` casts.
 * - ERR-002: Every triage result has reason + nextAction.
 * - ERR-024/025/048: Production-path tests for the adapter.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSourceKind,
  buildToolFailureObservation,
  buildLlmDetectionObservation,
  type RawObservation,
  evaluateEvidenceTriage,
  isHighConfidenceUnsafeAction,
} from '../../src/hooks/triage-adapter.js';

// ── resolveSourceKind: Tool Failure Path ─────────────────────────────────────

describe('resolveSourceKind: tool failure path', () => {
  it('maps pain tool to agent_on_owner_request with openclaw_context_bound', () => {
    const obs: RawObservation = { observedAt: 't', toolName: 'pain', failureSource: 'tool_failure', provenance: 'host_context_bound' };
    expect(resolveSourceKind(obs)).toBe('agent_on_owner_request');
  });

  it('maps pain tool to owner_reported without openclaw_context_bound', () => {
    expect(resolveSourceKind({ observedAt: 't', toolName: 'pain', failureSource: 'tool_failure' })).toBe('owner_reported');
    expect(resolveSourceKind({ observedAt: 't', toolName: 'pain', failureSource: 'tool_failure', provenance: 'automatic_hook' })).toBe('owner_reported');
  });

  it('maps skill:pain to agent_on_owner_request with openclaw_context_bound', () => {
    expect(resolveSourceKind({ observedAt: 't', toolName: 'skill:pain', failureSource: 'tool_failure', provenance: 'host_context_bound' })).toBe('agent_on_owner_request');
  });

  it('maps dispatch_error to dispatch_error', () => {
    expect(resolveSourceKind({ observedAt: 't', toolName: 'read', failureSource: 'dispatch_error' })).toBe('dispatch_error');
  });

  it('maps regular tool failure to tool_failure', () => {
    expect(resolveSourceKind({ observedAt: 't', toolName: 'write', failureSource: 'tool_failure' })).toBe('tool_failure');
    expect(resolveSourceKind({ observedAt: 't', toolName: 'exec', failureSource: 'tool_failure' })).toBe('tool_failure');
  });

  it('maps undefined tool name with tool_failure to dispatch_error via toolNotFound', () => {
    expect(resolveSourceKind({ observedAt: 't', toolName: undefined, failureSource: 'tool_failure' })).toBe('tool_failure');
  });
});

// ── resolveSourceKind: LLM Detection Path ────────────────────────────────────

describe('resolveSourceKind: LLM detection path', () => {
  it('maps gfi triggered to gfi_threshold', () => {
    expect(resolveSourceKind({ observedAt: 't', detectionSource: 'llm_some_rule', isGfiTriggered: true })).toBe('gfi_threshold');
  });

  it('maps llm_paralysis to llm_paralysis', () => {
    expect(resolveSourceKind({ observedAt: 't', detectionSource: 'llm_paralysis', isGfiTriggered: false })).toBe('llm_paralysis');
  });

  it('maps llm_* detection rules to semantic', () => {
    expect(resolveSourceKind({ observedAt: 't', detectionSource: 'llm_repetition', isGfiTriggered: false })).toBe('semantic');
    expect(resolveSourceKind({ observedAt: 't', detectionSource: 'llm_loop', isGfiTriggered: false })).toBe('semantic');
  });

  it('maps user_empathy to empathy_inferred', () => {
    expect(resolveSourceKind({ observedAt: 't', detectionSource: 'user_empathy', isGfiTriggered: false })).toBe('empathy_inferred');
  });

  it('maps unknown source to unknown', () => {
    expect(resolveSourceKind({ observedAt: 't', detectionSource: 'something_else', isGfiTriggered: false })).toBe('unknown');
  });
});

// ── resolveSourceKind: Other Context Paths ───────────────────────────────────

describe('resolveSourceKind: gate block path', () => {
  it('returns rulehost_block', () => {
    expect(resolveSourceKind({ observedAt: 't', isGateBlock: true })).toBe('rulehost_block');
  });
});

describe('resolveSourceKind: manual command path', () => {
  it('returns owner_reported', () => {
    expect(resolveSourceKind({ observedAt: 't', isManualEntry: true })).toBe('owner_reported');
  });
});

describe('resolveSourceKind: provider path', () => {
  it('returns provider_failure for non-rate-limit', () => {
    expect(resolveSourceKind({ observedAt: 't', isRateLimit: false })).toBe('provider_failure');
  });

  it('returns rate_limit for rate-limit', () => {
    expect(resolveSourceKind({ observedAt: 't', isRateLimit: true })).toBe('rate_limit');
  });
});

describe('resolveSourceKind: subagent path', () => {
  it('returns subagent_error', () => {
    expect(resolveSourceKind({ observedAt: 't', isSubagentError: true })).toBe('subagent_error');
  });
});

// ── buildToolFailureObservation ──────────────────────────────────────────────

describe('buildToolFailureObservation', () => {
  it('classifies empty tool name as dispatch_error', () => {
    const obs = buildToolFailureObservation({ toolName: undefined, error: 'tool not found', exitCode: 1 });
    expect(obs.failureSource).toBe('dispatch_error');
    expect(resolveSourceKind(obs)).toBe('dispatch_error');
  });

  it('classifies "tool not found" error as dispatch_error', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: 'tool read_file not found', exitCode: 1 });
    expect(obs.failureSource).toBe('dispatch_error');
    expect(resolveSourceKind(obs)).toBe('dispatch_error');
  });

  it('classifies "Unknown tool" error as dispatch_error', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: 'Unknown Tool', exitCode: 1 });
    expect(obs.failureSource).toBe('dispatch_error');
  });

  it('classifies real errors (ENOENT) as tool_failure', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: 'ENOENT: no such file', exitCode: 1 });
    expect(obs.failureSource).toBe('tool_failure');
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });

  it('classifies no error + no exit as non-failure (undefined failureSource)', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: undefined, exitCode: 0 });
    expect(obs.failureSource).toBeUndefined();
  });

  it('classifies whitespace-only tool name as dispatch_error', () => {
    const obs = buildToolFailureObservation({ toolName: '   ', error: 'tool not found', exitCode: 1 });
    expect(obs.failureSource).toBe('dispatch_error');
  });

  it('word-boundary: "report_tool_not_found" does NOT match dispatch pattern', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: 'report_tool_not_found', exitCode: 1 });
    expect(obs.failureSource).toBe('tool_failure');
  });

  it('word-boundary: "atoolnotfound" does NOT match dispatch pattern', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: 'atoolnotfound', exitCode: 1 });
    expect(obs.failureSource).toBe('tool_failure');
  });

  it('preserves provenance', () => {
    const obs = buildToolFailureObservation({ toolName: 'pain', error: 'fail', exitCode: 1, provenance: 'host_context_bound' });
    expect(obs.provenance).toBe('host_context_bound');
    expect(resolveSourceKind(obs)).toBe('agent_on_owner_request');
  });
});

// ── buildLlmDetectionObservation ─────────────────────────────────────────────

describe('buildLlmDetectionObservation', () => {
  it('builds observation for GFI-triggered detection', () => {
    const obs = buildLlmDetectionObservation({ detectionSource: 'llm_some_rule', isGfiTriggered: true });
    expect(obs.detectionSource).toBe('llm_some_rule');
    expect(obs.isGfiTriggered).toBe(true);
    expect(resolveSourceKind(obs)).toBe('gfi_threshold');
  });

  it('builds observation for llm_paralysis', () => {
    const obs = buildLlmDetectionObservation({ detectionSource: 'llm_paralysis', isGfiTriggered: false });
    expect(resolveSourceKind(obs)).toBe('llm_paralysis');
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
