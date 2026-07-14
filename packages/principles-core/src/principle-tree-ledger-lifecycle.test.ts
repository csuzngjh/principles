import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import type {
  LedgerPrinciple,
  LedgerRule,
  Implementation,
} from './principle-tree-ledger.js';
import {
  isValidLifecycleTransition,
  getAllowedTransitions,
  addPrincipleToLedger,
  updatePrinciple,
  createRule,
  createImplementation,
  updateRule,
  deleteRule,
  updateImplementation,
  deleteImplementation,
  transitionImplementationState,
  listImplementationsForRule,
  findActiveImplementation,
  listRuleImplementationsByState,
  getPrincipleSubtree,
  loadLedger,
} from './principle-tree-ledger.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: 'p-1',
    version: 1,
    text: 'Test principle',
    triggerPattern: 'always',
    action: 'enforce',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 0.5,
    adherenceRate: 0.8,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRule(overrides: Partial<LedgerRule> = {}): LedgerRule {
  return {
    id: 'r-1',
    principleId: 'p-1',
    implementationIds: [],
    ...overrides,
  };
}

function makeImplementation(overrides: Partial<Implementation> = {}): Implementation {
  return {
    id: 'impl-1',
    ruleId: 'r-1',
    lifecycleState: 'candidate',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Temp directory helper
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(process.cwd(), 'tmp-test-ledger-lifecycle-' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// 1. Pure lifecycle transition tests
// ---------------------------------------------------------------------------

describe('isValidLifecycleTransition', () => {
  it('allows candidate → active', () => {
    expect(isValidLifecycleTransition('candidate', 'active')).toBe(true);
  });

  it('allows candidate → archived', () => {
    expect(isValidLifecycleTransition('candidate', 'archived')).toBe(true);
  });

  it('allows active → disabled', () => {
    expect(isValidLifecycleTransition('active', 'disabled')).toBe(true);
  });

  it('allows active → archived', () => {
    expect(isValidLifecycleTransition('active', 'archived')).toBe(true);
  });

  it('allows disabled → active', () => {
    expect(isValidLifecycleTransition('disabled', 'active')).toBe(true);
  });

  it('allows disabled → archived', () => {
    expect(isValidLifecycleTransition('disabled', 'archived')).toBe(true);
  });

  it('rejects candidate → candidate (self-loop)', () => {
    expect(isValidLifecycleTransition('candidate', 'candidate')).toBe(false);
  });

  it('rejects candidate → disabled', () => {
    expect(isValidLifecycleTransition('candidate', 'disabled')).toBe(false);
  });

  it('rejects active → candidate', () => {
    expect(isValidLifecycleTransition('active', 'candidate')).toBe(false);
  });

  it('rejects active → active (self-loop)', () => {
    expect(isValidLifecycleTransition('active', 'active')).toBe(false);
  });

  it('rejects disabled → candidate', () => {
    expect(isValidLifecycleTransition('disabled', 'candidate')).toBe(false);
  });

  it('rejects disabled → disabled (self-loop)', () => {
    expect(isValidLifecycleTransition('disabled', 'disabled')).toBe(false);
  });

  it('rejects all transitions from archived (terminal state)', () => {
    expect(isValidLifecycleTransition('archived', 'candidate')).toBe(false);
    expect(isValidLifecycleTransition('archived', 'active')).toBe(false);
    expect(isValidLifecycleTransition('archived', 'disabled')).toBe(false);
    expect(isValidLifecycleTransition('archived', 'archived')).toBe(false);
  });
});

describe('getAllowedTransitions', () => {
  it('returns [active, archived] for candidate', () => {
    expect(getAllowedTransitions('candidate')).toEqual(['active', 'archived']);
  });

  it('returns [disabled, archived] for active', () => {
    expect(getAllowedTransitions('active')).toEqual(['disabled', 'archived']);
  });

  it('returns [active, archived] for disabled', () => {
    expect(getAllowedTransitions('disabled')).toEqual(['active', 'archived']);
  });

  it('returns [] for archived', () => {
    expect(getAllowedTransitions('archived')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. CRUD operations
// ---------------------------------------------------------------------------

describe('addPrincipleToLedger', () => {
  it('adds a principle and returns it', () => {
    const p = makePrinciple();
    const result = addPrincipleToLedger(tmpDir, p);
    expect(result.id).toBe('p-1');

    const ledger = loadLedger(tmpDir);
    expect(ledger.tree.principles['p-1']).toBeDefined();
    const principle = ledger.tree.principles['p-1'];
    if (!principle) throw new Error('Expected non-null principle');
    expect(principle.id).toBe('p-1');
  });
});

describe('updatePrinciple', () => {
  it('updates fields on an existing principle', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    const updated = updatePrinciple(tmpDir, 'p-1', { text: 'Updated text', priority: 'P0' });
    expect(updated.text).toBe('Updated text');
    expect(updated.priority).toBe('P0');
    expect(updated.id).toBe('p-1');
  });

  it('preserves fields not in updates', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    const updated = updatePrinciple(tmpDir, 'p-1', { text: 'New text' });
    expect(updated.scope).toBe('general');
    expect(updated.ruleIds).toEqual([]);
  });

  it('deduplicates ruleIds', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    const updated = updatePrinciple(tmpDir, 'p-1', { ruleIds: ['r-1', 'r-1', 'r-2'] });
    expect(updated.ruleIds).toEqual(['r-1', 'r-2']);
  });

  it('throws when principle does not exist', () => {
    expect(() => updatePrinciple(tmpDir, 'nonexistent', { text: 'x' })).toThrow(
      /Cannot update missing principle/,
    );
  });
});

describe('createRule', () => {
  it('creates a rule and adds it to the parent principle ruleIds', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    const rule = makeRule();
    const result = createRule(tmpDir, rule);
    expect(result.id).toBe('r-1');
    expect(result.principleId).toBe('p-1');

    const ledger = loadLedger(tmpDir);
    expect(ledger.tree.rules['r-1']).toBeDefined();
    const principle = ledger.tree.principles['p-1'];
    if (!principle) throw new Error('Expected non-null principle');
    expect(principle.ruleIds).toContain('r-1');
  });

  it('deduplicates implementationIds', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    const rule = makeRule({ implementationIds: ['a', 'a', 'b'] });
    const result = createRule(tmpDir, rule);
    expect(result.implementationIds).toEqual(['a', 'b']);
  });
});

describe('createImplementation', () => {
  it('creates an implementation and adds it to the parent rule implementationIds', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    const impl = makeImplementation();
    const result = createImplementation(tmpDir, impl);
    expect(result.id).toBe('impl-1');
    expect(result.ruleId).toBe('r-1');

    const ledger = loadLedger(tmpDir);
    expect(ledger.tree.implementations['impl-1']).toBeDefined();
    const rule = ledger.tree.rules['r-1'];
    if (!rule) throw new Error('Expected non-null rule');
    expect(rule.implementationIds).toContain('impl-1');
  });
});

describe('updateRule', () => {
  it('updates fields on an existing rule', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    const updated = updateRule(tmpDir, 'r-1', { name: 'Updated rule' });
    expect(updated.name).toBe('Updated rule');
    expect(updated.id).toBe('r-1');
  });

  it('supports cross-principle migration (moves ruleIds)', () => {
    addPrincipleToLedger(tmpDir, makePrinciple({ id: 'p-1' }));
    addPrincipleToLedger(tmpDir, makePrinciple({ id: 'p-2' }));
    createRule(tmpDir, makeRule({ id: 'r-1', principleId: 'p-1' }));

    const updated = updateRule(tmpDir, 'r-1', { principleId: 'p-2' });
    expect(updated.principleId).toBe('p-2');

    const ledger = loadLedger(tmpDir);
    const p1 = ledger.tree.principles['p-1'];
    if (!p1) throw new Error('Expected non-null principle p-1');
    expect(p1.ruleIds).not.toContain('r-1');
    const p2 = ledger.tree.principles['p-2'];
    if (!p2) throw new Error('Expected non-null principle p-2');
    expect(p2.ruleIds).toContain('r-1');
  });

  it('throws when rule does not exist', () => {
    expect(() => updateRule(tmpDir, 'nonexistent', { name: 'x' })).toThrow(
      /Cannot update missing rule/,
    );
  });

  it('throws when target principle does not exist', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    expect(() => updateRule(tmpDir, 'r-1', { principleId: 'ghost' })).toThrow(
      /Cannot move rule.*missing principle/,
    );
  });
});

