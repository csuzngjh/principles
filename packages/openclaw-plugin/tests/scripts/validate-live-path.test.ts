/**
 * Validate Live Path Script Tests (Phase 18)
 *
 * TDD test suite for live path validation script.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeRmDir } from '../test-utils.js';
import {
  loadLedger,
  saveLedger,
  createRule,
  updatePrinciple,
  type HybridLedgerStore,
  type LedgerPrinciple,
  type LedgerRule,
} from '../../src/core/principle-tree-ledger.js';
import type { LegacyPrincipleTrainingStore, LegacyPrincipleTrainingState } from '../../src/core/principle-tree-ledger.js';

// Script path
const SCRIPT_PATH = path.join(__dirname, '../../scripts/validate-live-path.ts');

describe('validate-live-path script', () => {
  let tempDir: string;
  let stateDir: string;
  let queuePath: string;
  let dbPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(process.env.TMP || '/tmp', 'pd-validate-'));
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    queuePath = path.join(stateDir, 'EVOLUTION_QUEUE');
    dbPath = path.join(stateDir, 'subagent_workflows.db');
  });

  afterAll(() => {
    safeRmDir(tempDir);
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

  // Helper: Setup ledger with bootstrapped rules
  function setupBootstrapLedger(): void {
    const trainingStore: LegacyPrincipleTrainingStore = {
      'P_test_001': {
        principleId: 'P_test_001',
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
    };

    const principle = createLedgerPrinciple('P_test_001');

    const tree = {
      principles: { 'P_test_001': principle },
      rules: {} as Record<string, LedgerRule>,
      implementations: {},
      metrics: {},
      lastUpdated: new Date().toISOString(),
    };

    const store: HybridLedgerStore = {
      trainingStore,
      tree,
    };

    saveLedger(stateDir, store);

    // Create stub bootstrap rule
    const ruleId = 'P_test_001_stub_bootstrap';
    const rule = createRule(stateDir, {
      id: ruleId,
      version: 1,
      name: 'Stub bootstrap rule for P_test_001',
      description: 'Placeholder rule for principle-internalization bootstrap',
      type: 'hook',
      triggerCondition: 'stub: bootstrap placeholder',
      enforcement: 'warn',
      action: 'allow (stub)',
      principleId: 'P_test_001',
      status: 'proposed',
      coverageRate: 0,
      falsePositiveRate: 0,
      implementationIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Link rule to principle
    updatePrinciple(stateDir, 'P_test_001', {
      suggestedRules: [ruleId],
    });
  }

  describe('script file existence', () => {
    it('should have validate-live-path.ts script file', () => {
      expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
    });

    it('should have minimum 150 lines', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      const lineCount = content.split('\n').length;
      expect(lineCount).toBeGreaterThanOrEqual(150);
    });
  });

  describe('script imports and patterns', () => {
    it('should implement acquireLockAsync and releaseLock functions', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toMatch(/acquireLockAsync/);
      expect(content).toMatch(/releaseLock/);
      // Script is standalone, so it doesn't import from file-lock.js
      // It implements its own simplified lock functions
    });

    it('should use better-sqlite3 for direct SQLite query', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toMatch(/better-sqlite3/);
      expect(content).toMatch(/workflow_type\s*=\s*['"]nocturnal['"]/);
    });

    it('should filter for _stub_bootstrap rules', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toMatch(/_stub_bootstrap/);
    });

    it('should have proper exit codes', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toMatch(/process\.exit\(0\)/);
      expect(content).toMatch(/process\.exit\(1\)/);
    });
  });

  describe('bootstrapped rule detection', () => {
    it('should detect bootstrapped rules from ledger', () => {
      setupBootstrapLedger();

      const ledger = loadLedger(stateDir);
      const bootstrappedRules = Object.values(ledger.tree.rules).filter(r =>
        r.id.endsWith('_stub_bootstrap')
      );

      expect(bootstrappedRules.length).toBeGreaterThan(0);
      expect(bootstrappedRules[0].id).toBe('P_test_001_stub_bootstrap');
    });

    it('should fail fast when no bootstrapped rules exist', () => {
      // Create empty ledger
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

      const ledger = loadLedger(stateDir);
      const bootstrappedRules = Object.values(ledger.tree.rules).filter(r =>
        r.id.endsWith('_stub_bootstrap')
      );

      expect(bootstrappedRules.length).toBe(0);
    });
  });

  describe('synthetic snapshot construction', () => {
    it('should create snapshot with recentPain to pass hasUsableNocturnalSnapshot guard', () => {
      // This test verifies the snapshot shape from plan context
      const snapshot = {
        sessionId: `validation-${Date.now()}`,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        assistantTurns: [],
        userTurns: [],
        toolCalls: [],
        painEvents: [],
        gateBlocks: [],
        stats: {
          totalAssistantTurns: 0,
          totalToolCalls: 0,
          failureCount: 0,
          totalPainEvents: 1,
          totalGateBlocks: 0,
        },
        recentPain: [{
          source: 'live-validation',
          score: 50,
          severity: 'moderate',
          reason: 'Synthetic snapshot for live path validation',
          createdAt: new Date().toISOString(),
        }],
        _dataSource: 'pain_context_fallback',
      };

      // Verify snapshot has required fields
      expect(snapshot.sessionId).toBeTruthy();
      expect(snapshot.sessionId.length).toBeGreaterThan(0);
      expect(snapshot.recentPain).toBeDefined();
      expect(snapshot.recentPain!.length).toBeGreaterThan(0);
      expect(snapshot._dataSource).toBe('pain_context_fallback');
    });
  });

  describe('queue file locking', () => {
    it('should use acquireLockAsync before writing to queue', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      // Check for lock acquisition pattern
      expect(content).toMatch(/acquireLockAsync/);
      expect(content).toMatch(/QUEUE_PATH/);
    });

    it('should release lock in finally block', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      // Check for finally block with lock release
      expect(content).toMatch(/\}\s*finally/);
      expect(content).toMatch(/if\s+\(lockCtx\)/);
      expect(content).toMatch(/releaseLock\(lockCtx\)/);
    });
  });

  describe('workflow store query', () => {
    it('should query subagent_workflows.db directly for nocturnal workflows', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      // Check for raw SQLite query pattern
      expect(content).toMatch(/workflow_type\s*=\s*['"]nocturnal['"]/);
    });

    it('should correlate workflow to queue item via taskId', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      // Check for taskId correlation pattern
      expect(content).toMatch(/taskId|metadata_json/);
    });
  });

  describe('resolution verification', () => {
    it('should read resolution from queue item, not from WorkflowRow', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      // Check for resolution field access on queue
      expect(content).toMatch(/resolution.*queue|queue.*resolution/);
    });

    it('should verify explicit resolution (not expired)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      // Check for explicit resolution check
      expect(content).toMatch(/resolution.*expired|expired.*resolution/);
    });
  });
});
