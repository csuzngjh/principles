/**
 * Type-level + smoke tests for IntentDecisionRecord contracts (PRI-470).
 *
 * These tests verify the SHAPE of the types (required vs optional fields,
 * interface method signatures, type compatibility between Input and Record)
 * so a refactor that breaks the SPEC §21.7 contract fails at test time.
 */
import { describe, it, expect } from 'vitest';
import { expectTypeOf } from 'vitest';
import type {
  IntentDecisionRecord,
  IntentDecisionInput,
  IntentDecisionRecordResult,
  IntentDecisionSummary,
  IntentDecisionStore,
} from '../intent-decision-record.js';
import type {
  IntentTensionSource,
  EvidenceStrength,
  IntentRelatedField,
  SuggestedOwnerAction,
} from '../../diagnostician/diag-rootcause-output.js';

describe('IntentDecisionRecord type contract', () => {
  it('has all SPEC §21.7 required and optional fields', () => {
    const record: IntentDecisionRecord = {
      id: 'rec-1',
      painId: 'pain-1',
      taskId: 'task-1',
      runId: 'run-1',
      intentDocHash: 'sha256:abc',
      source: 'action_drift',
      evidenceStrength: 'moderate',
      relatedIntentFields: ['why'],
      ownerAction: 'confirm_drift',
      evidenceRefs: ['ref-1'],
      resultingCandidateId: 'cand-1',
      resultingRuleCandidateId: 'rule-1',
      patchProposalId: 'patch-1',
      createdAt: '2026-06-25T00:00:00.000Z',
    };
    expect(record.id).toBe('rec-1');
    expect(record.source).toBe('action_drift');
    expect(record.ownerAction).toBe('confirm_drift');
  });

  it('allows optional fields to be omitted', () => {
    const record: IntentDecisionRecord = {
      id: 'rec-2',
      source: 'none',
      evidenceStrength: 'weak',
      relatedIntentFields: [],
      ownerAction: 'observe',
      evidenceRefs: [],
      createdAt: '2026-06-25T00:00:00.000Z',
    };
    expect(record.painId).toBeUndefined();
    expect(record.taskId).toBeUndefined();
    expect(record.resultingCandidateId).toBeUndefined();
  });

  it('field types match the SPEC enums', () => {
    expectTypeOf<IntentDecisionRecord['source']>().toExtend<IntentTensionSource>();
    expectTypeOf<IntentDecisionRecord['evidenceStrength']>().toExtend<EvidenceStrength>();
    expectTypeOf<IntentDecisionRecord['relatedIntentFields']>().toEqualTypeOf<IntentRelatedField[]>();
    expectTypeOf<IntentDecisionRecord['ownerAction']>().toExtend<SuggestedOwnerAction>();
    expectTypeOf<IntentDecisionRecord['evidenceRefs']>().toEqualTypeOf<string[]>();
    expectTypeOf<IntentDecisionRecord['createdAt']>().toBeString();
  });
});

describe('IntentDecisionInput type contract', () => {
  it('requires id and enum fields, keeps lineage fields optional', () => {
    const input: IntentDecisionInput = {
      id: 'in-1',
      source: 'intent_suspect',
      evidenceStrength: 'strong',
      relatedIntentFields: ['desired_outcome'],
      ownerAction: 'revise_intent',
      evidenceRefs: ['ref-a', 'ref-b'],
    };
    expect(input.id).toBe('in-1');
    expect(input.painId).toBeUndefined();
    expect(input.note).toBeUndefined();
  });

  it('accepts a note and full lineage', () => {
    const input: IntentDecisionInput = {
      id: 'in-2',
      painId: 'pain-2',
      taskId: 'task-2',
      runId: 'run-2',
      intentDocHash: 'sha256:def',
      source: 'healthy_tension',
      evidenceStrength: 'moderate',
      relatedIntentFields: ['stop_escalation', 'current_strategic_focus'],
      ownerAction: 'dismiss',
      evidenceRefs: ['ref-c'],
      note: 'owner dismissed as healthy trade-off',
    };
    expect(input.note).toBe('owner dismissed as healthy trade-off');
  });

  it('Input is assignable to a partial of Record (compatible shape)', () => {
    // The store builds a Record from an Input + createdAt; this guard ensures
    // every Input field name also exists on Record (no drift between shapes).
    expectTypeOf<IntentDecisionInput>().toMatchTypeOf<Partial<IntentDecisionRecord>>();
  });
});