describe('deleteRule', () => {
  it('deletes the rule and removes it from parent principle ruleIds', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    const deleted = deleteRule(tmpDir, 'r-1');
    expect(deleted).toBeDefined();
    if (!deleted) throw new Error('Expected non-null deleted');
    expect(deleted.id).toBe('r-1');

    const ledger = loadLedger(tmpDir);
    expect(ledger.tree.rules['r-1']).toBeUndefined();
    const principle = ledger.tree.principles['p-1'];
    if (!principle) throw new Error('Expected non-null principle');
    expect(principle.ruleIds).not.toContain('r-1');
  });

  it('cascade deletes implementations', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    createImplementation(tmpDir, makeImplementation({ id: 'impl-1' }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-2' }));

    deleteRule(tmpDir, 'r-1');

    const ledger = loadLedger(tmpDir);
    expect(ledger.tree.implementations['impl-1']).toBeUndefined();
    expect(ledger.tree.implementations['impl-2']).toBeUndefined();
  });

  it('returns undefined when rule does not exist', () => {
    const result = deleteRule(tmpDir, 'nonexistent');
    expect(result).toBeUndefined();
  });
});

describe('updateImplementation', () => {
  it('updates fields on an existing implementation', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    createImplementation(tmpDir, makeImplementation());
    const updated = updateImplementation(tmpDir, 'impl-1', { version: '2.0' });
    expect(updated.version).toBe('2.0');
    expect(updated.id).toBe('impl-1');
  });

  it('supports cross-rule migration (moves implementationIds)', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule({ id: 'r-1' }));
    createRule(tmpDir, makeRule({ id: 'r-2' }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-1', ruleId: 'r-1' }));

    const updated = updateImplementation(tmpDir, 'impl-1', { ruleId: 'r-2' });
    expect(updated.ruleId).toBe('r-2');

    const ledger = loadLedger(tmpDir);
    const r1 = ledger.tree.rules['r-1'];
    if (!r1) throw new Error('Expected non-null rule r-1');
    expect(r1.implementationIds).not.toContain('impl-1');
    const r2 = ledger.tree.rules['r-2'];
    if (!r2) throw new Error('Expected non-null rule r-2');
    expect(r2.implementationIds).toContain('impl-1');
  });

  it('throws when implementation does not exist', () => {
    expect(() => updateImplementation(tmpDir, 'nonexistent', { version: '1' })).toThrow(
      /Cannot update missing implementation/,
    );
  });

  it('throws when target rule does not exist', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    createImplementation(tmpDir, makeImplementation());
    expect(() => updateImplementation(tmpDir, 'impl-1', { ruleId: 'ghost' })).toThrow(
      /Cannot move implementation.*missing rule/,
    );
  });
});

