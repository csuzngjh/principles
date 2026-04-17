import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileStorageAdapter } from '../../src/core/file-storage-adapter.js';
import type { HybridLedgerStore } from '../../src/core/principle-tree-ledger.js';
import { TREE_NAMESPACE, loadLedger } from '../../src/core/principle-tree-ledger.js';
import { safeRmDir } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-file-storage-adapter-test-'));
}

function createEmptyStore(): HybridLedgerStore {
  return {
    trainingStore: {},
    tree: {
      principles: {},
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: new Date(0).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileStorageAdapter', () => {
  let tmpDir: string;
  let adapter: FileStorageAdapter;

  beforeEach(() => {
    tmpDir = createTmpDir();
    adapter = new FileStorageAdapter(tmpDir, tmpDir);
  });

  afterEach(() => {
    safeRmDir(tmpDir);
  });

  // -------------------------------------------------------------------------
  // loadLedger
  // -------------------------------------------------------------------------

  describe('loadLedger', () => {
    it('returns empty store when no file exists', async () => {
      const store = await adapter.loadLedger();
      expect(store.trainingStore).toEqual({});
      expect(store.tree.principles).toEqual({});
      expect(store.tree.rules).toEqual({});
    });

    it('loads existing persisted store', async () => {
      const original = createEmptyStore();
      original.tree.principles['P-001'] = {
        id: 'P-001',
        version: 1,
        text: 'Write before delete',
        triggerPattern: 'delete',
        action: 'write first',
        status: 'active',
        priority: 'P1',
        scope: 'general',
        evaluability: 'deterministic',
        valueScore: 0,
        adherenceRate: 0,
        painPreventedCount: 0,
        derivedFromPainIds: [],
        ruleIds: [],
        conflictsWithPrincipleIds: [],
        createdAt: '2026-04-17T00:00:00.000Z',
        updatedAt: '2026-04-17T00:00:00.000Z',
      };

      // Persist using the low-level ledger to seed the file
      await adapter.saveLedger(original);
      const loaded = await adapter.loadLedger();
      expect(loaded.tree.principles['P-001']).toBeDefined();
      expect(loaded.tree.principles['P-001'].text).toBe('Write before delete');
    });
  });

  // -------------------------------------------------------------------------
  // saveLedger
  // -------------------------------------------------------------------------

  describe('saveLedger', () => {
    it('persists store to disk', async () => {
      const store = createEmptyStore();
      store.trainingStore['test-principle'] = {
        principleId: 'test-principle',
        evaluability: 'manual_only',
        applicableOpportunityCount: 0,
        observedViolationCount: 0,
        complianceRate: 0,
        violationTrend: 0,
        generatedSampleCount: 0,
        approvedSampleCount: 0,
        includedTrainRunIds: [],
        deployedCheckpointIds: [],
        internalizationStatus: 'prompt_only',
      };

      await adapter.saveLedger(store);

      // Verify file exists and contains the data
      const filePath = path.join(tmpDir, 'principle_training_state.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(raw['test-principle']).toBeDefined();
      expect(raw[TREE_NAMESPACE]).toBeDefined();
    });

    it('round-trips data through save and load', async () => {
      const store = createEmptyStore();
      store.trainingStore['p-1'] = {
        principleId: 'p-1',
        evaluability: 'weak_heuristic',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
        violationTrend: -0.1,
        generatedSampleCount: 3,
        approvedSampleCount: 2,
        includedTrainRunIds: ['run-1'],
        deployedCheckpointIds: [],
        internalizationStatus: 'in_training',
      };

      await adapter.saveLedger(store);
      const loaded = await adapter.loadLedger();
      expect(loaded.trainingStore['p-1'].evaluability).toBe('weak_heuristic');
      expect(loaded.trainingStore['p-1'].applicableOpportunityCount).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // mutateLedger
  // -------------------------------------------------------------------------

  describe('mutateLedger', () => {
    it('reads, mutates, and writes atomically', async () => {
      // Start with empty store
      await adapter.saveLedger(createEmptyStore());

      const result = await adapter.mutateLedger((store) => {
        store.tree.principles['P-002'] = {
          id: 'P-002',
          version: 1,
          text: 'Test principle',
          triggerPattern: 'test',
          action: 'do something',
          status: 'candidate',
          priority: 'P2',
          scope: 'general',
          evaluability: 'manual_only',
          valueScore: 0,
          adherenceRate: 0,
          painPreventedCount: 0,
          derivedFromPainIds: [],
          ruleIds: [],
          conflictsWithPrincipleIds: [],
          createdAt: '2026-04-17T00:00:00.000Z',
          updatedAt: '2026-04-17T00:00:00.000Z',
        };
        return 42;
      });

      expect(result).toBe(42);
      const loaded = await adapter.loadLedger();
      expect(loaded.tree.principles['P-002']).toBeDefined();
      expect(loaded.tree.principles['P-002'].text).toBe('Test principle');
    });

    it('returns the value from the mutate function', async () => {
      await adapter.saveLedger(createEmptyStore());

      const count = await adapter.mutateLedger((store) => {
        return Object.keys(store.tree.principles).length;
      });

      expect(count).toBe(0);
    });

    it('supports async mutate functions', async () => {
      await adapter.saveLedger(createEmptyStore());

      const result = await adapter.mutateLedger(async (store) => {
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        store.trainingStore['async-test'] = {
          principleId: 'async-test',
          evaluability: 'deterministic',
          applicableOpportunityCount: 1,
          observedViolationCount: 0,
          complianceRate: 1.0,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        };
        return 'async-done';
      });

      expect(result).toBe('async-done');
      const loaded = await adapter.loadLedger();
      expect(loaded.trainingStore['async-test']).toBeDefined();
    });

    it('persists via atomicWriteFileSync (file is not corrupted)', async () => {
      await adapter.saveLedger(createEmptyStore());

      await adapter.mutateLedger((store) => {
        store.tree.principles['P-003'] = {
          id: 'P-003',
          version: 1,
          text: 'Atomic write test',
          triggerPattern: 'test',
          action: 'verify atomicity',
          status: 'candidate',
          priority: 'P1',
          scope: 'general',
          evaluability: 'manual_only',
          valueScore: 0,
          adherenceRate: 0,
          painPreventedCount: 0,
          derivedFromPainIds: [],
          ruleIds: [],
          conflictsWithPrincipleIds: [],
          createdAt: '2026-04-17T00:00:00.000Z',
          updatedAt: '2026-04-17T00:00:00.000Z',
        };
      });

      // Verify no leftover temp file
      const filePath = path.join(tmpDir, 'principle_training_state.json');
      expect(fs.existsSync(filePath + '.tmp')).toBe(false);
      expect(fs.existsSync(filePath)).toBe(true);

      // File is valid JSON
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(raw[TREE_NAMESPACE].principles['P-003']).toBeDefined();
    });

    it('is compatible with low-level loadLedger', async () => {
      await adapter.saveLedger(createEmptyStore());

      await adapter.mutateLedger((store) => {
        store.tree.principles['P-COMPAT'] = {
          id: 'P-COMPAT',
          version: 1,
          text: 'Compatibility test',
          triggerPattern: 'compat',
          action: 'verify',
          status: 'active',
          priority: 'P1',
          scope: 'general',
          evaluability: 'deterministic',
          valueScore: 10,
          adherenceRate: 0.8,
          painPreventedCount: 5,
          derivedFromPainIds: ['pain-1'],
          ruleIds: [],
          conflictsWithPrincipleIds: [],
          createdAt: '2026-04-17T00:00:00.000Z',
          updatedAt: '2026-04-17T00:00:00.000Z',
        };
      });

      // Load with the low-level function — should see the same data
      const ledger = loadLedger(tmpDir);
      expect(ledger.tree.principles['P-COMPAT']).toBeDefined();
      expect(ledger.tree.principles['P-COMPAT'].text).toBe('Compatibility test');
    });
  });
});
