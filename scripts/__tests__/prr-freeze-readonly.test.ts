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

const verifyOk = () => ({ verified: true, approved: true });

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
    const { problems, minPairsEligible } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifyOk, dataset });
    expect(problems).toEqual([]);
    expect(minPairsEligible).toBe(true); // 13 tasks >= minPairs 3
  });

  it('refuses without a trusted verifier function (no default authorization)', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const { problems } = validateFreezeForRealRun({ freeze, preregBody, dataset });
    expect(problems.some((p: string) => p.includes('trusted Owner-approval verifier missing'))).toBe(true);
  });

  it('refuses when the verifier rejects the decision reference', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const { problems } = validateFreezeForRealRun({
      freeze,
      preregBody,
      verifyOwnerApproval: () => ({ verified: false, reason: 'no such decision record' }),
      dataset,
    });
    expect(problems.some((p: string) => p.includes('not verified'))).toBe(true);
  });

  it('refuses when the verifier confirms the record is NOT an approval', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const { problems } = validateFreezeForRealRun({
      freeze,
      preregBody,
      verifyOwnerApproval: () => ({ verified: true, approved: false }),
      dataset,
    });
    expect(problems.some((p: string) => p.includes('not an approval'))).toBe(true);
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

  it('minPairs above the available task count → UNPROVEN flag, never a pass', () => {
    const freeze = fullyFrozenRecord(preregBody);
    const fz11: any = freeze.items.find((i: any) => i.id === 'FZ-11');
    fz11.value = { minPairs: 999, derivationBasis: 'over-ambitious detectable difference' };
    const { problems, minPairsEligible } = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifyOk, dataset });
    expect(minPairsEligible).toBe(false);
    expect(problems.some((p: string) => p.includes('UNPROVEN'))).toBe(true);
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
    const unreadable = measureLedgerPrinciples({ coreResult: { availability: { status: 'unreadable' } } });
    expect(unreadable.m1.count).toBeNull();
    expect(unreadable.m1.trueZero).toBe(false);
    expect(unreadable.m1.reasonCode).toBe('ledger_unreadable');
    const empty = measureLedgerPrinciples({ coreResult: { availability: { status: 'empty' } } });
    expect(empty.m1.count).toBe(0);
    expect(empty.m1.trueZero).toBe(true);
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
    expect(measure.m3.count).toBe(0);
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