describe('deleteImplementation', () => {
  it('deletes the implementation and removes it from parent rule implementationIds', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    createImplementation(tmpDir, makeImplementation());

    const deleted = deleteImplementation(tmpDir, 'impl-1');
    expect(deleted).toBeDefined();
    if (!deleted) throw new Error('Expected non-null deleted');
    expect(deleted.id).toBe('impl-1');

    const ledger = loadLedger(tmpDir);
    expect(ledger.tree.implementations['impl-1']).toBeUndefined();
    const rule = ledger.tree.rules['r-1'];
    if (!rule) throw new Error('Expected non-null rule');
    expect(rule.implementationIds).not.toContain('impl-1');
  });

  it('returns undefined when implementation does not exist', () => {
    const result = deleteImplementation(tmpDir, 'nonexistent');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Lifecycle state machine tests
// ---------------------------------------------------------------------------

describe('transitionImplementationState', () => {
  function setupWithCandidate(): string {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    createImplementation(tmpDir, makeImplementation({ lifecycleState: 'candidate' }));
    return tmpDir;
  }

  it('transitions candidate → active', () => {
    setupWithCandidate();
    const result = transitionImplementationState(tmpDir, 'impl-1', 'active');
    expect(result.lifecycleState).toBe('active');
  });

  it('transitions candidate → archived', () => {
    setupWithCandidate();
    const result = transitionImplementationState(tmpDir, 'impl-1', 'archived');
    expect(result.lifecycleState).toBe('archived');
  });

  it('transitions active → disabled', () => {
    setupWithCandidate();
    transitionImplementationState(tmpDir, 'impl-1', 'active');
    const result = transitionImplementationState(tmpDir, 'impl-1', 'disabled');
    expect(result.lifecycleState).toBe('disabled');
  });

  it('transitions active → archived', () => {
    setupWithCandidate();
    transitionImplementationState(tmpDir, 'impl-1', 'active');
    const result = transitionImplementationState(tmpDir, 'impl-1', 'archived');
    expect(result.lifecycleState).toBe('archived');
  });

  it('transitions disabled → active', () => {
    setupWithCandidate();
    transitionImplementationState(tmpDir, 'impl-1', 'active');
    transitionImplementationState(tmpDir, 'impl-1', 'disabled');
    const result = transitionImplementationState(tmpDir, 'impl-1', 'active');
    expect(result.lifecycleState).toBe('active');
  });

  it('transitions disabled → archived', () => {
    setupWithCandidate();
    transitionImplementationState(tmpDir, 'impl-1', 'active');
    transitionImplementationState(tmpDir, 'impl-1', 'disabled');
    const result = transitionImplementationState(tmpDir, 'impl-1', 'archived');
    expect(result.lifecycleState).toBe('archived');
  });

  it('treats undefined lifecycleState as candidate', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    // Implementation without explicit lifecycleState
    createImplementation(tmpDir, { id: 'impl-1', ruleId: 'r-1' });
    const result = transitionImplementationState(tmpDir, 'impl-1', 'active');
    expect(result.lifecycleState).toBe('active');
  });

  it('throws on invalid transition candidate → disabled', () => {
    setupWithCandidate();
    expect(() => transitionImplementationState(tmpDir, 'impl-1', 'disabled')).toThrow(
      /Invalid lifecycle transition/,
    );
  });

  it('throws on transition from archived (terminal)', () => {
    setupWithCandidate();
    transitionImplementationState(tmpDir, 'impl-1', 'archived');
    expect(() => transitionImplementationState(tmpDir, 'impl-1', 'active')).toThrow(
      /Invalid lifecycle transition.*none \(terminal state\)/,
    );
  });

  it('throws when implementation does not exist', () => {
    expect(() => transitionImplementationState(tmpDir, 'ghost', 'active')).toThrow(
      /Implementation not found/,
    );
  });
});

describe('listRuleImplementationsByState', () => {
  it('returns only implementations matching the given state', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule({ implementationIds: [] }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-a', lifecycleState: 'candidate' }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-b', lifecycleState: 'active' }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-c', lifecycleState: 'disabled' }));

    const candidates = listRuleImplementationsByState(tmpDir, 'r-1', 'candidate');
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    if (!candidate) throw new Error('Expected non-null candidate');
    expect(candidate.id).toBe('impl-a');

    const actives = listRuleImplementationsByState(tmpDir, 'r-1', 'active');
    expect(actives).toHaveLength(1);
    const [active] = actives;
    if (!active) throw new Error('Expected non-null active');
    expect(active.id).toBe('impl-b');

    const disableds = listRuleImplementationsByState(tmpDir, 'r-1', 'disabled');
    expect(disableds).toHaveLength(1);
    const [disabled] = disableds;
    if (!disabled) throw new Error('Expected non-null disabled');
    expect(disabled.id).toBe('impl-c');

    expect(listRuleImplementationsByState(tmpDir, 'r-1', 'archived')).toHaveLength(0);
  });

  it('treats undefined lifecycleState as candidate', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule({ implementationIds: [] }));
    createImplementation(tmpDir, { id: 'impl-x', ruleId: 'r-1' });

    const candidates = listRuleImplementationsByState(tmpDir, 'r-1', 'candidate');
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    if (!candidate) throw new Error('Expected non-null candidate');
    expect(candidate.id).toBe('impl-x');
  });
});

