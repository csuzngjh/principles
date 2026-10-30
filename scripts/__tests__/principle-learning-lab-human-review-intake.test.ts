import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson, hashOfCanonical } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';
import { verifyExmHumanReviews } from '../dev/principle-learning-lab/verify-exm-human-review.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab/challenge-studies/EXM-MVP-001-v4');
const now = '2026-10-30T00:00:00.000Z';
function syntheticIntake() {
  const receipts = JSON.parse(fs.readFileSync(path.join(packageDir, 'blind-review/receipts.template.json'), 'utf8'));
  const keys = generateKeyPairSync('ed25519');
  const reviewerId = 'SYNTHETIC-TEST-ONLY-NOT-A-HUMAN-APPROVAL';
  const authority = { schema: 'examiner-review-authority.v1', ownerDesignationRef: 'SYNTHETIC-TEST-ONLY', excludedAuthors: ['EXAMINER'], reviewers: [{
    id: reviewerId, kind: 'HUMAN', independent: true, revoked: false, canApproveGold: true,
    identityEvidenceRef: 'SYNTHETIC-TEST-ONLY', allowedSchemas: ['examiner-mapping-review.v1', 'examiner-gold-review.v1'],
    allowedSubjects: [receipts.mappingReview.subjectHash], validFrom: '2026-10-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }] };
  for (const receipt of [receipts.mappingReview, ...receipts.goldReviews]) {
    receipt.reviewerId = reviewerId;
    receipt.decision = 'APPROVED';
    receipt.reviewedAt = now;
    receipt.reason = 'Synthetic signature verification test only; no research approval.';
    receipt.goldSourcesVerified = true;
    delete receipt.signature;
    receipt.signature = sign(null, Buffer.from(canonicalJson(receipt)), keys.privateKey).toString('base64');
  }
  return { packageDir, now, receipts, authority, authorityPin: hashOfCanonical(authority) };
}

describe('complete frozen Gold intake, with ephemeral test identities only', () => {
  it('keeps the actual package pending without independently supplied human credentials', async () => {
    const result = await verifyExmHumanReviews({ packageDir, now });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('GOLD_REVIEW_PENDING');
  });
  it('can validate all nine signatures without changing research authorization or frozen inputs', async () => {
    const result = await verifyExmHumanReviews(syntheticIntake());
    expect(result.ok).toBe(true);
    expect(result.reviews).toHaveLength(9);
    expect(result.experimentAuthorization).toBe('NOT_AUTHORIZED');
    expect(result.realExaminerQuality).toBe('NOT_VERIFIED');
  });
  it('rejects an incomplete review set', async () => {
    const input = syntheticIntake(); input.receipts.goldReviews.pop();
    expect((await verifyExmHumanReviews(input)).ok).toBe(false);
  });
  it('rejects a changed case binding despite a valid authority', async () => {
    const input = syntheticIntake(); input.receipts.goldReviews[0].goldHash = '0'.repeat(64);
    expect((await verifyExmHumanReviews(input)).ok).toBe(false);
  });
  it('rejects the source mapping when its signature is missing', async () => {
    const input = syntheticIntake(); delete input.receipts.mappingReview.signature;
    expect((await verifyExmHumanReviews(input)).ok).toBe(false);
  });
});
