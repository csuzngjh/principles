/**
 * PRI-459 Stage 1.4: round-trip preservation + async/trainingStore coverage.
 *
 * Two contracts are pinned here that had NO dedicated test before PRI-459:
 *
 *  1. Extra-field preservation. parsePrinciples uses `{ ...value }` spread,
 *     so fields NOT in the declared Principle interface (suggestedRules,
 *     lastTriggeredAt, compilationRetryCount, ...) survive a save→load cycle.
 *     This is load-bearing: plugin consumers (evolution-reducer writes
 *     compilationRetryCount; suggestedRules is part of the bootstrap flow)
 *     depend on these surviving. If a future refactor tightens the codec to a
 *     whitelist, this test must fail LOUD rather than silently drop data
 *     (EP-09 / ERR-007 / ERR-025).
 *
 *  2. The async mutator (saveLedgerAsync) and updateTrainingStore go through
 *     the same locked read-modify-write path as the sync mutators, so a
 *     concurrent sync write cannot lose an async update (EP-07).
 *
 * Fixtures mirror the real on-disk hybrid schema (top-level training records
 * + _tree subtree).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  loadLedger,
  saveLedger,
  saveLedgerAsync,
  updatePrinciple,
  updateTrainingStore,
} from '../src/principle-tree-ledger.js';
import type {
  LedgerPrinciple,
  LegacyPrincipleTrainingState,
  HybridLedgerStore,
} from '../src/runtime-v2/types/ledger-store.js';

function makePrinciple(id: string): LedgerPrinciple {
  return {
    id,
    version: 1,
    text: `principle ${id}`,
    triggerPattern: 'tp',
    action: 'act',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
  };
}

function emptyStore(): HybridLedgerStore {
  return {
    trainingStore: {},
    tree: { principles: {}, rules: {}, implementations: {}, metrics: {}, lastUpdated: '2026-06-24T00:00:00.000Z' },
  };
}

describe('PRI-459 Stage 1.4 — round-trip + async + trainingStore', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-rt-'));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe('extra-field preservation through save → load', () => {
    it('preserves suggestedRules and lastTriggeredAt on a principle', () => {
      // Seed the principle, THEN update with extras (updatePrinciple requires
      // the entity to already exist — fail-loud, EP-03).
      saveLedger(stateDir, emptyStore());
      const store1 = loadLedger(stateDir);
      store1.tree.principles['p1'] = makePrinciple('p1');
      saveLedger(stateDir, store1);

      // Attach optional/extra fields the way plugin consumers do.
      const withExtras = {
        ...makePrinciple('p1'),
        suggestedRules: ['rule-a', 'rule-b'],
        lastTriggeredAt: '2026-06-24T12:00:00.000Z',
      } as LedgerPrinciple;
      updatePrinciple(stateDir, 'p1', { ...withExtras });

      const reloaded = loadLedger(stateDir).tree.principles['p1']!;
      expect(reloaded.suggestedRules).toEqual(['rule-a', 'rule-b']);
      expect(reloaded.lastTriggeredAt).toBe('2026-06-24T12:00:00.000Z');
    });

    it('preserves an arbitrary extension field (compilationRetryCount)', () => {
      // evolution-reducer writes compilationRetryCount via updatePrinciple; it
      // is not in the Principle interface but MUST survive a round trip.
      saveLedger(stateDir, emptyStore());
      const store1 = loadLedger(stateDir);
      store1.tree.principles['p2'] = makePrinciple('p2');
      saveLedger(stateDir, store1);

      const withExtra = { ...makePrinciple('p2'), compilationRetryCount: 3 } as LedgerPrinciple & { compilationRetryCount: number };
      updatePrinciple(stateDir, 'p2', { ...withExtra });

      const reloaded = loadLedger(stateDir).tree.principles['p2']! as LedgerPrinciple & { compilationRetryCount?: number };
      expect(reloaded.compilationRetryCount).toBe(3);
    });

    it('preserves array fields (ruleIds / derivedFromPainIds) without duplication', () => {
      saveLedger(stateDir, emptyStore());
      const store1 = loadLedger(stateDir);
      store1.tree.principles['p3'] = makePrinciple('p3');
      saveLedger(stateDir, store1);

      updatePrinciple(stateDir, 'p3', {
        ruleIds: ['r1', 'r2', 'r1'],
        derivedFromPainIds: ['pain-1', 'pain-2'],
      });

      const reloaded = loadLedger(stateDir).tree.principles['p3']!;
      expect(reloaded.ruleIds).toEqual(['r1', 'r2']); // uniqueStrings applied
      expect(reloaded.derivedFromPainIds).toEqual(['pain-1', 'pain-2']);
    });
  });

  describe('saveLedgerAsync (async locked path)', () => {
    it('writes through the async mutator and is readable synchronously', async () => {
      const store = emptyStore();
      store.tree.principles['pAsync'] = makePrinciple('pAsync');
      await saveLedgerAsync(stateDir, store);

      const reloaded = loadLedger(stateDir);
      expect(reloaded.tree.principles['pAsync']).toBeDefined();
    });

    it('an async save followed by a sync save both persist (no lost update across paths)', async () => {
      const asyncStore = emptyStore();
      asyncStore.tree.principles['pAsync'] = makePrinciple('pAsync');
      await saveLedgerAsync(stateDir, asyncStore);

      const syncStore = loadLedger(stateDir);
      syncStore.tree.principles['pSync'] = makePrinciple('pSync');
      saveLedger(stateDir, syncStore);

      const final = loadLedger(stateDir);
      expect(Object.keys(final.tree.principles).sort()).toEqual(['pAsync', 'pSync']);
    });
  });

  describe('updateTrainingStore', () => {
    it('mutates a top-level training record and persists it', () => {
      saveLedger(stateDir, emptyStore());
      const record: LegacyPrincipleTrainingState = {
        principleId: 'p1',
        evaluability: 'weak_heuristic',
        applicableOpportunityCount: 5,
        observedViolationCount: 1,
        complianceRate: 0.8,
        violationTrend: 0,
        generatedSampleCount: 0,
        approvedSampleCount: 0,
        includedTrainRunIds: [],
        deployedCheckpointIds: [],
        internalizationStatus: 'needs_training',
      };
      updateTrainingStore(stateDir, (store) => {
        store['p1'] = record;
      });

      const reloaded = loadLedger(stateDir).trainingStore['p1']!;
      expect(reloaded.internalizationStatus).toBe('needs_training');
      expect(reloaded.applicableOpportunityCount).toBe(5);
    });
  });
});
