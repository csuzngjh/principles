/**
 * PRI-915: resolveLedgerActivationId availability semantics.
 *
 * An unreadable ledger must resolve as `ledger_unavailable`, never as
 * `principle_not_in_ledger` (data drift) — even when the membership fake would
 * have said "member", proving the availability gate precedes membership.
 */
import { describe, it, expect } from 'vitest';
import { resolveLedgerActivationId } from '../ledger-identity.js';
import type { LedgerIdentityChecker } from '../ledger-identity.js';
import type { LedgerIdentityLookupDeps } from '../ledger-identity.js';
import type { PIArtifactSnapshot } from '../activation-types.js';

const PRINCIPLE_ID = '11111111-2222-4222-8222-222222222222';
const CANDIDATE_ID = '22222222-3333-4333-8333-333333333333';
const DREAMER_TASK_ID = `dreamer-${CANDIDATE_ID}-prompt`;

function makeArtifact(sourcePrincipleId?: string): PIArtifactSnapshot {
  return {
    artifactId: 'pi-art-1',
    artifactKind: 'principle',
    sourceTaskId: 'task-1',
    ...(sourcePrincipleId !== undefined ? { sourcePrincipleId } : {}),
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: '{}',
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };
}

function makeChecker(opts: {
  available: boolean;
  known?: readonly string[];
  matches?: readonly { id: string }[];
}): LedgerIdentityChecker {
  return {
    isAvailable: () => opts.available,
    hasPrinciple: (id) => opts.known?.includes(id) ?? false,
    listForCandidate: () => [...(opts.matches ?? [])],
  };
}

function makeDeps(
  checker: LedgerIdentityChecker,
  dreamerArtifact?: PIArtifactSnapshot,
): LedgerIdentityLookupDeps {
  return {
    ledger: checker,
    getArtifactById: async (id) => (dreamerArtifact !== undefined && id === dreamerArtifact.artifactId ? dreamerArtifact : null),
  };
}

describe('resolveLedgerActivationId — PRI-915 availability gate', () => {
  it('direct path: an unreadable ledger is ledger_unavailable even for a member id', async () => {
    const resolution = await resolveLedgerActivationId(
      makeArtifact(PRINCIPLE_ID),
      makeDeps(makeChecker({ available: false, known: [PRINCIPLE_ID] })),
    );

    expect(resolution.status).toBe('unresolved');
    if (resolution.status === 'unresolved') {
      expect(resolution.reason).toContain('ledger_unavailable');
      expect(resolution.reason).not.toContain('principle_not_in_ledger');
    }
  });

  it('direct path: a readable ledger that does not know the id stays principle_not_in_ledger (drift)', async () => {
    const resolution = await resolveLedgerActivationId(
      makeArtifact(PRINCIPLE_ID),
      makeDeps(makeChecker({ available: true, known: [] })),
    );

    expect(resolution.status).toBe('unresolved');
    if (resolution.status === 'unresolved') {
      expect(resolution.reason).toBe(`principle_not_in_ledger: ${PRINCIPLE_ID}`);
    }
  });

  it('direct path: a readable ledger that knows the id still resolves', async () => {
    const resolution = await resolveLedgerActivationId(
      makeArtifact(PRINCIPLE_ID),
      makeDeps(makeChecker({ available: true, known: [PRINCIPLE_ID] })),
    );

    expect(resolution).toEqual({ status: 'resolved', principleId: PRINCIPLE_ID, how: 'direct_validated' });
  });

  it('lineage path: an unreadable ledger is ledger_unavailable, not an empty-match verdict', async () => {
    // No direct id → the dreamer lineage path: lineage → dreamer artifact →
    // task-id candidateId (DREAMER_TASK_ID → CANDIDATE_ID) → listForCandidate.
    const dreamerArtifact = makeArtifact();
    dreamerArtifact.artifactId = 'art-dreamer-1';
    dreamerArtifact.sourceTaskId = DREAMER_TASK_ID;
    const artifact = makeArtifact();
    artifact.lineageArtifactIds = ['art-dreamer-1'];

    const resolution = await resolveLedgerActivationId(
      artifact,
      makeDeps(makeChecker({ available: false, matches: [{ id: PRINCIPLE_ID }] }), dreamerArtifact),
    );

    expect(resolution.status).toBe('unresolved');
    if (resolution.status === 'unresolved') {
      expect(resolution.reason).toContain('ledger_unavailable');
      expect(resolution.reason).not.toContain('no principle derived from candidate');
    }
  });

  it('lineage path: a readable ledger with exactly one match still resolves via candidate_lineage', async () => {
    const dreamerArtifact = makeArtifact();
    dreamerArtifact.artifactId = 'art-dreamer-1';
    dreamerArtifact.sourceTaskId = DREAMER_TASK_ID;
    const artifact = makeArtifact();
    artifact.lineageArtifactIds = ['art-dreamer-1'];

    const resolution = await resolveLedgerActivationId(
      artifact,
      makeDeps(makeChecker({ available: true, matches: [{ id: PRINCIPLE_ID }] }), dreamerArtifact),
    );

    expect(resolution).toEqual({ status: 'resolved', principleId: PRINCIPLE_ID, how: 'candidate_lineage' });
  });
});

