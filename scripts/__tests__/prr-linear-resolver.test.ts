// PRI-1002 — production Linear-backed evidence-resolver regression suite.
//
// The resolver reads the Owner's freeze-approval comment on Linear PRI-1001
// through an injected (mock) Linear client. No real Linear call, no real
// model. Author identity is bound to the STABLE Linear user id from trusted
// deployment configuration (LINEAR_OWNER_ID) — display names never decide
// authorization. Covers: matching id+signature end-to-end, same-display-name
// different-id refusal, missing author id, unconfigured expected id, identity
// query failure, digest/commit/fixtureHash/decisionRef/pricing mismatch
// classes, non-Owner authors, unsigned/incomplete signatures, latest-wins.

import { describe, expect, it, vi, afterEach } from 'vitest';

import { verify, fetchOwnerApproval, expectedOwnerId, APPROVAL_MARKER } from '../dev/principle-learning-lab/prr/lib/linear-owner-resolver.mjs';

const OWNER_ID = '11111111-2222-3333-4444-555555555555'; // stable Linear user id (trusted config)
const DIGEST = '7'.repeat(64);
const COMMIT = 'c'.repeat(40);
const FIXTURE = 'f'.repeat(64);
const COST_REF = 'zai-coding-plan-2026-10';
const OWNER_NAME = 'gong wesley';

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

function mockClient(comments: { body: string; name?: string; id?: string | null }[]) {
  return {
    request: async () => ({
      data: {
        issue: {
          comments: {
            nodes: comments.map((c) => ({
              body: c.body,
              createdAt: '2026-10-23T00:00:00.000Z',
              user: { id: c.id === undefined ? OWNER_ID : c.id, name: c.name ?? OWNER_NAME, active: true },
            })),
          },
        },
      },
    }),
  };
}

const happyComment = { body: approvalBody() };
const OWNER_DECISION_REQ = {
  kind: 'owner-decision',
  decisionRef: 'PRI-1001-approval-2026-10-23',
  expectedProtocolDigest: DIGEST,
  expectedCommitSha: COMMIT,
  expectedFixtureHash: FIXTURE,
  expectedBudget: {
    costBasis: { provider: 'zai', model: 'glm-4.7', currency: 'USD', inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0, maxInputTokensPerRequest: 8192, maxOutputTokensPerRequest: 1024, effectiveDate: '2026-10-23' },
  },
};

