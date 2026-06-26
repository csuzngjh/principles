/**
 * IntentPatchProposal tests (PRI-471, SPEC §10).
 *
 * Verifies the read-only patch proposal generator:
 * - Deterministic id derived from decisionId
 * - SPEC §10 markdown format (Reason, Related INTENT Fields, Evidence, Proposed Diff, Risk)
 * - "Display only" warning present (cannot be auto-applied)
 * - Evidence truncated to max 3 items
 * - Handles empty fields gracefully
 *
 * ERR checklist:
 * - EP-01: pure function over already-validated IntentDecisionRecord — no untrusted input
 * - EP-09: pure function, independently testable
 */
import { describe, it, expect } from 'vitest';
import { generateIntentPatchProposal } from '../intent-patch-proposal.js';
import type { IntentDecisionRecord } from '../intent-decision-record.js';

function makeRecord(overrides: Partial<IntentDecisionRecord> = {}): IntentDecisionRecord {
  return {
    id: 'rec-test-1',
    source: 'action_drift',
    evidenceStrength: 'moderate',
    relatedIntentFields: ['why', 'desired_outcome'],
    ownerAction: 'revise_intent',
    evidenceRefs: ['ev-1', 'ev-2'],
    createdAt: '2026-06-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('generateIntentPatchProposal', () => {
  it('returns a proposal with a deterministic id derived from decisionId', () => {
    const decision = makeRecord({ id: 'rec-abc' });
    const proposal = generateIntentPatchProposal(decision);
    expect(proposal.id).toBe('patch-rec-abc');
    expect(proposal.decisionId).toBe('rec-abc');
  });

  it('markdown contains the SPEC §10 section headers', () => {
    const proposal = generateIntentPatchProposal(makeRecord());
    expect(proposal.markdown).toContain('## Intent Patch Proposal');
    expect(proposal.markdown).toContain('### Reason');
    expect(proposal.markdown).toContain('### Related INTENT Fields');
    expect(proposal.markdown).toContain('### Evidence');
    expect(proposal.markdown).toContain('### Proposed Diff');
    expect(proposal.markdown).toContain('### Risk');
  });

  it('markdown contains the "Display only" warning (SPEC §22.1.4)', () => {
    const proposal = generateIntentPatchProposal(makeRecord());
    expect(proposal.markdown).toContain('Display only');
    expect(proposal.markdown).toContain('cannot be auto-applied');
    expect(proposal.markdown).toContain('.principles/INTENT.md');
  });

  it('reason summarizes ownerAction, source, and evidenceStrength', () => {
    const decision = makeRecord({
      ownerAction: 'revise_intent',
      source: 'intent_suspect',
      evidenceStrength: 'strong',
    });
    const proposal = generateIntentPatchProposal(decision);
    expect(proposal.markdown).toContain('Owner decision: revise_intent');
    expect(proposal.markdown).toContain('Source: intent_suspect');
    expect(proposal.markdown).toContain('Evidence strength: strong');
  });

  it('lists human-readable labels for related INTENT fields', () => {
    const decision = makeRecord({
      relatedIntentFields: ['why', 'desired_outcome', 'current_strategic_focus'],
    });
    const proposal = generateIntentPatchProposal(decision);
    expect(proposal.markdown).toContain('Why');
    expect(proposal.markdown).toContain('Desired Outcome');
    expect(proposal.markdown).toContain('Current Strategic Focus');
  });

  it('falls back to the raw field name for unknown IntentRelatedField values', () => {
    // Defensive: if a new IntentRelatedField is added to the enum but not to
    // FIELD_LABELS, the raw value should appear (not undefined or [object Object]).
    const decision = makeRecord({
      relatedIntentFields: ['why', 'unknown_field' as 'why'],
    });
    const proposal = generateIntentPatchProposal(decision);
    expect(proposal.markdown).toContain('Why');
    expect(proposal.markdown).toContain('unknown_field');
  });

  it('truncates evidence to 3 items', () => {
    const decision = makeRecord({
      evidenceRefs: ['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5'],
    });
    const proposal = generateIntentPatchProposal(decision);
    expect(proposal.markdown).toContain('Evidence 1: ev-1');
    expect(proposal.markdown).toContain('Evidence 2: ev-2');
    expect(proposal.markdown).toContain('Evidence 3: ev-3');
    expect(proposal.markdown).not.toContain('ev-4');
    expect(proposal.markdown).not.toContain('ev-5');
  });

  it('shows "No evidence recorded" when evidenceRefs is empty', () => {
    const decision = makeRecord({ evidenceRefs: [] });
    const proposal = generateIntentPatchProposal(decision);
    expect(proposal.markdown).toContain('No evidence recorded.');
  });

  it('shows "No specific fields identified" when relatedIntentFields is empty', () => {
    const decision = makeRecord({ relatedIntentFields: [] });
    const proposal = generateIntentPatchProposal(decision);
    expect(proposal.markdown).toContain('No specific fields identified.');
  });

  it('proposed diff is a placeholder — PD does not auto-generate diff content', () => {
    const proposal = generateIntentPatchProposal(makeRecord());
    expect(proposal.markdown).toContain('```diff');
    expect(proposal.markdown).toContain('placeholder');
    expect(proposal.markdown).toContain('PD does not auto-generate diff content');
  });

  it('risk section explains both "if modified" and "if not modified" outcomes', () => {
    const proposal = generateIntentPatchProposal(makeRecord());
    expect(proposal.markdown).toContain('If modified:');
    expect(proposal.markdown).toContain('If not modified:');
  });

  it('is a pure function — same input yields identical output', () => {
    const decision = makeRecord();
    const a = generateIntentPatchProposal(decision);
    const b = generateIntentPatchProposal(decision);
    expect(a.id).toBe(b.id);
    expect(a.markdown).toBe(b.markdown);
  });
});
