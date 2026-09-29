/**
 * PRI-917 PR3B — appendReuseEvidence: the Ledger-layer reuse evidence writer.
 *
 * Pins the contract every later slice (decision surface, console) relies on:
 *   - append runs inside the single-writer lock, one entry per candidateId
 *     (idempotent replay, INV-R07);
 *   - fail-closed on a ledger file that exists with bytes but parses to an
 *     empty principles tree — the loader swallows parse errors, so writing
 *     blind would replace the whole corpus with this one write;
 *   - fail-closed on missing principle / malformed entry — no file mutation;
 *   - append-only: existing evidence, unknown fields, and every other
 *     principle field (including updatedAt and derivedFromPainIds) are
 *     preserved untouched (INV-R05).
 *
 * Fixtures use the real on-disk schema shape (EP-09 / ERR-025).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  addPrincipleToLedger,
  appendReuseEvidence,
  loadLedger,
  LedgerIntegrityError,
} from '../src/principle-tree-ledger.js';
import type { LedgerPrinciple } from '../src/runtime-v2/types/ledger-store.js';
import type { ReuseEvidenceEntry } from '../src/runtime-v2/types/principle-schema.js';

function makePrinciple(id: string): LedgerPrinciple {
  return {
    id,
    version: 1,
    text: `principle ${id}`,
    triggerPattern: 'tp',
    action: 'act',
    status: 'candidate',
    priority: 'P1',
    scope: 'general',
    evaluability: 'weak_heuristic',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: ['candidate-src-1'],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
  };
}

function makeEntry(candidateId: string): ReuseEvidenceEntry {
  return {
    painId: `pain-for-${candidateId}`,
    candidateId,
    decision: 'reuse',
    actor: { kind: 'owner', id: 'owner-1' },
    reason: 'existing principle already covers this behavioral demand',
    decidedAt: '2026-09-29T00:00:00.000Z',
  };
}

describe('PRI-917 PR3B — appendReuseEvidence', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-reuse-evidence-'));
    addPrincipleToLedger(stateDir, makePrinciple('p1'));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function ledgerPath(): string {
    return path.join(stateDir, 'principle_training_state.json');
  }

  it('appends evidence and returns it with appended: true', () => {
    const entry = makeEntry('c1');
    const result = appendReuseEvidence(stateDir, 'p1', entry);

    expect(result.appended).toBe(true);
    expect(result.reuseEvidence).toHaveLength(1);
    expect(result.reuseEvidence[0]).toEqual(entry);

    const stored = loadLedger(stateDir).tree.principles['p1'];
    expect(stored?.reuseEvidence).toHaveLength(1);
    expect(stored?.reuseEvidence?.[0]).toEqual(entry);
  });

  it('replaying the same candidate is a no-op: no second entry, first entry kept', () => {
    const first = makeEntry('c1');
    appendReuseEvidence(stateDir, 'p1', first);

    // Same candidateId, different content — the replay must NOT overwrite
    // the recorded decision with newer wording.
    const replay: ReuseEvidenceEntry = { ...first, reason: 'replayed with different wording', decidedAt: '2026-09-29T09:00:00.000Z' };
    const result = appendReuseEvidence(stateDir, 'p1', replay);

    expect(result.appended).toBe(false);
    const stored = loadLedger(stateDir).tree.principles['p1'];
    expect(stored?.reuseEvidence).toHaveLength(1);
    expect(stored?.reuseEvidence?.[0]).toEqual(first);
  });

  it('a different candidate appends a second entry', () => {
    appendReuseEvidence(stateDir, 'p1', makeEntry('c1'));
    const result = appendReuseEvidence(stateDir, 'p1', makeEntry('c2'));

    expect(result.appended).toBe(true);
    const stored = loadLedger(stateDir).tree.principles['p1'];
    expect(stored?.reuseEvidence).toHaveLength(2);
    expect(stored?.reuseEvidence?.map((e) => e.candidateId)).toEqual(['c1', 'c2']);
  });

  it('refuses a corrupt ledger and leaves the file byte-identical', () => {
    addPrincipleToLedger(stateDir, makePrinciple('p2'));
    const before = fs.readFileSync(ledgerPath(), 'utf8');
    fs.writeFileSync(ledgerPath(), '{ this is not json {{{', 'utf8');

    expect(() => appendReuseEvidence(stateDir, 'p1', makeEntry('c1'))).toThrow(LedgerIntegrityError);
    expect(() => appendReuseEvidence(stateDir, 'p1', makeEntry('c1'))).toThrow(/empty principles tree/);

    // The failed append must not have replaced the corrupt file with a
    // near-empty ledger (the destructive-overwrite hazard this guard exists for).
    expect(fs.readFileSync(ledgerPath(), 'utf8')).toBe('{ this is not json {{{');
    expect(before).not.toBe('{ this is not json {{{');
  });

  it('refuses a non-empty file that parses to an empty principles tree', () => {
    fs.writeFileSync(
      ledgerPath(),
      JSON.stringify({ trainingStore: {}, _tree: { principles: {}, rules: {}, implementations: {}, metrics: {}, lastUpdated: '2026-09-29T00:00:00.000Z' } }),
      'utf8',
    );
    expect(() => appendReuseEvidence(stateDir, 'p1', makeEntry('c1'))).toThrow(LedgerIntegrityError);
  });

  it('refuses an empty (0-byte) ledger file', () => {
    fs.writeFileSync(ledgerPath(), '', 'utf8');
    expect(() => appendReuseEvidence(stateDir, 'p1', makeEntry('c1'))).toThrow(LedgerIntegrityError);
  });

  it('refuses a missing principle without mutating the ledger', () => {
    const before = fs.readFileSync(ledgerPath(), 'utf8');
    expect(() => appendReuseEvidence(stateDir, 'missing-p', makeEntry('c1'))).toThrow(
      /principle "missing-p" does not exist/,
    );
    expect(fs.readFileSync(ledgerPath(), 'utf8')).toBe(before);
  });

  it('refuses a missing principle when no ledger file exists yet, without creating one', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-reuse-evidence-empty-'));
    try {
      expect(() => appendReuseEvidence(emptyDir, 'p1', makeEntry('c1'))).toThrow(/does not exist/);
      expect(fs.existsSync(path.join(emptyDir, 'principle_training_state.json'))).toBe(false);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('refuses malformed entries (fail closed, rc-3) without mutating the ledger', () => {
    const before = fs.readFileSync(ledgerPath(), 'utf8');
    const cases: Array<{ entry: unknown; detail: RegExp }> = [
      { entry: { ...makeEntry('c1'), decision: 'create' }, detail: /decision must be exactly "reuse"/ },
      { entry: { ...makeEntry('c1'), actor: { kind: 'robot', id: 'x' } }, detail: /actor\.kind must be "owner" or "ai_owner"/ },
      { entry: { ...makeEntry('c1'), actor: { kind: 'owner', id: '' } }, detail: /actor\.id must be a non-empty string/ },
      { entry: { ...makeEntry('c1'), reason: '' }, detail: /reason must be a non-empty string/ },
      { entry: { ...makeEntry('c1'), decidedAt: 'not-a-date' }, detail: /decidedAt must be a parseable date/ },
      { entry: { ...makeEntry('c1'), surprise: 1 }, detail: /unknown field "surprise"/ },
    ];
    for (const { entry, detail } of cases) {
      expect(() => appendReuseEvidence(stateDir, 'p1', entry as ReuseEvidenceEntry)).toThrow(detail);
    }
    expect(fs.readFileSync(ledgerPath(), 'utf8')).toBe(before);
  });

  it('preserves unknown fields already on the principle entry', () => {
    addPrincipleToLedger(stateDir, {
      ...makePrinciple('p-unknown'),
      zzFutureField: { note: 'unknown-to-this-schema' },
    } as LedgerPrinciple);

    appendReuseEvidence(stateDir, 'p-unknown', makeEntry('c1'));

    const stored = loadLedger(stateDir).tree.principles['p-unknown'];
    expect((stored as unknown as Record<string, unknown>)['zzFutureField']).toEqual({
      note: 'unknown-to-this-schema',
    });
    expect(stored?.reuseEvidence).toHaveLength(1);
  });

  it('changes no existing principle field other than reuseEvidence (INV-R05)', () => {
    const seeded = loadLedger(stateDir).tree.principles['p1'];
    expect(seeded).toBeDefined();
    const before = JSON.parse(JSON.stringify(seeded)) as LedgerPrinciple & { reuseEvidence?: ReuseEvidenceEntry[] };

    appendReuseEvidence(stateDir, 'p1', makeEntry('c1'));

    const after = loadLedger(stateDir).tree.principles['p1'];
    expect(after).toBeDefined();
    const { reuseEvidence: beforeEvidence, ...beforeRest } = before;
    const { reuseEvidence: afterEvidence, ...afterRest } = after as LedgerPrinciple & { reuseEvidence?: ReuseEvidenceEntry[] };
    expect(beforeEvidence).toBeUndefined();
    expect(afterRest).toEqual(beforeRest);
    expect(afterEvidence).toHaveLength(1);
    // Explicitly pin the fields history has burned us on.
    expect(afterRest.derivedFromPainIds).toEqual(['candidate-src-1']);
    expect(afterRest.updatedAt).toBe('2026-06-24T00:00:00.000Z');
    expect(afterRest.status).toBe('candidate');
  });
});
