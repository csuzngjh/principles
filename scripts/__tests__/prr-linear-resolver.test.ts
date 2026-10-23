// PRI-1002 — production Linear-backed evidence-resolver regression suite.
//
// The resolver reads the Owner's freeze-approval comment on Linear PRI-1001
// through an injected (mock) Linear client. No real Linear call, no real
// model. Covers: matching signature, digest/commit/fixtureHash/decisionRef
// mismatches, non-Owner authors, missing/unsigned comments, incomplete
// fields, pricing modes and pricing-reference mismatches.

import { describe, expect, it, vi } from 'vitest';

import { verify, fetchOwnerApproval, APPROVAL_MARKER } from '../dev/principle-learning-lab/prr/lib/linear-owner-resolver.mjs';

const DIGEST = '7'.repeat(64);
const COMMIT = 'c'.repeat(40);
const FIXTURE = 'f'.repeat(64);
const COST_REF = 'zai-coding-plan-2026-10';
const OWNER = 'gong wesley';

function approvalBody(overrides: Record<string, string> = {}) {
  const fields = {
    decisionRef: 'PRI-1001-approval-2026-10-23',
    protocolDigest: DIGEST,
    frozenCommitSha: COMMIT,
    fixtureHash: FIXTURE,
    costBasisRef: COST_REF,
    pricingMode: 'zai-coding-plan',
    approved: 'yes',
    ...overrides,
  };
  return [
    APPROVAL_MARKER,
    `decisionRef: ${fields.decisionRef}`,
    `protocolDigest: ${fields.protocolDigest}`,
    `frozenCommitSha: ${fields.frozenCommitSha}`,
    `fixtureHash: ${fields.fixtureHash}`,
    `costBasisRef: ${fields.costBasisRef}`,
    `pricingMode: ${fields.pricingMode}`,
    `approved: ${fields.approved}`,
  ].join('\n');
}

function mockClient(comments: { body: string; name: string }[]) {
  return {
    request: async () => ({
      data: {
        issue: {
          comments: {
            nodes: comments.map((c) => ({ body: c.body, createdAt: '2026-10-23T00:00:00.000Z', user: { name: c.name, email: 'owner@example.com', active: true } })),
          },
        },
      },
    }),
  };
}

const happyComment = { body: approvalBody(), name: OWNER };
const mock = () => mockClient([happyComment]);
const OWNER_DECISION_REQ = {
  kind: 'owner-decision',
  decisionRef: 'PRI-1001-approval-2026-10-23',
  expectedProtocolDigest: DIGEST,
  expectedCommitSha: COMMIT,
  expectedFixtureHash: FIXTURE,
  expectedBudget: {
    costBasis: { provider: 'zai', model: 'glm-4.7', currency: 'USD', inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0, maxInputTokensPerRequest: 8192, maxOutputTokensPerRequest: 1024, effectiveDate: '2026-10-23' },
  },
  client: mock(),
};

