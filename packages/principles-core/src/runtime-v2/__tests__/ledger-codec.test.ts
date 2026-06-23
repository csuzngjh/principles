/**
 * PRI-443: Ledger codec — pure parse/serialize functions, zero I/O.
 *
 * Tests verify:
 * 1. parseHybridLedger correctly parses a valid ledger JSON
 * 2. parseHybridLedger handles missing/malformed data gracefully
 * 3. serializeLedger produces correct JSON output
 * 4. createEmptyTree returns a valid empty tree
 * 5. The module has zero fs/path imports
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  parseHybridLedger,
  serializeLedger,
  createEmptyTree,
  isRecord,
  stringArray,
  clampFloat,
  clampInt,
  uniqueStrings,
} from '../principle-tree/ledger-codec.js';

import type { HybridLedgerStore } from '../types/ledger-store.js';

describe('PRI-443: ledger-codec.ts pure parse/serialize module', () => {
  it('createEmptyTree returns valid empty tree', () => {
    const tree = createEmptyTree();
    expect(tree.principles).toEqual({});
    expect(tree.rules).toEqual({});
    expect(tree.implementations).toEqual({});
    expect(tree.metrics).toEqual({});
    expect(tree.lastUpdated).toBe(new Date(0).toISOString());
  });

  it('parseHybridLedger parses valid hybrid ledger', () => {
    const raw = {
      trainingStore: {
        'pri-001': {
          principleId: 'pri-001',
          evaluability: 'manual_only',
          applicableOpportunityCount: 5,
          observedViolationCount: 2,
          complianceRate: 0.6,
          violationTrend: 0.1,
          generatedSampleCount: 3,
          approvedSampleCount: 1,
          includedTrainRunIds: ['run-1'],
          deployedCheckpointIds: ['ckpt-1'],
          internalizationStatus: 'prompt_only',
        },
      },
      _tree: {
        principles: {
          'pri-001': {
            id: 'pri-001',
            version: 1,
            text: 'Test',
            triggerPattern: 'test',
            action: 'test',
            status: 'active',
            priority: 'P0',
            scope: 'general',
            evaluability: 'manual_only',
            valueScore: 0.5,
            adherenceRate: 0.8,
            painPreventedCount: 0,
            derivedFromPainIds: [],
            ruleIds: [],
            conflictsWithPrincipleIds: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: '2026-01-01T00:00:00Z',
      },
    };

    const result = parseHybridLedger(raw);
    expect(result.trainingStore['pri-001']).toBeDefined();
    expect(result.trainingStore['pri-001']?.evaluability).toBe('manual_only');
    expect(result.tree.principles['pri-001']?.id).toBe('pri-001');
  });

  it('parseHybridLedger handles null input', () => {
    const result = parseHybridLedger(null);
    expect(result.trainingStore).toEqual({});
    expect(result.tree.principles).toEqual({});
  });

  it('parseHybridLedger handles non-object input', () => {
    const result = parseHybridLedger('not an object');
    expect(result.trainingStore).toEqual({});
    expect(result.tree.principles).toEqual({});
  });

  it('serializeLedger produces correct JSON with TREE_NAMESPACE', () => {
    const store: HybridLedgerStore = {
      trainingStore: {},
      tree: {
        principles: {},
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: '2026-01-01T00:00:00Z',
      },
    };
    const json = serializeLedger(store);
    const parsed = JSON.parse(json);
    expect(parsed._tree).toBeDefined();
    expect(parsed._tree.lastUpdated).toBeDefined();
  });

  it('isRecord correctly identifies records', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('string')).toBe(false);
  });

  it('stringArray filters non-strings from array', () => {
    expect(stringArray(['a', 1, 'b', null, 'c'])).toEqual(['a', 'b', 'c']);
    expect(stringArray('not array')).toEqual([]);
  });

  it('clampFloat clamps to range with fallback', () => {
    expect(clampFloat(0.5, { min: 0, max: 1, fallback: 0 })).toBe(0.5);
    expect(clampFloat(1.5, { min: 0, max: 1, fallback: 0 })).toBe(1);
    expect(clampFloat(-0.5, { min: 0, max: 1, fallback: 0 })).toBe(0);
    expect(clampFloat(NaN, { min: 0, max: 1, fallback: 0.5 })).toBe(0.5);
  });

  it('clampInt clamps and rounds to range with fallback', () => {
    expect(clampInt(5.7, { min: 0, max: 10, fallback: 0 })).toBe(6);
    expect(clampInt(15, { min: 0, max: 10, fallback: 0 })).toBe(10);
    expect(clampInt('x', { min: 0, max: 10, fallback: 3 })).toBe(3);
  });

  it('uniqueStrings deduplicates', () => {
    expect(uniqueStrings(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('ledger-codec.ts has zero fs/path imports (pure module)', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'principle-tree', 'ledger-codec.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/from\s+['"]fs['"]/);
    expect(src).not.toMatch(/from\s+['"]path['"]/);
    expect(src).not.toMatch(/from\s+['"]node:fs/);
    expect(src).not.toMatch(/from\s+['"]node:path/);
  });

  // PRI-443 regression tests — ledger-codec edge cases
  it('parseLegacyTrainingStore handles malformed evaluability', () => {
    const raw = {
      'pri-001': {
        principleId: 'pri-001',
        evaluability: 'invalid_value',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
        violationTrend: 0.1,
        generatedSampleCount: 3,
        approvedSampleCount: 1,
        includedTrainRunIds: ['run-1'],
        deployedCheckpointIds: ['ckpt-1'],
        internalizationStatus: 'prompt_only',
      },
    };
    const result = parseHybridLedger(raw);
    expect(result.trainingStore['pri-001']).toBeDefined();
    // Invalid evaluability should fallback to 'manual_only'
    expect(result.trainingStore['pri-001']?.evaluability).toBe('manual_only');
  });

  it('parseLegacyTrainingStore handles malformed internalizationStatus', () => {
    const raw = {
      'pri-002': {
        principleId: 'pri-002',
        evaluability: 'deterministic',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
        violationTrend: 0.1,
        generatedSampleCount: 3,
        approvedSampleCount: 1,
        includedTrainRunIds: ['run-1'],
        deployedCheckpointIds: ['ckpt-1'],
        internalizationStatus: 'invalid_status',
      },
    };
    const result = parseHybridLedger(raw);
    expect(result.trainingStore['pri-002']).toBeDefined();
    // Invalid internalizationStatus should fallback to 'prompt_only'
    expect(result.trainingStore['pri-002']?.internalizationStatus).toBe('prompt_only');
  });

  it('parseLegacyTrainingStore handles negative counts (clamped to 0)', () => {
    const raw = {
      'pri-003': {
        principleId: 'pri-003',
        evaluability: 'deterministic',
        applicableOpportunityCount: -5,
        observedViolationCount: -2,
        complianceRate: 0.6,
        violationTrend: 0.1,
        generatedSampleCount: -3,
        approvedSampleCount: -1,
        includedTrainRunIds: ['run-1'],
        deployedCheckpointIds: ['ckpt-1'],
        internalizationStatus: 'prompt_only',
      },
    };
    const result = parseHybridLedger(raw);
    expect(result.trainingStore['pri-003']).toBeDefined();
    // Negative counts should be clamped to 0
    expect(result.trainingStore['pri-003']?.applicableOpportunityCount).toBe(0);
    expect(result.trainingStore['pri-003']?.observedViolationCount).toBe(0);
    expect(result.trainingStore['pri-003']?.generatedSampleCount).toBe(0);
    expect(result.trainingStore['pri-003']?.approvedSampleCount).toBe(0);
  });

  it('parseLegacyTrainingStore handles out-of-range complianceRate (clamped to [0, 1])', () => {
    const raw = {
      'pri-004': {
        principleId: 'pri-004',
        evaluability: 'deterministic',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 1.5, // Out of range (> 1)
        violationTrend: -2.0, // Out of range (< -1)
        generatedSampleCount: 3,
        approvedSampleCount: 1,
        includedTrainRunIds: ['run-1'],
        deployedCheckpointIds: ['ckpt-1'],
        internalizationStatus: 'prompt_only',
      },
    };
    const result = parseHybridLedger(raw);
    expect(result.trainingStore['pri-004']).toBeDefined();
    // complianceRate should be clamped to [0, 1]
    expect(result.trainingStore['pri-004']?.complianceRate).toBe(1);
    // violationTrend should be clamped to [-1, 1]
    expect(result.trainingStore['pri-004']?.violationTrend).toBe(-1);
  });

  it('parseLegacyTrainingStore handles non-array includedTrainRunIds', () => {
    const raw = {
      'pri-005': {
        principleId: 'pri-005',
        evaluability: 'deterministic',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
        violationTrend: 0.1,
        generatedSampleCount: 3,
        approvedSampleCount: 1,
        includedTrainRunIds: 'not-an-array',
        deployedCheckpointIds: null,
        internalizationStatus: 'prompt_only',
      },
    };
    const result = parseHybridLedger(raw);
    expect(result.trainingStore['pri-005']).toBeDefined();
    // Non-array should be converted to empty array
    expect(result.trainingStore['pri-005']?.includedTrainRunIds).toEqual([]);
    expect(result.trainingStore['pri-005']?.deployedCheckpointIds).toEqual([]);
  });

  it('parseLegacyTrainingStore skips entries with mismatched principleId', () => {
    const raw = {
      'pri-006': {
        principleId: 'different-id', // Mismatched!
        evaluability: 'deterministic',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
        violationTrend: 0.1,
        generatedSampleCount: 3,
        approvedSampleCount: 1,
        includedTrainRunIds: ['run-1'],
        deployedCheckpointIds: ['ckpt-1'],
        internalizationStatus: 'prompt_only',
      },
    };
    const result = parseHybridLedger(raw);
    // Entry with mismatched principleId should be skipped
    expect(result.trainingStore['pri-006']).toBeUndefined();
  });

  it('parseLegacyTrainingStore skips TREE_NAMESPACE entries', () => {
    const raw = {
      '_tree': {
        principleId: '_tree',
        evaluability: 'deterministic',
        applicableOpportunityCount: 5,
        observedViolationCount: 2,
        complianceRate: 0.6,
        violationTrend: 0.1,
        generatedSampleCount: 3,
        approvedSampleCount: 1,
        includedTrainRunIds: ['run-1'],
        deployedCheckpointIds: ['ckpt-1'],
        internalizationStatus: 'prompt_only',
      },
    };
    const result = parseHybridLedger(raw);
    // TREE_NAMESPACE entries should be skipped in trainingStore
    expect(result.trainingStore._tree).toBeUndefined();
  });

  it('parsePrinciples handles missing ruleIds', () => {
    const raw = {
      'pri-007': {
        id: 'pri-007',
        version: 1,
        text: 'Test',
        triggerPattern: 'test',
        action: 'test',
        status: 'active',
        priority: 'P0',
        scope: 'general',
        evaluability: 'manual_only',
        valueScore: 0.5,
        adherenceRate: 0.8,
        painPreventedCount: 0,
        derivedFromPainIds: [],
        conflictsWithPrincipleIds: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        // ruleIds is missing
      },
    };
    const result = parseHybridLedger({ _tree: { principles: raw } });
    expect(result.tree.principles['pri-007']).toBeDefined();
    // Missing ruleIds should be converted to empty array
    expect(result.tree.principles['pri-007']?.ruleIds).toEqual([]);
  });

  it('parseRules handles missing implementationIds', () => {
    const raw = {
      'rule-001': {
        id: 'rule-001',
        principleId: 'pri-001',
        version: 1,
        text: 'Test rule',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        // implementationIds is missing
      },
    };
    const result = parseHybridLedger({ _tree: { rules: raw } });
    expect(result.tree.rules['rule-001']).toBeDefined();
    // Missing implementationIds should be converted to empty array
    expect(result.tree.rules['rule-001']?.implementationIds).toEqual([]);
  });

  it('parseRules handles missing principleId (defaults to empty string)', () => {
    const raw = {
      'rule-002': {
        id: 'rule-002',
        // principleId is missing
        version: 1,
        text: 'Test rule',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        implementationIds: [],
      },
    };
    const result = parseHybridLedger({ _tree: { rules: raw } });
    expect(result.tree.rules['rule-002']).toBeDefined();
    // Missing principleId should default to empty string
    expect(result.tree.rules['rule-002']?.principleId).toBe('');
  });

  it('parseImplementations skips entries without ruleId', () => {
    const raw = {
      'impl-001': {
        id: 'impl-001',
        // ruleId is missing
        code: 'function evaluate() { return { decision: "allow" }; }',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    };
    const result = parseHybridLedger({ _tree: { implementations: raw } });
    // Entry without ruleId should be skipped
    expect(result.tree.implementations['impl-001']).toBeUndefined();
  });

  it('serializeLedger preserves TREE_NAMESPACE key', () => {
    const store: HybridLedgerStore = {
      trainingStore: {
        'pri-001': {
          principleId: 'pri-001',
          evaluability: 'manual_only',
          applicableOpportunityCount: 5,
          observedViolationCount: 2,
          complianceRate: 0.6,
          violationTrend: 0.1,
          generatedSampleCount: 3,
          approvedSampleCount: 1,
          includedTrainRunIds: ['run-1'],
          deployedCheckpointIds: ['ckpt-1'],
          internalizationStatus: 'prompt_only',
        },
      },
      tree: {
        principles: {},
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: '2026-01-01T00:00:00Z',
      },
    };
    const json = serializeLedger(store);
    const parsed = JSON.parse(json);
    // TREE_NAMESPACE key should be present
    expect(parsed._tree).toBeDefined();
    // trainingStore entries should be at top level
    expect(parsed['pri-001']).toBeDefined();
    // TREE_NAMESPACE should NOT contain trainingStore entries
    expect(parsed._tree['pri-001']).toBeUndefined();
  });

  it('parseHybridLedger handles deeply nested malformed data', () => {
    const raw = {
      trainingStore: {
        'pri-001': null, // Malformed entry
      },
      _tree: {
        principles: {
          'pri-002': undefined, // Malformed entry
        },
        rules: {
          'rule-001': 'not-an-object', // Malformed entry
        },
        implementations: {
          'impl-001': [], // Malformed entry
        },
        metrics: {
          'metric-001': { principleId: 'pri-001' }, // Valid entry (Record)
        },
        lastUpdated: null, // Non-string value (triggers fallback)
      },
    };
    const result = parseHybridLedger(raw);
    // All malformed entries should be skipped/converted gracefully
    expect(result.trainingStore['pri-001']).toBeUndefined();
    expect(result.tree.principles['pri-002']).toBeUndefined();
    expect(result.tree.rules['rule-001']).toBeUndefined();
    expect(result.tree.implementations['impl-001']).toBeUndefined();
    // Valid metric entry should be preserved
    expect(result.tree.metrics['metric-001']).toBeDefined();
    expect(result.tree.metrics['metric-001']?.principleId).toBe('pri-001');
    // Non-string lastUpdated should fallback to epoch
    expect(result.tree.lastUpdated).toBe(new Date(0).toISOString());
  });
});
