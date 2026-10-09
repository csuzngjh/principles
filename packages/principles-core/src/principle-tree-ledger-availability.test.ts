/**
 * PRI-915: ledger file availability tri-state.
 *
 * `readLedgerFileState` is the single read primitive: it returns the same
 * silent-empty store the ledger always produced, PLUS why. The `unreadable`
 * state is the one callers must treat as "not decidable" — a missing file is
 * a true empty ledger (fresh workspace), not an outage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { addPrincipleToLedger, loadLedger, readLedgerFileState } from './principle-tree-ledger.js';
import type { LedgerPrinciple } from './principle-tree-ledger.js';

const LEDGER_FILE = 'principle_training_state.json';

let stateDir: string;

function mkdirAndWrite(content: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, LEDGER_FILE), content, 'utf-8');
}

beforeEach(() => {
  stateDir = join(mkdtempSync(join(tmpdir(), 'pd-ledger-availability-')), '.state');
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

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

describe('readLedgerFileState — PRI-915 availability tri-state', () => {
  it('reports empty (not an outage) when the ledger file does not exist yet', () => {
    const state = readLedgerFileState(stateDir);
    expect(state.availability).toEqual({ status: 'empty' });
    expect(state.ledger.tree.principles).toEqual({});
  });

  it('reports empty for a zero-byte ledger file', () => {
    mkdirAndWrite('');
    const state = readLedgerFileState(stateDir);
    expect(state.availability).toEqual({ status: 'empty' });
  });

  it('reports ok with the parsed store when the ledger reads back', () => {
    addPrincipleToLedger(stateDir, makePrinciple());
    const state = readLedgerFileState(stateDir);
    expect(state.availability).toEqual({ status: 'ok' });
    expect(Object.hasOwn(state.ledger.tree.principles, 'p-1')).toBe(true);
  });

  it('reports unreadable with the underlying problem when the file is corrupt', () => {
    mkdirAndWrite('{ this is not json');
    const state = readLedgerFileState(stateDir);
    expect(state.availability.status).toBe('unreadable');
    if (state.availability.status === 'unreadable') {
      expect(state.availability.problem.length).toBeGreaterThan(0);
    }
    // The store collapse is unchanged (callers consult availability); the
    // availability field is what makes it decidable.
    expect(state.ledger.tree.principles).toEqual({});
  });

  it('keeps loadLedger behavior identical: silent empty store on every state', () => {
    expect(loadLedger(stateDir).tree.principles).toEqual({});
    mkdirAndWrite('{ broken');
    expect(loadLedger(stateDir).tree.principles).toEqual({});
  });
});
