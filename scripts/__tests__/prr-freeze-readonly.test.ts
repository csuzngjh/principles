// PRI-1002 — B0 G7 freeze validator + G5 read-only semantics regression suite.
//
// The freeze tests prove fail-closed behavior from every angle: drafts refuse
// real runs, forged approvals are rejected, hash tampering is INVALID_PROTOCOL,
// and a fully-frozen record still needs a TRUSTED verifier to pass.
// The read-only tests pin the four-way ledger classification, explicit
// ambiguity (M4), D-01-gated summaries and the state-unchanged snapshot.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildDraftFreeze,
  FZ_IDS,
  preregBodyHash,
  validateFreezeForRealRun,
  validateFreezeRecord,
} from '../dev/principle-learning-lab/prr/lib/prr-freeze.mjs';
import {
  assertStateUnchanged,
  classifyLedgerAvailability,
  measureLedgerPrinciples,
  snapshotTree,
} from '../dev/principle-learning-lab/prr/lib/prr-readonly.mjs';
import { buildPrrDatasetFiles, writePrrDataset } from './prr-test-fixtures';
import { loadPrrDataset } from '../dev/principle-learning-lab/prr/lib/prr-dataset.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prr-freeze-ro-'));
let dataset: any;

beforeAll(() => {
  writePrrDataset(path.join(tmpRoot, 'dataset'));
  dataset = loadPrrDataset(path.join(tmpRoot, 'dataset'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function fullyFrozenRecord(preregBody: any, overrides: Record<string, unknown> = {}) {
  const draft = buildDraftFreeze({ studyId: 'test', preregBody });
  return {
    ...draft,
    status: 'OWNER_APPROVED_FROZEN',
    items: draft.items.map((item: any) => {
      let value: unknown = { frozen: true };
      if (item.id === 'FZ-01') value = { taskSetHash: dataset.fixtureHash };
      if (item.id === 'FZ-11') value = { minPairs: 3, derivationBasis: 'derived from the FZ-09 detectable difference under the expected variance' };
      return { ...item, status: 'VALUE_FROZEN', value, ownerApprovalRef: 'owner-decision-ref-1' };
    }),
    ownerApproval: {
      approvedBy: 'owner',
      decisionRef: 'owner-decision-ref-1',
      frozenCommitSha: 'a'.repeat(40),
    },
    ...overrides,
  };
}

const FROZEN_COMMIT = 'a'.repeat(40);
const verifyOk = () => ({ verified: true, approved: true, frozenCommitSha: FROZEN_COMMIT });

describe('freeze record structure', () => {
  const preregBody = { studyId: 'test', note: 'body' };

  it('enumerates exactly FZ-01..FZ-15', () => {
    expect(FZ_IDS).toHaveLength(15);
    expect(FZ_IDS[0]).toBe('FZ-01');
    expect(FZ_IDS[14]).toBe('FZ-15');
    const draft = buildDraftFreeze({ studyId: 'test', preregBody });
    expect(validateFreezeRecord(draft)).toEqual([]);
  });

  it('rejects unknown/missing FZ ids (closed namespace)', () => {
    const draft: any = buildDraftFreeze({ studyId: 'test', preregBody });
    draft.items.push({ id: 'FZ-16', status: 'OWNER_DECISION_REQUIRED', value: null });
    const problems = validateFreezeRecord(draft);
    expect(problems.some((p: string) => p.includes('FZ-16'))).toBe(true);

    const missing: any = buildDraftFreeze({ studyId: 'test', preregBody });
    missing.items = missing.items.filter((i: any) => i.id !== 'FZ-09');
    expect(validateFreezeRecord(missing).some((p: string) => p.includes('missing item FZ-09'))).toBe(true);
  });

  it('rejects a draft item that carries a value (no fabricated values)', () => {
    const draft: any = buildDraftFreeze({ studyId: 'test', preregBody });
    draft.items[0].value = { sneaked: true };
    expect(validateFreezeRecord(draft).some((p: string) => p.includes('fabricate values'))).toBe(true);
  });

  it('rejects FROZEN status without an ownerApproval record (forged approval)', () => {
    const draft: any = buildDraftFreeze({ studyId: 'test', preregBody });
    draft.status = 'OWNER_APPROVED_FROZEN';
    const problems = validateFreezeRecord(draft);
    expect(problems.some((p: string) => p.includes('ownerApproval record is missing'))).toBe(true);
  });
});

describe('freeze real-run gate (fail-closed)', () => {
  const preregBody = { studyId: 'test', note: 'body' };

  it('a fully-frozen record with a trusted verifier passes', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const { problems, minPairsEligible, pairDenominator } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifyOk, dataset });
    expect(problems).toEqual([]);
    // 13 tasks − 1 unauthorized C material = 12 complete A/C pairs.
    expect(pairDenominator).toEqual({ totalTasks: 13, completePairs: 12, excludedUnauthorizedTasks: 1 });
    expect(minPairsEligible).toBe(true); // 12 complete pairs >= minPairs 3
  });

  it('required inputs are mandatory: missing preregBody / dataset / verifier each refuse', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const noBody = validateFreezeForRealRun({ freeze, preregBody: undefined, verifyOwnerApproval: verifyOk, dataset });
    expect(noBody.problems.some((p: string) => p.includes('preregBody missing'))).toBe(true);
    expect(noBody.minPairsEligible).toBeNull();

    const noDataset = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifyOk, dataset: undefined });
    expect(noDataset.problems.some((p: string) => p.includes('dataset missing'))).toBe(true);

    const noVerifier = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: undefined, dataset });
    expect(noVerifier.problems.some((p: string) => p.includes('verifier missing'))).toBe(true);

    const noFreeze = validateFreezeForRealRun({ freeze: undefined, preregBody, verifyOwnerApproval: verifyOk, dataset });
    expect(noFetchOk(noFreeze)).toBe(true);
  });
  function noFetchOk(result: any) {
    return result.problems.some((p: string) => p.includes('freeze record missing'));
  }

  it('FZ-01 taskSetHash must EXIST and be well-formed — a missing hash refuses (never skipped)', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const fz01: any = freeze.items.find((i: any) => i.id === 'FZ-01');
    fz01.value = { datasetId: 'x' }; // no taskSetHash at all
    const { problems } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifyOk, dataset });
    expect(problems.some((p: string) => p.includes('taskSetHash missing or not a 64-hex'))).toBe(true);

    fz01.value = { taskSetHash: 'not-a-hash' };
    const { problems: p2 } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifyOk, dataset });
    expect(p2.some((p: string) => p.includes('taskSetHash missing or not a 64-hex'))).toBe(true);
  });

  it('verifier returning undefined / null / {} each refuse fail-closed', () => {
    for (const [label, verifier] of [
      ['undefined', () => undefined],
      ['null', () => null],
      ['empty object', () => ({})],
      ['wrong-shape object', () => ({ hello: 1 })],
    ] as const) {
      const freeze = fullyFrozenRecord(preregBody);
      const { problems } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifier as never, dataset });
      expect(problems.length, label).toBeGreaterThan(0);
      expect(problems.join('; '), label).toMatch(/FZ-15/);
    }
  });

  it('verified-only or approved-only verdicts refuse (must be BOTH)', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const verifiedOnly = validateFreezeForRealRun({
      freeze, preregBody,
      verifyOwnerApproval: () => ({ verified: true, approved: false, frozenCommitSha: FROZEN_COMMIT }),
      dataset,
    });
    expect(verifiedOnly.problems.some((p: string) => p.includes('not BOTH verified and approved'))).toBe(true);

    const approvedOnly = validateFreezeForRealRun({
      freeze, preregBody,
      verifyOwnerApproval: () => ({ verified: false, approved: true, frozenCommitSha: FROZEN_COMMIT }),
      dataset,
    });
    expect(approvedOnly.problems.some((p: string) => p.includes('not BOTH verified and approved'))).toBe(true);
  });

  it('verified approval without a commit binding refuses — 40-hex in the record alone is not approval', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const noBinding = validateFreezeForRealRun({
      freeze, preregBody,
      verifyOwnerApproval: () => ({ verified: true, approved: true }), // no frozenCommitSha
      dataset,
    });
    expect(noBinding.problems.some((p: string) => p.includes('no frozenCommitSha binding'))).toBe(true);

    const mismatched = validateFreezeForRealRun({
      freeze, preregBody,
      verifyOwnerApproval: () => ({ verified: true, approved: true, frozenCommitSha: 'b'.repeat(40) }),
      dataset,
    });
    expect(mismatched.problems.some((p: string) => p.includes('frozenCommitSha mismatch'))).toBe(true);
  });

  it('verifier throwing refuses', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const { problems } = validateFreezeForRealRun({
      freeze,
      preregBody,
      verifyOwnerApproval: () => {
        throw new Error('authoritative store unreachable');
      },
      dataset,
    });
    expect(problems.some((p: string) => p.includes('Owner approval verification failed'))).toBe(true);
  });

  it('FZ-11 complete-pair denominator: 12 complete pairs (13 tasks − 1 unauthorized exclusion)', () => {
    const freeze = fullyFrozenRecord(preregBody);
    // minPairs = 13 → exceeds the 12 complete pairs → UNPROVEN, never padded.
    const fz11: any = freeze.items.find((i: any) => i.id === 'FZ-11');
    fz11.value = { minPairs: 13, derivationBasis: 'owner-frozen detectable difference' };
    const short = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifyOk, dataset });
    expect(short.pairDenominator).toEqual({ totalTasks: 13, completePairs: 12, excludedUnauthorizedTasks: 1 });
    expect(short.minPairsEligible).toBe(false);
    expect(short.problems.some((p: string) => p.includes('UNPROVEN') && p.includes('12 of 13'))).toBe(true);

    // minPairs = 12 → passes the count comparison (all other gates still hold).
    fz11.value = { minPairs: 12, derivationBasis: 'owner-frozen detectable difference' };
    const exact = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifyOk, dataset });
    expect(exact.minPairsEligible).toBe(true);
    expect(exact.problems).toEqual([]);
  });

  it('prereg body edited after freezing → INVALID_PROTOCOL hash mismatch', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const edited = { ...preregBody, note: 'body (quietly amended after seeing results)' };
    const { problems } = validateFreezeForRealRun({ freeze, preregBody: edited, verifyOwnerApproval: verifyOk, dataset });
    expect(problems.some((p: string) => p.includes('INVALID_PROTOCOL'))).toBe(true);
  });

  it('frozen taskSetHash must equal the loaded dataset (FZ-01)', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const fz01: any = freeze.items.find((i: any) => i.id === 'FZ-01');
    fz01.value = { taskSetHash: '0'.repeat(64) };
    const { problems } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifyOk, dataset });
    expect(problems.some((p: string) => p.includes('FZ-01'))).toBe(true);
  });

  it('minPairs without a derivation basis is refused (no unexplained N)', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const fz11: any = freeze.items.find((i: any) => i.id === 'FZ-11');
    fz11.value = { minPairs: 3 };
    const { problems } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifyOk, dataset });
    expect(problems.some((p: string) => p.includes('derivationBasis'))).toBe(true);
  });

  it('preregBodyHash is stable and canonicalization-sensitive', () => {
    expect(preregBodyHash({ b: 1, a: 2 })).toBe(preregBodyHash({ a: 2, b: 1 }));
    expect(preregBodyHash({ a: 2, b: 1 })).not.toBe(preregBodyHash({ a: 2, b: 3 }));
  });
});

