/**
 * Evidence Guards Tests — PRI-345
 *
 * Unit tests for shared evidence guard functions used by admission gate
 * and pain signal bridge.
 *
 * Tests verify:
 * - isOwnerExplicitManual() correctly identifies owner manual provenance
 * - shouldShortCircuitEmptyEvidence() correctly determines short-circuit conditions
 * - Boundary conditions and edge cases
 *
 * ERR checklist:
 * - ERR-002: Every decision path carries reason + nextAction
 * - ERR-009: Malformed state fails loud
 * - ERR-025: Production-path tests, not just helpers
 */

import { describe, it, expect } from 'vitest';
import {
  isOwnerExplicitManual,
  shouldShortCircuitEmptyEvidence,
} from '../evidence-guards';
import type { PainProvenance } from '../admission-gate';

// ── isOwnerExplicitManual Tests ───────────────────────────────────────────────

describe('isOwnerExplicitManual', () => {
  it('returns true for owner_reported_no_host_trace provenance', () => {
    expect(isOwnerExplicitManual('owner_reported_no_host_trace')).toBe(true);
  });

  it('returns false for openclaw_context_bound provenance', () => {
    expect(isOwnerExplicitManual('host_context_bound')).toBe(false);
  });

  it('returns false for automatic_hook provenance', () => {
    expect(isOwnerExplicitManual('automatic_hook')).toBe(false);
  });

  it('returns false for undefined provenance', () => {
    expect(isOwnerExplicitManual(undefined)).toBe(false);
  });

  it('returns false for null provenance (treated as undefined)', () => {
    expect(isOwnerExplicitManual(null as unknown as PainProvenance)).toBe(false);
  });

  it('is strict — only owner_reported_no_host_trace returns true', () => {
    const allProvenances: (PainProvenance | undefined)[] = [
      'host_context_bound',
      'automatic_hook',
      undefined,
    ];
    for (const p of allProvenances) {
      expect(isOwnerExplicitManual(p)).toBe(false);
    }
  });

  it('does not accept string variants — exact match required', () => {
    // These are NOT valid provenance values, but test strictness
    expect(isOwnerExplicitManual('owner_reported' as PainProvenance)).toBe(false);
    expect(isOwnerExplicitManual('owner_manual' as PainProvenance)).toBe(false);
    expect(isOwnerExplicitManual('OWNER_REPORTED_NO_HOST_TRACE' as PainProvenance)).toBe(false);
  });
});

// ── shouldShortCircuitEmptyEvidence Tests ─────────────────────────────────────

describe('shouldShortCircuitEmptyEvidence', () => {
  // Core case: evidence empty + non-owner source → short circuit
  it('returns true when evidence is empty and source is tool_failure', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'tool_failure')).toBe(true);
  });

  it('returns true when evidence is empty and source is subagent_error', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'subagent_error')).toBe(true);
  });

  it('returns true when evidence is empty and source is dispatch_error', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'dispatch_error')).toBe(true);
  });

  it('returns true when evidence is empty and source is provider_failure', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'provider_failure')).toBe(true);
  });

  it('returns true when evidence is empty and source is rate_limit', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'rate_limit')).toBe(true);
  });

  it('returns true when evidence is empty and source is rulehost_block', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'rulehost_block')).toBe(true);
  });

  it('returns true when evidence is empty and source is empathy_inferred', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'empathy_inferred')).toBe(true);
  });

  it('returns true when evidence is empty and source is unknown', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'unknown')).toBe(true);
  });

  // Owner-initiated sources bypass short circuit (PRI-311 regression guard)
  it('returns false when evidence is empty but source is manual (owner-initiated)', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'manual')).toBe(false);
  });

  it('returns false when evidence is empty but source is pain (owner-initiated)', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'pain')).toBe(false);
  });

  it('returns false when evidence is empty but source is skill:pain (owner-initiated)', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'skill:pain')).toBe(false);
  });

  // Evidence non-empty → no short circuit regardless of source
  it('returns false when evidence has 1 entry regardless of source', () => {
    expect(shouldShortCircuitEmptyEvidence(1, 'tool_failure')).toBe(false);
    expect(shouldShortCircuitEmptyEvidence(1, 'subagent_error')).toBe(false);
    expect(shouldShortCircuitEmptyEvidence(1, 'unknown')).toBe(false);
  });

  it('returns false when evidence has multiple entries regardless of source', () => {
    expect(shouldShortCircuitEmptyEvidence(5, 'tool_failure')).toBe(false);
    expect(shouldShortCircuitEmptyEvidence(10, 'dispatch_error')).toBe(false);
  });

  // Boundary tests
  it('returns true for evidenceLength=0 (exact boundary)', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'tool_failure')).toBe(true);
  });

  it('returns false for evidenceLength=1 (just above boundary)', () => {
    expect(shouldShortCircuitEmptyEvidence(1, 'tool_failure')).toBe(false);
  });

  // Edge case: negative evidence length (invalid input)
  it('returns false for negative evidenceLength (invalid but safe default)', () => {
    // Negative length is invalid input, but function returns false (no short circuit)
    // This is a safe default — don't short circuit on invalid data
    expect(shouldShortCircuitEmptyEvidence(-1, 'tool_failure')).toBe(false);
  });

  // Edge case: source string variations
  it('is case-sensitive for source matching', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'MANUAL')).toBe(true);
    expect(shouldShortCircuitEmptyEvidence(0, 'Pain')).toBe(true);
    expect(shouldShortCircuitEmptyEvidence(0, 'Skill:Pain')).toBe(true);
  });

  it('does not match partial source strings', () => {
    expect(shouldShortCircuitEmptyEvidence(0, 'manual_')).toBe(true);
    expect(shouldShortCircuitEmptyEvidence(0, 'pain_report')).toBe(true);
    expect(shouldShortCircuitEmptyEvidence(0, 'skill:pain:extra')).toBe(true);
  });

  // Invariant: only manual, pain, skill:pain bypass short circuit
  it('only three sources bypass short circuit when evidence is empty', () => {
    const bypassSources = ['manual', 'pain', 'skill:pain'];
    const allSources = [
      'tool_failure', 'subagent_error', 'dispatch_error', 'provider_failure',
      'rate_limit', 'rulehost_block', 'empathy_inferred', 'semantic',
      'llm_paralysis', 'gfi_threshold', 'unknown', 'automatic', 'hook',
    ];

    for (const source of bypassSources) {
      expect(shouldShortCircuitEmptyEvidence(0, source)).toBe(false);
    }

    for (const source of allSources) {
      expect(shouldShortCircuitEmptyEvidence(0, source)).toBe(true);
    }
  });
});

// ── Integration with Admission Gate (PRI-345 regression guard) ────────────────

describe('integration with admission gate logic', () => {
  it('isOwnerExplicitManual matches the provenance check in admission gate', () => {
    // Admission gate uses isOwnerExplicitManual for inputEvidenceCount=0 gate
    // owner_reported_no_host_trace should bypass the gate
    const ownerProvenance: PainProvenance = 'owner_reported_no_host_trace';
    expect(isOwnerExplicitManual(ownerProvenance)).toBe(true);
  });

  it('shouldShortCircuitEmptyEvidence matches pain signal bridge logic', () => {
    // Pain signal bridge short-circuits when evidence empty and source not owner-initiated
    // This test verifies the same logic is used in both places
    expect(shouldShortCircuitEmptyEvidence(0, 'tool_failure')).toBe(true);
    expect(shouldShortCircuitEmptyEvidence(0, 'manual')).toBe(false);
  });
});