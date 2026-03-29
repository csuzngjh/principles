import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadStore,
  saveStore,
  loadStoreAsync,
  saveStoreAsync,
  getPrincipleState,
  setPrincipleState,
  removePrincipleState,
  listPrincipleIds,
  listPrinciplesByStatus,
  listEvaluablePrinciples,
  createDefaultPrincipleState,
  PRINCIPLE_TRAINING_FILE,
} from '../../src/core/principle-training-state.js';
import { safeRmDir } from '../test-utils.js';

describe('PrincipleTrainingState', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    // Each test gets its own isolated temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pts-'));
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(tempDir);
  });

  // -------------------------------------------------------------------------
  // createDefaultPrincipleState
  // -------------------------------------------------------------------------

  describe('createDefaultPrincipleState', () => {
    it('creates a default state with prompt_only status', () => {
      const state = createDefaultPrincipleState('T-01');
      expect(state.principleId).toBe('T-01');
      expect(state.internalizationStatus).toBe('prompt_only');
      expect(state.evaluability).toBe('manual_only');
      expect(state.applicableOpportunityCount).toBe(0);
      expect(state.observedViolationCount).toBe(0);
      expect(state.complianceRate).toBe(0);
      expect(state.violationTrend).toBe(0);
      expect(state.generatedSampleCount).toBe(0);
      expect(state.approvedSampleCount).toBe(0);
      expect(state.includedTrainRunIds).toEqual([]);
      expect(state.deployedCheckpointIds).toEqual([]);
      expect(state.lastEvalScore).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // saveStore / loadStore — basic roundtrip
  // -------------------------------------------------------------------------

  describe('saveStore / loadStore', () => {
    it('saves and loads a store with a single principle', () => {
      const store = {
        'T-01': {
          principleId: 'T-01',
          evaluability: 'deterministic',
          applicableOpportunityCount: 10,
          observedViolationCount: 2,
          complianceRate: 0.8,
          violationTrend: -1,
          generatedSampleCount: 3,
          approvedSampleCount: 2,
          includedTrainRunIds: ['run-001'],
          deployedCheckpointIds: [],
          internalizationStatus: 'needs_training',
        },
      };

      saveStore(stateDir, store);
      const loaded = loadStore(stateDir);

      expect(Object.keys(loaded)).toHaveLength(1);
      expect(loaded['T-01']).toEqual(store['T-01']);
    });

    it('saves and loads a store with multiple principles', () => {
      const store = {
        'T-01': {
          principleId: 'T-01',
          evaluability: 'deterministic',
          applicableOpportunityCount: 10,
          observedViolationCount: 2,
          complianceRate: 0.8,
          violationTrend: -1,
          generatedSampleCount: 3,
          approvedSampleCount: 2,
          includedTrainRunIds: ['run-001'],
          deployedCheckpointIds: [],
          internalizationStatus: 'needs_training',
        },
        'P_write_before_delete': {
          principleId: 'P_write_before_delete',
          evaluability: 'weak_heuristic',
          applicableOpportunityCount: 5,
          observedViolationCount: 1,
          complianceRate: 0.8,
          violationTrend: 0,
          generatedSampleCount: 1,
          approvedSampleCount: 1,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      };

      saveStore(stateDir, store);
      const loaded = loadStore(stateDir);

      expect(Object.keys(loaded)).toHaveLength(2);
      expect(loaded['T-01']).toEqual(store['T-01']);
      expect(loaded['P_write_before_delete']).toEqual(store['P_write_before_delete']);
    });

    it('overwrites existing file on save', () => {
      const store1 = {
        'T-01': {
          principleId: 'T-01',
          evaluability: 'deterministic',
          applicableOpportunityCount: 5,
          observedViolationCount: 1,
          complianceRate: 0.8,
          violationTrend: 0,
          generatedSampleCount: 1,
          approvedSampleCount: 1,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'needs_training',
        },
      };

      saveStore(stateDir, store1);

      const store2 = {
        'T-02': {
          principleId: 'T-02',
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
        },
      };

      saveStore(stateDir, store2);
      const loaded = loadStore(stateDir);

      // T-01 should be gone — file was overwritten
      expect(Object.keys(loaded)).toHaveLength(1);
      expect(loaded['T-02']).toEqual(store2['T-02']);
    });

    it('writes valid JSON to disk', () => {
      const store = {
        'T-01': {
          principleId: 'T-01',
          evaluability: 'deterministic',
          applicableOpportunityCount: 10,
          observedViolationCount: 0,
          complianceRate: 1.0,
          violationTrend: 0,
          generatedSampleCount: 5,
          approvedSampleCount: 4,
          includedTrainRunIds: [],
          deployedCheckpointIds: ['ckpt-001'],
          internalizationStatus: 'deployed_pending_eval',
          lastEvalScore: 0.85,
        },
      };

      saveStore(stateDir, store);
      const raw = fs.readFileSync(path.join(stateDir, PRINCIPLE_TRAINING_FILE), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(store);
    });
  });

  // -------------------------------------------------------------------------
  // loadStore — fail-safe (file not found, corrupted JSON)
  // -------------------------------------------------------------------------

  describe('loadStore — fail-safe', () => {
    it('returns an empty store when file does not exist', () => {
      const loaded = loadStore(stateDir);
      expect(loaded).toEqual({});
    });

    it('returns an empty store when file contains invalid JSON', () => {
      fs.writeFileSync(path.join(stateDir, PRINCIPLE_TRAINING_FILE), '{ broken json }', 'utf-8');
      const loaded = loadStore(stateDir);
      expect(loaded).toEqual({});
    });

    it('returns an empty store when file contains null', () => {
      fs.writeFileSync(path.join(stateDir, PRINCIPLE_TRAINING_FILE), 'null', 'utf-8');
      const loaded = loadStore(stateDir);
      expect(loaded).toEqual({});
    });

    it('returns an empty store when file contains a plain string', () => {
      fs.writeFileSync(path.join(stateDir, PRINCIPLE_TRAINING_FILE), '"just a string"', 'utf-8');
      const loaded = loadStore(stateDir);
      expect(loaded).toEqual({});
    });

    it('returns an empty store when file contains an array instead of object', () => {
      fs.writeFileSync(path.join(stateDir, PRINCIPLE_TRAINING_FILE), '[1, 2, 3]', 'utf-8');
      const loaded = loadStore(stateDir);
      expect(loaded).toEqual({});
    });

    it('skips corrupted entries but loads valid ones', () => {
      // One valid entry and one with invalid value
      const store = {
        'T-01': {
          principleId: 'T-01',
          evaluability: 'deterministic',
          applicableOpportunityCount: 5,
          observedViolationCount: 1,
          complianceRate: 0.8,
          violationTrend: 0,
          generatedSampleCount: 1,
          approvedSampleCount: 1,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'needs_training',
        },
        // Invalid entry: missing principleId and bad enum
        'BAD_ENTRY': {
          evaluability: 'invalid_enum',
          internalizationStatus: 'also_invalid',
        },
      };

      fs.writeFileSync(path.join(stateDir, PRINCIPLE_TRAINING_FILE), JSON.stringify(store), 'utf-8');
      const loaded = loadStore(stateDir);

      // T-01 should be present (migration defaults applied)
      expect(loaded['T-01']).toBeDefined();
      expect(loaded['T-01'].principleId).toBe('T-01');
      expect(loaded['T-01'].evaluability).toBe('deterministic'); // valid
      expect(loaded['T-01'].internalizationStatus).toBe('needs_training'); // valid

      // BAD_ENTRY should be skipped — principleId field is undefined (missing),
      // so storedPrincipleId !== principleId (key). This indicates corruption/tampering.
      expect(loaded['BAD_ENTRY']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // loadStore — migration-safe defaults
  // -------------------------------------------------------------------------

  describe('loadStore — migration-safe defaults', () => {
    function writeRawPrinciple(data: Record<string, unknown>): void {
      const store = { 'T-01': data };
      fs.writeFileSync(path.join(stateDir, PRINCIPLE_TRAINING_FILE), JSON.stringify(store), 'utf-8');
    }

    it('applies defaults when evaluability is missing', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        internalizationStatus: 'prompt_only',
        evaluability: undefined, // missing
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.evaluability).toBe('manual_only'); // safe default
    });

    it('applies defaults when internalizationStatus is missing', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        internalizationStatus: undefined, // missing
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.internalizationStatus).toBe('prompt_only'); // safe default
    });

    it('applies defaults when numeric fields are NaN', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        applicableOpportunityCount: NaN,
        observedViolationCount: Infinity,
        complianceRate: 'not a number',
        violationTrend: null,
        generatedSampleCount: undefined,
        approvedSampleCount: NaN,
        internalizationStatus: 'prompt_only',
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.applicableOpportunityCount).toBe(0);
      expect(loaded['T-01']!.observedViolationCount).toBe(0);
      expect(loaded['T-01']!.complianceRate).toBe(0);
      expect(loaded['T-01']!.violationTrend).toBe(0);
      expect(loaded['T-01']!.generatedSampleCount).toBe(0);
      expect(loaded['T-01']!.approvedSampleCount).toBe(0);
    });

    it('clamps complianceRate above 1.0 to 1.0', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        complianceRate: 1.5,
        internalizationStatus: 'prompt_only',
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.complianceRate).toBe(1);
    });

    it('clamps complianceRate below 0.0 to 0.0', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        complianceRate: -0.5,
        internalizationStatus: 'prompt_only',
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.complianceRate).toBe(0);
    });

    it('clamps violationTrend to -1 / 0 / 1 range', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        violationTrend: 5,
        internalizationStatus: 'prompt_only',
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.violationTrend).toBe(1);

      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        violationTrend: -5,
        internalizationStatus: 'prompt_only',
      });
      const loaded2 = loadStore(stateDir);
      expect(loaded2['T-01']!.violationTrend).toBe(-1);
    });

    it('filters out non-string entries in includedTrainRunIds', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        includedTrainRunIds: ['run-001', 123, null, 'run-002', undefined],
        internalizationStatus: 'in_training',
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.includedTrainRunIds).toEqual(['run-001', 'run-002']);
    });

    it('filters out non-string entries in deployedCheckpointIds', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        deployedCheckpointIds: ['ckpt-001', false, 'ckpt-002'],
        internalizationStatus: 'deployed_pending_eval',
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.deployedCheckpointIds).toEqual(['ckpt-001', 'ckpt-002']);
    });

    it('applies default lastEvalScore when undefined', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        lastEvalScore: undefined,
        internalizationStatus: 'prompt_only',
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.lastEvalScore).toBeUndefined();
    });

    it('clamps lastEvalScore to 0-1 range when out of range', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        lastEvalScore: 1.5,
        internalizationStatus: 'deployed_pending_eval',
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.lastEvalScore).toBe(1);

      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        lastEvalScore: -0.1,
        internalizationStatus: 'deployed_pending_eval',
      });
      const loaded2 = loadStore(stateDir);
      expect(loaded2['T-01']!.lastEvalScore).toBe(0);
    });

    it('accepts valid enum values as-is', () => {
      const validStatuses = [
        'prompt_only',
        'needs_training',
        'in_training',
        'deployed_pending_eval',
        'internalized',
        'regressed',
      ] as const;

      // Save all statuses in a single store to avoid file-overwrite race between iterations
      const store: Record<string, Record<string, unknown>> = {};
      for (const status of validStatuses) {
        const id = `T-${String(status)}`;
        store[id] = {
          principleId: id,
          evaluability: 'deterministic',
          internalizationStatus: status,
        };
      }
      fs.writeFileSync(path.join(stateDir, PRINCIPLE_TRAINING_FILE), JSON.stringify(store), 'utf-8');
      const loaded = loadStore(stateDir);

      for (const status of validStatuses) {
        const id = `T-${String(status)}`;
        expect(loaded[id]).toBeDefined();
        expect(loaded[id]!.internalizationStatus).toBe(status);
        expect(loaded[id]!.evaluability).toBe('deterministic');
      }
    });

    it('defaults invalid evaluability to manual_only', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'not_deterministic',
        internalizationStatus: 'prompt_only',
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.evaluability).toBe('manual_only');
    });

    it('defaults invalid internalizationStatus to prompt_only', () => {
      writeRawPrinciple({
        principleId: 'T-01',
        evaluability: 'deterministic',
        internalizationStatus: 'completed', // not a valid status
      });
      const loaded = loadStore(stateDir);
      expect(loaded['T-01']!.internalizationStatus).toBe('prompt_only');
    });
  });

  // -------------------------------------------------------------------------
  // Single-principle accessors
  // -------------------------------------------------------------------------

  describe('getPrincipleState / setPrincipleState', () => {
    it('returns a default state for an unknown principle', () => {
      const state = getPrincipleState(stateDir, 'T-99');
      expect(state.principleId).toBe('T-99');
      expect(state.internalizationStatus).toBe('prompt_only');
      expect(state.evaluability).toBe('manual_only');
    });

    it('roundtrips a complete state through set/get', () => {
      const original: Parameters<typeof setPrincipleState>[1] = {
        principleId: 'T-01',
        evaluability: 'deterministic',
        applicableOpportunityCount: 20,
        observedViolationCount: 4,
        complianceRate: 0.8,
        violationTrend: -1,
        generatedSampleCount: 5,
        approvedSampleCount: 3,
        includedTrainRunIds: ['run-001', 'run-002'],
        deployedCheckpointIds: ['ckpt-alpha'],
        lastEvalScore: 0.82,
        internalizationStatus: 'deployed_pending_eval',
      };

      setPrincipleState(stateDir, original);
      const loaded = getPrincipleState(stateDir, 'T-01');

      expect(loaded).toEqual(original);
    });

    it('setPrincipleState does not affect other principles', () => {
      const state1 = createDefaultPrincipleState('T-01');
      state1.internalizationStatus = 'needs_training';
      setPrincipleState(stateDir, state1);

      const state2 = createDefaultPrincipleState('T-02');
      state2.internalizationStatus = 'internalized';
      setPrincipleState(stateDir, state2);

      const loaded1 = getPrincipleState(stateDir, 'T-01');
      const loaded2 = getPrincipleState(stateDir, 'T-02');

      expect(loaded1.internalizationStatus).toBe('needs_training');
      expect(loaded2.internalizationStatus).toBe('internalized');
    });
  });

  // -------------------------------------------------------------------------
  // removePrincipleState
  // -------------------------------------------------------------------------

  describe('removePrincipleState', () => {
    it('removes an existing principle', () => {
      const state = createDefaultPrincipleState('T-01');
      setPrincipleState(stateDir, state);
      expect(getPrincipleState(stateDir, 'T-01').principleId).toBe('T-01');

      removePrincipleState(stateDir, 'T-01');
      // After removal, getPrincipleState returns a fresh default
      expect(getPrincipleState(stateDir, 'T-01').principleId).toBe('T-01');
      // But listPrincipleIds should be empty
      expect(listPrincipleIds(stateDir)).toEqual([]);
    });

    it('removePrincipleState is idempotent for unknown principles', () => {
      expect(() => removePrincipleState(stateDir, 'NONEXISTENT')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // listPrincipleIds
  // -------------------------------------------------------------------------

  describe('listPrincipleIds', () => {
    it('returns empty array when store is empty', () => {
      expect(listPrincipleIds(stateDir)).toEqual([]);
    });

    it('returns all principle IDs', () => {
      for (const id of ['T-01', 'T-05', 'P_foo', 'P_bar']) {
        setPrincipleState(stateDir, { ...createDefaultPrincipleState(id) });
      }
      const ids = listPrincipleIds(stateDir);
      expect(ids).toHaveLength(4);
      expect(ids).toContain('T-01');
      expect(ids).toContain('T-05');
      expect(ids).toContain('P_foo');
      expect(ids).toContain('P_bar');
    });
  });

  // -------------------------------------------------------------------------
  // listPrinciplesByStatus
  // -------------------------------------------------------------------------

  describe('listPrinciplesByStatus', () => {
    it('returns only principles with matching status', () => {
      const principles = [
        { id: 'T-01', status: 'prompt_only' as const },
        { id: 'T-02', status: 'needs_training' as const },
        { id: 'T-03', status: 'needs_training' as const },
        { id: 'T-04', status: 'internalized' as const },
      ];

      for (const { id, status } of principles) {
        const state = createDefaultPrincipleState(id);
        state.internalizationStatus = status;
        setPrincipleState(stateDir, state);
      }

      const needsTraining = listPrinciplesByStatus(stateDir, 'needs_training');
      expect(needsTraining).toHaveLength(2);
      expect(needsTraining.map((s) => s.principleId)).toContain('T-02');
      expect(needsTraining.map((s) => s.principleId)).toContain('T-03');

      const promptOnly = listPrinciplesByStatus(stateDir, 'prompt_only');
      expect(promptOnly).toHaveLength(1);
      expect(promptOnly[0].principleId).toBe('T-01');

      const internalized = listPrinciplesByStatus(stateDir, 'internalized');
      expect(internalized).toHaveLength(1);
      expect(internalized[0].principleId).toBe('T-04');
    });

    it('returns empty array when no principles match', () => {
      const state = createDefaultPrincipleState('T-01');
      state.internalizationStatus = 'prompt_only';
      setPrincipleState(stateDir, state);

      expect(listPrinciplesByStatus(stateDir, 'internalized')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // listEvaluablePrinciples
  // -------------------------------------------------------------------------

  describe('listEvaluablePrinciples', () => {
    it('excludes manual_only evaluability', () => {
      const state = createDefaultPrincipleState('T-01');
      state.evaluability = 'manual_only';
      state.internalizationStatus = 'needs_training';
      setPrincipleState(stateDir, state);

      expect(listEvaluablePrinciples(stateDir)).toEqual([]);
    });

    it('excludes prompt_only internalizationStatus (not yet trainable)', () => {
      const state = createDefaultPrincipleState('T-01');
      state.evaluability = 'deterministic';
      state.internalizationStatus = 'prompt_only';
      setPrincipleState(stateDir, state);

      expect(listEvaluablePrinciples(stateDir)).toEqual([]);
    });

    it('includes deterministic + needs_training', () => {
      const state = createDefaultPrincipleState('T-01');
      state.evaluability = 'deterministic';
      state.internalizationStatus = 'needs_training';
      setPrincipleState(stateDir, state);

      const evaluable = listEvaluablePrinciples(stateDir);
      expect(evaluable).toHaveLength(1);
      expect(evaluable[0].principleId).toBe('T-01');
    });

    it('includes weak_heuristic + deployed_pending_eval', () => {
      const state = createDefaultPrincipleState('P_foo');
      state.evaluability = 'weak_heuristic';
      state.internalizationStatus = 'deployed_pending_eval';
      setPrincipleState(stateDir, state);

      const evaluable = listEvaluablePrinciples(stateDir);
      expect(evaluable).toHaveLength(1);
      expect(evaluable[0].principleId).toBe('P_foo');
    });

    it('includes internalized principles (still eligible for retraining if regressed)', () => {
      const state = createDefaultPrincipleState('T-07');
      state.evaluability = 'deterministic';
      state.internalizationStatus = 'internalized';
      setPrincipleState(stateDir, state);

      const evaluable = listEvaluablePrinciples(stateDir);
      expect(evaluable).toHaveLength(1);
      expect(evaluable[0].principleId).toBe('T-07');
    });

    it('returns empty array for empty store', () => {
      expect(listEvaluablePrinciples(stateDir)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Async variants
  // -------------------------------------------------------------------------

  describe('loadStoreAsync / saveStoreAsync', () => {
    it('roundtrips through async save/load', async () => {
      const store = {
        'T-01': {
          principleId: 'T-01',
          evaluability: 'deterministic',
          applicableOpportunityCount: 15,
          observedViolationCount: 3,
          complianceRate: 0.8,
          violationTrend: -1,
          generatedSampleCount: 4,
          approvedSampleCount: 3,
          includedTrainRunIds: ['run-async-001'],
          deployedCheckpointIds: [],
          internalizationStatus: 'in_training',
        },
      };

      await saveStoreAsync(stateDir, store);
      const loaded = await loadStoreAsync(stateDir);

      expect(Object.keys(loaded)).toHaveLength(1);
      expect(loaded['T-01']).toEqual(store['T-01']);
    });

    it('loadStoreAsync returns empty store for missing file', async () => {
      const loaded = await loadStoreAsync(stateDir);
      expect(loaded).toEqual({});
    });

    it('loadStoreAsync returns empty store for corrupted file', async () => {
      fs.writeFileSync(path.join(stateDir, PRINCIPLE_TRAINING_FILE), 'not json{', 'utf-8');
      const loaded = await loadStoreAsync(stateDir);
      expect(loaded).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // File path constant
  // -------------------------------------------------------------------------

  describe('PRINCIPLE_TRAINING_FILE', () => {
    it('is a non-empty string', () => {
      expect(typeof PRINCIPLE_TRAINING_FILE).toBe('string');
      expect(PRINCIPLE_TRAINING_FILE.length).toBeGreaterThan(0);
    });
  });
});