describe('ledger availability four-way classification', () => {
  const ledgerWithPrinciples = {
    ledger: { tree: { principles: { 'p-1': { id: 'p-1', status: 'active' } } } },
    availability: { status: 'ok' },
  };

  it('ok with real principles', () => {
    expect(classifyLedgerAvailability(ledgerWithPrinciples)).toBe('ok');
  });

  it('ok_but_empty_ledger for parse-lenient structural empties (F-04)', () => {
    for (const coreResult of [
      { ledger: { tree: {} }, availability: { status: 'ok' } },
      { ledger: {}, availability: { status: 'ok' } },
    ]) {
      expect(classifyLedgerAvailability(coreResult)).toBe('ok_but_empty_ledger');
    }
  });

  it('empty and unreadable pass through unchanged', () => {
    expect(classifyLedgerAvailability({ availability: { status: 'empty' } })).toBe('empty');
    expect(classifyLedgerAvailability({ availability: { status: 'unreadable' } })).toBe('unreadable');
  });

  it('unreadable and lenient-empty ledgers never report a proven true zero (M1)', () => {
    const unreadable = measureLedgerPrinciples({ coreResult: { availability: { status: 'unreadable' } }, authorization: { summaryFieldsAllowed: true } });
    expect(unreadable.m1.count).toBeNull();
    expect(unreadable.m1.trueZero).toBe(false);
    expect(unreadable.m1.reasonCode).toBe('ledger_unreadable');
    // 'empty' means missing/zero-byte/lenient file — the parsed count is 0 but
    // that state alone canNOT prove a genuinely empty population.
    const empty = measureLedgerPrinciples({ coreResult: { availability: { status: 'empty' } }, authorization: { summaryFieldsAllowed: true } });
    expect(empty.m1.count).toBe(0);
    expect(empty.m1.trueZero).toBe(false);
    expect(empty.m1.reasonCode).toBe('ledger_empty__true_zero_unproven_requires_independent_evidence');
  });

  it('a true-zero claim requires independent auditable evidence, not inference from empty', () => {
    const empty = { availability: { status: 'empty' } };
    const withEvidence = measureLedgerPrinciples({
      coreResult: empty,
      authorization: { summaryFieldsAllowed: true },
      trueZeroEvidence: { auditor: 'independent-audit', recordRef: 'audit-record-1' },
    });
    expect(withEvidence.m1.trueZero).toBe(true);
    expect(withEvidence.m1.reasonCode).toBe('ledger_empty_with_independent_true_zero_evidence');
    expect(withEvidence.m1.trueZeroEvidence).toEqual({ auditor: 'independent-audit', recordRef: 'audit-record-1' });

    // Evidence missing either field is not auditable evidence.
    const weakEvidence = measureLedgerPrinciples({
      coreResult: empty,
      authorization: { summaryFieldsAllowed: true },
      trueZeroEvidence: { auditor: 'independent-audit' },
    });
    expect(weakEvidence.m1.trueZero).toBe(false);
  });

  it('unknown/missing availability status is unmeasurable (fail-loud, never inferred)', () => {
    expect(classifyLedgerAvailability({ ledger: {}, availability: {} })).toBe('unmeasurable_unknown_availability');
    expect(classifyLedgerAvailability({})).toBe('unmeasurable_unknown_availability');
    expect(classifyLedgerAvailability({ availability: { status: 'corrupted-index' } })).toBe('unmeasurable_unknown_availability');
    // Authority status wins over ledger content: unreadable stays unreadable.
    expect(classifyLedgerAvailability({ availability: { status: 'unreadable' }, ledger: { tree: { principles: { p: {} } } } })).toBe('unreadable');

    const measure = measureLedgerPrinciples({ coreResult: { availability: { status: 'corrupted-index' } }, authorization: { summaryFieldsAllowed: true } });
    expect(measure.m1).toMatchObject({ count: null, trueZero: false, reasonCode: 'availability_status_unknown' });
    expect(measure.m2.count).toBeNull();
    expect(measure.m3.count).toBeNull();
  });

  it('malformed authorization throws (rc-3); omission is observably unauthorized', () => {
    const ok = { availability: { status: 'ok' }, ledger: { tree: { principles: { p1: { id: 'p1', status: 'active', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'c', painId: 'pain', evidenceQuality: 'exact' }] } } } } };
    for (const bad of [() => {}, { summaryFieldsAllowed: 'yes' }, { nope: true }, 'granted'] as unknown[]) {
      expect(() => measureLedgerPrinciples({ coreResult: ok, authorization: bad as never })).toThrow(/explicit boolean summaryFieldsAllowed/);
    }

    const omitted = measureLedgerPrinciples({ coreResult: ok });
    expect(omitted.authorizationBasis).toBe('NOT_DECLARED_TREATED_AS_UNAUTHORIZED');
    expect(omitted.m3).toMatchObject({ count: 0, reasonCode: 'summary_authorization_not_declared' });
    expect(omitted.m5.unauthorizedCount).toBe(1);
    expect(omitted.m5.unauthorizedField).toBeTruthy();
  });

  it('authorization declared-false vs declared-true produce different observable behavior', () => {
    const ok = { availability: { status: 'ok' }, ledger: { tree: { principles: { p1: { id: 'p1', status: 'active', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'c', painId: 'pain', evidenceQuality: 'exact' }] } } } } };
    const denied = measureLedgerPrinciples({ coreResult: ok, authorization: { summaryFieldsAllowed: false } });
    expect(denied.authorizationBasis).toBe('D01_NOT_GRANTED_DECLARED');
    expect(denied.m3).toMatchObject({ count: 0, reasonCode: 'summary_fields_unauthorized_d01' });

    const granted = measureLedgerPrinciples({ coreResult: ok, authorization: { summaryFieldsAllowed: true } });
    expect(granted.authorizationBasis).toBe('D01_GRANTED_DECLARED');
    expect(granted.m3).toMatchObject({ count: 1, reasonCode: 'ok' });
    expect(granted.m5.unauthorizedField).toBeNull();
  });
});

