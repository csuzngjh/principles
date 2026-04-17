import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { calculateBaselines } from '../../src/core/observability.js';
import type { ObservabilityBaselines } from '../../src/core/observability.js';
import { loadLedger, saveLedger } from '../../src/core/principle-tree-ledger.js';
import type { HybridLedgerStore } from '../../src/core/principle-tree-ledger.js';
import { safeRmDir } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-observability-test-'));
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

function createTestPrinciple(id: string, status: string, priority: string) {
  return {
    id,
    version: 1,
    text: `Test principle ${id}`,
    triggerPattern: 'test',
    action: 'verify',
    status,
    priority,
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

function seedStore(stateDir: string, store: HybridLedgerStore): void {
  saveLedger(stateDir, store);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('calculateBaselines', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    seedStore(tmpDir, createEmptyStore());
  });

  afterEach(() => {
    safeRmDir(tmpDir);
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  it('returns zeros for empty store', () => {
    const baselines = calculateBaselines(tmpDir);

    expect(baselines.principleStock).toBe(0);
    expect(baselines.totalRules).toBe(0);
    expect(baselines.totalImplementations).toBe(0);
    expect(baselines.avgRulesPerPrinciple).toBe(0);
    expect(baselines.avgImplementationsPerRule).toBe(0);
    expect(baselines.totalPainEvents).toBe(0);
    expect(baselines.associationRate).toBe(0);
    expect(baselines.internalizedCount).toBe(0);
    expect(baselines.internalizationRate).toBe(0);
  });

  it('sets calculatedAt to current time', () => {
    const before = new Date().toISOString();
    const baselines = calculateBaselines(tmpDir);
    const after = new Date().toISOString();

    expect(baselines.calculatedAt >= before).toBe(true);
    expect(baselines.calculatedAt <= after).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Principle Stock
  // -------------------------------------------------------------------------

  it('counts all principles in the ledger', () => {
    const store = createEmptyStore();
    store.tree.principles['P-001'] = createTestPrinciple('P-001', 'active', 'P1');
    store.tree.principles['P-002'] = createTestPrinciple('P-002', 'candidate', 'P2');
    store.tree.principles['P-003'] = createTestPrinciple('P-003', 'deprecated', 'P1');
    seedStore(tmpDir, store);

    const baselines = calculateBaselines(tmpDir);
    expect(baselines.principleStock).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Structure
  // -------------------------------------------------------------------------

  it('calculates avgRulesPerPrinciple', () => {
    const store = createEmptyStore();
    store.tree.principles['P-001'] = {
      ...createTestPrinciple('P-001', 'active', 'P1'),
      ruleIds: ['R-001', 'R-002'],
    };
    store.tree.principles['P-002'] = {
      ...createTestPrinciple('P-002', 'active', 'P1'),
      ruleIds: ['R-003'],
    };
    store.tree.rules['R-001'] = { id: 'R-001', principleId: 'P-001', implementationIds: [] } as any;
    store.tree.rules['R-002'] = { id: 'R-002', principleId: 'P-001', implementationIds: [] } as any;
    store.tree.rules['R-003'] = { id: 'R-003', principleId: 'P-002', implementationIds: [] } as any;
    seedStore(tmpDir, store);

    const baselines = calculateBaselines(tmpDir);
    expect(baselines.totalRules).toBe(3);
    expect(baselines.avgRulesPerPrinciple).toBe(1.5); // 3 rules / 2 principles
  });

  it('calculates avgImplementationsPerRule', () => {
    const store = createEmptyStore();
    store.tree.principles['P-001'] = {
      ...createTestPrinciple('P-001', 'active', 'P1'),
      ruleIds: ['R-001'],
    };
    store.tree.rules['R-001'] = {
      id: 'R-001',
      principleId: 'P-001',
      implementationIds: ['I-001', 'I-002'],
    } as any;
    store.tree.implementations['I-001'] = { id: 'I-001', ruleId: 'R-001' } as any;
    store.tree.implementations['I-002'] = { id: 'I-002', ruleId: 'R-001' } as any;
    seedStore(tmpDir, store);

    const baselines = calculateBaselines(tmpDir);
    expect(baselines.totalImplementations).toBe(2);
    expect(baselines.avgImplementationsPerRule).toBe(2); // 2 impls / 1 rule
  });

  it('returns 0 for structure metrics when no principles exist', () => {
    seedStore(tmpDir, createEmptyStore());
    const baselines = calculateBaselines(tmpDir);

    expect(baselines.avgRulesPerPrinciple).toBe(0);
    expect(baselines.avgImplementationsPerRule).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Association Rate
  // -------------------------------------------------------------------------

  it('returns 0 association rate when no pain events exist', () => {
    const store = createEmptyStore();
    store.tree.principles['P-001'] = createTestPrinciple('P-001', 'active', 'P1');
    seedStore(tmpDir, store);

    const baselines = calculateBaselines(tmpDir);
    expect(baselines.totalPainEvents).toBe(0);
    expect(baselines.associationRate).toBe(0);
  });

  it('computes association rate as principles / pain events', () => {
    const store = createEmptyStore();
    store.tree.principles['P-001'] = createTestPrinciple('P-001', 'active', 'P1');
    store.tree.principles['P-002'] = createTestPrinciple('P-002', 'active', 'P2');
    seedStore(tmpDir, store);

    // Create a trajectory DB with pain events
    const dbPath = path.join(tmpDir, 'trajectory.db');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE pain_events (id TEXT PRIMARY KEY, created_at TEXT);
      INSERT INTO pain_events VALUES ('pe-1', '2026-04-17T00:00:00Z');
      INSERT INTO pain_events VALUES ('pe-2', '2026-04-17T00:01:00Z');
      INSERT INTO pain_events VALUES ('pe-3', '2026-04-17T00:02:00Z');
      INSERT INTO pain_events VALUES ('pe-4', '2026-04-17T00:03:00Z');
    `);
    db.close();

    const baselines = calculateBaselines(tmpDir);
    expect(baselines.totalPainEvents).toBe(4);
    expect(baselines.associationRate).toBe(0.5); // 2 principles / 4 pain events
  });

  // -------------------------------------------------------------------------
  // Internalization Rate
  // -------------------------------------------------------------------------

  it('computes internalization rate from training store', () => {
    const store = createEmptyStore();
    store.tree.principles['P-001'] = createTestPrinciple('P-001', 'active', 'P1');
    store.tree.principles['P-002'] = createTestPrinciple('P-002', 'active', 'P2');
    store.tree.principles['P-003'] = createTestPrinciple('P-003', 'candidate', 'P2');
    store.trainingStore['P-001'] = {
      principleId: 'P-001',
      evaluability: 'deterministic',
      applicableOpportunityCount: 10,
      observedViolationCount: 0,
      complianceRate: 1.0,
      violationTrend: 0,
      generatedSampleCount: 5,
      approvedSampleCount: 5,
      includedTrainRunIds: ['run-1'],
      deployedCheckpointIds: ['ckpt-1'],
      internalizationStatus: 'internalized',
    };
    store.trainingStore['P-002'] = {
      principleId: 'P-002',
      evaluability: 'weak_heuristic',
      applicableOpportunityCount: 3,
      observedViolationCount: 1,
      complianceRate: 0.67,
      violationTrend: 0,
      generatedSampleCount: 0,
      approvedSampleCount: 0,
      includedTrainRunIds: [],
      deployedCheckpointIds: [],
      internalizationStatus: 'in_training',
    };
    seedStore(tmpDir, store);

    const baselines = calculateBaselines(tmpDir);
    expect(baselines.internalizedCount).toBe(1);
    // 1 internalized / 3 total principles = 0.333
    expect(baselines.internalizationRate).toBeGreaterThan(0.33);
    expect(baselines.internalizationRate).toBeLessThanOrEqual(0.334);
  });

  it('returns 0 internalization rate when no principles are internalized', () => {
    const store = createEmptyStore();
    store.tree.principles['P-001'] = createTestPrinciple('P-001', 'active', 'P1');
    store.trainingStore['P-001'] = {
      principleId: 'P-001',
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
    seedStore(tmpDir, store);

    const baselines = calculateBaselines(tmpDir);
    expect(baselines.internalizedCount).toBe(0);
    expect(baselines.internalizationRate).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Distributions
  // -------------------------------------------------------------------------

  it('computes status distribution', () => {
    const store = createEmptyStore();
    store.tree.principles['P-001'] = createTestPrinciple('P-001', 'active', 'P1');
    store.tree.principles['P-002'] = createTestPrinciple('P-002', 'active', 'P2');
    store.tree.principles['P-003'] = createTestPrinciple('P-003', 'candidate', 'P1');
    store.tree.principles['P-004'] = createTestPrinciple('P-004', 'deprecated', 'P2');
    seedStore(tmpDir, store);

    const baselines = calculateBaselines(tmpDir);
    expect(baselines.statusDistribution.active).toBe(2);
    expect(baselines.statusDistribution.candidate).toBe(1);
    expect(baselines.statusDistribution.deprecated).toBe(1);
  });

  it('computes priority distribution', () => {
    const store = createEmptyStore();
    store.tree.principles['P-001'] = createTestPrinciple('P-001', 'active', 'P0');
    store.tree.principles['P-002'] = createTestPrinciple('P-002', 'active', 'P1');
    store.tree.principles['P-003'] = createTestPrinciple('P-003', 'active', 'P1');
    store.tree.principles['P-004'] = createTestPrinciple('P-004', 'active', 'P2');
    seedStore(tmpDir, store);

    const baselines = calculateBaselines(tmpDir);
    expect(baselines.priorityDistribution.P0).toBe(1);
    expect(baselines.priorityDistribution.P1).toBe(2);
    expect(baselines.priorityDistribution.P2).toBe(1);
  });

  it('computes internalization distribution', () => {
    const store = createEmptyStore();
    store.trainingStore['p-1'] = {
      principleId: 'p-1',
      evaluability: 'deterministic',
      applicableOpportunityCount: 5,
      observedViolationCount: 0,
      complianceRate: 1.0,
      violationTrend: 0,
      generatedSampleCount: 3,
      approvedSampleCount: 3,
      includedTrainRunIds: [],
      deployedCheckpointIds: [],
      internalizationStatus: 'internalized',
    };
    store.trainingStore['p-2'] = {
      principleId: 'p-2',
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
    seedStore(tmpDir, store);

    const baselines = calculateBaselines(tmpDir);
    expect(baselines.internalizationDistribution.internalized).toBe(1);
    expect(baselines.internalizationDistribution.prompt_only).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  it('persists baselines to .state/baselines.json', () => {
    calculateBaselines(tmpDir);

    const baselinesPath = path.join(tmpDir, 'baselines.json');
    expect(fs.existsSync(baselinesPath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(baselinesPath, 'utf8')) as ObservabilityBaselines;
    expect(raw.principleStock).toBe(0);
    expect(raw.calculatedAt).toBeDefined();
  });

  it('overwrites previous baselines on recalculation', () => {
    // First calculation with empty store
    calculateBaselines(tmpDir);

    // Add a principle
    const store = createEmptyStore();
    store.tree.principles['P-001'] = createTestPrinciple('P-001', 'active', 'P1');
    seedStore(tmpDir, store);

    // Second calculation
    calculateBaselines(tmpDir);

    const baselinesPath = path.join(tmpDir, 'baselines.json');
    const raw = JSON.parse(fs.readFileSync(baselinesPath, 'utf8')) as ObservabilityBaselines;
    expect(raw.principleStock).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('handles missing state directory gracefully', () => {
    const missingDir = path.join(tmpDir, 'nonexistent');
    // loadLedger handles missing dirs by returning empty store
    const baselines = calculateBaselines(missingDir);
    expect(baselines.principleStock).toBe(0);
  });
});