describe('linear-owner-resolver (mock Linear client)', () => {
  it('a matching Owner signature verifies with every attested field', async () => {
    const approval = await fetchOwnerApproval({ client: mockClient([happyComment]) });
    expect(approval).toMatchObject({
      verified: true,
      approved: true,
      decisionRef: 'PRI-1001-approval-2026-10-23',
      approvedProtocolDigest: DIGEST,
      frozenCommitSha: COMMIT,
      frozenFixtureHash: FIXTURE,
      costBasisRef: COST_REF,
      pricingMode: 'zai-coding-plan',
      author: OWNER,
    });
  });

  it('verify passes end-to-end when every expectation matches the attestation', async () => {
    const result = await verify({ ...OWNER_DECISION_REQ, client: mock() });
    expect(result.verified).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.approvedProtocolDigest).toBe(DIGEST);
    expect(result.frozenFixtureHash).toBe(FIXTURE);
  });

  it('a protocol digest mismatch refuses with the exact expectation echoed', async () => {
    const result = await verify({
      ...OWNER_DECISION_REQ,
      expectedProtocolDigest: 'e'.repeat(64),
      client: mock(),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('protocolDigest');
    expect(result.reason).toContain('vs expected');
  });

  it('a frozen-commit mismatch refuses', async () => {
    const result = await verify({ ...OWNER_DECISION_REQ, expectedCommitSha: 'e'.repeat(40), client: mock() });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('frozenCommitSha');
  });

  it('a fixture-hash mismatch refuses', async () => {
    const result = await verify({ ...OWNER_DECISION_REQ, expectedFixtureHash: 'e'.repeat(64), client: mock() });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('fixtureHash');
  });

  it('a decision-ref mismatch refuses', async () => {
    const result = await verify({ ...OWNER_DECISION_REQ, decisionRef: 'a-different-ref', client: mock() });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('decisionRef');
  });

  it('comments by non-Owner authors are never approval evidence', async () => {
    const approval = await fetchOwnerApproval({ client: mockClient([
      { body: approvalBody(), name: 'some-other-agent' },
    ]) });
    expect(approval.verified).toBe(false);
    expect(approval.reason).toContain('none by the configured Owner');
  });

  it('no approval-marker comment at all refuses', async () => {
    const approval = await fetchOwnerApproval({ client: mockClient([
      { body: 'looks good to me', name: OWNER },
    ]) });
    expect(approval.verified).toBe(false);
    expect(approval.reason).toContain('no [PRR-FREEZE-APPROVAL] comment');
  });

  it('an incomplete signature (missing fixtureHash) refuses', async () => {
    const body = approvalBody().replace(/^fixtureHash:.*$/m, 'fixtureHash: (to be filled)');
    const approval = await fetchOwnerApproval({ client: mockClient([{ body, name: OWNER }]) });
    expect(approval.verified).toBe(false);
    expect(approval.reason).toContain('fixtureHash');
  });

  it('an unsigned (approved: no) signature refuses', async () => {
    const approval = await fetchOwnerApproval({ client: mockClient([
      { body: approvalBody({ approved: 'no' }), name: OWNER },
    ]) });
    expect(approval.verified).toBe(false);
    expect(approval.reason).toContain('approved:yes');
  });

  it('the latest Owner signature wins over older ones', async () => {
    const older = { body: approvalBody({ protocolDigest: 'e'.repeat(64) }), name: OWNER };
    const approval = await fetchOwnerApproval({ client: {
      request: async () => ({
        data: { issue: { comments: { nodes: [
          { ...older, createdAt: '2026-10-22T00:00:00.000Z', user: { name: OWNER, active: true } },
          { ...happyComment, createdAt: '2026-10-23T00:00:00.000Z', user: { name: OWNER, active: true } },
        ] } } },
      }),
    } });
    // Both nodes carry createdAt in-body; the resolver relies on Linear's
    // createdAtDesc ordering, which this mock's node order already reflects
    // (newest first). Assert the FIRST (newest) node's attestation wins.
    expect(approval.approvedProtocolDigest).toBe(DIGEST); // the LATEST signature
  });

  it('cost-basis with a mismatching signed reference refuses', async () => {
    const pricing = await verify({
      kind: 'cost-basis',
      reference: 'a-different-costBasisRef',
      provider: 'zai',
      model: 'glm-4.7',
      expectedBudget: OWNER_DECISION_REQ.expectedBudget,
      client: mockClient([happyComment]),
    });
    expect(pricing.verified).toBe(false);
    expect(pricing.reason).toContain('pricing schedule');
    expect(pricing.reason).toContain('a-different-costBasisRef');
  });

  it('an unrecognized pricingMode refuses', async () => {
    const pricing = await verify({
      kind: 'cost-basis',
      reference: COST_REF,
      provider: 'zai',
      model: 'glm-4.7',
      expectedBudget: OWNER_DECISION_REQ.expectedBudget,
      client: mockClient([{ body: approvalBody({ pricingMode: 'pay-as-you-go' }), name: OWNER }]),
    });
    expect(pricing.verified).toBe(false);
    expect(String(pricing.reason)).toMatch(/unrecognized pricingMode|missing.*pricingMode/i);
  });

  it('an unknown evidence kind refuses', async () => {
    const result = await verify({ kind: 'something-else', client: mock() });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('unknown evidence kind');
  });

  it('the Owner identity is configurable via LINEAR_OWNER_NAME', async () => {
    const previous = process.env.LINEAR_OWNER_NAME;
    process.env.LINEAR_OWNER_NAME = 'delegated-reviewer';
    try {
      const approval = await fetchOwnerApproval({ client: mockClient([
        { body: approvalBody(), name: 'delegated-reviewer' },
      ]) });
      expect(approval.verified).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LINEAR_OWNER_NAME;
      else process.env.LINEAR_OWNER_NAME = previous;
    }
  });
});
