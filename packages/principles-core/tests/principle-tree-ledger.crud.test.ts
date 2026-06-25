/**
 * PRI-459 Stage 1.2: Ledger Rule/Implementation CRUD + lifecycle state machine.
 *
 * Before PRI-459 these mutators lived ONLY in the openclaw-plugin ledger copy.
 * They are now hoisted into core (the single mutator source of truth) so the
 * plugin ledger can become a re-export adapter. This test pins the behavior
 * every consumer relies on:
 *
 *   - create{Rule,Implementation} reject missing parent entities (fail loud);
 *   - updateRule moving a rule across parents maintains BOTH ruleIds arrays;
 *   - deleteRule cascades to its implementations;
 *   - the lifecycle state machine accepts valid transitions and rejects
 *     invalid ones with a message naming the allowed set (EP-03 / ERR-009).
 *
 * Fixtures use the real on-disk schema shape (EP-09 / ERR-025).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  addPrincipleToLedger,
  createRule,
  createImplementation,
  updateRule,
  deleteRule,
  updateImplementation,
  deleteImplementation,
  listImplementationsForRule,
  getPrincipleSubtree,
  transitionImplementationState,
  isValidLifecycleTransition,
  getAllowedTransitions,
  listRuleImplementationsByState,
  findActiveImplementation,
  loadLedger,
} from '../src/principle-tree-ledger.js';
import type {
  LedgerPrinciple,
  LedgerRule,
} from '../src/runtime-v2/types/ledger-store.js';
import type { ImplementationLifecycleState } from '../src/runtime-v2/types/principle-enums.js';

function makePrinciple(id: string): LedgerPrinciple {
  return {
    id,
    version: 1,
    text: `principle ${id}`,
    triggerPattern: 'tp',
    action: 'act',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
  };
}

function makeRule(id: string, principleId: string): LedgerRule {
  return {
    id,
    principleId,
    ruleIds: [],
    implementationIds: [],
  };
}

describe('PRI-459 Stage 1.2 — Rule/Implementation CRUD', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-crud-'));
    addPrincipleToLedger(stateDir, makePrinciple('p1'));
    addPrincipleToLedger(stateDir, makePrinciple('p2'));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe('createRule', () => {
    it('creates a rule and links it to the parent principle ruleIds', () => {
      createRule(stateDir, makeRule('r1', 'p1'));
      const ledger = loadLedger(stateDir);
      expect(ledger.tree.rules['r1']).toBeDefined();
      expect(ledger.tree.rules['r1']!.implementationIds).toEqual([]);
      expect(ledger.tree.principles['p1']!.ruleIds).toContain('r1');
    });

    it('throws when the parent principle does not exist', () => {
      expect(() => createRule(stateDir, makeRule('rx', 'missing-principle'))).toThrow(
        /missing principle "missing-principle"/,
      );
      // Failure path must not mutate state (CLI gate rule 5 / no-side-effect-on-failure).
      expect(loadLedger(stateDir).tree.rules['rx']).toBeUndefined();
    });
  });

  describe('createImplementation', () => {
    beforeEach(() => {
      createRule(stateDir, makeRule('r1', 'p1'));
    });

    it('creates an implementation and links it to the parent rule', () => {
      createImplementation(stateDir, { id: 'impl1', ruleId: 'r1', lifecycleState: 'candidate' });
      const ledger = loadLedger(stateDir);
      expect(ledger.tree.implementations['impl1']).toBeDefined();
      expect(ledger.tree.rules['r1']!.implementationIds).toContain('impl1');
    });

    it('throws when the parent rule does not exist', () => {
      expect(() =>
        createImplementation(stateDir, { id: 'implX', ruleId: 'missing-rule' }),
      ).toThrow(/missing rule "missing-rule"/);
      expect(loadLedger(stateDir).tree.implementations['implX']).toBeUndefined();
    });
  });

  describe('updateRule — cross-parent migration', () => {
    beforeEach(() => {
      createRule(stateDir, makeRule('r1', 'p1'));
    });

    it('moves a rule from p1 to p2, updating both ruleIds arrays', () => {
      updateRule(stateDir, 'r1', { principleId: 'p2' });
      const ledger = loadLedger(stateDir);
      expect(ledger.tree.rules['r1']!.principleId).toBe('p2');
      expect(ledger.tree.principles['p1']!.ruleIds).not.toContain('r1');
      expect(ledger.tree.principles['p2']!.ruleIds).toContain('r1');
    });

    it('throws when the destination principle does not exist', () => {
      expect(() => updateRule(stateDir, 'r1', { principleId: 'nope' })).toThrow(
        /missing principle "nope"/,
      );
      // State unchanged.
      expect(loadLedger(stateDir).tree.rules['r1']!.principleId).toBe('p1');
    });
  });

  describe('deleteRule — cascade', () => {
    beforeEach(() => {
      createRule(stateDir, makeRule('r1', 'p1'));
      createImplementation(stateDir, { id: 'impl1', ruleId: 'r1', lifecycleState: 'active' });
      createImplementation(stateDir, { id: 'impl2', ruleId: 'r1', lifecycleState: 'candidate' });
    });

    it('deletes the rule, unlinks it from the parent, and cascades to implementations', () => {
      const removed = deleteRule(stateDir, 'r1');
      expect(removed).toBeDefined();
      const ledger = loadLedger(stateDir);
      expect(ledger.tree.rules['r1']).toBeUndefined();
      expect(ledger.tree.implementations['impl1']).toBeUndefined();
      expect(ledger.tree.implementations['impl2']).toBeUndefined();
      expect(ledger.tree.principles['p1']!.ruleIds).not.toContain('r1');
    });

    it('returns undefined when deleting a missing rule (idempotent)', () => {
      expect(deleteRule(stateDir, 'no-such-rule')).toBeUndefined();
    });
  });

  describe('implementation queries', () => {
    beforeEach(() => {
      createRule(stateDir, makeRule('r1', 'p1'));
      createImplementation(stateDir, { id: 'implA', ruleId: 'r1', lifecycleState: 'active' });
      createImplementation(stateDir, { id: 'implB', ruleId: 'r1', lifecycleState: 'candidate' });
    });

    it('listImplementationsForRule returns implementations in declared order', () => {
      const impls = listImplementationsForRule(stateDir, 'r1');
      expect(impls.map((i) => i.id)).toEqual(['implA', 'implB']);
    });

    it('listRuleImplementationsByState filters by state', () => {
      const active = listRuleImplementationsByState(stateDir, 'r1', 'active');
      expect(active.map((i) => i.id)).toEqual(['implA']);
    });

    it('findActiveImplementation returns the active one', () => {
      expect(findActiveImplementation(stateDir, 'r1')?.id).toBe('implA');
    });

    it('getPrincipleSubtree returns principle + rules + implementations', () => {
      const subtree = getPrincipleSubtree(stateDir, 'p1');
      expect(subtree).toBeDefined();
      expect(subtree!.principle.id).toBe('p1');
      expect(subtree!.rules).toHaveLength(1);
      expect(subtree!.rules[0]!.implementations).toHaveLength(2);
    });
  });

  describe('implementation lifecycle state machine', () => {
    beforeEach(() => {
      createRule(stateDir, makeRule('r1', 'p1'));
    });

    it('isValidLifecycleTransition / getAllowedTransitions match the documented table', () => {
      // candidate -> active / archived
      expect(isValidLifecycleTransition('candidate', 'active')).toBe(true);
      expect(isValidLifecycleTransition('candidate', 'disabled')).toBe(false);
      // active -> disabled / archived
      expect(isValidLifecycleTransition('active', 'disabled')).toBe(true);
      expect(isValidLifecycleTransition('active', 'candidate')).toBe(false);
      // archived is terminal
      expect(getAllowedTransitions('archived')).toEqual([]);
      expect(isValidLifecycleTransition('archived', 'active')).toBe(false);
    });

    it('transitionImplementationState applies a valid candidate->active transition', () => {
      createImplementation(stateDir, { id: 'impl1', ruleId: 'r1', lifecycleState: 'candidate' });
      const updated = transitionImplementationState(stateDir, 'impl1', 'active');
      expect(updated.lifecycleState).toBe('active');
      expect(loadLedger(stateDir).tree.implementations['impl1']!.lifecycleState).toBe('active');
    });

    it('transitionImplementationState throws on an invalid active->candidate transition', () => {
      createImplementation(stateDir, { id: 'impl1', ruleId: 'r1', lifecycleState: 'active' });
      expect(() => transitionImplementationState(stateDir, 'impl1', 'candidate')).toThrow(
        /Invalid lifecycle transition: active -> candidate/,
      );
      // No mutation on failure.
      expect(loadLedger(stateDir).tree.implementations['impl1']!.lifecycleState).toBe('active');
    });

    it('transitionImplementationState throws when the implementation is missing', () => {
      expect(() =>
        transitionImplementationState(stateDir, 'ghost', 'active' as ImplementationLifecycleState),
      ).toThrow(/Implementation not found: ghost/);
    });
  });

  describe('updateImplementation / deleteImplementation', () => {
    beforeEach(() => {
      createRule(stateDir, makeRule('r1', 'p1'));
      createImplementation(stateDir, { id: 'impl1', ruleId: 'r1', lifecycleState: 'candidate' });
    });

    it('updateImplementation mutates fields', () => {
      const updated = updateImplementation(stateDir, 'impl1', { type: 'code' });
      expect(updated.type).toBe('code');
      expect(loadLedger(stateDir).tree.implementations['impl1']!.type).toBe('code');
    });

    it('deleteImplementation removes it and unlinks from the parent rule', () => {
      deleteImplementation(stateDir, 'impl1');
      const ledger = loadLedger(stateDir);
      expect(ledger.tree.implementations['impl1']).toBeUndefined();
      expect(ledger.tree.rules['r1']!.implementationIds).not.toContain('impl1');
    });
  });
});
