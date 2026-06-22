/**
 * PRI-443: Ledger store types module — pure type definitions, zero I/O.
 *
 * Tests verify:
 * 1. All types are importable from the new pure module
 * 2. The module has zero fs/path imports
 * 3. TREE_NAMESPACE constant is available
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Import types from the NEW pure module
import type {
  LedgerPrinciple,
  HybridLedgerStore,
} from '../types/ledger-store.js';

import { TREE_NAMESPACE } from '../types/ledger-store.js';

describe('PRI-443: ledger-store.ts pure types module', () => {
  it('TREE_NAMESPACE constant is exported and equals _tree', () => {
    expect(TREE_NAMESPACE).toBe('_tree');
  });

  it('LedgerPrinciple extends Principle with optional fields', () => {
    const principle: LedgerPrinciple = {
      id: 'pri-001',
      version: 1,
      text: 'Test principle',
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
      suggestedRules: ['rule-1'],
      lastTriggeredAt: '2026-01-02T00:00:00Z',
    };
    expect(principle.id).toBe('pri-001');
    expect(principle.suggestedRules).toEqual(['rule-1']);
    expect(principle.lastTriggeredAt).toBe('2026-01-02T00:00:00Z');
  });

  it('HybridLedgerStore has trainingStore and tree', () => {
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
    expect(store.trainingStore).toEqual({});
    expect(store.tree.principles).toEqual({});
  });

  it('ledger-store.ts has zero fs/path imports (pure module)', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'types', 'ledger-store.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/from\s+['"]fs['"]/);
    expect(src).not.toMatch(/from\s+['"]path['"]/);
    expect(src).not.toMatch(/from\s+['"]node:fs/);
    expect(src).not.toMatch(/from\s+['"]node:path/);
  });
});