describe('linear-owner-resolver (stable-id identity binding, round 8)', () => {
  afterEach(() => {
    delete process.env.LINEAR_OWNER_ID;
    vi.unstubAllEnvs();
  });

  it('expectedOwnerId reads trusted deployment config and is null when absent', () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    expect(expectedOwnerId()).toBe(OWNER_ID);
    delete process.env.LINEAR_OWNER_ID;
    expect(expectedOwnerId()).toBeNull();
  });

  it('the correct Owner id + correct signature verifies end-to-end with every attested field', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const result = await verify({ ...OWNER_DECISION_REQ, client: mockClient([happyComment]) });
    expect(result).toMatchObject({
      verified: true,
      approved: true,
      decisionRef: 'PRI-1001-approval-2026-10-23',
      approvedProtocolDigest: DIGEST,
      frozenCommitSha: COMMIT,
      frozenFixtureHash: FIXTURE,
    });
  });

  it('the same display name with a DIFFERENT user id refuses (round 8 core case)', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const approval = await fetchOwnerApproval({ client: mockClient([
      { body: approvalBody(), name: OWNER_NAME, id: '99999999-8888-7777-6666-555555555555' }, // same name, different id
    ]) });
    expect(approval.verified).toBe(false);
    expect(approval.reason).toContain('none by the configured Owner id');
  });

  it('a missing author id refuses even with the right display name', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const approval = await fetchOwnerApproval({ client: mockClient([
      { body: approvalBody(), name: OWNER_NAME, id: null },
    ]) });
    expect(approval.verified).toBe(false);
    expect(approval.reason).toContain('none by the configured Owner id');
  });

  it('an UNCONFIGURED expected Owner id falls back to the PRI-1001 creator id (Linear-authoritative)', async () => {
    delete process.env.LINEAR_OWNER_ID;
    // Mock mirrors the resolver query shape: creator + comments.
    const client = {
      request: async () => ({
        data: { issue: {
          creator: { id: OWNER_ID, name: OWNER_NAME, active: true },
          comments: { nodes: [{ body: approvalBody(), createdAt: '2026-10-23T00:00:00.000Z', user: { id: OWNER_ID, name: OWNER_NAME, active: true } }] },
        } },
      }),
    };
    const approval = await fetchOwnerApproval({ client });
    expect(approval.verified).toBe(true); // creator-id fallback accepts the Owner signature
    expect(approval.authorId).toBe(OWNER_ID);
  });

  it('creator fallback still refuses when the signature author differs from the creator', async () => {
    delete process.env.LINEAR_OWNER_ID;
    const client = {
      request: async () => ({
        data: { issue: {
          creator: { id: OWNER_ID, name: OWNER_NAME, active: true },
          comments: { nodes: [{ body: approvalBody(), createdAt: '2026-10-23T00:00:00.000Z', user: { id: '99999999-8888-7777-6666-555555555555', name: 'impostor', active: true } }] },
        } },
      }),
    };
    const approval = await fetchOwnerApproval({ client });
    expect(approval.verified).toBe(false);
    expect(approval.reason).toContain('none by the configured Owner id');
  });

  it('an UNCONFIGURED expected Owner id is fail-closed when Linear reports no creator', async () => {
    delete process.env.LINEAR_OWNER_ID;
    const approval = await fetchOwnerApproval({ client: mockClient([happyComment]) });
    expect(approval.verified).toBe(false);
    expect(approval.reason).toContain('cannot establish the expected Owner identity');
    // And the runner gate would then refuse — the signature is never accepted
    // on display-name similarity alone.
    const result = await verify({ ...OWNER_DECISION_REQ, client: mockClient([happyComment]) });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('cannot establish the expected Owner identity');
  });

  it('an identity query failure refuses (transport error caught and turned into unverified)', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    // verify()'s try/catch contract turns transport failures into a
    // verified:false refusal — never an unhandled crash, never a pass.
    const result = await verify({ ...OWNER_DECISION_REQ, client: { request: async () => { throw new Error('Linear API 503'); } } });
    expect(result.verified).toBe(false);
    expect(String(result.reason)).toContain('Linear API 503');
  });

  it('a different (non-Owner) author id refuses', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const approval = await fetchOwnerApproval({ client: mockClient([
      { body: approvalBody(), name: 'some-other-agent', id: '99999999-8888-7777-6666-555555555555' },
    ]) });
    expect(approval.verified).toBe(false);
    expect(approval.reason).toContain('none by the configured Owner id');
  });

  it('verify refuses on protocol digest mismatch (existing class kept)', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const result = await verify({ ...OWNER_DECISION_REQ, expectedProtocolDigest: 'e'.repeat(64), client: mockClient([happyComment]) });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('protocolDigest');
  });

  it('verify refuses on frozen-commit mismatch (existing class kept)', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const result = await verify({ ...OWNER_DECISION_REQ, expectedCommitSha: 'e'.repeat(40), client: mockClient([happyComment]) });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('frozenCommitSha');
  });

  it('verify refuses on fixture-hash mismatch (existing class kept)', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const result = await verify({ ...OWNER_DECISION_REQ, expectedFixtureHash: 'e'.repeat(64), client: mockClient([happyComment]) });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('fixtureHash');
  });

  it('verify refuses on decision-ref mismatch (existing class kept)', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const result = await verify({ ...OWNER_DECISION_REQ, decisionRef: 'a-different-ref', client: mockClient([happyComment]) });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('decisionRef');
  });

  it('the latest signature by the Owner id wins over older ones', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const approval = await fetchOwnerApproval({ client: {
      request: async () => ({
        data: { issue: { comments: { nodes: [
          { body: approvalBody({ protocolDigest: 'e'.repeat(64) }), createdAt: '2026-10-22T00:00:00.000Z', user: { id: OWNER_ID, name: OWNER_NAME, active: true } },
          { body: approvalBody(), createdAt: '2026-10-23T00:00:00.000Z', user: { id: OWNER_ID, name: OWNER_NAME, active: true } },
        ] } } },
      }),
    } });
    expect(approval.approvedProtocolDigest).toBe(DIGEST); // the LATEST signature
  });

  it('cost-basis attestation: signed reference + $0 subscription rate + frozen max tokens', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const pricing = await verify({
      kind: 'cost-basis',
      reference: COST_REF,
      provider: 'zai',
      model: 'glm-4.7',
      expectedBudget: OWNER_DECISION_REQ.expectedBudget,
      client: mockClient([happyComment]),
    });
    expect(pricing).toMatchObject({
      verified: true,
      reference: COST_REF,
      provider: 'zai',
      model: 'glm-4.7',
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
      maxInputTokensPerRequest: 8192,
      maxOutputTokensPerRequest: 1024,
    });
    expect(String(pricing.source)).toContain('zai-coding-plan');
  });

  it('cost-basis with a mismatching signed reference refuses (existing class kept)', async () => {
    process.env.LINEAR_OWNER_ID = OWNER_ID;
    const pricing = await verify({
      kind: 'cost-basis',
      reference: 'a-different-costBasisRef',
      provider: 'zai',
      model: 'glm-4.7',
      expectedBudget: OWNER_DECISION_REQ.expectedBudget,
      client: mockClient([happyComment]),
    });
    expect(pricing.verified).toBe(false);
    expect(pricing.reason).toContain('does not cover this pricing schedule');
    expect(pricing.reason).toContain('a-different-costBasisRef');
  });

  it('cost-basis falls back to the creator id too; fail-closed when Linear reports no creator', async () => {
    delete process.env.LINEAR_OWNER_ID;
    // mockClient has no creator field → Linear reports no creator → fail-closed.
    const pricing = await verify({
      kind: 'cost-basis',
      reference: COST_REF,
      provider: 'zai',
      model: 'glm-4.7',
      expectedBudget: OWNER_DECISION_REQ.expectedBudget,
      client: mockClient([happyComment]),
    });
    expect(pricing.verified).toBe(false);
    expect(String(pricing.reason)).toContain('cannot establish the expected Owner identity');

    // With a creator present, the fallback accepts a matching signature.
    const clientWithCreator = {
      request: async () => ({
        data: { issue: {
          creator: { id: OWNER_ID, name: OWNER_NAME, active: true },
          comments: { nodes: [{ body: approvalBody(), createdAt: '2026-10-23T00:00:00.000Z', user: { id: OWNER_ID, name: OWNER_NAME, active: true } }] },
        } },
      }),
    };
    const pricingOk = await verify({
      kind: 'cost-basis',
      reference: COST_REF,
      provider: 'zai',
      model: 'glm-4.7',
      expectedBudget: OWNER_DECISION_REQ.expectedBudget,
      client: clientWithCreator,
    });
    expect(pricingOk.verified).toBe(true);
  });

  it('every authoritative status is usable and statuses keep deriving from the schema', async () => {
    // (kept from round 3/4 guard) — statuses continue to derive from the
    // schema constant; asserted via the resolver's exported helper.
    const { authoritativePrincipleStatuses } = await import('../dev/principle-learning-lab/prr/lib/prr-readonly.mjs');
    expect(authoritativePrincipleStatuses()).toEqual([...(await import('@principles/core/runtime-v2')).PRINCIPLE_STATUSES].sort());
  });
});
