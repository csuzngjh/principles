/**
 * Ledger Registrar Tests (Task 4)
 *
 * TDD test suite for registerCompiledRule — creates a gate rule + code
 * implementation in the principle tree ledger for a compiled principle.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { safeRmDir } from '../test-utils.js';
import {
  loadLedger,
  saveLedger,
  type HybridLedgerStore,
  type LedgerPrinciple,
  type LedgerRule,
} from '../../src/core/principle-tree-ledger.js';
import { registerCompiledRule, type RegisterInput, type RegisterResult } from '../../src/core/principle-compiler/ledger-registrar.js';

describe('ledger-registrar', () => {
  let tempDir: string;
  let stateDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(process.env.TMP || '/tmp', 'pd-registrar-'));
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterAll(() => {
    safeRmDir(tempDir);
  });

  afterEach(() => {
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

  // Helper: Setup ledger with a single principle
  function setupLedgerWithPrinciple(principleId: string): void {
    const tree = {
      principles: {} as Record<string, LedgerPrinciple>,
      rules: {} as Record<string, LedgerRule>,
      implementations: {},
      metrics: {},
      lastUpdated: new Date().toISOString(),
    };

    tree.principles[principleId] = createLedgerPrinciple(principleId);

    const store: HybridLedgerStore = {
      trainingStore: {},
      tree,
    };

    saveLedger(stateDir, store);
  }

  describe('registerCompiledRule', () => {
    it('creates a gate rule and code implementation in the ledger', () => {
      setupLedgerWithPrinciple('P_001');

      const input: RegisterInput = {
        principleId: 'P_001',
        codeContent: 'export function check() { return true; }',
        coversCondition: 'file_write',
      };

      const result = registerCompiledRule(stateDir, input);

      // Verify result structure
      expect(result.success).toBe(true);
      expect(result.ruleId).toBe('R_P_001_auto');
      expect(result.implementationId).toBe('IMPL_P_001_auto');

      // Verify rule in ledger
      const ledger = loadLedger(stateDir);
      const rule = ledger.tree.rules['R_P_001_auto'];
      expect(rule).toBeDefined();
      expect(rule.id).toBe('R_P_001_auto');
      expect(rule.type).toBe('gate');
      expect(rule.enforcement).toBe('block');
      expect(rule.status).toBe('proposed');
      expect(rule.principleId).toBe('P_001');
      expect(rule.implementationIds).toContain('IMPL_P_001_auto');

      // Verify implementation in ledger
      const impl = ledger.tree.implementations['IMPL_P_001_auto'];
      expect(impl).toBeDefined();
      expect(impl.id).toBe('IMPL_P_001_auto');
      expect(impl.ruleId).toBe('R_P_001_auto');
      expect(impl.type).toBe('code');
      expect(impl.coversCondition).toBe('file_write');
      expect(impl.lifecycleState).toBe('candidate');

      // Verify principle linked to rule
      const principle = ledger.tree.principles['P_001'];
      expect(principle.ruleIds).toContain('R_P_001_auto');
    });

    it('returns the codePath in the result', () => {
      setupLedgerWithPrinciple('P_042');

      const input: RegisterInput = {
        principleId: 'P_042',
        codeContent: '// some code',
        coversCondition: 'git_push',
      };

      const result = registerCompiledRule(stateDir, input);

      expect(result.success).toBe(true);
      expect(result.codePath).toContain('P_042');
      expect(result.codePath).toMatch(/\.ts$/);
    });

    it('throws if the principle does not exist', () => {
      // Empty ledger — no principles
      const store: HybridLedgerStore = {
        trainingStore: {},
        tree: {
          principles: {},
          rules: {},
          implementations: {},
          metrics: {},
          lastUpdated: new Date().toISOString(),
        },
      };
      saveLedger(stateDir, store);

      const input: RegisterInput = {
        principleId: 'P_NONEXISTENT',
        codeContent: 'export function check() { return true; }',
        coversCondition: 'test',
      };

      expect(() => registerCompiledRule(stateDir, input)).toThrow(/missing principle.*P_NONEXISTENT/);
    });

    it('sets correct timestamps on rule and implementation', () => {
      setupLedgerWithPrinciple('P_100');

      const before = new Date().toISOString();
      const input: RegisterInput = {
        principleId: 'P_100',
        codeContent: 'export const x = 1;',
        coversCondition: 'test_condition',
      };

      const result = registerCompiledRule(stateDir, input);
      const after = new Date().toISOString();

      expect(result.success).toBe(true);

      const ledger = loadLedger(stateDir);
      const rule = ledger.tree.rules['R_P_100_auto'];
      const impl = ledger.tree.implementations['IMPL_P_100_auto'];

      // Timestamps should be between before and after
      expect(rule.createdAt >= before).toBe(true);
      expect(rule.createdAt <= after).toBe(true);
      expect(rule.updatedAt).toBe(rule.createdAt);

      expect(impl.createdAt >= before).toBe(true);
      expect(impl.createdAt <= after).toBe(true);
      expect(impl.updatedAt).toBe(impl.createdAt);
    });

    it('handles multiple registrations for different principles', () => {
      // Setup ledger with two principles
      const tree = {
        principles: {} as Record<string, LedgerPrinciple>,
        rules: {} as Record<string, LedgerRule>,
        implementations: {},
        metrics: {},
        lastUpdated: new Date().toISOString(),
      };
      tree.principles['P_001'] = createLedgerPrinciple('P_001');
      tree.principles['P_002'] = createLedgerPrinciple('P_002');

      const store: HybridLedgerStore = { trainingStore: {}, tree };
      saveLedger(stateDir, store);

      const result1 = registerCompiledRule(stateDir, {
        principleId: 'P_001',
        codeContent: '// code 1',
        coversCondition: 'cond_1',
      });
      const result2 = registerCompiledRule(stateDir, {
        principleId: 'P_002',
        codeContent: '// code 2',
        coversCondition: 'cond_2',
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.ruleId).toBe('R_P_001_auto');
      expect(result2.ruleId).toBe('R_P_002_auto');

      const ledger = loadLedger(stateDir);
      expect(Object.keys(ledger.tree.rules)).toHaveLength(2);
      expect(Object.keys(ledger.tree.implementations)).toHaveLength(2);
    });
  });
});
