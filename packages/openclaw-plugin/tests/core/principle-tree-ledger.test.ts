import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TREE_NAMESPACE,
  createImplementation,
  createRule,
  getLedgerFilePath,
  getPrincipleSubtree,
  listImplementationsForRule,
  loadLedger,
  saveLedger,
} from '../../src/core/principle-tree-ledger.js';
import { createDefaultPrincipleState, type PrincipleTrainingStore } from '../../src/core/principle-training-state.js';
import type { Principle, PrincipleTreeStore, Rule } from '../../src/types/principle-tree-schema.js';
import { safeRmDir } from '../test-utils.js';

function createLedgerPrinciple(overrides: Partial<Principle> = {}): Principle {
  return {
    id: 'P-001',
    version: 1,
    text: 'Write before delete',
    triggerPattern: 'delete',
    action: 'write replacement content first',
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
    createdAt: '2026-04-07T00:00:00.000Z',
    updatedAt: '2026-04-07T00:00:00.000Z',
    ...overrides,
  };
}

function createLedgerRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'R-001',
    version: 1,
    name: 'Protect deletes',
    description: 'Require safe file replacement sequence',
    type: 'hook',
    triggerCondition: 'tool=delete',
    enforcement: 'warn',
    action: 'block unsafe delete',
    principleId: 'P-001',
    status: 'proposed',
    coverageRate: 0,
    falsePositiveRate: 0,
    implementationIds: [],
    createdAt: '2026-04-07T00:00:00.000Z',
    updatedAt: '2026-04-07T00:00:00.000Z',
    ...overrides,
  };
}

function createLegacyStore(): PrincipleTrainingStore {
  const state = createDefaultPrincipleState('P-001');
  state.evaluability = 'deterministic';
  state.internalizationStatus = 'needs_training';
  return {
    'P-001': state,
  };
}

function createEmptyTree(): PrincipleTreeStore {
  return {
    principles: {},
    rules: {},
    implementations: {},
    metrics: {},
    lastUpdated: '2026-04-07T00:00:00.000Z',
  };
}

describe('principle-tree-ledger', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tree-ledger-'));
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(tempDir);
  });

  it('persists rule records under the reserved _tree namespace without changing legacy top-level principles', () => {
    const ledger = loadLedger(stateDir);
    ledger.trainingStore = createLegacyStore();
    ledger.tree = createEmptyTree();
    ledger.tree.principles['P-001'] = createLedgerPrinciple();

    saveLedger(stateDir, ledger);

    const rule = createRule(stateDir, createLedgerRule());
    const raw = JSON.parse(fs.readFileSync(getLedgerFilePath(stateDir), 'utf-8')) as Record<string, unknown>;

    expect(rule.principleId).toBe('P-001');
    expect(Object.keys(raw)).toContain('P-001');
    expect(Object.keys(raw)).toContain(TREE_NAMESPACE);
    expect((raw[TREE_NAMESPACE] as { rules: Record<string, unknown> }).rules['R-001']).toBeDefined();
    expect(raw['P-001']).toMatchObject({
      principleId: 'P-001',
      internalizationStatus: 'needs_training',
    });
  });

  it('persists implementation records for one rule with multiple implementations, including non-code types', () => {
    saveLedger(stateDir, {
      trainingStore: createLegacyStore(),
      tree: {
        ...createEmptyTree(),
        principles: {
          'P-001': createLedgerPrinciple({ ruleIds: ['R-001'] }),
        },
        rules: {
          'R-001': createLedgerRule(),
        },
      },
    });

    createImplementation(stateDir, {
      id: 'IMPL-001',
      ruleId: 'R-001',
      type: 'skill',
      path: 'agents/write-before-delete',
      version: 'v1',
      coversCondition: 'delete protection',
      coveragePercentage: 60,
      createdAt: '2026-04-07T00:00:00.000Z',
      updatedAt: '2026-04-07T00:00:00.000Z',
    });
    createImplementation(stateDir, {
      id: 'IMPL-002',
      ruleId: 'R-001',
      type: 'test',
      path: 'tests/delete-safety.test.ts',
      version: 'abc1234',
      coversCondition: 'delete protection',
      coveragePercentage: 40,
      createdAt: '2026-04-07T00:00:01.000Z',
      updatedAt: '2026-04-07T00:00:01.000Z',
    });

    const implementations = listImplementationsForRule(stateDir, 'R-001');
    const saved = loadLedger(stateDir);

    expect(implementations.map((entry) => entry.id)).toEqual(['IMPL-001', 'IMPL-002']);
    expect(implementations.map((entry) => entry.type)).toEqual(['skill', 'test']);
    expect(saved.tree.rules['R-001']?.implementationIds).toEqual(['IMPL-001', 'IMPL-002']);
  });

  it('returns a Principle -> Rule -> Implementation subtree for direct ledger queries', () => {
    saveLedger(stateDir, {
      trainingStore: createLegacyStore(),
      tree: {
        ...createEmptyTree(),
        principles: {
          'P-001': createLedgerPrinciple({ ruleIds: ['R-001'] }),
        },
        rules: {
          'R-001': createLedgerRule({ implementationIds: ['IMPL-001', 'IMPL-002'] }),
        },
        implementations: {
          'IMPL-001': {
            id: 'IMPL-001',
            ruleId: 'R-001',
            type: 'prompt',
            path: 'prompts/write-before-delete.md',
            version: 'v1',
            coversCondition: 'delete protection',
            coveragePercentage: 70,
            createdAt: '2026-04-07T00:00:00.000Z',
            updatedAt: '2026-04-07T00:00:00.000Z',
          },
          'IMPL-002': {
            id: 'IMPL-002',
            ruleId: 'R-001',
            type: 'lora',
            path: 'models/write-before-delete',
            version: 'v3',
            coversCondition: 'delete protection',
            coveragePercentage: 30,
            createdAt: '2026-04-07T00:00:01.000Z',
            updatedAt: '2026-04-07T00:00:01.000Z',
          },
        },
      },
    });

    const subtree = getPrincipleSubtree(stateDir, 'P-001');

    expect(subtree?.principle.id).toBe('P-001');
    expect(subtree?.rules).toHaveLength(1);
    expect(subtree?.rules[0]?.rule.id).toBe('R-001');
    expect(subtree?.rules[0]?.implementations.map((entry) => entry.id)).toEqual(['IMPL-001', 'IMPL-002']);
    expect(subtree?.rules[0]?.implementations.map((entry) => entry.type)).toEqual(['prompt', 'lora']);
  });

  it('does not auto-backfill first-class rule entities from suggestedRules fields', () => {
    const principleWithSuggestedRules = createLedgerPrinciple({
      id: 'P-002',
      ruleIds: [],
      suggestedRules: ['warn before delete'],
    });

    saveLedger(stateDir, {
      trainingStore: {
        ...createLegacyStore(),
        'P-002': createDefaultPrincipleState('P-002'),
      },
      tree: {
        ...createEmptyTree(),
        principles: {
          'P-002': principleWithSuggestedRules,
        },
      },
    });

    const loaded = loadLedger(stateDir);

    expect(loaded.tree.principles['P-002']?.suggestedRules).toEqual(['warn before delete']);
    expect(loaded.tree.principles['P-002']?.ruleIds).toEqual([]);
    expect(loaded.tree.rules).toEqual({});
  });
});
