/**
 * PRI-471: validateFollowUpResponse validator tests.
 *
 * Covers the validateFollowUpResponse() function in ui/utils/validators.ts.
 * The validator protects the UI from untrusted API response data per
 * Runtime Contract Rules (ERR-001/005/009/013).
 *
 * Tests import the production validator (ERR-025: tests must cover real
 * product paths, not copy implementation).
 */

import { describe, it, expect } from 'vitest';
import { validateFollowUpResponse } from '../../src/ui/utils/validators.js';
import type { IntentDecisionRecordData } from '../../src/ui/utils/validators.js';

// A minimal valid IntentDecisionRecord used as the `record` field in branches
// that need it (link_candidate, generate_patch_proposal).
const VALID_RECORD: IntentDecisionRecordData = {
  id: 'rec-1',
  source: 'action_drift',
  evidenceStrength: 'moderate',
  relatedIntentFields: ['why'],
  ownerAction: 'confirm_drift',
  evidenceRefs: ['ev-1'],
  createdAt: '2026-06-25T00:00:00.000Z',
};

// ── link_candidate ──────────────────────────────────────────────────────────

describe('validateFollowUpResponse — link_candidate', () => {
  it('accepts a valid link_candidate response', () => {
    const result = validateFollowUpResponse({
      type: 'link_candidate',
      decisionId: 'dec-1',
      record: VALID_RECORD,
      linkedCandidateId: 'cand-1',
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe('link_candidate');
    expect(result?.decisionId).toBe('dec-1');
    expect(result?.linkedCandidateId).toBe('cand-1');
    expect(result?.record.id).toBe('rec-1');
  });

  it('rejects when record is missing', () => {
    expect(validateFollowUpResponse({
      type: 'link_candidate',
      decisionId: 'dec-1',
      linkedCandidateId: 'cand-1',
    })).toBeNull();
  });

  it('rejects when record is invalid', () => {
    expect(validateFollowUpResponse({
      type: 'link_candidate',
      decisionId: 'dec-1',
      record: { id: 123 }, // wrong type
      linkedCandidateId: 'cand-1',
    })).toBeNull();
  });

  it('rejects when linkedCandidateId is missing', () => {
    expect(validateFollowUpResponse({
      type: 'link_candidate',
      decisionId: 'dec-1',
      record: VALID_RECORD,
    })).toBeNull();
  });

  it('rejects when linkedCandidateId is not a string', () => {
    expect(validateFollowUpResponse({
      type: 'link_candidate',
      decisionId: 'dec-1',
      record: VALID_RECORD,
      linkedCandidateId: 42,
    })).toBeNull();
  });
});

// ── guide_rulehost ──────────────────────────────────────────────────────────

describe('validateFollowUpResponse — guide_rulehost', () => {
  it('accepts a valid guide_rulehost response', () => {
    const result = validateFollowUpResponse({
      type: 'guide_rulehost',
      decisionId: 'dec-2',
      cliCommand: 'pd runtime rulehost',
      note: 'Run this in your terminal.',
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe('guide_rulehost');
    expect(result?.decisionId).toBe('dec-2');
    expect(result?.cliCommand).toBe('pd runtime rulehost');
    expect(result?.note).toBe('Run this in your terminal.');
  });

  it('rejects when cliCommand is missing', () => {
    expect(validateFollowUpResponse({
      type: 'guide_rulehost',
      decisionId: 'dec-2',
      note: 'note',
    })).toBeNull();
  });

  it('rejects when cliCommand is not a string', () => {
    expect(validateFollowUpResponse({
      type: 'guide_rulehost',
      decisionId: 'dec-2',
      cliCommand: 123,
      note: 'note',
    })).toBeNull();
  });

  it('rejects when note is missing', () => {
    expect(validateFollowUpResponse({
      type: 'guide_rulehost',
      decisionId: 'dec-2',
      cliCommand: 'cmd',
    })).toBeNull();
  });

  it('rejects when note is not a string', () => {
    expect(validateFollowUpResponse({
      type: 'guide_rulehost',
      decisionId: 'dec-2',
      cliCommand: 'cmd',
      note: null,
    })).toBeNull();
  });
});

// ── generate_patch_proposal ─────────────────────────────────────────────────

describe('validateFollowUpResponse — generate_patch_proposal', () => {
  it('accepts a valid generate_patch_proposal response', () => {
    const result = validateFollowUpResponse({
      type: 'generate_patch_proposal',
      decisionId: 'dec-3',
      record: VALID_RECORD,
      patchProposal: { id: 'patch-1', markdown: '## Intent Patch Proposal' },
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe('generate_patch_proposal');
    expect(result?.decisionId).toBe('dec-3');
    expect(result?.record.id).toBe('rec-1');
    expect(result?.patchProposal.id).toBe('patch-1');
    expect(result?.patchProposal.markdown).toContain('Intent Patch Proposal');
  });

  it('rejects when patchProposal is missing', () => {
    expect(validateFollowUpResponse({
      type: 'generate_patch_proposal',
      decisionId: 'dec-3',
      record: VALID_RECORD,
    })).toBeNull();
  });

  it('rejects when patchProposal is not an object', () => {
    expect(validateFollowUpResponse({
      type: 'generate_patch_proposal',
      decisionId: 'dec-3',
      record: VALID_RECORD,
      patchProposal: 'string-instead-of-object',
    })).toBeNull();
  });

  it('rejects when patchProposal.id is missing', () => {
    expect(validateFollowUpResponse({
      type: 'generate_patch_proposal',
      decisionId: 'dec-3',
      record: VALID_RECORD,
      patchProposal: { markdown: 'md' },
    })).toBeNull();
  });

  it('rejects when patchProposal.markdown is missing', () => {
    expect(validateFollowUpResponse({
      type: 'generate_patch_proposal',
      decisionId: 'dec-3',
      record: VALID_RECORD,
      patchProposal: { id: 'patch-1' },
    })).toBeNull();
  });

  it('rejects when patchProposal.id is not a string', () => {
    expect(validateFollowUpResponse({
      type: 'generate_patch_proposal',
      decisionId: 'dec-3',
      record: VALID_RECORD,
      patchProposal: { id: 123, markdown: 'md' },
    })).toBeNull();
  });

  it('rejects when patchProposal.markdown is not a string', () => {
    expect(validateFollowUpResponse({
      type: 'generate_patch_proposal',
      decisionId: 'dec-3',
      record: VALID_RECORD,
      patchProposal: { id: 'patch-1', markdown: 42 },
    })).toBeNull();
  });
});

// ── common field validation (type + decisionId) ─────────────────────────────

describe('validateFollowUpResponse — common fields', () => {
  it('rejects null', () => {
    expect(validateFollowUpResponse(null)).toBeNull();
  });

  it('rejects array', () => {
    expect(validateFollowUpResponse([1, 2, 3])).toBeNull();
  });

  it('rejects primitive', () => {
    expect(validateFollowUpResponse('link_candidate')).toBeNull();
  });

  it('rejects when type is missing', () => {
    expect(validateFollowUpResponse({
      decisionId: 'dec-x',
      cliCommand: 'cmd',
      note: 'note',
    })).toBeNull();
  });

  it('rejects when type is not a string', () => {
    expect(validateFollowUpResponse({
      type: 123,
      decisionId: 'dec-x',
      cliCommand: 'cmd',
      note: 'note',
    })).toBeNull();
  });

  it('rejects when type is an unknown value', () => {
    expect(validateFollowUpResponse({
      type: 'unknown_type',
      decisionId: 'dec-x',
      cliCommand: 'cmd',
      note: 'note',
    })).toBeNull();
  });

  it('rejects when decisionId is missing', () => {
    expect(validateFollowUpResponse({
      type: 'guide_rulehost',
      cliCommand: 'cmd',
      note: 'note',
    })).toBeNull();
  });

  it('rejects when decisionId is not a string', () => {
    expect(validateFollowUpResponse({
      type: 'guide_rulehost',
      decisionId: 42,
      cliCommand: 'cmd',
      note: 'note',
    })).toBeNull();
  });
});
