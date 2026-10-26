import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuleCandidateBindingRequest } from '@principles/core/runtime-v2';
import { fetchRuleBindingQueue, fetchRuleBindingReview, mutateRuleBinding } from '../../api.js';
import { validateBindingMutation, validateBindingQueue, validateBindingReview } from '../rule-binding-validators.js';

const candidateId = 'candidate/with ? and #';
const digest = `sha256:${'a'.repeat(64)}`;
const validQueue = {
  items: [
    { candidateId, text: 'Protect the selected scope.', reason: 'Awaiting an Owner binding.' },
    { candidateId: 'candidate-two', text: 'Keep evidence linked.', reason: 'Awaiting review.' },
  ],
};
const validReview = {
  candidateId,
  candidateText: 'Protect the selected scope.',
  sourcePainId: 'pain-1',
  evidence: 'The operation crossed its authorized scope.',
  candidateDigest: digest,
  currentRevision: 0,
  currentBinding: null,
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

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('RuleCode binding UI decoders', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an entire queue when any later row is malformed instead of exposing a valid prefix', () => {
    expect(validateBindingQueue(validQueue)).toEqual(validQueue);
    for (const key of ['candidateId', 'text', 'reason']) {
      const item = { ...validQueue.items[0] } as Record<string, unknown>;
      delete item[key];
      expect(validateBindingQueue({ items: [item] }), `queue item missing ${key}`).toBeNull();
    }
    expect(validateBindingQueue({ items: [validQueue.items[0], { candidateId: 'broken', text: 7, reason: 'bad row' }] }))
      .toBeNull();
    expect(validateBindingQueue({ items: [validQueue.items[0], null] })).toBeNull();
    expect(validateBindingQueue({ items: 'not-an-array' })).toBeNull();
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
    for (const version of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateBindingReview({
        ...validReview,
        eligibleTargets: [{ ...validReview.eligibleTargets[0], version }],
      }), `unsafe target version ${version}`).toBeNull();
    }
    for (const key of ['action', 'principleId', 'reason', 'revision']) {
      const currentBinding = {
        action: 'bind', principleId: '11111111-2222-4222-8222-222222222222', reason: 'Bound.', revision: 1,
      } as Record<string, unknown>;
      delete currentBinding[key];
      expect(validateBindingReview({ ...validReview, currentBinding }), `binding missing ${key}`).toBeNull();
    }
    expect(validateBindingReview({ ...validReview, currentRevision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(validateBindingReview({ ...validReview, currentRevision: 1.5 })).toBeNull();
    expect(validateBindingReview({ ...validReview, currentRevision: -1 })).toBeNull();
    expect(validateBindingReview({ ...validReview, eligibleTargets: new Array(21).fill(validReview.eligibleTargets[0]) })).toBeNull();
  });

  it('keeps a valid no-target revoked review readable and preserves refused-revision mutation state', () => {
    const revokedReview = {
      ...validReview,
      currentRevision: 2,
      currentBinding: { action: 'revoke', principleId: '11111111-2222-4222-8222-222222222222', reason: 'Owner withdrew the binding.', revision: 2 },
      eligibleTargets: [],
    };
    expect(validateBindingReview(revokedReview)).toMatchObject({
      currentRevision: 2, currentBinding: { action: 'revoke', revision: 2 }, eligibleTargets: [],
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

  it('uses the queue, review, and mutation API decoders on real fetch requests', async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(response(validQueue))
      .mockResolvedValueOnce(response({ ...validReview, currentBinding: { action: 'revoke', principleId: '11111111-2222-4222-8222-222222222222', reason: 'Withdrawn.', revision: 2 }, currentRevision: 2, eligibleTargets: [] }))
      .mockResolvedValueOnce(response({
        status: 'bound', runtimeDeactivated: false, inFlightOperationsMayComplete: true,
        revision: { status: 'refused', reason: 'revision_budget_exhausted' },
      }));
    vi.stubGlobal('fetch', fetchStub);

    const queue = await fetchRuleBindingQueue();
    const review = await fetchRuleBindingReview(candidateId, 'target / #1');
    const mutation = await mutateRuleBinding(candidateId, bindingRequest);

    expect(queue).toMatchObject({ success: true, data: { items: validQueue.items } });
    expect(review).toMatchObject({ success: true, data: { currentBinding: { action: 'revoke' }, eligibleTargets: [] } });
    expect(mutation).toMatchObject({ success: true, data: { status: 'bound', revisionStatus: 'refused' } });
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/governance/rule-candidate-bindings',
      '/api/v1/governance/rule-candidate-bindings/candidate%2Fwith%20%3F%20and%20%23/review?search=target%20%2F%20%231',
      '/api/v1/governance/rule-candidate-bindings/candidate%2Fwith%20%3F%20and%20%23',
    ]);
    expect(fetchStub.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(bindingRequest) });
  });

  it('returns decoder failures without actionable data for corrupt queue, review, or mutation payloads', async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(response({ items: [validQueue.items[0], { candidateId: 'broken', text: null, reason: 'bad row' }] }))
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
