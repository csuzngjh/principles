/**
 * Trigger Controller Tests — PEAT-B2
 *
 * Production-path tests for the trigger controller.
 * Every test exercises the full path from input to TriggerDecision,
 * not just helper functions.
 *
 * ERR checklist:
 * - ERR-002: Every path carries reason + nextAction
 * - ERR-009: Malformed input fails loud
 * - ERR-025: Production-path tests, not just helpers
 * - ERR-031/034: Decisions come from canonical descriptors
 * - ERR-048: Write-read disconnect prevented
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateTriggerController,
  shouldCreateTask,
  isAdmittedOutcome,
  isSkippedOutcome,
} from '../trigger-controller.js';
import type { TriggerControllerInput, TriggerDecision } from '../trigger-controller.js';
import { evaluateTriage } from '../triage-policy.js';
import type { TriageResult } from '../types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<TriggerControllerInput> & { triageResult: TriageResult }): TriggerControllerInput {
  return {
    isOwnerManual: false,
    isCooldownActive: false,
    isValid: true,
    score: 50,
    ...overrides,
  };
}

function triageForKind(sourceKind: Parameters<typeof evaluateTriage>[0]['sourceKind'], score = 50): TriageResult {
  return evaluateTriage({ sourceKind, score });
}

// ── Manual Pain → diagnosis_created ─────────────────────────────────────────

describe('manual owner pain', () => {
  it('creates diagnostic task for owner manual pain regardless of source kind', () => {
    const triage = triageForKind('owner_reported', 100);
    const input = makeInput({ triageResult: triage, isOwnerManual: true, score: 100 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('manual_owner_admitted');
    expect(decision.shouldCreateDiagnosticTask).toBe(true);
    expect(decision.reason).toBeTruthy();
    expect(decision.nextAction).toBe('create_diagnostic_task');
  });

  it('bypasses cooldown for owner manual pain', () => {
    const triage = triageForKind('owner_reported', 100);
    const input = makeInput({ triageResult: triage, isOwnerManual: true, score: 100, isCooldownActive: true });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('manual_owner_admitted');
    expect(decision.shouldCreateDiagnosticTask).toBe(true);
  });

  it('bypasses triage for owner manual pain even if triage would reject', () => {
    // owner_reported always admits, but test with a different triage result to show bypass
    const triage: TriageResult = {
      decision: 'evidence_only',
      sourceKind: 'tool_failure',
      reason: 'Tool failure is infrastructure noise.',
      nextAction: 'store_as_evidence',
    };
    const input = makeInput({ triageResult: triage, isOwnerManual: true, score: 100 });
    const decision = evaluateTriggerController(input);

    // Manual pain still creates task even when triage said evidence_only
    expect(decision.outcome).toBe('manual_owner_admitted');
    expect(decision.shouldCreateDiagnosticTask).toBe(true);
  });
});

// ── Tool Failure → evidence_only ────────────────────────────────────────────

describe('tool failure', () => {
  it('records as evidence-only by default', () => {
    const triage = triageForKind('tool_failure', 40);
    const input = makeInput({ triageResult: triage, score: 40 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('evidence_only');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
    expect(decision.reason).toContain('infrastructure');
    expect(decision.nextAction).toBeTruthy();
  });

  it('does not create diagnostic task even at high score', () => {
    const triage = triageForKind('tool_failure', 90);
    const input = makeInput({ triageResult: triage, score: 90 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('evidence_only');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
  });
});

// ── Provider/Rate Limit → health_only ───────────────────────────────────────

describe('provider/rate-limit failure', () => {
  it('records as health-only for provider failure', () => {
    const triage = triageForKind('provider_failure', 30);
    const input = makeInput({ triageResult: triage, score: 30 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('health_only');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
    expect(decision.reason).toContain('Infrastructure');
  });

  it('records as health-only for rate limit', () => {
    const triage = triageForKind('rate_limit', 20);
    const input = makeInput({ triageResult: triage, score: 20 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('health_only');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
  });
});

// ── RuleHost Block → evidence_only (default) / diagnosis_created (upgraded) ─

describe('rulehost block', () => {
  it('records as evidence-only by default', () => {
    const triage = triageForKind('rulehost_block', 50);
    const input = makeInput({ triageResult: triage, score: 50 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('evidence_only');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
  });

  it('creates diagnosis when triage upgrades to admit (high-confidence unsafe)', () => {
    // The triage adapter calls evaluateTriage with isUnsafeHighConfidence=true
    // which upgrades rulehost_block from evidence_only to admit
    const triage: TriageResult = {
      decision: 'admit',
      sourceKind: 'rulehost_block',
      reason: 'RuleHost blocked a high-confidence unsafe action (score=80). Upgrading to direct diagnosis.',
      nextAction: 'none',
    };
    const input = makeInput({ triageResult: triage, score: 80 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('diagnosis_created');
    expect(decision.shouldCreateDiagnosticTask).toBe(true);
  });
});

// ── Empathy Inferred → owner_confirm_required ──────────────────────────────

describe('empathy inferred', () => {
  it('requires owner confirmation', () => {
    const triage = triageForKind('empathy_inferred', 60);
    const input = makeInput({ triageResult: triage, score: 60 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('owner_confirm_required');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
    expect(decision.reason).toContain('Empathy-inferred');
  });
});

// ── Cooldown → cooldown_skipped ─────────────────────────────────────────────

describe('cooldown', () => {
  it('skips diagnosis when cooldown is active', () => {
    // Use a source that would normally admit (e.g., upgraded rulehost_block)
    const triage: TriageResult = {
      decision: 'admit',
      sourceKind: 'rulehost_block',
      reason: 'Upgraded to admit.',
      nextAction: 'none',
    };
    const input = makeInput({ triageResult: triage, score: 80, isCooldownActive: true });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('cooldown_skipped');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
    expect(decision.reason).toContain('cooldown');
    expect(decision.nextAction).toContain('cooldown');
  });

  it('allows diagnosis when cooldown bypass is allowed', () => {
    const triage: TriageResult = {
      decision: 'admit',
      sourceKind: 'owner_reported',
      reason: 'Owner reported.',
      nextAction: 'none',
    };
    const input = makeInput({
      triageResult: triage,
      score: 100,
      isCooldownActive: true,
      cooldownBypassAllowed: true,
    });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('diagnosis_created');
    expect(decision.shouldCreateDiagnosticTask).toBe(true);
  });
});

// ── Malformed Input → refused ──────────────────────────────────────────────

describe('malformed input', () => {
  it('refuses invalid input with reason and nextAction', () => {
    const triage = triageForKind('tool_failure', 40);
    const input = makeInput({
      triageResult: triage,
      isValid: false,
      validationError: 'sourceKind is missing',
      score: 40,
    });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('refused');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
    expect(decision.reason).toContain('sourceKind is missing');
    expect(decision.nextAction).toBeTruthy();
  });

  it('refuses with generic message when no validation error provided', () => {
    const triage = triageForKind('tool_failure', 40);
    const input = makeInput({
      triageResult: triage,
      isValid: false,
      score: 40,
    });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('refused');
    expect(decision.reason).toContain('malformed');
  });
});

// ── Dispatch Error → evidence_only ──────────────────────────────────────────

describe('dispatch error', () => {
  it('records as evidence-only', () => {
    const triage = triageForKind('dispatch_error', 30);
    const input = makeInput({ triageResult: triage, score: 30 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('evidence_only');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
  });
});

// ── Subagent Error → evidence_only ──────────────────────────────────────────

describe('subagent error', () => {
  it('records as evidence-only', () => {
    const triage = triageForKind('subagent_error', 40);
    const input = makeInput({ triageResult: triage, score: 40 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('evidence_only');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
  });
});

// ── Unknown Source → evidence_only ──────────────────────────────────────────

describe('unknown source', () => {
  it('records as evidence-only (conservative default)', () => {
    const triage = triageForKind('unknown', 50);
    const input = makeInput({ triageResult: triage, score: 50 });
    const decision = evaluateTriggerController(input);

    expect(decision.outcome).toBe('evidence_only');
    expect(decision.shouldCreateDiagnosticTask).toBe(false);
  });
});

// ── Helper Functions ────────────────────────────────────────────────────────

describe('helper functions', () => {
  it('shouldCreateTask returns correct boolean', () => {
    const admittedDecision: TriggerDecision = {
      outcome: 'diagnosis_created',
      reason: 'test',
      nextAction: 'test',
      sourceKind: 'owner_reported',
      triageDecision: 'admit',
      shouldCreateDiagnosticTask: true,
      decidedAt: new Date().toISOString(),
    };
    expect(shouldCreateTask(admittedDecision)).toBe(true);

    const evidenceDecision: TriggerDecision = {
      outcome: 'evidence_only',
      reason: 'test',
      nextAction: 'test',
      sourceKind: 'tool_failure',
      triageDecision: 'evidence_only',
      shouldCreateDiagnosticTask: false,
      decidedAt: new Date().toISOString(),
    };
    expect(shouldCreateTask(evidenceDecision)).toBe(false);
  });

  it('isAdmittedOutcome identifies admitted outcomes', () => {
    expect(isAdmittedOutcome('diagnosis_created')).toBe(true);
    expect(isAdmittedOutcome('manual_owner_admitted')).toBe(true);
    expect(isAdmittedOutcome('evidence_only')).toBe(false);
    expect(isAdmittedOutcome('cooldown_skipped')).toBe(false);
    expect(isAdmittedOutcome('refused')).toBe(false);
    expect(isAdmittedOutcome('health_only')).toBe(false);
  });

  it('isSkippedOutcome identifies skipped outcomes', () => {
    expect(isSkippedOutcome('diagnosis_skipped')).toBe(true);
    expect(isSkippedOutcome('cooldown_skipped')).toBe(true);
    expect(isSkippedOutcome('diagnosis_created')).toBe(false);
    expect(isSkippedOutcome('evidence_only')).toBe(false);
  });
});

// ── Structured Fields ───────────────────────────────────────────────────────

describe('structured fields', () => {
  it('every decision has decidedAt timestamp', () => {
    const triage = triageForKind('tool_failure', 40);
    const input = makeInput({ triageResult: triage, score: 40 });
    const decision = evaluateTriggerController(input);

    expect(decision.decidedAt).toBeTruthy();
    expect(new Date(decision.decidedAt).getTime()).not.toBeNaN();
  });

  it('every decision carries the source kind from triage', () => {
    const triage = triageForKind('tool_failure', 40);
    const input = makeInput({ triageResult: triage, score: 40 });
    const decision = evaluateTriggerController(input);

    expect(decision.sourceKind).toBe('tool_failure');
  });

  it('every decision carries the triage decision', () => {
    const triage = triageForKind('tool_failure', 40);
    const input = makeInput({ triageResult: triage, score: 40 });
    const decision = evaluateTriggerController(input);

    expect(decision.triageDecision).toBe('evidence_only');
  });

  it('every decision has a non-empty reason', () => {
    for (const kind of ['owner_reported', 'tool_failure', 'provider_failure', 'rate_limit', 'rulehost_block', 'empathy_inferred', 'dispatch_error', 'subagent_error', 'unknown'] as const) {
      const triage = triageForKind(kind, 50);
      const input = makeInput({ triageResult: triage, score: 50 });
      const decision = evaluateTriggerController(input);

      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.nextAction.length).toBeGreaterThan(0);
    }
  });
});

// ── Privacy Boundary ────────────────────────────────────────────────────────

describe('privacy boundary', () => {
  it('no raw sensitive data in trigger decisions', () => {
    const triage = triageForKind('tool_failure', 40);
    const input = makeInput({
      triageResult: triage,
      score: 40,
      sessionId: 'session_with_sensitive_data_sk-1234567890abcdef1234567890abcdef',
    });
    const decision = evaluateTriggerController(input);

    const serialized = JSON.stringify(decision);
    // Should not contain raw API keys
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    // Should not contain absolute paths
    expect(serialized).not.toMatch(/[A-Z]:\\/);
  });
});
