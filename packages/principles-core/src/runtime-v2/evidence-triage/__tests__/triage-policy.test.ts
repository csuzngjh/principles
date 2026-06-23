/**
 * Triage Policy Tests — PEAT-B1
 *
 * Tests the pure triage policy evaluation.
 * No I/O, no plugin imports, no mocks needed.
 *
 * ERR checklist:
 * - ERR-001: Validates that source kind is runtime-checked, not cast.
 * - ERR-002: Validates that every result has reason + nextAction.
 * - ERR-024/025/048: Tests exercise the production evaluateTriage path.
 */

import { describe, it, expect } from 'vitest';
import { evaluateTriage, RISKY_HIGH_SCORE_THRESHOLD, REPEATED_FAILURE_THRESHOLD } from '../triage-policy.js';
import type { TriageInput, TriageResult, SourceKind } from '../types.js';
import { isSourceKind } from '../types.js';
import { getSourceDescriptor, SOURCE_DESCRIPTORS } from '../source-descriptors.js';

// ── Helper ──────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    sourceKind: 'unknown',
    score: 50,
    ...overrides,
  };
}

function assertHasReasonAndNextAction(result: TriageResult): void {
  expect(result.reason).toBeTruthy();
  expect(result.reason.length).toBeGreaterThan(0);
  expect(result.nextAction).toBeTruthy();
  expect(result.nextAction.length).toBeGreaterThan(0);
}

// ── Source Kind Validation ───────────────────────────────────────────────────

describe('isSourceKind', () => {
  it('accepts valid source kinds', () => {
    expect(isSourceKind('owner_reported')).toBe(true);
    expect(isSourceKind('tool_failure')).toBe(true);
    expect(isSourceKind('empathy_inferred')).toBe(true);
    expect(isSourceKind('unknown')).toBe(true);
  });

  it('rejects invalid source kinds', () => {
    expect(isSourceKind('not_a_kind')).toBe(false);
    expect(isSourceKind('')).toBe(false);
    expect(isSourceKind(null)).toBe(false);
    expect(isSourceKind(undefined)).toBe(false);
    expect(isSourceKind(42)).toBe(false);
  });
});

// ── Source Descriptors ───────────────────────────────────────────────────────

describe('getSourceDescriptor', () => {
  it('returns descriptor for every registered kind', () => {
    const kinds = [
      'owner_reported', 'agent_on_owner_request', 'tool_failure', 'dispatch_error',
      'provider_failure', 'rate_limit', 'rulehost_block', 'empathy_inferred',
      'semantic', 'llm_paralysis', 'subagent_error', 'gfi_threshold', 'unknown',
    ] as const;
    for (const kind of kinds) {
      const desc = getSourceDescriptor(kind);
      expect(desc).toBeDefined();
      if (!desc) throw new Error(`descriptor missing for ${kind}`);
      expect(desc.kind).toBe(kind);
    }
  });

  it('returns undefined for unregistered kind', () => {
    // isSourceKind would return false for this, but descriptor lookup still works
    const fakeKind = 'not_a_kind';
    expect(getSourceDescriptor(fakeKind as SourceKind)).toBeUndefined();
  });

  it('has exactly 13 registered descriptors', () => {
    expect(SOURCE_DESCRIPTORS.size).toBe(13);
  });
});

// ── Owner-Reported Pain ─────────────────────────────────────────────────────

describe('owner_reported', () => {
  it('admits with direct diagnosis', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'owner_reported', score: 100 }));
    expect(result.decision).toBe('admit');
    expect(result.sourceKind).toBe('owner_reported');
    assertHasReasonAndNextAction(result);
  });

  it('admits regardless of score', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'owner_reported', score: 10 }));
    expect(result.decision).toBe('admit');
  });
});

describe('agent_on_owner_request', () => {
  it('admits with direct diagnosis', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'agent_on_owner_request', score: 90 }));
    expect(result.decision).toBe('admit');
    assertHasReasonAndNextAction(result);
  });
});

// ── Tool Failure ─────────────────────────────────────────────────────────────

describe('tool_failure', () => {
  it('defaults to evidence_only', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'tool_failure', score: 70 }));
    expect(result.decision).toBe('evidence_only');
    assertHasReasonAndNextAction(result);
  });

  it('does not admit regardless of score', () => {
    const high = evaluateTriage(makeInput({ sourceKind: 'tool_failure', score: 95 }));
    expect(high.decision).toBe('evidence_only');
    const low = evaluateTriage(makeInput({ sourceKind: 'tool_failure', score: 10 }));
    expect(low.decision).toBe('evidence_only');
  });
});

// ── Dispatch Error ───────────────────────────────────────────────────────────

