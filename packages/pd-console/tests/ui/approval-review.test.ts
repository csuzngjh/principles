import { describe, it, expect } from 'vitest';
import { validateApprovalsGroupedData } from '../../src/ui/pages/focus/focus-validation.js';
import { validateApprovalReview } from '../../src/ui/utils/approval-review.js';

function fixture() {
  return { approvalId: 'approval-one', artifactId: 'artifact-one', channel: 'prompt', status: 'pending', riskLevel: 'low', requestedAt: '2026-10-30T00:00:00Z', writeGuardVersion: 'approval-review-v1',
    review: { expectedReview: { schemaVersion: 'approval-review-v1', approvalId: 'approval-one', artifactId: 'artifact-one', channel: 'prompt', artifactState: 'present', artifactDigest: 'sha256:' + 'a'.repeat(64) },
      material: { availability: 'available', artifactId: 'artifact-one', statement: 'Check the requested scope.', rationale: null, targetBehavior: 'Ask before the shared write.', scope: ['File operations'], risks: ['Verify the deletion boundary.'], exactBody: { kind: 'principle', text: 'Complete normative text.' } } } };
}
describe('one response binds readable material to the submitted approval snapshot', () => {
  it('retains exact material with its guard; unreadable present artifacts remain readable only as unavailable material', () => {
    expect(validateApprovalReview(fixture())).toMatchObject({ expectedReview: { artifactId: 'artifact-one' }, material: { exactBody: { text: 'Complete normative text.' } } });
    const value = fixture();
    expect(validateApprovalReview({ ...value, review: { ...value.review, material: { ...value.review.material, availability: 'unreadable', exactBody: null } } })).not.toBeNull();
  });
  it.each(['approvalId', 'artifactId', 'channel'])('rejects mismatched guard %s', key => {
    const value = fixture();
    expect(validateApprovalReview({ ...value, review: { ...value.review, expectedReview: { ...value.review.expectedReview, [key]: 'different' } } })).toBeNull();
  });
  it('rejects a material from another artifact or malformed scope/digest', () => {
    const value = fixture();
    for (const material of [{ ...value.review.material, artifactId: 'other' }, { ...value.review.material, scope: [null] }, { ...value.review.material, risks: [null] }]) {
      expect(validateApprovalReview({ ...value, review: { ...value.review, material } })).toBeNull();
    }
    expect(validateApprovalReview({ ...value, review: { ...value.review, expectedReview: { ...value.review.expectedReview, artifactDigest: 'wrong' } } })).toBeNull();
  });
  it('accepts only an explicitly missing material for a missing-artifact rejection guard', () => {
    const value = fixture();
    const missing = { schemaVersion: 'approval-review-v1', approvalId: value.approvalId, artifactId: value.artifactId, channel: value.channel, artifactState: 'missing' };
    expect(validateApprovalReview({ ...value, review: { ...value.review, expectedReview: missing } })).toBeNull();
    expect(validateApprovalReview({ ...value, review: { expectedReview: missing, material: { ...value.review.material, availability: 'missing', statement: null, exactBody: null } } })).not.toBeNull();
  });
});


it('Focus preserves revision identity, digest and unavailable intent across its extra validation boundary', () => {
  const revisionReview = { artifactId: 'artifact-one', artifactDigest: 'sha256:' + 'b'.repeat(64), oldStatement: 'before', newStatement: 'after', intentFields: { ownerIntent: 'Keep the boundary' } };
  const data = validateApprovalsGroupedData({ generatedAt: '2026-10-30T00:00:00Z', groups: [{ principleId: 'principle-one', principleTitle: 'A readable title', status: 'pending', records: [], revisionReview, revisionReviewUnavailable: true }] });
  expect(data?.groups[0]?.revisionReview).toEqual(revisionReview);
  expect(data?.groups[0]?.revisionReviewUnavailable).toBe(true);
});
