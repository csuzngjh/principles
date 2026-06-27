/**
 * PRI-470/471: IntentDecision validator tests.
 *
 * Covers:
 * - validateIntentDecisionRecord: validates untrusted IntentDecisionRecord from API
 * - validateIntentDecisionList: validates array of IntentDecisionRecord
 * - validateIntentDecisionResult: validates POST response envelope { record, created }
 * - validateIntentDecisionSummary: validates GET /summary response
 *
 * These validators protect the UI from untrusted API response data per
 * Runtime Contract Rules (ERR-001/005/009/013).
 *
 * Tests import production validators (ERR-025: tests must cover real product
 * paths, not copy implementation).
 */

import { describe, it, expect } from 'vitest';
import {
  validateIntentDecisionRecord,
  validateIntentDecisionList,
  validateIntentDecisionResult,
  validateIntentDecisionSummary,
} from '../../src/ui/utils/validators.js';
import type { IntentDecisionRecordData, IntentDecisionSummaryData } from '../../src/ui/utils/validators.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

function validIntentDecisionRecord(overrides?: Partial<IntentDecisionRecordData>): Record<string, unknown> {
  return {
    id: 'idr-001',
    source: 'action_drift',
    evidenceStrength: 'moderate',
    relatedIntentFields: ['why', 'desired_outcome'],
    ownerAction: 'confirm_drift',
    evidenceRefs: ['ev-1', 'ev-2'],
    createdAt: '2026-06-26T00:00:00.000Z',
    ...overrides,
  };
}

function validIntentDecisionResult(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    record: validIntentDecisionRecord(),
    created: true,
    ...overrides,
  };
}

function validIntentDecisionSummary(overrides?: Partial<IntentDecisionSummaryData>): Record<string, unknown> {
  return {
    counts: {
      confirm_drift: 5,
      revise_intent: 3,
      observe: 10,
      dismiss: 2,
      promote_to_principle: 1,
      promote_to_rulehost: 0,
    },
    lastDecisionAt: '2026-06-26T12:00:00.000Z',
    ...overrides,
  };
}

// ── validateIntentDecisionRecord ───────────────────────────────────────────────

