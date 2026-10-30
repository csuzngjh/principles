import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson, hashOfCanonical, verifyExaminerReview } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';

// Ephemeral test keys and identities only. No receipt is installed or copied
// into a research asset; positive tests simulate a separately pinned Owner.
function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const subjectHash = 'a'.repeat(64);
  const reviewer = { id: 'SYNTHETIC-HUMAN-FOR-TEST-ONLY', kind: 'HUMAN', independent: true,
    revoked: false, canApproveGold: true, identityEvidenceRef: 'SYNTHETIC-IDENTITY-NOT-A-PERSON',
    allowedSchemas: ['examiner-gold-review.v1'], allowedSubjects: [subjectHash],
    validFrom: '2026-10-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const authority = { schema: 'examiner-review-authority.v1', ownerDesignationRef: 'SYNTHETIC OWNER PIN TEST', excludedAuthors: ['EXAMINER'], reviewers: [reviewer] };
  const payload = { schema: 'examiner-gold-review.v1', reviewerId: reviewer.id, reviewerRole: 'INDEPENDENT_REVIEWER',
    decision: 'APPROVED', reviewedAt: '2026-10-30T00:00:00.000Z', reason: 'Synthetic validator test, not actual human approval.',
    caseId: 'TEST', goldHash: 'b'.repeat(64), sourceRefs: ['TEST-SOURCE'], subjectHash,
    scope: 'OFFLINE_GOLD_ONLY', goldSourcesVerified: true };
  const review = { ...payload, signature: sign(null, Buffer.from(canonicalJson(payload)), keys.privateKey).toString('base64') };
  return { review, reviewTrust: { authority, trustedAuthorityHash: hashOfCanonical(authority), subjectHash, now: '2026-10-30T00:00:00.000Z' } };
}
const check = (f) => verifyExaminerReview({ ...f, schema: 'examiner-gold-review.v1', mode: 'formal' });
describe('offline human review authority — fail closed', () => {
  it('verifies an intact signed receipt against a separately pinned permitted test identity', () => expect(check(fixture()).ok).toBe(true));
  it('does not accept a role string without a pinned authority', () => expect(check({ review: fixture().review }).ok).toBe(false));
  it.each(['decision', 'goldHash', 'caseId', 'reason', 'sourceRefs'])('rejects signed receipt tampering: %s', (field) => {
    const f = fixture(); f.review[field] = field === 'sourceRefs' ? ['changed'] : 'changed'; expect(check(f).ok).toBe(false);
  });
  it.each(['revoked', 'independent', 'kind', 'canApproveGold', 'allowedSchemas', 'allowedSubjects', 'validUntil', 'publicKeyPem'])('rejects an authentic policy denying %s', (field) => {
    const f = fixture();
    const values = { revoked: true, independent: false, kind: 'AI', canApproveGold: false, allowedSchemas: [], allowedSubjects: [], validUntil: '2026-10-29T00:00:00.000Z', publicKeyPem: 'not a key' };
    f.reviewTrust.authority.reviewers[0][field] = values[field];
    f.reviewTrust.trustedAuthorityHash = hashOfCanonical(f.reviewTrust.authority);
    expect(check(f).ok).toBe(false);
  });
  it('rejects unpinned policy replacement, wrong subject, absent signature and invalid dates', () => {
    const a = fixture(); a.reviewTrust.authority.ownerDesignationRef = 'changed'; expect(check(a).ok).toBe(false);
    const b = fixture(); b.reviewTrust.subjectHash = 'c'.repeat(64); expect(check(b).ok).toBe(false);
    const c = fixture(); delete c.review.signature; expect(check(c).ok).toBe(false);
    const d = fixture(); d.review.reviewedAt = '2026-02-30T00:00:00.000Z'; expect(check(d).ok).toBe(false);
  });
});
