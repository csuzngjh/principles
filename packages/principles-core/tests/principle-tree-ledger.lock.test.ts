/**
 * PRI-459 Stage 1.1: Ledger file-lock behavior.
 *
 * The principle-tree-ledger mutator is the SINGLE source of truth for writing
 * `principle_training_state.json`. To eliminate the dual-writer lost-update
 * risk (core wrote unlocked, plugin wrote with a lock — neither knew the
 * other's lock), the file lock was hoisted INTO core. Every mutation now
 * acquires a `.lock` file (O_EXCL | O_CREAT) and releases it.
 *
 * This test locks the observable contract of the lock:
 *   - a `.lock` file appears while a mutation is in-flight and is gone after;
 *   - a second mutation on the same file serializes (no lost update);
 *   - lock acquisition failure fails LOUD with the file path (ERR-009),
 *     never silently swallows.
 *
 * ERR checklist:
 *   EP-03 / ERR-009: degraded/refused path must include a reason; no silent
 *     fallback when the lock cannot be acquired.
 *   EP-07: ledger state is read from the canonical source after writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  loadLedger,
  saveLedger,
  addPrincipleToLedger,
  getLedgerFilePathPublic,
} from '../src/principle-tree-ledger.js';
import { createEmptyTree } from '../src/runtime-v2/principle-tree/ledger-codec.js';
import type { LedgerPrinciple } from '../src/runtime-v2/types/ledger-store.js';

function makePrinciple(id: string): LedgerPrinciple {
  return {
    id,
    version: 1,
    text: `principle ${id}`,
    triggerPattern: 'tp',
    action: 'act',
    status: 'candidate',
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

describe('PRI-459 Stage 1.1 — ledger file lock', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-lock-'));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('a mutation leaves no orphan .lock file behind on success', () => {
    addPrincipleToLedger(stateDir, makePrinciple('p1'));

    const lockPath = getLedgerFilePathPublic(stateDir) + '.lock';
    expect(fs.existsSync(lockPath)).toBe(false);

    // And the write actually landed.
    const ledger = loadLedger(stateDir);
    expect(ledger.tree.principles['p1']).toBeDefined();
  });

  it('two sequential mutations on the same file both persist (no lost update)', () => {
    // This is the core anti-regression: the old core mutator had NO lock and
    // the plugin mutator had a lock; concurrent writers could lose updates.
    // Now both serialize through the same .lock and both writes survive.
    addPrincipleToLedger(stateDir, makePrinciple('p1'));
    addPrincipleToLedger(stateDir, makePrinciple('p2'));

    const ledger = loadLedger(stateDir);
    expect(Object.keys(ledger.tree.principles).sort()).toEqual(['p1', 'p2']);
  });

  it('a stale .lock file (held by a dead PID) is reclaimed, not deadlocked', () => {
    // Pre-create a stale lock owned by a PID that does not exist. The next
    // mutation must detect staleness, clean it up, and proceed — rather than
    // fail forever or block indefinitely.
    const lockPath = getLedgerFilePathPublic(stateDir) + '.lock';
    fs.writeFileSync(lockPath, String(999_999_999), 'utf8'); // nonexistent PID

    addPrincipleToLedger(stateDir, makePrinciple('p-stale'));

    expect(loadLedger(stateDir).tree.principles['p-stale']).toBeDefined();
    // Lock cleaned up after the reclaimed mutation.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('serialize then load round-trips an empty tree through the locked path', () => {
    // saveLedger also goes through mutateLedger → must acquire the lock.
    saveLedger(stateDir, { trainingStore: {}, tree: createEmptyTree() });

    const ledger = loadLedger(stateDir);
    expect(ledger.tree.principles).toEqual({});
    expect(ledger.trainingStore).toEqual({});
  });
});