describe('validateIntentDecisionRecord', () => {
  // Required field validation
  it('accepts a valid IntentDecisionRecord with all required fields', () => {
    const result = validateIntentDecisionRecord(validIntentDecisionRecord());
    expect(result).not.toBeNull();
    expect(result!.id).toBe('idr-001');
    expect(result!.source).toBe('action_drift');
    expect(result!.evidenceStrength).toBe('moderate');
    expect(result!.relatedIntentFields).toEqual(['why', 'desired_outcome']);
    expect(result!.ownerAction).toBe('confirm_drift');
    expect(result!.evidenceRefs).toEqual(['ev-1', 'ev-2']);
    expect(result!.createdAt).toBe('2026-06-26T00:00:00.000Z');
  });

  it('accepts a record with all optional fields', () => {
    const input = validIntentDecisionRecord({
      painId: 'pain-001',
      taskId: 'task-001',
      runId: 'run-001',
      intentDocHash: 'sha256:abc123',
      resultingCandidateId: 'cand-001',
      resultingRuleCandidateId: 'rule-cand-001',
      patchProposalId: 'patch-001',
    });
    const result = validateIntentDecisionRecord(input);
    expect(result).not.toBeNull();
    expect(result!.painId).toBe('pain-001');
    expect(result!.taskId).toBe('task-001');
    expect(result!.runId).toBe('run-001');
    expect(result!.intentDocHash).toBe('sha256:abc123');
    expect(result!.resultingCandidateId).toBe('cand-001');
    expect(result!.resultingRuleCandidateId).toBe('rule-cand-001');
    expect(result!.patchProposalId).toBe('patch-001');
  });

  it('accepts record without optional fields', () => {
    const result = validateIntentDecisionRecord(validIntentDecisionRecord());
    expect(result).not.toBeNull();
    expect(result!.painId).toBeUndefined();
    expect(result!.taskId).toBeUndefined();
    expect(result!.runId).toBeUndefined();
    expect(result!.intentDocHash).toBeUndefined();
    expect(result!.resultingCandidateId).toBeUndefined();
    expect(result!.resultingRuleCandidateId).toBeUndefined();
    expect(result!.patchProposalId).toBeUndefined();
  });

  // Enum validation for source
  it('accepts all valid source enum values', () => {
    const sources = ['none', 'action_drift', 'intent_suspect', 'healthy_tension'];
    for (const source of sources) {
      const result = validateIntentDecisionRecord(validIntentDecisionRecord({ source }));
      expect(result).not.toBeNull();
      expect(result!.source).toBe(source);
    }
  });

  it('rejects invalid source enum value', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ source: 'invalid_source' }))).toBeNull();
  });

  // Enum validation for evidenceStrength
  it('accepts all valid evidenceStrength enum values', () => {
    const strengths = ['weak', 'moderate', 'strong'];
    for (const strength of strengths) {
      const result = validateIntentDecisionRecord(validIntentDecisionRecord({ evidenceStrength: strength }));
      expect(result).not.toBeNull();
      expect(result!.evidenceStrength).toBe(strength);
    }
  });

  it('rejects invalid evidenceStrength enum value', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ evidenceStrength: 'invalid' }))).toBeNull();
  });

  // Enum validation for ownerAction
  it('accepts all valid ownerAction enum values', () => {
    const actions = ['confirm_drift', 'revise_intent', 'observe', 'dismiss', 'promote_to_principle', 'promote_to_rulehost'];
    for (const action of actions) {
      const result = validateIntentDecisionRecord(validIntentDecisionRecord({ ownerAction: action }));
      expect(result).not.toBeNull();
      expect(result!.ownerAction).toBe(action);
    }
  });

  it('rejects invalid ownerAction enum value', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ ownerAction: 'invalid_action' }))).toBeNull();
  });

  // relatedIntentFields validation
  it('accepts all valid IntentRelatedField values', () => {
    const fields = ['why', 'desired_outcome', 'non_negotiables', 'stop_escalation', 'current_strategic_focus'];
    const result = validateIntentDecisionRecord(validIntentDecisionRecord({ relatedIntentFields: fields }));
    expect(result).not.toBeNull();
    expect(result!.relatedIntentFields).toEqual(fields);
  });

  it('rejects invalid IntentRelatedField element', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ relatedIntentFields: ['why', 'invalid_field'] }))).toBeNull();
  });

  it('rejects non-array relatedIntentFields', () => {
    const input = validIntentDecisionRecord();
    (input as Record<string, unknown>).relatedIntentFields = 'not an array';
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects relatedIntentFields with non-string element', () => {
    const input = validIntentDecisionRecord();
    (input as Record<string, unknown>).relatedIntentFields = ['why', 123];
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('accepts empty relatedIntentFields array', () => {
    const result = validateIntentDecisionRecord(validIntentDecisionRecord({ relatedIntentFields: [] }));
    expect(result).not.toBeNull();
    expect(result!.relatedIntentFields).toEqual([]);
  });

  // evidenceRefs validation
  it('rejects non-array evidenceRefs', () => {
    const input = validIntentDecisionRecord();
    (input as Record<string, unknown>).evidenceRefs = 'not an array';
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects evidenceRefs with non-string element', () => {
    const input = validIntentDecisionRecord();
    (input as Record<string, unknown>).evidenceRefs = ['ev-1', 42, 'ev-3'];
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('accepts empty evidenceRefs array', () => {
    const result = validateIntentDecisionRecord(validIntentDecisionRecord({ evidenceRefs: [] }));
    expect(result).not.toBeNull();
    expect(result!.evidenceRefs).toEqual([]);
  });

  // Required field rejection
  it('rejects null input', () => {
    expect(validateIntentDecisionRecord(null)).toBeNull();
  });

  it('rejects array input', () => {
    expect(validateIntentDecisionRecord([1, 2, 3])).toBeNull();
  });

  it('rejects primitive input', () => {
    expect(validateIntentDecisionRecord('idr-001')).toBeNull();
    expect(validateIntentDecisionRecord(42)).toBeNull();
  });

  it('rejects missing id', () => {
    const input = validIntentDecisionRecord();
    delete (input as Record<string, unknown>).id;
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects non-string id', () => {
    const input = validIntentDecisionRecord({ id: 123 });
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects missing source', () => {
    const input = validIntentDecisionRecord();
    delete (input as Record<string, unknown>).source;
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects non-string source', () => {
    const input = validIntentDecisionRecord({ source: 123 });
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects missing evidenceStrength', () => {
    const input = validIntentDecisionRecord();
    delete (input as Record<string, unknown>).evidenceStrength;
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects non-string evidenceStrength', () => {
    const input = validIntentDecisionRecord({ evidenceStrength: 123 });
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects missing relatedIntentFields', () => {
    const input = validIntentDecisionRecord();
    delete (input as Record<string, unknown>).relatedIntentFields;
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects missing ownerAction', () => {
    const input = validIntentDecisionRecord();
    delete (input as Record<string, unknown>).ownerAction;
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects non-string ownerAction', () => {
    const input = validIntentDecisionRecord({ ownerAction: 123 });
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects missing evidenceRefs', () => {
    const input = validIntentDecisionRecord();
    delete (input as Record<string, unknown>).evidenceRefs;
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects missing createdAt', () => {
    const input = validIntentDecisionRecord();
    delete (input as Record<string, unknown>).createdAt;
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  it('rejects non-string createdAt', () => {
    const input = validIntentDecisionRecord({ createdAt: 123 });
    expect(validateIntentDecisionRecord(input)).toBeNull();
  });

  // Optional field type validation (ERR-009: fail loud on wrong type)
  it('rejects non-string painId when present', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ painId: 123 }))).toBeNull();
  });

  it('rejects non-string taskId when present', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ taskId: 123 }))).toBeNull();
  });

  it('rejects non-string runId when present', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ runId: 123 }))).toBeNull();
  });

  it('rejects non-string intentDocHash when present', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ intentDocHash: 123 }))).toBeNull();
  });

  it('rejects non-string resultingCandidateId when present', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ resultingCandidateId: 123 }))).toBeNull();
  });

  it('rejects non-string resultingRuleCandidateId when present', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ resultingRuleCandidateId: 123 }))).toBeNull();
  });

  it('rejects non-string patchProposalId when present', () => {
    expect(validateIntentDecisionRecord(validIntentDecisionRecord({ patchProposalId: 123 }))).toBeNull();
  });
});