describe('findActiveImplementation', () => {
  it('returns the active implementation for a rule', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule({ implementationIds: [] }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-a', lifecycleState: 'candidate' }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-b', lifecycleState: 'active' }));

    const active = findActiveImplementation(tmpDir, 'r-1');
    expect(active).not.toBeNull();
    if (!active) throw new Error('Expected non-null active');
    expect(active.id).toBe('impl-b');
  });

  it('returns null when no active implementation exists', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule({ implementationIds: [] }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-a', lifecycleState: 'candidate' }));

    expect(findActiveImplementation(tmpDir, 'r-1')).toBeNull();
  });

  it('returns null when rule does not exist', () => {
    expect(findActiveImplementation(tmpDir, 'nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Subtree query tests
// ---------------------------------------------------------------------------

describe('getPrincipleSubtree', () => {
  it('returns the full subtree for a principle', () => {
    addPrincipleToLedger(tmpDir, makePrinciple({ id: 'p-1' }));
    createRule(tmpDir, makeRule({ id: 'r-1', implementationIds: [] }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-1', ruleId: 'r-1' }));

    const subtree = getPrincipleSubtree(tmpDir, 'p-1');
    expect(subtree).toBeDefined();
    if (!subtree) throw new Error('Expected non-null subtree');
    expect(subtree.principle.id).toBe('p-1');
    expect(subtree.rules).toHaveLength(1);
    const [ruleEntry] = subtree.rules;
    if (!ruleEntry) throw new Error('Expected non-null rule entry');
    expect(ruleEntry.rule.id).toBe('r-1');
    expect(ruleEntry.implementations).toHaveLength(1);
    const [implEntry] = ruleEntry.implementations;
    if (!implEntry) throw new Error('Expected non-null implementation entry');
    expect(implEntry.id).toBe('impl-1');
  });

  it('returns undefined for missing principle', () => {
    expect(getPrincipleSubtree(tmpDir, 'ghost')).toBeUndefined();
  });

  it('returns empty rules array for principle with no rules', () => {
    addPrincipleToLedger(tmpDir, makePrinciple({ id: 'p-1' }));
    const subtree = getPrincipleSubtree(tmpDir, 'p-1');
    expect(subtree).toBeDefined();
    if (!subtree) throw new Error('Expected non-null subtree');
    expect(subtree.rules).toEqual([]);
  });
});

describe('listImplementationsForRule', () => {
  it('returns implementations for a given rule', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule({ implementationIds: [] }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-1' }));
    createImplementation(tmpDir, makeImplementation({ id: 'impl-2' }));

    const impls = listImplementationsForRule(tmpDir, 'r-1');
    expect(impls).toHaveLength(2);
    expect(impls.map((i) => i.id).sort()).toEqual(['impl-1', 'impl-2']);
  });

  it('returns empty array for missing rule', () => {
    expect(listImplementationsForRule(tmpDir, 'nonexistent')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Error cases
// ---------------------------------------------------------------------------

describe('error cases', () => {
  it('createRule throws if parent principle is missing', () => {
    expect(() => createRule(tmpDir, makeRule({ principleId: 'ghost' }))).toThrow(
      /Cannot create rule.*missing principle/,
    );
  });

  it('createRule throws if rule already exists', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule({ id: 'r-1' }));
    expect(() => createRule(tmpDir, makeRule({ id: 'r-1' }))).toThrow(
      /already exists.*Use updateRule/,
    );
  });

  it('createImplementation throws if parent rule is missing', () => {
    expect(() => createImplementation(tmpDir, makeImplementation({ ruleId: 'ghost' }))).toThrow(
      /Cannot create implementation.*missing rule/,
    );
  });

  it('createImplementation throws if implementation already exists', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    createImplementation(tmpDir, makeImplementation({ id: 'impl-1' }));
    expect(() => createImplementation(tmpDir, makeImplementation({ id: 'impl-1' }))).toThrow(
      /already exists.*Use updateImplementation/,
    );
  });

  it('transitionImplementationState throws on invalid transition', () => {
    addPrincipleToLedger(tmpDir, makePrinciple());
    createRule(tmpDir, makeRule());
    createImplementation(tmpDir, makeImplementation({ lifecycleState: 'active' }));
    expect(() => transitionImplementationState(tmpDir, 'impl-1', 'candidate')).toThrow(
      /Invalid lifecycle transition/,
    );
  });

  it('transitionImplementationState throws when implementation missing', () => {
    expect(() => transitionImplementationState(tmpDir, 'no-such-impl', 'active')).toThrow(
      /Implementation not found/,
    );
  });
});
