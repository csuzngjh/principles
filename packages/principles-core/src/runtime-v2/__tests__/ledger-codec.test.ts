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
});