describe('M1~M5 offline measurement logic', () => {
  const coreResult = (principles: any[]) => ({
    availability: { status: 'ok' },
    ledger: {
      tree: {
        principles: Object.fromEntries(principles.map((p) => [p.id, p])),
      },
    },
  });

  it('counts eligibility, traceability, completeness separately with explicit ambiguity', () => {
    const measure = measureLedgerPrinciples({
      authorization: { summaryFieldsAllowed: true },
      coreResult: coreResult([
        { id: 'p1', status: 'active', derivedFromPainIds: ['c1'], reuseEvidence: [] },
        { id: 'p2', status: 'active', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'c1', painId: 'pain1', evidenceQuality: 'exact' }] },
        { id: 'p3', status: 'active', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'cX', painId: 'pain3', evidenceQuality: 'context_only' }] },
        { id: 'p4', status: 'deactivated', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'c4', painId: 'pain4', evidenceQuality: 'exact' }] },
      ]),
    });
    expect(measure.m1.count).toBe(3); // deactivated p4 excluded from eligibility
    expect(measure.m2.count).toBe(3); // p1 via derived-candidate cross-check, p2/p3 direct
    expect(measure.m3.count).toBe(2); // pain3 is context_only → not complete; pain4 belongs to ineligible p4
    expect(measure.m4.count).toBe(1); // c1 claimed by p1 (derived) AND p2 (reuse) — flagged explicitly
    expect(measure.m2.ambiguousFlagged).toBe(1); // p1 carries the double-claimed candidate
    // p3's pain is resolved but incomplete → M5 unavailable bucket.
    expect(measure.m5.unavailableCount).toBe(1);
  });

  it('derived candidate ids never count as canonical pain ids (C-T03 semantics)', () => {
    const measure = measureLedgerPrinciples({
      coreResult: coreResult([
        { id: 'p1', status: 'active', derivedFromPainIds: ['cand-only-no-reuse-anywhere'], reuseEvidence: [] },
      ]),
    });
    expect(measure.m1.count).toBe(1);
    expect(measure.m2.count).toBe(0); // candidate unresolved → not traceable, no pain id invented
    expect(measure.perPrinciple[0].unresolvedCandidates).toEqual(['cand-only-no-reuse-anywhere']);
  });

  it('unauthorized summary fields are counted with the field name, not silently zeroed', () => {
    const measure = measureLedgerPrinciples({
      coreResult: coreResult([
        { id: 'p1', status: 'active', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'c1', painId: 'pain1', evidenceQuality: 'exact' }] },
      ]),
      authorization: { summaryFieldsAllowed: false },
    });
    expect(measure.authorizationBasis).toBe('D01_NOT_GRANTED_DECLARED');
    expect(measure.m3.count).toBe(0);
    expect(measure.m3.reasonCode).toBe('summary_fields_unauthorized_d01');
    expect(measure.m5.unauthorizedCount).toBe(1);
    expect(measure.m5.unauthorizedField).toContain('D-01');
  });
});

describe('state-unchanged snapshot', () => {
  it('detects added, modified and removed files', async () => {
    const dir = path.join(tmpRoot, 'snapshot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one', 'utf8');
    const before = snapshotTree(dir);

    fs.writeFileSync(path.join(dir, 'b.txt'), 'new', 'utf8'); // added
    let problems = assertStateUnchanged(before, snapshotTree(dir), 't');
    expect(problems.some((p: string) => p.includes('b.txt') && p.includes('appeared'))).toBe(true);

    fs.rmSync(path.join(dir, 'b.txt'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two', 'utf8'); // modified
    problems = assertStateUnchanged(before, snapshotTree(dir), 't');
    expect(problems.some((p: string) => p.includes('a.txt') && p.includes('content hash changed'))).toBe(true);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'one', 'utf8');
    fs.rmSync(path.join(dir, 'a.txt')); // removed
    problems = assertStateUnchanged(before, snapshotTree(dir), 't');
    expect(problems.some((p: string) => p.includes('a.txt') && p.includes('disappeared'))).toBe(true);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'one', 'utf8');
    expect(assertStateUnchanged(before, snapshotTree(dir), 't')).toEqual([]);
  });
});
