/**
 * Principle Tree Ledger — pure file-based ledger for principle entries.
 *
 * Lives in principles-core so pd-cli can read/write the ledger without
 * importing openclaw-plugin private code.
 *
 * M8: Single-path ledger. The ledger file is at:
 *   {stateDir}/principle_training_state.json
 *
 * M8 key insight: ledger operations are single-process. No cross-process
 * locking needed for pd-cli usage. The file write is atomic (rename).
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from './io.js';

// PRI-443: Types and constants now live in the pure module
import type {
  Principle,
  Rule,
  Implementation,
  PrincipleValueMetrics,
  LedgerPrinciple,
  LedgerRule,
  LedgerTreeStore,
  LegacyPrincipleTrainingState,
  LegacyPrincipleTrainingStore,
  HybridLedgerStore,
} from './runtime-v2/types/ledger-store.js';
import { TREE_NAMESPACE } from './runtime-v2/types/ledger-store.js';

// PRI-443: Pure parse/serialize functions extracted to codec module
import {
  uniqueStrings,
  createEmptyTree,
  parseHybridLedger,
  serializeLedger,
} from './runtime-v2/principle-tree/ledger-codec.js';

// Re-export for backward compatibility — existing imports from
// @principles/core/principle-tree-ledger continue to work.
export type {
  Principle,
  Rule,
  Implementation,
  PrincipleValueMetrics,
  LedgerPrinciple,
  LedgerRule,
  LedgerTreeStore,
  LegacyPrincipleTrainingState,
  LegacyPrincipleTrainingStore,
  HybridLedgerStore,
};
export { TREE_NAMESPACE };

const PRINCIPLE_TRAINING_FILE = 'principle_training_state.json';

// ---------------------------------------------------------------------------
// Ledger file I/O (the only non-pure part of this module)
// ---------------------------------------------------------------------------

function getLedgerFilePath(stateDir: string): string {
  return path.join(stateDir, PRINCIPLE_TRAINING_FILE);
}

function readLedgerFromFile(filePath: string): HybridLedgerStore {
  if (!fs.existsSync(filePath)) {
    return { trainingStore: {}, tree: createEmptyTree() };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || content.trim() === '') {
      return { trainingStore: {}, tree: createEmptyTree() };
    }
    const parsed = JSON.parse(content) as unknown;
    return parseHybridLedger(parsed);
  } catch {
    return { trainingStore: {}, tree: createEmptyTree() };
  }
}

// ---------------------------------------------------------------------------
// Ledger mutations (synchronous — safe for single-process use)
// ---------------------------------------------------------------------------

/**
 * Read-modify-write the ledger file atomically.
 * Safe for single-process CLI use. NOT safe for concurrent multi-process access.
 */
function mutateLedger<T>(stateDir: string, mutate: (store: HybridLedgerStore) => T): T {
  const filePath = getLedgerFilePath(stateDir);
  const store = readLedgerFromFile(filePath);
  const result = mutate(store);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(filePath, serializeLedger(store));
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadLedger(stateDir: string): HybridLedgerStore {
  return readLedgerFromFile(getLedgerFilePath(stateDir));
}

export function saveLedger(stateDir: string, store: HybridLedgerStore): void {
  mutateLedger(stateDir, (current) => {
    current.trainingStore = store.trainingStore;
    current.tree = store.tree;
  });
}

export function addPrincipleToLedger(stateDir: string, principle: LedgerPrinciple): LedgerPrinciple {
  return mutateLedger(stateDir, (store) => {
    store.tree.principles[principle.id] = principle;
    store.tree.lastUpdated = new Date().toISOString();
    return principle;
  });
}

export function updatePrinciple(stateDir: string, principleId: string, updates: Partial<LedgerPrinciple>): LedgerPrinciple {
  return mutateLedger(stateDir, (store) => {
    const existing = store.tree.principles[principleId];
    if (!existing) throw new Error(`Cannot update missing principle "${principleId}".`);
    const next: LedgerPrinciple = {
      ...existing,
      ...updates,
      id: principleId,
      ruleIds: updates.ruleIds ? uniqueStrings(updates.ruleIds) : existing.ruleIds,
      conflictsWithPrincipleIds: updates.conflictsWithPrincipleIds
        ? uniqueStrings(updates.conflictsWithPrincipleIds) : existing.conflictsWithPrincipleIds,
      derivedFromPainIds: updates.derivedFromPainIds
        ? uniqueStrings(updates.derivedFromPainIds) : existing.derivedFromPainIds,
    };
    store.tree.principles[principleId] = next;
    return next;
  });
}

export function updatePrincipleValueMetrics(stateDir: string, principleId: string, metrics: PrincipleValueMetrics): PrincipleValueMetrics {
  return mutateLedger(stateDir, (store) => {
    const next: PrincipleValueMetrics = { ...metrics, principleId };
    store.tree.metrics[principleId] = next;
    return next;
  });
}

export function getLedgerFilePathPublic(stateDir: string): string {
  return getLedgerFilePath(stateDir);
}
