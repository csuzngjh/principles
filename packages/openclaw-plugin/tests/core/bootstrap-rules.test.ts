/**
 * Bootstrap Rules Tests (Phase 17)
 *
 * TDD test suite for minimal rule bootstrap functionality.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeRmDir } from '../test-utils.js';
import {
  bootstrapRules,
  selectPrinciplesForBootstrap,
  validateBootstrap,
} from '../../src/core/bootstrap-rules.js';
import {
  createRule,
  loadLedger,
  saveLedger,
  type HybridLedgerStore,
  type LedgerPrinciple,
  type LedgerRule,
} from '../../src/core/principle-tree-ledger.js';
import type { LegacyPrincipleTrainingStore, LegacyPrincipleTrainingState } from '../../src/core/principle-tree-ledger.js';

describe('bootstrap-rules', () => {
  let tempDir: string;
  let stateDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(process.env.TMP || '/tmp', 'pd-bootstrap-'));
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterAll(() => {
    safeRmDir(tempDir);
  });

  afterEach(() => {
    // Clean up state file after each test
    const stateFile = path.join(stateDir, 'principle_training_state.json');
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  });

  // Helper: Create a minimal ledger principle
  function createLedgerPrinciple(principleId: string, overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
    return {
      id: principleId,
      version: 1,
      text: `Test principle ${principleId}`,
      triggerPattern: 'test',
      action: 'test action',
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
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
      ...overrides,
    };
  }

  // Helper: Setup ledger with training store and principles
  function setupLedger(trainingStates: LegacyPrincipleTrainingState[], principles: LedgerPrinciple[]): void {
    const trainingStore: LegacyPrincipleTrainingStore = {};
    for (const state of trainingStates) {
      trainingStore[state.principleId] = state;
    }

    const tree = {
      principles: {} as Record<string, LedgerPrinciple>,
      rules: {} as Record<string, LedgerRule>,
      implementations: {},
      metrics: {},
      lastUpdated: new Date().toISOString(),
    };

    for (const principle of principles) {
      tree.principles[principle.id] = principle;
    }

    const store: HybridLedgerStore = {
      trainingStore,
      tree,
    };

    saveLedger(stateDir, store);
  }

  describe('selectPrinciplesForBootstrap', () => {
    it('selects deterministic principles sorted by violation count', () => {
      // Setup: 4 principles (3 deterministic with violations 10, 5, 1; 1 manual_only with 100)
      const trainingStates: LegacyPrincipleTrainingState[] = [
        {
          principleId: 'P_001',
          evaluability: 'deterministic',
          applicableOpportunityCount: 20,
          observedViolationCount: 10,
          complianceRate: 0.5,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_002',
          evaluability: 'deterministic',
          applicableOpportunityCount: 15,
          observedViolationCount: 5,
          complianceRate: 0.6,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_003',
          evaluability: 'deterministic',
          applicableOpportunityCount: 10,
          observedViolationCount: 1,
          complianceRate: 0.7,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_004',
          evaluability: 'manual_only',
          applicableOpportunityCount: 100,
          observedViolationCount: 100,
          complianceRate: 0.5,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      ];

      const principles = trainingStates.map((s) => createLedgerPrinciple(s.principleId, { evaluability: s.evaluability }));
      setupLedger(trainingStates, principles);

      // Act: Select top 2
      const selected = selectPrinciplesForBootstrap(stateDir, 2);

      // Assert: Should get P_001 (10 violations) and P_002 (5 violations)
      expect(selected).toHaveLength(2);
      expect(selected).toContain('P_001');
      expect(selected).toContain('P_002');
      expect(selected).not.toContain('P_003'); // Only 1 violation, not in top 2
      expect(selected).not.toContain('P_004'); // manual_only, excluded
    });

    it('falls back to all deterministic when violation data is sparse', () => {
      // Setup: 2 deterministic principles with 0 violations
      const trainingStates: LegacyPrincipleTrainingState[] = [
        {
          principleId: 'P_001',
          evaluability: 'deterministic',
          applicableOpportunityCount: 0,
          observedViolationCount: 0,
          complianceRate: 1,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_002',
          evaluability: 'deterministic',
          applicableOpportunityCount: 0,
          observedViolationCount: 0,
          complianceRate: 1,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      ];

      const principles = trainingStates.map((s) => createLedgerPrinciple(s.principleId));
      setupLedger(trainingStates, principles);

      // Act: Select up to 3
      const selected = selectPrinciplesForBootstrap(stateDir, 3);

      // Assert: Both deterministic principles returned
      expect(selected).toHaveLength(2);
      expect(selected).toContain('P_001');
      expect(selected).toContain('P_002');
    });

    it('throws when no deterministic principles exist', () => {
      // Setup: Only manual_only principles
      const trainingStates: LegacyPrincipleTrainingState[] = [
        {
          principleId: 'P_001',
          evaluability: 'manual_only',
          applicableOpportunityCount: 10,
          observedViolationCount: 5,
          complianceRate: 0.5,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      ];

      const principles = trainingStates.map((s) => createLedgerPrinciple(s.principleId, { evaluability: s.evaluability }));
      setupLedger(trainingStates, principles);

      // Act & Assert: Should throw
      expect(() => selectPrinciplesForBootstrap(stateDir, 3)).toThrow('No deterministic principles');
    });
  });

  describe('bootstrapRules', () => {
    it('creates stub rules with correct ID format and fields', () => {
      // Setup: 2 deterministic principles
      const trainingStates: LegacyPrincipleTrainingState[] = [
        {
          principleId: 'P_001',
          evaluability: 'deterministic',
          applicableOpportunityCount: 10,
          observedViolationCount: 5,
          complianceRate: 0.5,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_002',
          evaluability: 'deterministic',
          applicableOpportunityCount: 8,
          observedViolationCount: 3,
          complianceRate: 0.6,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      ];

      const principles = trainingStates.map((s) => createLedgerPrinciple(s.principleId));
      setupLedger(trainingStates, principles);

      // Act: Bootstrap 2 principles
      const results = bootstrapRules(stateDir, 2);

      // Assert: Check results
      expect(results).toHaveLength(2);

      const ledger = loadLedger(stateDir);

      for (const result of results) {
        expect(result.status).toBe('created');
        expect(result.ruleId).toBe(`${result.principleId}_stub_bootstrap`);

        const rule = ledger.tree.rules[result.ruleId];
        expect(rule).toBeDefined();
        expect(rule?.id).toBe(result.ruleId);
        expect(rule?.type).toBe('hook');
        expect(rule?.triggerCondition).toBe('stub: bootstrap placeholder');
        expect(rule?.enforcement).toBe('warn');
        expect(rule?.action).toBe('allow (stub)');
        expect(rule?.status).toBe('proposed');
        expect(rule?.coverageRate).toBe(0);
        expect(rule?.falsePositiveRate).toBe(0);
        expect(rule?.principleId).toBe(result.principleId);
      }
    });

    it('links principles to rules via suggestedRules array', () => {
      // Setup: 2 deterministic principles
      const trainingStates: LegacyPrincipleTrainingState[] = [
        {
          principleId: 'P_001',
          evaluability: 'deterministic',
          applicableOpportunityCount: 10,
          observedViolationCount: 5,
          complianceRate: 0.5,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_002',
          evaluability: 'deterministic',
          applicableOpportunityCount: 8,
          observedViolationCount: 3,
          complianceRate: 0.6,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      ];

      const principles = trainingStates.map((s) => createLedgerPrinciple(s.principleId));
      setupLedger(trainingStates, principles);

      // Act: Bootstrap
      const results = bootstrapRules(stateDir, 2);

      // Assert: Check suggestedRules linkage
      const ledger = loadLedger(stateDir);

      for (const result of results) {
        const principle = ledger.tree.principles[result.principleId];
        expect(principle).toBeDefined();
        expect(principle?.suggestedRules).toContain(result.ruleId);
      }
    });

    it('is idempotent - second run skips existing rules', () => {
      // Setup: 2 deterministic principles
      const trainingStates: LegacyPrincipleTrainingState[] = [
        {
          principleId: 'P_001',
          evaluability: 'deterministic',
          applicableOpportunityCount: 10,
          observedViolationCount: 5,
          complianceRate: 0.5,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_002',
          evaluability: 'deterministic',
          applicableOpportunityCount: 8,
          observedViolationCount: 3,
          complianceRate: 0.6,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      ];

      const principles = trainingStates.map((s) => createLedgerPrinciple(s.principleId));
      setupLedger(trainingStates, principles);

      // Act: First bootstrap
      const firstResults = bootstrapRules(stateDir, 2);
      expect(firstResults.every((r) => r.status === 'created')).toBe(true);

      // Act: Second bootstrap
      const secondResults = bootstrapRules(stateDir, 2);

      // Assert: All skipped
      expect(secondResults).toHaveLength(2);
      expect(secondResults.every((r) => r.status === 'skipped')).toBe(true);

      // Verify ledger unchanged
      const ledger = loadLedger(stateDir);
      expect(Object.keys(ledger.tree.rules)).toHaveLength(2);
    });

    it('limits bootstrap to requested count', () => {
      // Setup: 5 deterministic principles
      const trainingStates: LegacyPrincipleTrainingState[] = [
        {
          principleId: 'P_001',
          evaluability: 'deterministic',
          applicableOpportunityCount: 20,
          observedViolationCount: 10,
          complianceRate: 0.5,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_002',
          evaluability: 'deterministic',
          applicableOpportunityCount: 15,
          observedViolationCount: 8,
          complianceRate: 0.6,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_003',
          evaluability: 'deterministic',
          applicableOpportunityCount: 12,
          observedViolationCount: 6,
          complianceRate: 0.7,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_004',
          evaluability: 'deterministic',
          applicableOpportunityCount: 10,
          observedViolationCount: 4,
          complianceRate: 0.8,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
        {
          principleId: 'P_005',
          evaluability: 'deterministic',
          applicableOpportunityCount: 5,
          observedViolationCount: 2,
          complianceRate: 0.9,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      ];

      const principles = trainingStates.map((s) => createLedgerPrinciple(s.principleId));
      setupLedger(trainingStates, principles);

      // Act: Bootstrap only 3
      const results = bootstrapRules(stateDir, 3);

      // Assert: Only 3 rules created
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.status === 'created')).toBe(true);

      // Verify only top 3 by violation count
      const ledger = loadLedger(stateDir);
      expect(Object.keys(ledger.tree.rules)).toHaveLength(3);
      expect(ledger.tree.rules['P_001_stub_bootstrap']).toBeDefined();
      expect(ledger.tree.rules['P_002_stub_bootstrap']).toBeDefined();
      expect(ledger.tree.rules['P_003_stub_bootstrap']).toBeDefined();
      expect(ledger.tree.rules['P_004_stub_bootstrap']).toBeUndefined();
      expect(ledger.tree.rules['P_005_stub_bootstrap']).toBeUndefined();
    });

    it('throws when no deterministic principles exist', () => {
      // Setup: Only manual_only principles
      const trainingStates: LegacyPrincipleTrainingState[] = [
        {
          principleId: 'P_001',
          evaluability: 'manual_only',
          applicableOpportunityCount: 10,
          observedViolationCount: 5,
          complianceRate: 0.5,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      ];

      const principles = trainingStates.map((s) => createLedgerPrinciple(s.principleId, { evaluability: s.evaluability }));
      setupLedger(trainingStates, principles);

      // Act & Assert: Should throw
      expect(() => bootstrapRules(stateDir, 3)).toThrow('No deterministic principles');
    });
  });

  describe('validateBootstrap', () => {
    it('returns true for correctly bootstrapped state', () => {
      // Setup: Bootstrap 1 principle
      const trainingStates: LegacyPrincipleTrainingState[] = [
        {
          principleId: 'P_001',
          evaluability: 'deterministic',
          applicableOpportunityCount: 10,
          observedViolationCount: 5,
          complianceRate: 0.5,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      ];

      const principles = trainingStates.map((s) => createLedgerPrinciple(s.principleId));
      setupLedger(trainingStates, principles);

      const results = bootstrapRules(stateDir, 1);
      const bootstrappedIds = results.map((r) => r.principleId);

      // Act: Validate
      const valid = validateBootstrap(stateDir, bootstrappedIds);

      // Assert: Should pass
      expect(valid).toBe(true);
    });

    it('throws when suggestedRules is empty', () => {
      // Setup: Bootstrap 1 principle
      const trainingStates: LegacyPrincipleTrainingState[] = [
        {
          principleId: 'P_001',
          evaluability: 'deterministic',
          applicableOpportunityCount: 10,
          observedViolationCount: 5,
          complianceRate: 0.5,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'prompt_only',
        },
      ];

      const principles = trainingStates.map((s) => createLedgerPrinciple(s.principleId));
      setupLedger(trainingStates, principles);

      const results = bootstrapRules(stateDir, 1);
      const bootstrappedIds = results.map((r) => r.principleId);

      // Manually clear suggestedRules
      const ledger = loadLedger(stateDir);
      const principle = ledger.tree.principles[bootstrappedIds[0]];
      if (principle) {
        principle.suggestedRules = [];
        saveLedger(stateDir, ledger);
      }

      // Act & Assert: Should throw
      expect(() => validateBootstrap(stateDir, bootstrappedIds)).toThrow();
    });
  });
});