describe('dispatch_error', () => {
  it('defaults to evidence_only', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'dispatch_error', score: 50 }));
    expect(result.decision).toBe('evidence_only');
    assertHasReasonAndNextAction(result);
  });
});

// ── Provider / Rate Limit ───────────────────────────────────────────────────

describe('provider_failure', () => {
  it('defaults to health_only', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'provider_failure', score: 60 }));
    expect(result.decision).toBe('health_only');
    assertHasReasonAndNextAction(result);
  });
});

describe('rate_limit', () => {
  it('defaults to health_only', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'rate_limit', score: 40 }));
    expect(result.decision).toBe('health_only');
    assertHasReasonAndNextAction(result);
  });
});

// ── RuleHost Block ───────────────────────────────────────────────────────────

describe('rulehost_block', () => {
  it('defaults to evidence_only', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'rulehost_block', score: 45 }));
    expect(result.decision).toBe('evidence_only');
    assertHasReasonAndNextAction(result);
  });

  it('upgrades to admit when isUnsafeHighConfidence is true', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'rulehost_block',
      score: 80,
      isUnsafeHighConfidence: true,
    }));
    expect(result.decision).toBe('admit');
    expect(result.reason).toContain('unsafe');
    assertHasReasonAndNextAction(result);
  });

  it('stays evidence_only when isUnsafeHighConfidence is false', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'rulehost_block',
      score: 80,
      isUnsafeHighConfidence: false,
    }));
    expect(result.decision).toBe('evidence_only');
  });

  it('stays evidence_only when isUnsafeHighConfidence is undefined', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'rulehost_block',
      score: 80,
    }));
    expect(result.decision).toBe('evidence_only');
  });
});

// ── PRI-446: migrated upgrade rules (risky high-score, repeated failure) ────

describe('PRI-446 upgrade thresholds', () => {
  it('RISKY_HIGH_SCORE_THRESHOLD is 70 (matches prior plugin magic number)', () => {
    expect(RISKY_HIGH_SCORE_THRESHOLD).toBe(70);
  });

  it('REPEATED_FAILURE_THRESHOLD is 4 (matches prior plugin magic number)', () => {
    expect(REPEATED_FAILURE_THRESHOLD).toBe(4);
  });
});

describe('PRI-446 risky high-score upgrade', () => {
  it('upgrades tool_failure to admit when isRisky && score >= 70', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'tool_failure',
      score: 70,
      isRisky: true,
    }));
    expect(result.decision).toBe('admit');
    // Verbatim string from the prior plugin triage-adapter
    expect(result.reason).toBe('Risky high-score operation overrides evidence-only decision. Immediate diagnosis required.');
    expect(result.nextAction).toBe('create_diagnostic_task');
  });

  it('stays evidence_only when score is below 70 even if risky', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'tool_failure',
      score: 69,
      isRisky: true,
    }));
    expect(result.decision).toBe('evidence_only');
  });

  it('stays evidence_only when not risky even with high score', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'tool_failure',
      score: 95,
      isRisky: false,
    }));
    expect(result.decision).toBe('evidence_only');
  });

  it('upgrades any evidence_only kind, not just tool_failure', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'semantic',
      score: 75,
      isRisky: true,
    }));
    expect(result.decision).toBe('admit');
  });

  it('never upgrades a non-evidence_only kind (health_only stays health_only)', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'provider_failure',
      score: 90,
      isRisky: true,
    }));
    expect(result.decision).toBe('health_only');
  });
});

describe('PRI-446 repeated-failure upgrade', () => {
  it('upgrades tool_failure to admit when consecutiveErrors >= 4', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'tool_failure',
      score: 50,
      consecutiveErrors: 4,
    }));
    expect(result.decision).toBe('admit');
    // Verbatim string from the prior plugin triage-adapter
    expect(result.reason).toBe('Repeated failures override evidence-only decision. Pattern suggests systemic issue requiring diagnosis.');
    expect(result.nextAction).toBe('create_diagnostic_task');
  });

  it('stays evidence_only when consecutiveErrors is below 4', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'tool_failure',
      score: 50,
      consecutiveErrors: 3,
    }));
    expect(result.decision).toBe('evidence_only');
  });

  it('stays evidence_only when consecutiveErrors is undefined', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'tool_failure',
      score: 50,
    }));
    expect(result.decision).toBe('evidence_only');
  });

  it('upgrades even at low score when consecutiveErrors >= 4', () => {
    const result = evaluateTriage(makeInput({
      sourceKind: 'tool_failure',
      score: 5,
      consecutiveErrors: 10,
    }));
    expect(result.decision).toBe('admit');
  });
});