// ── validateIntentDecisionList ─────────────────────────────────────────────────

describe('validateIntentDecisionList', () => {
  it('accepts an empty array', () => {
    const result = validateIntentDecisionList([]);
    expect(result).not.toBeNull();
    expect(result).toEqual([]);
  });

  it('accepts an array of valid records', () => {
    const input = [
      validIntentDecisionRecord({ id: 'idr-001' }),
      validIntentDecisionRecord({ id: 'idr-002' }),
    ];
    const result = validateIntentDecisionList(input);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].id).toBe('idr-001');
    expect(result![1].id).toBe('idr-002');
  });

  it('rejects null input', () => {
    expect(validateIntentDecisionList(null)).toBeNull();
  });

  it('rejects non-array input', () => {
    expect(validateIntentDecisionList('not an array')).toBeNull();
    expect(validateIntentDecisionList({})).toBeNull();
    expect(validateIntentDecisionList(42)).toBeNull();
  });

  it('rejects array with invalid record', () => {
    const input = [
      validIntentDecisionRecord({ id: 'idr-001' }),
      { id: 123 }, // invalid record
    ];
    expect(validateIntentDecisionList(input)).toBeNull();
  });

  it('rejects array with malformed record', () => {
    const input = [
      validIntentDecisionRecord({ id: 'idr-001' }),
      validIntentDecisionRecord({ id: 'idr-002', source: 'invalid' }),
    ];
    expect(validateIntentDecisionList(input)).toBeNull();
  });
});

// ── validateIntentDecisionResult ───────────────────────────────────────────────

describe('validateIntentDecisionResult', () => {
  it('accepts valid result with created=true', () => {
    const result = validateIntentDecisionResult(validIntentDecisionResult({ created: true }));
    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.record.id).toBe('idr-001');
  });

  it('accepts valid result with created=false (idempotent replay)', () => {
    const result = validateIntentDecisionResult(validIntentDecisionResult({ created: false }));
    expect(result).not.toBeNull();
    expect(result!.created).toBe(false);
    expect(result!.record.id).toBe('idr-001');
  });

  it('rejects null input', () => {
    expect(validateIntentDecisionResult(null)).toBeNull();
  });

  it('rejects array input', () => {
    expect(validateIntentDecisionResult([1, 2, 3])).toBeNull();
  });

  it('rejects primitive input', () => {
    expect(validateIntentDecisionResult('result')).toBeNull();
  });

  it('rejects missing record', () => {
    const input = { created: true };
    expect(validateIntentDecisionResult(input)).toBeNull();
  });

  it('rejects invalid record', () => {
    const input = { record: { id: 123 }, created: true };
    expect(validateIntentDecisionResult(input)).toBeNull();
  });

  it('rejects missing created', () => {
    const input = { record: validIntentDecisionRecord() };
    expect(validateIntentDecisionResult(input)).toBeNull();
  });

  it('rejects non-boolean created', () => {
    const input = validIntentDecisionResult({ created: 'true' });
    expect(validateIntentDecisionResult(input)).toBeNull();
  });

  it('rejects created=123', () => {
    const input = validIntentDecisionResult({ created: 123 });
    expect(validateIntentDecisionResult(input)).toBeNull();
  });
});

// ── validateIntentDecisionSummary ───────────────────────────────────────────────

