import { describe, expect, it } from 'vitest';
import { validateApprovedRuleRevisionPreview, validateApprovedRuleRevisionRequest, validateApprovedRuleRevisionResult } from '../../src/shared/approved-rule-revision-contract.js';

const request = { expectedArtifactId: 'artifact-1', expectedArtifactDigest: 'sha256:' + 'a'.repeat(64), expectedBindingRevision: 1, expectedControlVersion: 0, expectedTaskRevisionEpoch: 2, requestId: 'request-1', feedback: 'Protect official recovery operations.' };
const preview = { status: 'ready', activationId: 'activation-1', candidateId: 'candidate-1', principleId: 'principle-1', artificerTaskId: 'artificer-1', ...request };

describe('approved rule revision wire contract', () => {
  it('keeps the reviewed version bindings and strips arbitrary client authorities', () => {
    expect(validateApprovedRuleRevisionRequest({ ...request, actor: 'invented-owner', candidateId: 'invented-candidate' })).toEqual(request);
    expect(validateApprovedRuleRevisionPreview(preview)).toMatchObject({ status: 'ready', expectedArtifactDigest: request.expectedArtifactDigest, expectedControlVersion: 0 });
  });
  it.each(['expectedArtifactId', 'expectedArtifactDigest', 'expectedBindingRevision', 'expectedControlVersion', 'expectedTaskRevisionEpoch', 'requestId', 'feedback'])('requires %s rather than silently dropping a CAS condition', field => {
    expect(validateApprovedRuleRevisionRequest(Object.fromEntries(Object.entries(request).filter(([key]) => key !== field)))).toBeNull();
  });
  it('rejects missing lineage and string-wrapped numbers before enabling the CTA', () => {
    expect(validateApprovedRuleRevisionPreview({ ...preview, candidateId: null })).toBeNull();
    expect(validateApprovedRuleRevisionPreview({ ...preview, expectedTaskRevisionEpoch: '2' })).toBeNull();
    expect(validateApprovedRuleRevisionPreview({ ...preview, expectedArtifactDigest: 'not-a-digest' })).toBeNull();
  });
  it('preserves refusal and requires a real task receipt for success', () => {
    const refusal = { status: 'refused', reason: 'revision_budget_exhausted', nextAction: 'Inspect the existing revision.' };
    expect(validateApprovedRuleRevisionPreview(refusal)).toEqual(refusal);
    expect(validateApprovedRuleRevisionResult(refusal)).toEqual(refusal);
    expect(validateApprovedRuleRevisionResult({ status: 'started' })).toBeNull();
    expect(validateApprovedRuleRevisionResult({ status: 'approved', artificerTaskId: 'task', causeId: 'cause', taskRevisionEpoch: 1 })).toBeNull();
    expect(validateApprovedRuleRevisionResult({ status: 'already_started', artificerTaskId: 'task', causeId: 'cause', taskRevisionEpoch: 1 })).toMatchObject({ status: 'already_started' });
  });
});