describe('IntentDecisionRecordResult type contract', () => {
  it('wraps a record with a created flag', () => {
    const result: IntentDecisionRecordResult = {
      record: {
        id: 'rec-3',
        source: 'action_drift',
        evidenceStrength: 'weak',
        relatedIntentFields: [],
        ownerAction: 'promote_to_principle',
        evidenceRefs: [],
        createdAt: '2026-06-25T00:00:00.000Z',
      },
      created: true,
    };
    expect(result.created).toBe(true);
    expect(result.record.id).toBe('rec-3');
  });

  it('created flag is a boolean', () => {
    expectTypeOf<IntentDecisionRecordResult['created']>().toBeBoolean();
    expectTypeOf<IntentDecisionRecordResult['record']>().toEqualTypeOf<IntentDecisionRecord>();
  });
});

describe('IntentDecisionSummary type contract', () => {
  it('holds counts for every SuggestedOwnerAction and a nullable lastDecisionAt', () => {
    const summary: IntentDecisionSummary = {
      counts: {
        confirm_drift: 1,
        revise_intent: 0,
        observe: 2,
        dismiss: 0,
        promote_to_principle: 0,
        promote_to_rulehost: 0,
      },
      lastDecisionAt: '2026-06-25T00:00:00.000Z',
    };
    expect(summary.counts.confirm_drift).toBe(1);
    expect(summary.lastDecisionAt).not.toBeNull();
  });

  it('allows null lastDecisionAt for empty stores', () => {
    const summary: IntentDecisionSummary = {
      counts: {
        confirm_drift: 0,
        revise_intent: 0,
        observe: 0,
        dismiss: 0,
        promote_to_principle: 0,
        promote_to_rulehost: 0,
      },
      lastDecisionAt: null,
    };
    expect(summary.lastDecisionAt).toBeNull();
  });

  it('counts is a Record keyed by SuggestedOwnerAction', () => {
    expectTypeOf<IntentDecisionSummary['counts']>().toEqualTypeOf<Record<SuggestedOwnerAction, number>>();
    expectTypeOf<IntentDecisionSummary['lastDecisionAt']>().toEqualTypeOf<string | null>();
  });
});

describe('IntentDecisionStore interface contract', () => {
  it('exposes the five SPEC §21.7 methods', () => {
    const store: IntentDecisionStore = {
      record: async () => ({ record: {} as IntentDecisionRecord, created: true }),
      getById: async () => null,
      listByPainId: async () => [],
      listByTaskId: async () => [],
      getSummary: async () => ({
        counts: {
          confirm_drift: 0, revise_intent: 0, observe: 0, dismiss: 0,
          promote_to_principle: 0, promote_to_rulehost: 0,
        },
        lastDecisionAt: null,
      }),
    };
    expect(typeof store.record).toBe('function');
    expect(typeof store.getById).toBe('function');
    expect(typeof store.listByPainId).toBe('function');
    expect(typeof store.listByTaskId).toBe('function');
    expect(typeof store.getSummary).toBe('function');
  });

  it('record returns IntentDecisionRecordResult', () => {
    expectTypeOf<IntentDecisionStore['record']>().returns.toEqualTypeOf<Promise<IntentDecisionRecordResult>>();
  });

  it('getById returns Record or null', () => {
    expectTypeOf<IntentDecisionStore['getById']>().returns.toEqualTypeOf<Promise<IntentDecisionRecord | null>>();
  });

  it('listByPainId and listByTaskId return arrays', () => {
    expectTypeOf<IntentDecisionStore['listByPainId']>().returns.toEqualTypeOf<Promise<IntentDecisionRecord[]>>();
    expectTypeOf<IntentDecisionStore['listByTaskId']>().returns.toEqualTypeOf<Promise<IntentDecisionRecord[]>>();
  });

  it('getSummary returns IntentDecisionSummary', () => {
    expectTypeOf<IntentDecisionStore['getSummary']>().returns.toEqualTypeOf<Promise<IntentDecisionSummary>>();
  });
});