describe('validateIntentDecisionSummary', () => {
  it('accepts valid summary with all counts', () => {
    const result = validateIntentDecisionSummary(validIntentDecisionSummary());
    expect(result).not.toBeNull();
    expect(result!.counts.confirm_drift).toBe(5);
    expect(result!.counts.revise_intent).toBe(3);
    expect(result!.counts.observe).toBe(10);
    expect(result!.counts.dismiss).toBe(2);
    expect(result!.counts.promote_to_principle).toBe(1);
    expect(result!.counts.promote_to_rulehost).toBe(0);
    expect(result!.lastDecisionAt).toBe('2026-06-26T12:00:00.000Z');
  });

  it('accepts summary with lastDecisionAt=null', () => {
    const result = validateIntentDecisionSummary(validIntentDecisionSummary({ lastDecisionAt: null }));
    expect(result).not.toBeNull();
    expect(result!.lastDecisionAt).toBeNull();
  });

  it('accepts summary with all counts=0', () => {
    const result = validateIntentDecisionSummary(validIntentDecisionSummary({
      counts: {
        confirm_drift: 0,
        revise_intent: 0,
        observe: 0,
        dismiss: 0,
        promote_to_principle: 0,
        promote_to_rulehost: 0,
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.counts.confirm_drift).toBe(0);
    expect(result!.counts.revise_intent).toBe(0);
  });

  it('rejects null input', () => {
    expect(validateIntentDecisionSummary(null)).toBeNull();
  });

  it('rejects array input', () => {
    expect(validateIntentDecisionSummary([1, 2, 3])).toBeNull();
  });

  it('rejects primitive input', () => {
    expect(validateIntentDecisionSummary('summary')).toBeNull();
  });

  it('rejects missing counts', () => {
    const input = { lastDecisionAt: '2026-06-26T12:00:00.000Z' };
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects counts as non-object', () => {
    const input = validIntentDecisionSummary();
    (input as Record<string, unknown>).counts = 'not an object';
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  // Per-key count validation
  it('rejects missing confirm_drift count', () => {
    const input = validIntentDecisionSummary();
    delete (input.counts as Record<string, unknown>).confirm_drift;
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects non-number confirm_drift', () => {
    const input = validIntentDecisionSummary();
    (input.counts as Record<string, unknown>).confirm_drift = '5';
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects negative confirm_drift', () => {
    expect(validateIntentDecisionSummary(validIntentDecisionSummary({
      counts: { confirm_drift: -1, revise_intent: 0, observe: 0, dismiss: 0, promote_to_principle: 0, promote_to_rulehost: 0 },
    }))).toBeNull();
  });

  it('rejects missing revise_intent count', () => {
    const input = validIntentDecisionSummary();
    delete (input.counts as Record<string, unknown>).revise_intent;
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects non-number revise_intent', () => {
    const input = validIntentDecisionSummary();
    (input.counts as Record<string, unknown>).revise_intent = null;
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects negative revise_intent', () => {
    expect(validateIntentDecisionSummary(validIntentDecisionSummary({
      counts: { confirm_drift: 0, revise_intent: -5, observe: 0, dismiss: 0, promote_to_principle: 0, promote_to_rulehost: 0 },
    }))).toBeNull();
  });

  it('rejects missing observe count', () => {
    const input = validIntentDecisionSummary();
    delete (input.counts as Record<string, unknown>).observe;
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects missing dismiss count', () => {
    const input = validIntentDecisionSummary();
    delete (input.counts as Record<string, unknown>).dismiss;
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects missing promote_to_principle count', () => {
    const input = validIntentDecisionSummary();
    delete (input.counts as Record<string, unknown>).promote_to_principle;
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects missing promote_to_rulehost count', () => {
    const input = validIntentDecisionSummary();
    delete (input.counts as Record<string, unknown>).promote_to_rulehost;
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  // lastDecisionAt validation
  it('rejects missing lastDecisionAt', () => {
    const input = validIntentDecisionSummary();
    delete (input as Record<string, unknown>).lastDecisionAt;
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects non-string/non-null lastDecisionAt', () => {
    const input = validIntentDecisionSummary({ lastDecisionAt: 123 as unknown as string });
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects lastDecisionAt as object', () => {
    const input = validIntentDecisionSummary({ lastDecisionAt: {} as unknown as string });
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  it('rejects lastDecisionAt as array', () => {
    const input = validIntentDecisionSummary({ lastDecisionAt: [] as unknown as string });
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });

  // NaN edge case
  it('rejects NaN count value', () => {
    const input = validIntentDecisionSummary();
    (input.counts as Record<string, unknown>).confirm_drift = NaN;
    expect(validateIntentDecisionSummary(input)).toBeNull();
  });
});