/**
 * P1-3 regression: the ARTIFACT kind is not the candidate's identity family. A
 * `principle` candidate can publish a `rule` artifact for code enforcement (the
 * RuleHost pipeline), and that must still resolve through the principle
 * namespace. Conversely a `rule` candidate stays in the rule (Owner-binding)
 * namespace whatever artifact carries it.
 */
describe('resolveLedgerActivationId — the persisted candidate kind decides the ledger namespace', () => {
  function lineageDeps(artifactKind: PIArtifactSnapshot['artifactKind'], recommendationKind: string) {
    const dreamerArtifact = makeArtifact();
    dreamerArtifact.artifactId = 'art-dreamer-1';
    dreamerArtifact.sourceTaskId = DREAMER_TASK_ID;
    const artifact = makeArtifact();
    artifact.artifactKind = artifactKind;
    artifact.lineageArtifactIds = ['art-dreamer-1'];
    const seenKinds: unknown[] = [];
    const checker: LedgerIdentityChecker = {
      isAvailable: () => true,
      hasPrinciple: () => false,
      listForCandidate: () => [],
      resolveCandidatePrincipleIdentity: (_id, kind) => {
        seenKinds.push(kind);
        return kind === 'principle' || kind === 'rule'
          ? { status: 'resolved', candidateId: CANDIDATE_ID, principleId: PRINCIPLE_ID, basis: 'derived_candidate', checkedAt: '2026-11-13T00:00:00.000Z' }
          : { status: 'unresolved', reason: 'candidate_kind_not_ledger_eligible', nextAction: 'use_the_candidate_channel' };
      },
    };
    const deps: LedgerIdentityLookupDeps = {
      ledger: checker,
      getCandidateKind: () => recommendationKind,
      getArtifactById: async (id) => (id === 'art-dreamer-1' ? dreamerArtifact : null),
    };
    return { artifact, deps, seenKinds };
  }

  it('a principle candidate published as a rule artifact resolves through the principle namespace', async () => {
    const { artifact, deps, seenKinds } = lineageDeps('rule', 'principle');
    const resolution = await resolveLedgerActivationId(artifact, deps);
    expect(resolution).toEqual({ status: 'resolved', principleId: PRINCIPLE_ID, how: 'candidate_lineage' });
    expect(seenKinds).toEqual(['principle']);
  });

  it('a rule candidate stays in the rule namespace whatever artifact carries it', async () => {
    const { artifact, deps, seenKinds } = lineageDeps('principle', 'rule');
    const resolution = await resolveLedgerActivationId(artifact, deps);
    expect(resolution).toEqual({ status: 'resolved', principleId: PRINCIPLE_ID, how: 'candidate_lineage' });
    expect(seenKinds).toEqual(['rule']);
  });

  it('an unknown persisted kind still reaches the ledger resolver as-is (no silent coercion)', async () => {
    const { artifact, deps, seenKinds } = lineageDeps('skill', 'prompt');
    const resolution = await resolveLedgerActivationId(artifact, deps);
    expect(resolution.status).toBe('unresolved');
    expect(seenKinds).toEqual(['prompt']);
  });
});
