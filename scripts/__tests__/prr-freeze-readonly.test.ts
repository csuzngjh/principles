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
  freezeItemsHash,
  FZ_IDS,
  preregBodyHash,
  protocolApprovalDigest,
  validateFreezeForRealRun,
  validateFreezeRecord,
} from '../dev/principle-learning-lab/prr/lib/prr-freeze.mjs';
import { verifyDatasetIntegrity } from '../dev/principle-learning-lab/prr/lib/prr-dataset.mjs';
import {
  assertStateUnchanged,
  authoritativePrincipleStatuses,
  classifyLedgerAvailability,
  measureLedgerPrinciples,
  snapshotTree,
} from '../dev/principle-learning-lab/prr/lib/prr-readonly.mjs';
import { PRINCIPLE_STATUSES } from '@principles/core/runtime-v2';
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

/**
 * Simulate the REAL approval order (owner review round 3, P1-1): the Owner
 * approves a protocol ONCE — a deep-cloned snapshot is digested and the
 * digest SAVED — and later verifications resolve the saved decision record.
 * The verifier therefore NEVER recomputes a digest from the object currently
 * under test: a tampered record cannot launder itself into "approved".
 */
function approveOnce(freeze: any, preregBody: any) {
  const snapshot = JSON.parse(JSON.stringify(freeze));
  const saved = {
    protocolDigest: protocolApprovalDigest({ freeze: snapshot, preregBody }),
    frozenCommitSha: snapshot.ownerApproval.frozenCommitSha as string,
  };
  const verifier = () => ({
    verified: true,
    approved: true,
    frozenCommitSha: saved.frozenCommitSha,
    approvedProtocolDigest: saved.protocolDigest,
  });
  return { saved, verifier };
}

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
  // A trusted execution context would source this (verified runner / CI);
  // tests pass it explicitly — it is REQUIRED since owner review round 3.
  const RUNNING_COMMIT = FROZEN_COMMIT;

  function frozenWithApproval() {
    const freeze = fullyFrozenRecord(preregBody);
    const { saved, verifier } = approveOnce(freeze, preregBody);
    return { freeze, saved, verifier };
  }

  it('a fully-frozen record with a saved Owner approval and trusted running commit passes', () => {
    const { freeze, verifier } = frozenWithApproval();
    const { problems, minPairsEligible, pairDenominator } = validateFreezeForRealRun({
      freeze, preregBody, verifyOwnerApproval: verifier, dataset, runningCommitSha: RUNNING_COMMIT,
    });
    expect(problems).toEqual([]);
    // 13 tasks − 1 unauthorized C material = 12 complete A/C pairs.
    expect(pairDenominator).toEqual({ totalTasks: 13, completePairs: 12, excludedUnauthorizedTasks: 1 });
    expect(minPairsEligible).toBe(true); // 12 complete pairs >= minPairs 3
  });

  it('required inputs are mandatory: missing preregBody / dataset / verifier / runningCommitSha each refuse', () => {
    const { freeze, verifier } = frozenWithApproval();
    const noBody = validateFreezeForRealRun({ freeze, preregBody: undefined, verifyOwnerApproval: verifier, dataset, runningCommitSha: RUNNING_COMMIT });
    expect(noBody.problems.some((p: string) => p.includes('preregBody missing'))).toBe(true);
    expect(noBody.minPairsEligible).toBeNull();

    const noDataset = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifier, dataset: undefined, runningCommitSha: RUNNING_COMMIT });
    expect(noDataset.problems.some((p: string) => p.includes('dataset missing'))).toBe(true);

    const noVerifier = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: undefined, dataset, runningCommitSha: RUNNING_COMMIT });
    expect(noVerifier.problems.some((p: string) => p.includes('verifier missing'))).toBe(true);

    const noFreeze = validateFreezeForRealRun({ freeze: undefined, preregBody, verifyOwnerApproval: verifier, dataset, runningCommitSha: RUNNING_COMMIT });
    expect(noFreeze.problems.some((p: string) => p.includes('freeze record missing'))).toBe(true);
  });

  // ── Owner review round 3 — P1-2: runningCommitSha is mandatory ──
  it('runningCommitSha missing / malformed / mismatched each refuse; matching passes (P1-2)', () => {
    for (const [label, sha] of [
      ['missing', undefined],
      ['null', null],
      ['not-a-sha string', 'HEAD'],
      ['short hash', 'a'.repeat(7)],
      ['non-hex', 'g'.repeat(40)],
    ] as [string, unknown][]) {
      const { freeze, verifier } = frozenWithApproval();
      const { problems } = validateFreezeForRealRun({
        freeze, preregBody, verifyOwnerApproval: verifier, dataset,
        runningCommitSha: sha as never,
      });
      expect(problems.some((p: string) => p.includes('runningCommitSha missing or not a 40-hex')), label).toBe(true);
    }

    const { freeze, verifier } = frozenWithApproval();
    const mismatched = validateFreezeForRealRun({
      freeze, preregBody, verifyOwnerApproval: verifier, dataset, runningCommitSha: 'c'.repeat(40),
    });
    expect(mismatched.problems.some((p: string) => p.includes('running commit') && p.includes('differs from the Owner-approved frozen commit'))).toBe(true);

    // The verifier refuses to simply echo the record's SHA as the running one:
    // the test's mismatch above IS a differing value, and a record-copying
    // caller would pass it — the gate compares against the SAVED approval.
  });

  it('FZ-01 taskSetHash must EXIST and be well-formed — a missing hash refuses (never skipped)', () => {
    const { freeze, verifier } = frozenWithApproval();
    const fz01: any = freeze.items.find((i: any) => i.id === 'FZ-01');
    fz01.value = { datasetId: 'x' }; // no taskSetHash at all
    const { problems } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifier, dataset, runningCommitSha: RUNNING_COMMIT });
    expect(problems.some((p: string) => p.includes('taskSetHash missing or not a 64-hex'))).toBe(true);

    fz01.value = { taskSetHash: 'not-a-hash' };
    const { problems: p2 } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifier, dataset, runningCommitSha: RUNNING_COMMIT });
    expect(p2.some((p: string) => p.includes('taskSetHash missing or not a 64-hex'))).toBe(true);
  });

  it('verifier returning undefined / null / {} each refuse fail-closed', () => {
    for (const [label, verifier] of [
      ['undefined', () => undefined],
      ['null', () => null],
      ['empty object', () => ({})],
      ['wrong-shape object', () => ({ hello: 1 })],
    ] as const) {
      const { freeze } = frozenWithApproval();
      const { problems } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifier as never, dataset, runningCommitSha: RUNNING_COMMIT });
      expect(problems.length, label).toBeGreaterThan(0);
      expect(problems.join('; '), label).toMatch(/FZ-15/);
    }
  });

  it('verified-only or approved-only verdicts refuse (must be BOTH)', () => {
    const { freeze } = frozenWithApproval();
    const verifiedOnly = validateFreezeForRealRun({
      freeze, preregBody,
      verifyOwnerApproval: () => ({ verified: true, approved: false, frozenCommitSha: FROZEN_COMMIT, approvedProtocolDigest: protocolApprovalDigest({ freeze, preregBody }) }),
      dataset, runningCommitSha: RUNNING_COMMIT,
    });
    expect(verifiedOnly.problems.some((p: string) => p.includes('not BOTH verified and approved'))).toBe(true);

    const approvedOnly = validateFreezeForRealRun({
      freeze, preregBody,
      verifyOwnerApproval: () => ({ verified: false, approved: true, frozenCommitSha: FROZEN_COMMIT, approvedProtocolDigest: protocolApprovalDigest({ freeze, preregBody }) }),
      dataset, runningCommitSha: RUNNING_COMMIT,
    });
    expect(approvedOnly.problems.some((p: string) => p.includes('not BOTH verified and approved'))).toBe(true);
  });

  it('verified approval without a commit binding refuses — 40-hex in the record alone is not approval', () => {
    const { freeze } = frozenWithApproval();
    const noBinding = validateFreezeForRealRun({
      freeze, preregBody,
      verifyOwnerApproval: () => ({ verified: true, approved: true, approvedProtocolDigest: protocolApprovalDigest({ freeze, preregBody }) }),
      dataset, runningCommitSha: RUNNING_COMMIT,
    });
    expect(noBinding.problems.some((p: string) => p.includes('no frozenCommitSha binding'))).toBe(true);

    const mismatched = validateFreezeForRealRun({
      freeze, preregBody,
      verifyOwnerApproval: () => ({ verified: true, approved: true, frozenCommitSha: 'b'.repeat(40), approvedProtocolDigest: protocolApprovalDigest({ freeze, preregBody }) }),
      dataset, runningCommitSha: RUNNING_COMMIT,
    });
    expect(mismatched.problems.some((p: string) => p.includes('frozenCommitSha mismatch'))).toBe(true);
  });

  it('verifier throwing refuses', () => {
    const { freeze } = frozenWithApproval();
    const { problems } = validateFreezeForRealRun({
      freeze,
      preregBody,
      verifyOwnerApproval: () => {
        throw new Error('authoritative store unreachable');
      },
      dataset, runningCommitSha: RUNNING_COMMIT,
    });
    expect(problems.some((p: string) => p.includes('Owner approval verification failed'))).toBe(true);
  });

  // ── Owner review round 3 — P1-1: the approval binds the COMPLETE protocol ──
  it('mutating the prereg body, studyId, or ANY frozen value fails against the SAVED approval digest (P1-1)', () => {
    // Approve once, save the digest.
    const approvedFreeze = fullyFrozenRecord(preregBody);
    const { saved } = approveOnce(approvedFreeze, preregBody);
    const verifierOfSaved = () => ({
      verified: true,
      approved: true,
      frozenCommitSha: saved.frozenCommitSha,
      approvedProtocolDigest: saved.protocolDigest,
    });

    const cases: [string, (f: any, body: any) => void][] = [
      ['prereg body text edited (record hash stale)', (f, body) => { body.note = 'quietly amended after approval'; }],
      ['prereg body edited AND record hash synced, approval NOT re-obtained', (f, body) => {
        body.note = 'amended';
        f.prereg.canonicalSha256 = preregBodyHash(body);
      }],
      ['studyId changed', (f, body) => { body.studyId = 'other-study'; f.studyId = 'other-study'; }],
      ['studyId changed in freeze only', (f) => { f.studyId = 'other-study'; }],
      ['FZ-11.minPairs', (f) => { const it = f.items.find((i: any) => i.id === 'FZ-11'); it.value = { minPairs: 1, derivationBasis: it.value.derivationBasis }; }],
      ['FZ-06 budget', (f) => { const it = f.items.find((i: any) => i.id === 'FZ-06'); it.value = { totalCostCapUsd: 999999, note: 'quietly raised' }; }],
      ['FZ-13 STOP conditions', (f) => { const it = f.items.find((i: any) => i.id === 'FZ-13'); it.value = { stopConditions: ['never stop'] }; }],
      ['FZ-01 taskSetHash', (f) => { const it = f.items.find((i: any) => i.id === 'FZ-01'); it.value.taskSetHash = 'f'.repeat(64); }],
      ['an ownerApprovalRef', (f) => { f.items.find((i: any) => i.id === 'FZ-02').ownerApprovalRef = 'some-other-ref'; }],
      ['an item status downgraded', (f) => { f.items.find((i: any) => i.id === 'FZ-07').status = 'OWNER_DECISION_REQUIRED'; }],
    ];
    for (const [label, mutate] of cases) {
      const tamperedFreeze = fullyFrozenRecord(preregBody);
      const tamperedBody = { ...preregBody };
      mutate(tamperedFreeze, tamperedBody);
      const { problems } = validateFreezeForRealRun({
        freeze: tamperedFreeze, preregBody: tamperedBody, verifyOwnerApproval: verifierOfSaved, dataset, runningCommitSha: RUNNING_COMMIT,
      });
      // studyId-only changes refuse via the identity check; value/ref changes
      // via the saved-digest reconciliation; a downgraded item status trips
      // the structural validator first (fabricated value on a non-frozen
      // item) — every path must refuse, each with its own explicit message.
      const refused = problems.some((p: string) => p.includes('protocol approval reconciliation FAILED') || p.includes('studyId mismatch') || p.includes('fabricate values'))
        && problems.some((p: string) => p.includes('INVALID_PROTOCOL') || p.includes('real run refused') || p.includes('fabricate values'));
      expect(problems.length, label).toBeGreaterThan(0);
      expect(refused, label).toBe(true);
    }
  });

  it('studyId identity: prereg body without studyId, or mismatching the freeze record, refuses (P1-1)', () => {
    const { freeze, verifier } = frozenWithApproval();
    const noStudyId = validateFreezeForRealRun({
      freeze, preregBody: { note: 'no study id' }, verifyOwnerApproval: verifier, dataset, runningCommitSha: RUNNING_COMMIT,
    });
    expect(noStudyId.problems.some((p: string) => p.includes('preregBody.studyId missing'))).toBe(true);

    const mismatch = validateFreezeForRealRun({
      freeze, preregBody: { studyId: 'other-study', note: 'body' }, verifyOwnerApproval: verifier, dataset, runningCommitSha: RUNNING_COMMIT,
    });
    expect(mismatch.problems.some((p: string) => p.includes('studyId mismatch'))).toBe(true);
  });

  it('old-format approval records without approvedProtocolDigest refuse — never auto-completed (P1-1)', () => {
    const { freeze } = frozenWithApproval();
    const oldFormat = validateFreezeForRealRun({
      freeze, preregBody,
      verifyOwnerApproval: () => ({ verified: true, approved: true, frozenCommitSha: FROZEN_COMMIT, approvedFreezeItemsHash: freezeItemsHash(freeze) }),
      dataset, runningCommitSha: RUNNING_COMMIT,
    });
    expect(oldFormat.problems.some((p: string) => p.includes('no approvedProtocolDigest'))).toBe(true);
  });

  it('freezeItemsHash / protocolApprovalDigest are deterministic and change with any component', () => {
    const a = fullyFrozenRecord(preregBody);
    const b = fullyFrozenRecord(preregBody);
    expect(freezeItemsHash(a)).toBe(freezeItemsHash(b));
    expect(protocolApprovalDigest({ freeze: a, preregBody })).toBe(protocolApprovalDigest({ freeze: b, preregBody }));
    const c = fullyFrozenRecord(preregBody);
    c.items.find((i: any) => i.id === 'FZ-11').value.minPairs = 99;
    expect(freezeItemsHash(c)).not.toBe(freezeItemsHash(a));
    expect(protocolApprovalDigest({ freeze: c, preregBody })).not.toBe(protocolApprovalDigest({ freeze: a, preregBody }));
    expect(protocolApprovalDigest({ freeze: a, preregBody: { studyId: 'test', note: 'other' } })).not.toBe(protocolApprovalDigest({ freeze: a, preregBody }));
    expect(protocolApprovalDigest({ freeze: { ...a, studyId: 'zzz' }, preregBody })).not.toBe(protocolApprovalDigest({ freeze: a, preregBody }));
  });

  it('FZ-11 complete-pair denominator: 12 complete pairs (13 tasks − 1 unauthorized exclusion)', () => {
    const { freeze, verifier } = frozenWithApproval();
    // minPairs = 13 → exceeds the 12 complete pairs → UNPROVEN, never padded.
    const fz11: any = freeze.items.find((i: any) => i.id === 'FZ-11');
    fz11.value = { minPairs: 13, derivationBasis: 'owner-frozen detectable difference' };
    const { saved: savedShort, verifier: vShort } = approveOnce(freeze, preregBody);
    const short = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: vShort, dataset, runningCommitSha: RUNNING_COMMIT });
    expect(short.pairDenominator).toEqual({ totalTasks: 13, completePairs: 12, excludedUnauthorizedTasks: 1 });
    expect(short.minPairsEligible).toBe(false);
    expect(short.problems.some((p: string) => p.includes('UNPROVEN') && p.includes('12 of 13'))).toBe(true);

    // minPairs = 12 → passes the count comparison (all other gates still hold).
    const freeze12 = fullyFrozenRecord(preregBody);
    const fz11b: any = freeze12.items.find((i: any) => i.id === 'FZ-11');
    fz11b.value = { minPairs: 12, derivationBasis: 'owner-frozen detectable difference' };
    const { verifier: vExact } = approveOnce(freeze12, preregBody);
    const exact = validateFreezeForRealRun({ freeze: freeze12, preregBody, verifyOwnerApproval: vExact, dataset, runningCommitSha: RUNNING_COMMIT });
    expect(exact.minPairsEligible).toBe(true);
    expect(exact.problems).toEqual([]);
  });

  it('minPairs without a derivation basis is refused (no unexplained N)', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const fz11: any = freeze.items.find((i: any) => i.id === 'FZ-11');
    fz11.value = { minPairs: 3 };
    const { verifier } = approveOnce(freeze, preregBody);
    const { problems } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifier, dataset, runningCommitSha: RUNNING_COMMIT });
    expect(problems.some((p: string) => p.includes('derivationBasis'))).toBe(true);
  });

  it('FZ-11 value of any non-contract type refuses instead of skipping the sample gate (P1-2, round 2)', () => {
    const variants: [string, unknown][] = [
      ['string value', 'frozen'],
      ['empty array value', []],
      ['null value', null],
      ['object without minPairs', { derivationBasis: 'some basis' }],
      ['minPairs zero', { minPairs: 0, derivationBasis: 'basis' }],
      ['minPairs negative', { minPairs: -2, derivationBasis: 'basis' }],
      ['minPairs non-integer', { minPairs: 2.5, derivationBasis: 'basis' }],
      ['minPairs numeric string', { minPairs: '12', derivationBasis: 'basis' }],
      ['missing derivationBasis', { minPairs: 12 }],
      ['empty derivationBasis', { minPairs: 12, derivationBasis: '   ' }],
    ];
    for (const [label, value] of variants) {
      const freeze = fullyFrozenRecord(preregBody);
      const fz11: any = freeze.items.find((i: any) => i.id === 'FZ-11');
      fz11.value = value as never;
      const { verifier } = approveOnce(freeze, preregBody);
      const { problems, minPairsEligible } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifier, dataset, runningCommitSha: RUNNING_COMMIT });
      expect(problems.length, label).toBeGreaterThan(0);
      expect(problems.join('; '), label).toMatch(/FZ-11/);
      expect(minPairsEligible, label).toBeNull();
    }
  });

  // ── Owner review round 3 — P1-4: dataset integrity is re-verified at gate time ──
  it('a lying cached fixtureHash cannot mask post-load dataset mutation (P1-4)', () => {
    // Simulate an attacker bypassing the deep freeze: clone the loaded dataset
    // (JSON round-trip breaks the shared references), mutate task content,
    // keep the ORIGINAL cached fixtureHash. The gate must refuse BOTH because
    // the consumed structures are no longer the hashed snapshot objects AND
    // any byFile-side mutation shows up in the recomputed hash.
    const mutated = structuredClone(JSON.parse(JSON.stringify(dataset)));
    mutated.tasks.tasks[0].taskText = 'tampered task text after approval';
    expect(mutated.fixtureHash).toBe(dataset.fixtureHash); // the cache still lies
    const { freeze, verifier } = frozenWithApproval();
    const { problems } = validateFreezeForRealRun({
      freeze, preregBody, verifyOwnerApproval: verifier, dataset: mutated, runningCommitSha: RUNNING_COMMIT,
    });
    expect(problems.some((p: string) => p.includes('dataset integrity FAILED')), 'clone+mutate refuses').toBe(true);

    // A byFile-side mutation trips the recomputed-hash check explicitly.
    const byFileMutated = structuredClone(JSON.parse(JSON.stringify(dataset)));
    byFileMutated.byFile['tasks.json'].tasks[0].taskText = 'tampered raw file data';
    const { problems: p2 } = validateFreezeForRealRun({
      freeze, preregBody, verifyOwnerApproval: verifier, dataset: byFileMutated, runningCommitSha: RUNNING_COMMIT,
    });
    expect(p2.some((p: string) => p.includes('dataset integrity FAILED') && p.includes('content changed after loading')), 'byFile mutation refuses').toBe(true);
  });

  it('replacing a task / nested field / byFile entry is caught by the recomputed hash (P1-4)', () => {
    const { freeze, verifier } = frozenWithApproval();
    const variants: [string, (d: any) => void][] = [
      ['replace a task entry', (d) => { d.tasks.tasks[1] = { ...d.tasks.tasks[1], taskText: 'replaced' }; }],
      ['mutate a nested task field', (d) => { d.tasks.tasks[0].historyMaterial.text = 'mutated history'; }],
      ['mutate gold', (d) => { d.gold.gold['t1-history-decides'].acceptedDecisionIds = ['d-hijacked']; }],
      ['mutate byFile directly', (d) => { d.byFile['principles.json'].principles[0].text = 'hijacked'; }],
      ['mutate behaviors the run consumes', (d) => { d.behaviors.behaviors['C:t1-history-decides'].output.decisionId = 'd-hijacked'; }],
    ];
    for (const [label, mutate] of variants) {
      const mutated = structuredClone(JSON.parse(JSON.stringify(dataset)));
      mutate(mutated);
      const { problems } = validateFreezeForRealRun({
        freeze, preregBody, verifyOwnerApproval: verifier, dataset: mutated, runningCommitSha: RUNNING_COMMIT,
      });
      expect(problems.some((p: string) => p.includes('dataset integrity FAILED')), label).toBe(true);
    }
  });

  it('verifyDatasetIntegrity accepts the untouched dataset and detects direct byFile tampering', () => {
    expect(verifyDatasetIntegrity(dataset)).toMatchObject({ ok: true });
    const mutated = structuredClone(JSON.parse(JSON.stringify(dataset)));
    mutated.byFile['tasks.json'].tasks.pop();
    expect(verifyDatasetIntegrity(mutated).ok).toBe(false);
    expect(verifyDatasetIntegrity(mutated).currentHash).not.toBe(mutated.fixtureHash);
  });

  it('post-load mutation is BLOCKED at the object level: the loaded dataset is deep-frozen (P1-4)', () => {
    // Raw file data, consumed structures and derived indexes are all frozen —
    // strict-mode assignment throws instead of silently diverging from the
    // hashed snapshot.
    expect(() => { (dataset.tasks.tasks[0] as any).taskText = 'mutated'; }).toThrow();
    expect(() => { (dataset.byFile['tasks.json'] as any).tasks.pop(); }).toThrow();
    expect(() => { (dataset.gold.gold['t1-history-decides'] as any).acceptedDecisionIds = ['x']; }).toThrow();
    expect(() => { (dataset.behaviors.behaviors['C:t1-history-decides'] as any).status = 'INVALID_OUTPUT'; }).toThrow();
    expect(() => dataset.tasksById.set('rogue', {} as never)).toThrow();
    expect(() => { (dataset as any).goldByTask['rogue'] = {}; }).toThrow();
    // And the verified snapshot is untouched by all of the above.
    expect(verifyDatasetIntegrity(dataset)).toMatchObject({ ok: true });
  });

  // ── Owner review round 4 — P1-4: derived indexes must be EXACTLY consistent ──
  // JSON round-trips break the frozen shared references, so a clone's derived
  // indexes are rebuilt from the cloned sources; this isolates the DERIVED
  // dimension under test (the shared-identity dimension has its own tests).
  function cloneWithRebuiltIndexes() {
    const mutated = structuredClone(JSON.parse(JSON.stringify(dataset)));
    mutated.tasksById = new Map(mutated.tasks.tasks.map((t: any) => [t.taskId, t]));
    mutated.principlesById = new Map(mutated.principles.principles.map((p: any) => [p.principleId, p]));
    mutated.goldByTask = { ...mutated.gold.gold };
    return mutated;
  }

  it('deleting a tasksById entry fails the derived-index integrity check (P1-4)', () => {
    const mutated = cloneWithRebuiltIndexes();
    mutated.tasksById.delete(mutated.tasks.tasks[0].taskId);
    const result = verifyDatasetIntegrity(mutated);
    expect(result.derivedIndexesBound).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('mapping a task id to ANOTHER legitimate task object fails (P1-4)', () => {
    const mutated = cloneWithRebuiltIndexes();
    const [first, second] = mutated.tasks.tasks;
    mutated.tasksById.set(first.taskId, second); // wrong value mapping
    const result = verifyDatasetIntegrity(mutated);
    expect(result.derivedIndexesBound).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('deleting a principlesById entry fails (P1-4)', () => {
    const mutated = cloneWithRebuiltIndexes();
    mutated.principlesById.delete(mutated.principles.principles[0].principleId);
    expect(verifyDatasetIntegrity(mutated)).toMatchObject({ derivedIndexesBound: false, ok: false });
  });

  it('mapping a principle key to ANOTHER legitimate principle fails (P1-4)', () => {
    const mutated = cloneWithRebuiltIndexes();
    const [first, second] = mutated.principles.principles;
    mutated.principlesById.set(first.principleId, second);
    expect(verifyDatasetIntegrity(mutated)).toMatchObject({ derivedIndexesBound: false, ok: false });
  });

  it('deleting a goldByTask entry fails (P1-4)', () => {
    const mutated = cloneWithRebuiltIndexes();
    delete mutated.goldByTask['t1-history-decides'];
    expect(verifyDatasetIntegrity(mutated)).toMatchObject({ derivedIndexesBound: false, ok: false });
  });

  it('extra keys in a derived index fail (P1-4)', () => {
    const mutated = cloneWithRebuiltIndexes();
    mutated.tasksById.set('extra-key', mutated.tasks.tasks[0]);
    expect(verifyDatasetIntegrity(mutated)).toMatchObject({ derivedIndexesBound: false, ok: false });

    const mutatedGold = cloneWithRebuiltIndexes();
    (mutatedGold as any).goldByTask['extra-key'] = mutatedGold.gold.gold['t1-history-decides'];
    expect(verifyDatasetIntegrity(mutatedGold)).toMatchObject({ derivedIndexesBound: false, ok: false });
  });

  it('duplicate task ids (ambiguous index) fail via the size check (P1-4)', () => {
    const mutated = cloneWithRebuiltIndexes();
    mutated.tasks.tasks[1].taskId = mutated.tasks.tasks[0].taskId; // two tasks, one id
    expect(verifyDatasetIntegrity(mutated)).toMatchObject({ derivedIndexesBound: false, ok: false });
  });

  it('Map.prototype.*.call() cannot mutate the protected indexes, and integrity still passes (P1-4)', () => {
    for (const attack of [
      () => Map.prototype.set.call(dataset.tasksById, 'rogue', {}),
      () => Map.prototype.delete.call(dataset.tasksById, dataset.tasks.tasks[0].taskId),
      () => Map.prototype.clear.call(dataset.tasksById),
      () => Map.prototype.set.call(dataset.principlesById, 'rogue', {}),
    ]) {
      expect(attack).toThrow(/incompatible receiver|cannot be mutated/);
    }
    expect(() => dataset.tasksById.set('rogue', {} as never)).toThrow(/cannot be mutated/);
    // Nothing changed — the verified snapshot still passes.
    expect(verifyDatasetIntegrity(dataset)).toMatchObject({ ok: true, derivedIndexesBound: true });
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

  // ── Owner review round 2 — P1-3: malformed entries are never a proven zero ──
  it('unusable principle entries make the ledger malformed, never ok (P1-3)', () => {
    const ok = { availability: { status: 'ok' } };
    const ledger = (principles: unknown) => ({ availability: { status: 'ok' }, ledger: { tree: { principles: principles as never } } });
    expect(classifyLedgerAvailability(ledger({ p1: 'garbage-string-entry' }))).toBe('malformed_entries__semantic_review_required');
    expect(classifyLedgerAvailability(ledger({ p1: ['array-entry'] }))).toBe('malformed_entries__semantic_review_required');
    expect(classifyLedgerAvailability(ledger({ p1: 42 }))).toBe('malformed_entries__semantic_review_required');
    expect(classifyLedgerAvailability(ledger({ p1: null }))).toBe('malformed_entries__semantic_review_required');
    expect(classifyLedgerAvailability(ledger({ p1: { title: 'object without id' } }))).toBe('malformed_entries__semantic_review_required');
    // Core's lenient parser backfills id-less entries WITHOUT a status — the
    // half-filled result is malformed, not a valid population.
    expect(classifyLedgerAvailability(ledger({ p1: { id: 'p1' } }))).toBe('malformed_entries__semantic_review_required');
    // Mixed valid + invalid poisons the whole ledger (no silent filtering).
    expect(classifyLedgerAvailability(ledger({ p1: { id: 'p1', status: 'active' }, p2: 'garbage' }))).toBe('malformed_entries__semantic_review_required');
    // Non-object principles container stays a parse-leniency case.
    expect(classifyLedgerAvailability({ ...ok, ledger: { tree: { principles: [] } } })).toBe('ok_but_empty_ledger');
  });

  it('a malformed ledger measures NOTHING — even supplied evidence cannot produce trueZero (P1-3)', () => {
    const malformed = { availability: { status: 'ok' }, ledger: { tree: { principles: { p1: 'garbage' } } } };
    const m = measureLedgerPrinciples({
      coreResult: malformed,
      authorization: { summaryFieldsAllowed: true },
      trueZeroEvidence: { auditor: 'independent-audit', recordRef: 'audit-record-1' },
    });
    expect(m.availabilityClass).toBe('malformed_entries__semantic_review_required');
    expect(m.m1).toMatchObject({ count: null, trueZero: false, reasonCode: 'malformed_ledger_entries__semantic_review_required' });
    expect(m.m2.count).toBeNull();
    expect(m.m3.count).toBeNull();
  });

  it('a parse-lenient empty ledger can NEVER be promoted to trueZero, evidence or not (P1-3)', () => {
    const lenient = { availability: { status: 'ok' }, ledger: { tree: {} } };
    const m = measureLedgerPrinciples({
      coreResult: lenient,
      authorization: { summaryFieldsAllowed: true },
      trueZeroEvidence: { auditor: 'independent-audit', recordRef: 'audit-record-1' },
    });
    expect(m.m1).toMatchObject({ count: 0, trueZero: false, reasonCode: 'ok_but_empty_ledger__semantic_review_required' });
    // Owner review round 3, P2: M2/M3/M4 of a parse-lenient emptiness are
    // UNMEASURABLE — never a normal zero with a success reason code.
    expect(m.m2).toMatchObject({ count: null, denominator: null, reasonCode: 'ok_but_empty_ledger__semantic_review_required' });
    expect(m.m3).toMatchObject({ count: null, reasonCode: 'ok_but_empty_ledger__semantic_review_required' });
    expect(m.m4.count).toBeNull();
    // The only reachable trueZero path: structurally complete ledger, all
    // entries usable (authoritative statuses), zero eligible, PLUS evidence.
    const completeButInactive = { availability: { status: 'ok' }, ledger: { tree: { principles: { p1: { id: 'p1', status: 'archived' } } } } };
    const proven = measureLedgerPrinciples({
      coreResult: completeButInactive,
      authorization: { summaryFieldsAllowed: true },
      trueZeroEvidence: { auditor: 'independent-audit', recordRef: 'audit-record-1' },
    });
    expect(proven.m1.trueZero).toBe(true);
    // The complete-ledger control keeps normal, measurable M2/M3 output.
    expect(proven.m2.count).toBe(0);
    expect(proven.m2.denominator).toBe(0); // archived entry is not eligible → empty perPrinciple
    const unproven = measureLedgerPrinciples({ coreResult: completeButInactive, authorization: { summaryFieldsAllowed: true } });
    expect(unproven.m1.trueZero).toBe(false);
  });

  it('status validity follows the Core authoritative enum, not a local list (P1-3, rounds 3+4)', () => {
    // Round 4: the allowlist must be exactly the canonical Core export
    // PRINCIPLE_STATUSES (runtime-v2/types/principle-enums.ts) — no local copy.
    expect(authoritativePrincipleStatuses()).toEqual([...PRINCIPLE_STATUSES].sort());

    const ok = { availability: { status: 'ok' } };
    const ledgerOf = (status: unknown) => ({
      availability: { status: 'ok' },
      ledger: { tree: { principles: { p1: { id: 'p1', status: status as never } } } },
    });
    // Every authoritative status classifies as usable.
    for (const status of PRINCIPLE_STATUSES) {
      expect(classifyLedgerAvailability(ledgerOf(status)), `status ${status}`).toBe('ok');
    }
    // Non-authoritative / malformed status values poison the ledger.
    for (const [label, status] of [
      ['deactivated (retired value)', 'deactivated'],
      ['garbage', 'garbage'],
      ['empty string', ''],
      ['null', null],
      ['missing', undefined],
      ['non-string', 7],
    ] as [string, unknown][]) {
      expect(classifyLedgerAvailability(ledgerOf(status)), label).toBe('malformed_entries__semantic_review_required');
      const m = measureLedgerPrinciples({ coreResult: ledgerOf(status), authorization: { summaryFieldsAllowed: true } });
      expect(m.m1, label).toMatchObject({ count: null, trueZero: false });
      expect(m.m1.reasonCode, label).toBe('malformed_ledger_entries__semantic_review_required');
      expect(m.m2.count, label).toBeNull();
      expect(m.m3.count, label).toBeNull();
    }
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
        { id: 'p4', status: 'archived', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'c4', painId: 'pain4', evidenceQuality: 'exact' }] },
      ]),
    });
    expect(measure.m1.count).toBe(3); // archived (authoritative non-active) p4 excluded from eligibility
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

  // ── Owner review round 4 — P2: unmeasurable ledger states never emit pseudo-zeros ──
  const LENIENT_EMPTY = { availability: { status: 'ok' }, ledger: { tree: {} } };
  const MALFORMED = { availability: { status: 'ok' }, ledger: { tree: { principles: { p1: 'garbage' } } } };
  const UNKNOWN = { availability: { status: 'corrupted-index' } };
  const UNREADABLE = { availability: { status: 'unreadable' } };
  const EMPTY = { availability: { status: 'empty' } };
  const EVIDENCE = { auditor: 'independent-audit', recordRef: 'audit-record-1' };

  it('measurable-control (ok ledger) keeps numeric M1~M5 output — no regression to nulls', () => {
    const measure = measureLedgerPrinciples({
      authorization: { summaryFieldsAllowed: true },
      coreResult: coreResult([
        { id: 'p1', status: 'active', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'c1', painId: 'pain1', evidenceQuality: 'exact' }] },
      ]),
    });
    expect(measure.availabilityClass).toBe('ok');
    expect(measure.m1.count).toBe(1);
    expect(measure.m2.count).toBe(1);
    expect(measure.m3.count).toBe(1);
    // The single candidate claim here has exactly one owner → zero conflicts,
    // as a REAL measured zero (numeric, not an unmeasurable null).
    expect(measure.m4.count).toBe(0);
    expect(Array.isArray(measure.m4.details)).toBe(true);
    expect(measure.m5.unauthorizedCount).toBe(0);
    expect(measure.m5.unavailableCount).toBe(0);
    expect(measure.m4.unmeasurable).toBeUndefined();
    expect(measure.m5.unmeasurable).toBeUndefined();
  });

  it('ok_but_empty_ledger: M1 parsed zero only; M2/M3/M4/M5 carry NO pseudo-zero numbers (P2)', () => {
    const measure = measureLedgerPrinciples({ coreResult: LENIENT_EMPTY, authorization: { summaryFieldsAllowed: true }, trueZeroEvidence: EVIDENCE });
    expect(measure.m1).toMatchObject({ count: 0, trueZero: false, reasonCode: 'ok_but_empty_ledger__semantic_review_required' });
    expect(measure.m2).toMatchObject({ count: null, denominator: null, unmeasurable: true, reasonCode: 'ok_but_empty_ledger__semantic_review_required' });
    expect(measure.m3).toMatchObject({ count: null, denominator: null, unmeasurable: true, reasonCode: 'ok_but_empty_ledger__semantic_review_required' });
    expect(measure.m4).toMatchObject({ count: null, unmeasurable: true, reasonCode: 'ok_but_empty_ledger__semantic_review_required' });
    expect(measure.m5).toMatchObject({ unauthorizedCount: null, unavailableCount: null, unmeasurable: true, reasons: ['ok_but_empty_ledger__semantic_review_required'] });
  });

  it('malformed and unknown-availability ledgers produce NO pseudo-zeros anywhere in M1~M5 (P2)', () => {
    for (const [label, core] of [['malformed', MALFORMED], ['unknown', UNKNOWN]] as [string, unknown][]) {
      const m = measureLedgerPrinciples({ coreResult: core as never, authorization: { summaryFieldsAllowed: true }, trueZeroEvidence: EVIDENCE });
      expect(m.m1.count, label).toBeNull();
      expect(m.m1.trueZero, label).toBe(false);
      expect(m.m2.count, label).toBeNull();
      expect(m.m3.count, label).toBeNull();
      expect(m.m4.count, label).toBeNull();
      expect(m.m4.unmeasurable, label).toBe(true);
      expect(m.m5.unauthorizedCount, label).toBeNull();
      expect(m.m5.unavailableCount, label).toBeNull();
      expect(m.m5.unmeasurable, label).toBe(true);
      // A supplied evidence parameter cannot bypass the malformed/unknown gates.
      expect(m.m1.trueZeroEvidence, label).toBeNull();
    }
  });

  it('unreadable vs empty are clearly distinguished; empty without evidence cannot prove a true zero (P2)', () => {
    const unreadable = measureLedgerPrinciples({ coreResult: UNREADABLE, authorization: { summaryFieldsAllowed: true } });
    expect(unreadable.m1).toMatchObject({ count: null, trueZero: false, reasonCode: 'ledger_unreadable' });
    expect(unreadable.m2.count).toBeNull();
    expect(unreadable.m4.count).toBeNull();
    expect(unreadable.m5.unauthorizedCount).toBeNull();

    const emptyUnproven = measureLedgerPrinciples({ coreResult: EMPTY, authorization: { summaryFieldsAllowed: true } });
    expect(emptyUnproven.m1).toMatchObject({ count: 0, trueZero: false, reasonCode: 'ledger_empty__true_zero_unproven_requires_independent_evidence' });
    expect(emptyUnproven.m2).toMatchObject({ count: null, unmeasurable: true, reasonCode: 'ledger_empty__true_zero_unproven' });
    expect(emptyUnproven.m3).toMatchObject({ count: null, unmeasurable: true, reasonCode: 'ledger_empty_or_unreadable' });
    expect(emptyUnproven.m4.count).toBeNull();
    expect(emptyUnproven.m5.unauthorizedCount).toBeNull();
    expect(emptyUnproven.m5.unavailableCount).toBeNull();

    // empty WITH independent evidence: M1 may claim the proven true zero; the
    // rest of the metrics still have no measured denominator.
    const emptyProven = measureLedgerPrinciples({ coreResult: EMPTY, authorization: { summaryFieldsAllowed: true }, trueZeroEvidence: EVIDENCE });
    expect(emptyProven.m1).toMatchObject({ count: 0, trueZero: true, reasonCode: 'ledger_empty_with_independent_true_zero_evidence', trueZeroEvidence: EVIDENCE });
    expect(emptyProven.m2.count).toBeNull();
    expect(emptyProven.m5.unmeasurable).toBe(true);
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
