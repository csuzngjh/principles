import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuleCandidateBindingRequest } from '@principles/core/runtime-v2';
import { fetchRuleBindingQueue, fetchRuleBindingReview, mutateRuleBinding, reviseRuleBindingOnce } from '../../api.js';
import { validateBindingMutation, validateBindingQueue, validateBindingReview, validateBindingRevise } from '../rule-binding-validators.js';

const candidateId = 'candidate/with ? and #';
const digest = `sha256:${'a'.repeat(64)}`;
const queueItem = {
  candidateId,
  text: 'Protect the selected scope.',
  pain: { painId: 'pain-1', text: 'Owner 原话。', source: 'manual', createdAt: '2026-10-26T00:00:00.000Z' },
  diagnosisStatus: 'succeeded',
  binding: { status: 'unlinked' },
  generation: null,
  resume: null,
};
const validQueue = {
  items: [queueItem, { ...queueItem, candidateId: 'candidate-two', text: 'Keep evidence linked.' }],
  summary: { painGroups: 2, candidates: 2, bound: 0, unlinked: 2, blocked: 0 },
  truncated: false,
};
const validReview = {
  candidateId,
  candidateText: 'Protect the selected scope.',
  sourcePain: { painId: 'pain-1', text: 'Owner 原话。', source: 'manual', createdAt: '2026-10-26T00:00:00.000Z' },
  evidence: 'The operation crossed its authorized scope.',
  candidateDigest: digest,
  currentRevision: 0,
  currentBinding: null,
  boundPrinciple: null,
  generation: { stage: 'blocked', stageKind: 'artificer', reasonCode: 'textual_basis_unanchored', detail: 'anchor missing' },
  resume: { status: 'refused', reason: 'revision_budget_exhausted', scribeTaskId: 'scribe-1', taskRevisionEpoch: 1 },
  eligibleTargets: [
    { principleId: '11111111-2222-4222-8222-222222222222', text: 'Keep writes scoped.', status: 'active', version: 3, digest },
  ],
  resumeNotice: 'Binding starts one bounded revision.',
};
const bindingRequest: RuleCandidateBindingRequest = {
  action: 'bind', principleId: '11111111-2222-4222-8222-222222222222',
  expectedRevision: 0, expectedCandidateDigest: digest,
  expectedPrincipleDigest: digest, reason: 'This rule implements the selected principle.',
  requestId: 'owner-request-1', resumeOnce: true,
};
const reviseRequest = {
  expectedBindingRevision: 1, expectedScribeTaskId: 'scribe-1', expectedTaskRevisionEpoch: 1, requestId: 'revise-1',
};

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('RuleCode binding UI decoders', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an entire queue when any later row is malformed instead of exposing a valid prefix', () => {
    expect(validateBindingQueue(validQueue)).toEqual(validQueue);
    for (const key of ['candidateId', 'text', 'pain', 'diagnosisStatus', 'binding']) {
      const item = { ...validQueue.items[0] } as Record<string, unknown>;
      delete item[key];
      expect(validateBindingQueue({ ...validQueue, items: [item] }), `queue item missing ${key}`).toBeNull();
    }
    expect(validateBindingQueue({ ...validQueue, items: [validQueue.items[0], { ...validQueue.items[0], text: 7 }] })).toBeNull();
    expect(validateBindingQueue({ ...validQueue, items: [validQueue.items[0], null] })).toBeNull();
    expect(validateBindingQueue({ ...validQueue, items: 'not-an-array' })).toBeNull();
    for (const key of ['painGroups', 'candidates', 'bound', 'unlinked', 'blocked']) {
      const summary = { ...validQueue.summary } as Record<string, unknown>;
      delete summary[key];
      expect(validateBindingQueue({ ...validQueue, summary }), `summary missing ${key}`).toBeNull();
    }
    expect(validateBindingQueue({ ...validQueue, truncated: 'yes' })).toBeNull();
  });

  it('rejects a duplicated candidateId row: the queue contract is one entry per candidate (PRI-1048)', () => {
    expect(validateBindingQueue({ ...validQueue, items: [queueItem, { ...queueItem }] })).toBeNull();
  });

  it('validates every projection sub-object: pain, binding, generation, resume', () => {
    const boundItem = {
      ...queueItem,
      binding: { status: 'bound', principle: { principleId: '11111111-2222-4222-8222-222222222222', text: 'Keep writes scoped.', status: 'candidate', version: 1, revision: 1, decidedAt: '2026-10-26T00:00:00.000Z' } },
      generation: { stage: 'advanced', stageKind: 'scribe', reasonCode: null, detail: null },
      resume: { status: 'ready', reason: null, scribeTaskId: 'scribe-1', taskRevisionEpoch: 0 },
    };
    expect(validateBindingQueue({ ...validQueue, items: [boundItem], summary: { painGroups: 1, candidates: 1, bound: 1, unlinked: 0, blocked: 0 } }))
      .toMatchObject({ items: [boundItem] });
    for (const badBinding of [
      { status: 'bound' },
      { status: 'bound', principle: { principleId: 'x' } },
      { status: 'attention' },
      { status: 'nope' },
    ]) {
      expect(validateBindingQueue({ ...validQueue, items: [{ ...queueItem, binding: badBinding }] }), JSON.stringify(badBinding)).toBeNull();
    }
    expect(validateBindingQueue({ ...validQueue, items: [{ ...queueItem, pain: { painId: 'p', text: 'x', source: 'manual', createdAt: 5 } }] })).toBeNull();
    expect(validateBindingQueue({ ...validQueue, items: [{ ...queueItem, generation: { stage: 'generated', stageKind: null, reasonCode: null, detail: null } }] })).toBeNull();
    expect(validateBindingQueue({ ...validQueue, items: [{ ...queueItem, resume: { status: 'ready', reason: null, scribeTaskId: 's', taskRevisionEpoch: -1 } }] })).toBeNull();
    // null fields are legal for unlinked rows and refused resumes without epochs.
    expect(validateBindingQueue({ ...validQueue, items: [{ ...queueItem, resume: { status: 'refused', reason: 'dreamer_missing', scribeTaskId: null, taskRevisionEpoch: null } }] })).not.toBeNull();
  });

  it('requires every review authority field and every eligible-target field before review can be acted on', () => {
    for (const key of Object.keys(validReview)) {
      const missing = { ...validReview } as Record<string, unknown>;
      delete missing[key];
      expect(validateBindingReview(missing), `missing ${key}`).toBeNull();
    }
    for (const key of ['principleId', 'text', 'status', 'version', 'digest']) {
      const target = { ...validReview.eligibleTargets[0] } as Record<string, unknown>;
      delete target[key];
      expect(validateBindingReview({ ...validReview, eligibleTargets: [target] }), `target missing ${key}`).toBeNull();
    }
    for (const key of ['action', 'principleId', 'reason', 'revision']) {
      const currentBinding = {
        action: 'bind', principleId: '11111111-2222-4222-8222-222222222222', reason: 'Bound.', revision: 1,
      } as Record<string, unknown>;
      delete currentBinding[key];
      expect(validateBindingReview({ ...validReview, currentBinding }), `binding missing ${key}`).toBeNull();
    }
    for (const key of ['principleId', 'text', 'status', 'version', 'revision', 'decidedAt']) {
      const boundPrinciple = { ...(validReview.boundPrinciple ?? {}), ...{
        principleId: '11111111-2222-4222-8222-222222222222', text: 'Keep writes scoped.', status: 'candidate',
        version: 1, revision: 1, decidedAt: '2026-10-26T00:00:00.000Z',
      } } as Record<string, unknown>;
      delete boundPrinciple[key];
      expect(validateBindingReview({ ...validReview, boundPrinciple }), `boundPrinciple missing ${key}`).toBeNull();
    }
    expect(validateBindingReview({ ...validReview, currentRevision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(validateBindingReview({ ...validReview, eligibleTargets: new Array(21).fill(validReview.eligibleTargets[0]) })).toBeNull();
  });

  it('keeps a valid no-target revoked review readable and preserves refused-revision mutation state', () => {
    const revokedReview = {
      ...validReview,
      currentRevision: 2,
      currentBinding: { action: 'revoke', principleId: '11111111-2222-4222-8222-222222222222', reason: 'Owner withdrew the binding.', revision: 2 },
      eligibleTargets: [],
      generation: null,
      resume: null,
    };
    expect(validateBindingReview(revokedReview)).toMatchObject({
      currentRevision: 2, currentBinding: { action: 'revoke', revision: 2 }, eligibleTargets: [], generation: null, resume: null,
    });

    const refusedResume = {
      status: 'bound', runtimeDeactivated: false, inFlightOperationsMayComplete: true,
      revision: { status: 'refused', reason: 'revision_budget_exhausted' },
      nextAction: 'Inspect the task revision budget.',
    };
    expect(validateBindingMutation(refusedResume)).toEqual({
      status: 'bound', revisionStatus: 'refused', nextAction: 'Inspect the task revision budget.',
    });
    expect(validateBindingMutation({ ...refusedResume, runtimeDeactivated: true })).toBeNull();
    expect(validateBindingMutation({ ...refusedResume, inFlightOperationsMayComplete: false })).toBeNull();
    expect(validateBindingMutation({ ...refusedResume, revision: { status: 9 } })).toBeNull();
  });

  it('validates the revise-once decoder: status required, optional fields typed', () => {
    expect(validateBindingRevise({ status: 'revision_started', scribeTaskId: 'scribe-1', taskRevisionEpoch: 1 }))
      .toEqual({ status: 'revision_started' });
    expect(validateBindingRevise({ status: 'revision_already_started' })).toEqual({ status: 'revision_already_started' });
    expect(validateBindingRevise({ status: 'refused', reason: 'revision_budget_exhausted', nextAction: 'Inspect budget.' }))
      .toEqual({ status: 'refused', reason: 'revision_budget_exhausted', nextAction: 'Inspect budget.' });
    expect(validateBindingRevise({})).toBeNull();
    expect(validateBindingRevise({ status: 9 })).toBeNull();
    expect(validateBindingRevise({ status: 'refused', reason: 9 })).toBeNull();
  });

  it('uses the queue, review, mutation, and revise API decoders on real fetch requests', async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(response(validQueue))
      .mockResolvedValueOnce(response({ ...validReview, currentBinding: { action: 'revoke', principleId: '11111111-2222-4222-8222-222222222222', reason: 'Withdrawn.', revision: 2 }, currentRevision: 2, eligibleTargets: [], generation: null, resume: null }))
      .mockResolvedValueOnce(response({
        status: 'bound', runtimeDeactivated: false, inFlightOperationsMayComplete: true,
        revision: { status: 'refused', reason: 'revision_budget_exhausted' },
      }))
      .mockResolvedValueOnce(response({ status: 'revision_started', scribeTaskId: 'scribe-1', taskRevisionEpoch: 1 }));
    vi.stubGlobal('fetch', fetchStub);

    const queue = await fetchRuleBindingQueue();
    const review = await fetchRuleBindingReview(candidateId, 'target / #1');
    const mutation = await mutateRuleBinding(candidateId, bindingRequest);
    const revision = await reviseRuleBindingOnce(candidateId, reviseRequest);

    expect(queue).toMatchObject({ success: true, data: { items: validQueue.items, summary: validQueue.summary } });
    expect(review).toMatchObject({ success: true, data: { currentBinding: { action: 'revoke' }, eligibleTargets: [] } });
    expect(mutation).toMatchObject({ success: true, data: { status: 'bound', revisionStatus: 'refused' } });
    expect(revision).toMatchObject({ success: true, data: { status: 'revision_started' } });
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/governance/rule-candidate-bindings',
      '/api/v1/governance/rule-candidate-bindings/candidate%2Fwith%20%3F%20and%20%23/review?search=target%20%2F%20%231',
      '/api/v1/governance/rule-candidate-bindings/candidate%2Fwith%20%3F%20and%20%23',
      '/api/v1/governance/rule-candidate-bindings/candidate%2Fwith%20%3F%20and%20%23/revise-once',
    ]);
    expect(fetchStub.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(bindingRequest) });
    expect(fetchStub.mock.calls[3]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(reviseRequest) });
  });

  it('returns decoder failures without actionable data for corrupt queue, review, or mutation payloads', async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(response({ ...validQueue, items: [validQueue.items[0], { ...validQueue.items[0], text: null }] }))
      .mockResolvedValueOnce(response({ ...validReview, eligibleTargets: [{ ...validReview.eligibleTargets[0], version: Number.MAX_SAFE_INTEGER + 1 }] }))
      .mockResolvedValueOnce(response({ status: 'bound', runtimeDeactivated: true, inFlightOperationsMayComplete: true }));
    vi.stubGlobal('fetch', fetchStub);

    const queue = await fetchRuleBindingQueue();
    const review = await fetchRuleBindingReview(candidateId);
    const mutation = await mutateRuleBinding(candidateId, bindingRequest);

    for (const result of [queue, review, mutation]) {
      expect(result.success).toBe(false);
      expect(result).not.toHaveProperty('data');
    }
  });
});
