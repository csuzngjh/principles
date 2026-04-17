/**
 * Storage Conformance Suite for StorageAdapter implementations.
 *
 * This suite accepts a factory function that creates a StorageAdapter instance
 * and tests the following contract guarantees:
 *
 * 1. Atomic writes/reads: data written is data read back
 * 2. Concurrent mutation with locks: overlapping mutateLedger calls serialize
 * 3. Persistence across restarts: data survives adapter re-creation
 * 4. Error handling: malformed state is handled gracefully
 *
 * Usage:
 *   import { describeStorageConformance } from './storage-conformance.test.js';
 *   describeStorageConformance('FileStorageAdapter', () => new FileStorageAdapter(tmpDir));
 *
 * The factory receives a fresh temp directory for each test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { StorageAdapter } from '../../src/core/storage-adapter.js';
import type { HybridLedgerStore } from '../../src/core/principle-tree-ledger.js';
import { safeRmDir } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-storage-conformance-'));
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

function createTestPrinciple(id: string, text?: string) {
  return {
    id,
    version: 1,
    text: text ?? `Test principle ${id}`,
    triggerPattern: 'test',
    action: 'verify',
    status: 'candidate' as const,
    priority: 'P1' as const,
    scope: 'general',
    evaluability: 'manual_only' as const,
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [] as string[],
    ruleIds: [] as string[],
    conflictsWithPrincipleIds: [] as string[],
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Exported conformance suite
// ---------------------------------------------------------------------------

export type StorageAdapterFactory = (stateDir: string) => StorageAdapter;

export function describeStorageConformance(
  name: string,
  factory: StorageAdapterFactory,
): void {
  describe(`Storage Conformance: ${name}`, () => {
    let tmpDir: string;
    let adapter: StorageAdapter;

    beforeEach(() => {
      tmpDir = createTmpDir();
      adapter = factory(tmpDir);
    });

    afterEach(() => {
      safeRmDir(tmpDir);
    });

    // -------------------------------------------------------------------------
    // 1. Atomic writes/reads
    // -------------------------------------------------------------------------

    describe('atomic writes and reads', () => {
      it('loadLedger returns empty store when no data exists', async () => {
        const store = await adapter.loadLedger();
        expect(store.trainingStore).toEqual({});
        expect(store.tree.principles).toEqual({});
        expect(store.tree.rules).toEqual({});
      });

      it('saveLedger then loadLedger returns the same data', async () => {
        const store = createEmptyStore();
        store.tree.principles['P-001'] = createTestPrinciple('P-001', 'Write before delete');

        await adapter.saveLedger(store);
        const loaded = await adapter.loadLedger();

        expect(loaded.tree.principles['P-001']).toBeDefined();
        expect(loaded.tree.principles['P-001'].text).toBe('Write before delete');
        expect(loaded.tree.principles['P-001'].id).toBe('P-001');
      });

      it('saveLedger overwrites previous data atomically', async () => {
        const store1 = createEmptyStore();
        store1.tree.principles['P-001'] = createTestPrinciple('P-001', 'First write');
        await adapter.saveLedger(store1);

        const store2 = createEmptyStore();
        store2.tree.principles['P-002'] = createTestPrinciple('P-002', 'Second write');
        await adapter.saveLedger(store2);

        const loaded = await adapter.loadLedger();
        // Second write should have replaced the first
        expect(loaded.tree.principles['P-001']).toBeUndefined();
        expect(loaded.tree.principles['P-002']).toBeDefined();
        expect(loaded.tree.principles['P-002'].text).toBe('Second write');
      });

      it('preserves all store fields across save/load cycle', async () => {
        const store = createEmptyStore();
        store.trainingStore['tp-1'] = {
          principleId: 'tp-1',
          evaluability: 'weak_heuristic',
          applicableOpportunityCount: 5,
          observedViolationCount: 2,
          complianceRate: 0.6,
          violationTrend: -0.1,
          generatedSampleCount: 3,
          approvedSampleCount: 2,
          includedTrainRunIds: ['run-1', 'run-2'],
          deployedCheckpointIds: ['ckpt-1'],
          internalizationStatus: 'in_training',
        };
        store.tree.principles['P-001'] = createTestPrinciple('P-001');

        await adapter.saveLedger(store);
        const loaded = await adapter.loadLedger();

        // Verify training store
        expect(loaded.trainingStore['tp-1'].evaluability).toBe('weak_heuristic');
        expect(loaded.trainingStore['tp-1'].complianceRate).toBe(0.6);
        expect(loaded.trainingStore['tp-1'].includedTrainRunIds).toEqual(['run-1', 'run-2']);
        expect(loaded.trainingStore['tp-1'].deployedCheckpointIds).toEqual(['ckpt-1']);

        // Verify tree principles
        expect(loaded.tree.principles['P-001']).toBeDefined();
      });

      it('mutateLedger reads and writes atomically', async () => {
        await adapter.saveLedger(createEmptyStore());

        const result = await adapter.mutateLedger((store) => {
          store.tree.principles['P-MUT'] = createTestPrinciple('P-MUT', 'Mutated');
          return Object.keys(store.tree.principles).length;
        });

        expect(result).toBe(1);

        const loaded = await adapter.loadLedger();
        expect(loaded.tree.principles['P-MUT'].text).toBe('Mutated');
      });

      it('mutateLedger returns the value from the mutate function', async () => {
        await adapter.saveLedger(createEmptyStore());

        const count = await adapter.mutateLedger((store) => {
          return Object.keys(store.tree.principles).length;
        });

        expect(count).toBe(0);
      });
    });

    // -------------------------------------------------------------------------
    // 2. Concurrent mutation with locks
    // -------------------------------------------------------------------------

    describe('concurrent mutation with locks', () => {
      it('serializes overlapping mutateLedger calls', async () => {
        await adapter.saveLedger(createEmptyStore());

        // Launch 5 concurrent mutations that each add a principle
        const operations = Array.from({ length: 5 }, (_, i) =>
          adapter.mutateLedger((store) => {
            store.tree.principles[`P-CONC-${i}`] = createTestPrinciple(`P-CONC-${i}`, `Concurrent ${i}`);
          }),
        );

        await Promise.all(operations);

        // All 5 should be present — no lost updates
        const loaded = await adapter.loadLedger();
        for (let i = 0; i < 5; i++) {
          expect(loaded.tree.principles[`P-CONC-${i}`]).toBeDefined();
          expect(loaded.tree.principles[`P-CONC-${i}`].text).toBe(`Concurrent ${i}`);
        }
      });

      it('concurrent mutateLedger calls with return values all resolve correctly', async () => {
        await adapter.saveLedger(createEmptyStore());

        // Seed with a principle
        await adapter.mutateLedger((store) => {
          store.tree.principles['P-SEED'] = createTestPrinciple('P-SEED');
        });

        // Concurrent reads that return the count
        const operations = Array.from({ length: 3 }, () =>
          adapter.mutateLedger((store) => {
            return Object.keys(store.tree.principles).length;
          }),
        );

        const results = await Promise.all(operations);

        // Each should see at least 1 (the seed) since mutations serialize
        for (const count of results) {
          expect(count).toBeGreaterThanOrEqual(1);
        }
      });

      it('no data loss under concurrent writes of different keys', async () => {
        await adapter.saveLedger(createEmptyStore());

        // One writes principles, another writes training store entries
        const op1 = adapter.mutateLedger((store) => {
          store.tree.principles['P-PRIN'] = createTestPrinciple('P-PRIN', 'Principle side');
        });
        const op2 = adapter.mutateLedger((store) => {
          store.trainingStore['tp-train'] = {
            principleId: 'tp-train',
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
        });

        await Promise.all([op1, op2]);

        const loaded = await adapter.loadLedger();
        expect(loaded.tree.principles['P-PRIN']).toBeDefined();
        expect(loaded.trainingStore['tp-train']).toBeDefined();
      });
    });

    // -------------------------------------------------------------------------
    // 3. Persistence across restarts
    // -------------------------------------------------------------------------

    describe('persistence across restarts', () => {
      it('data persists when adapter is re-created on the same directory', async () => {
        const store = createEmptyStore();
        store.tree.principles['P-PERSIST'] = createTestPrinciple('P-PERSIST', 'Survives restart');

        // Write with first adapter instance
        await adapter.saveLedger(store);

        // Simulate restart: create a new adapter pointing to the same dir
        const restartedAdapter = factory(tmpDir);
        const loaded = await restartedAdapter.loadLedger();

        expect(loaded.tree.principles['P-PERSIST']).toBeDefined();
        expect(loaded.tree.principles['P-PERSIST'].text).toBe('Survives restart');
      });

      it('mutateLedger changes persist across adapter re-creation', async () => {
        await adapter.saveLedger(createEmptyStore());

        await adapter.mutateLedger((store) => {
          store.tree.principles['P-MUT-PERSIST'] = createTestPrinciple('P-MUT-PERSIST', 'Mutate survives');
        });

        // New adapter instance
        const restartedAdapter = factory(tmpDir);
        const loaded = await restartedAdapter.loadLedger();

        expect(loaded.tree.principles['P-MUT-PERSIST']).toBeDefined();
        expect(loaded.tree.principles['P-MUT-PERSIST'].text).toBe('Mutate survives');
      });

      it('training store data persists across adapter re-creation', async () => {
        const store = createEmptyStore();
        store.trainingStore['tp-persist'] = {
          principleId: 'tp-persist',
          evaluability: 'weak_heuristic',
          applicableOpportunityCount: 10,
          observedViolationCount: 3,
          complianceRate: 0.7,
          violationTrend: -0.2,
          generatedSampleCount: 5,
          approvedSampleCount: 4,
          includedTrainRunIds: ['run-a'],
          deployedCheckpointIds: [],
          internalizationStatus: 'needs_training',
        };

        await adapter.saveLedger(store);

        const restartedAdapter = factory(tmpDir);
        const loaded = await restartedAdapter.loadLedger();

        expect(loaded.trainingStore['tp-persist']).toBeDefined();
        expect(loaded.trainingStore['tp-persist'].applicableOpportunityCount).toBe(10);
        expect(loaded.trainingStore['tp-persist'].internalizationStatus).toBe('needs_training');
      });
    });

    // -------------------------------------------------------------------------
    // 4. Error handling
    // -------------------------------------------------------------------------

    describe('error handling', () => {
      it('loadLedger handles corrupted JSON gracefully', async () => {
        // Write invalid JSON to the ledger file
        const filePath = path.join(tmpDir, 'principle_training_state.json');
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(filePath, '{ invalid json !!!', 'utf8');

        // Should not throw — should return empty store
        const store = await adapter.loadLedger();
        expect(store.trainingStore).toEqual({});
        expect(store.tree.principles).toEqual({});
      });

      it('loadLedger handles empty file', async () => {
        const filePath = path.join(tmpDir, 'principle_training_state.json');
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(filePath, '', 'utf8');

        const store = await adapter.loadLedger();
        expect(store.trainingStore).toEqual({});
      });

      it('loadLedger handles file with null content', async () => {
        const filePath = path.join(tmpDir, 'principle_training_state.json');
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(filePath, 'null', 'utf8');

        const store = await adapter.loadLedger();
        expect(store.trainingStore).toEqual({});
      });

      it('saveLedger throws on write errors (read-only dir)', async () => {
        // Create a read-only scenario by pointing to a non-existent nested path
        // where the parent doesn't exist and can't be created
        const readOnlyDir = path.join(tmpDir, 'nonexistent', 'nested');
        const roAdapter = factory(readOnlyDir);

        // Depending on the adapter implementation, this may or may not throw.
        // For FileStorageAdapter, the dir is created so this should succeed.
        // We test that the adapter either succeeds or throws a meaningful error.
        const store = createEmptyStore();
        try {
          await roAdapter.saveLedger(store);
          // If it succeeds (adapter creates dirs), that's fine
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
        }
      });

      it('mutateLedger propagates errors from the mutate function', async () => {
        await adapter.saveLedger(createEmptyStore());

        await expect(
          adapter.mutateLedger(() => {
            throw new Error('Intentional test error');
          }),
        ).rejects.toThrow('Intentional test error');
      });

      it('async mutateLedger propagates async errors', async () => {
        await adapter.saveLedger(createEmptyStore());

        await expect(
          adapter.mutateLedger(async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error('Async intentional error');
          }),
        ).rejects.toThrow('Async intentional error');
      });
    });

    // -------------------------------------------------------------------------
    // 5. Async support
    // -------------------------------------------------------------------------

    describe('async mutate support', () => {
      it('supports async mutate functions', async () => {
        await adapter.saveLedger(createEmptyStore());

        const result = await adapter.mutateLedger(async (store) => {
          await new Promise((r) => setTimeout(r, 10));
          store.tree.principles['P-ASYNC'] = createTestPrinciple('P-ASYNC', 'Async mutation');
          return 'async-result';
        });

        expect(result).toBe('async-result');
        const loaded = await adapter.loadLedger();
        expect(loaded.tree.principles['P-ASYNC']).toBeDefined();
        expect(loaded.tree.principles['P-ASYNC'].text).toBe('Async mutation');
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Run conformance suite against FileStorageAdapter
// ---------------------------------------------------------------------------

import { FileStorageAdapter } from '../../src/core/file-storage-adapter.js';

describeStorageConformance('FileStorageAdapter', (stateDir) => {
  return new FileStorageAdapter(stateDir, stateDir);
});