describe('PRI-446 upgrade rule precedence', () => {
  it('risky high-score takes precedence (checked first) when both conditions hold', () => {
    // Both risky-high-score and repeated-failure are true; risky reason wins.
    const result = evaluateTriage(makeInput({
      sourceKind: 'tool_failure',
      score: 80,
      isRisky: true,
      consecutiveErrors: 10,
    }));
    expect(result.decision).toBe('admit');
    expect(result.reason).toBe('Risky high-score operation overrides evidence-only decision. Immediate diagnosis required.');
  });
});

// ── Empathy Inferred ─────────────────────────────────────────────────────────

describe('empathy_inferred', () => {
  it('defaults to owner_confirm — never directly creates diagnosis', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'empathy_inferred', score: 80 }));
    expect(result.decision).toBe('owner_confirm');
    assertHasReasonAndNextAction(result);
  });

  it('never admits regardless of score', () => {
    const high = evaluateTriage(makeInput({ sourceKind: 'empathy_inferred', score: 100 }));
    expect(high.decision).toBe('owner_confirm');
    const low = evaluateTriage(makeInput({ sourceKind: 'empathy_inferred', score: 10 }));
    expect(low.decision).toBe('owner_confirm');
  });
});

// ── Semantic ─────────────────────────────────────────────────────────────────

describe('semantic', () => {
  it('defaults to evidence_only', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'semantic', score: 55 }));
    expect(result.decision).toBe('evidence_only');
    assertHasReasonAndNextAction(result);
  });
});

// ── LLM Paralysis ───────────────────────────────────────────────────────────

describe('llm_paralysis', () => {
  it('defaults to evidence_only', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'llm_paralysis', score: 40 }));
    expect(result.decision).toBe('evidence_only');
    assertHasReasonAndNextAction(result);
  });
});

// ── Subagent Error ───────────────────────────────────────────────────────────

describe('subagent_error', () => {
  it('defaults to evidence_only', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'subagent_error', score: 60 }));
    expect(result.decision).toBe('evidence_only');
    assertHasReasonAndNextAction(result);
  });
});

// ── GFI Threshold ───────────────────────────────────────────────────────────

describe('gfi_threshold', () => {
  it('defaults to evidence_only — GFI alone cannot create diagnosis', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'gfi_threshold', score: 70 }));
    expect(result.decision).toBe('evidence_only');
    assertHasReasonAndNextAction(result);
  });
});

// ── Unknown Source ───────────────────────────────────────────────────────────

describe('unknown', () => {
  it('defaults to evidence_only', () => {
    const result = evaluateTriage(makeInput({ sourceKind: 'unknown', score: 50 }));
    expect(result.decision).toBe('evidence_only');
    assertHasReasonAndNextAction(result);
  });
});

describe('invalid source kind (falls back to unknown)', () => {
  it('treats invalid source kind as unknown', () => {
    const fakeKind = 'not_a_kind';
    const result = evaluateTriage(makeInput({ sourceKind: fakeKind as SourceKind, score: 50 }));
    expect(result.decision).toBe('evidence_only');
    expect(result.sourceKind).toBe('unknown');
    assertHasReasonAndNextAction(result);
  });
});

// ── Invariants ───────────────────────────────────────────────────────────────

describe('invariants', () => {
  it('every result has decision, sourceKind, reason, and nextAction', () => {
    const kinds = [
      'owner_reported', 'agent_on_owner_request', 'tool_failure', 'dispatch_error',
      'provider_failure', 'rate_limit', 'rulehost_block', 'empathy_inferred',
      'semantic', 'llm_paralysis', 'subagent_error', 'gfi_threshold', 'unknown',
    ] as const;
    for (const kind of kinds) {
      const result = evaluateTriage(makeInput({ sourceKind: kind, score: 50 }));
      assertHasReasonAndNextAction(result);
      expect(result.sourceKind).toBe(kind);
      expect(typeof result.decision).toBe('string');
    }
  });

  it('owner_reported always admits', () => {
    for (const score of [0, 25, 50, 75, 100]) {
      const result = evaluateTriage(makeInput({ sourceKind: 'owner_reported', score }));
      expect(result.decision).toBe('admit');
    }
  });

  it('empathy_inferred never admits directly', () => {
    for (const score of [0, 25, 50, 75, 100]) {
      const result = evaluateTriage(makeInput({ sourceKind: 'empathy_inferred', score }));
      expect(result.decision).not.toBe('admit');
    }
  });

  it('GFI never admits directly', () => {
    for (const score of [0, 50, 80, 100]) {
      const result = evaluateTriage(makeInput({ sourceKind: 'gfi_threshold', score }));
      expect(result.decision).not.toBe('admit');
    }
  });

  it('tool_failure never admits', () => {
    for (const score of [0, 30, 60, 90, 100]) {
      const result = evaluateTriage(makeInput({ sourceKind: 'tool_failure', score }));
      expect(result.decision).not.toBe('admit');
    }
  });
});
