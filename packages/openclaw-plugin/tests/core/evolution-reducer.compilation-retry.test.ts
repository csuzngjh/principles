import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvolutionReducerImpl } from '../../src/core/evolution-reducer.js';
import { loadLedger, updatePrinciple } from '../../src/core/principle-tree-ledger.js';
import { safeRmDir } from '../test-utils.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-compile-'));
  tempDirs.push(dir);
  return dir;
}

// Minimal state dir structure
function makeStateDir(workspace: string): string {
  const stateDir = path.join(workspace, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'EVOLUTION_STREAM'), '', 'utf8');
  fs.writeFileSync(path.join(stateDir, 'PRINCIPLES'), '', 'utf8');
  fs.writeFileSync(path.join(stateDir, 'evolution_queue.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(stateDir, 'ledger.json'), JSON.stringify({
    trainingStore: {},
    tree: { principles: {}, rules: {}, implementations: {}, metrics: {}, lastUpdated: new Date().toISOString() },
  }), 'utf8');
  return stateDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    safeRmDir(dir);
  }
});

function createPrinciple(reducer: EvolutionReducerImpl, evaluability?: string, suffix = ''): string {
  const id = reducer.createPrincipleFromDiagnosis({
    painId: `pain-${evaluability ?? 'default'}-${Date.now()}${suffix}`,
    painType: 'tool_failure',
    triggerPattern: 'some pattern',
    action: 'some action',
    source: 'test-compilation-retry',
    ...(evaluability ? { evaluability } : {}),
  });
  expect(id).not.toBeNull();
  return id as string;
}

// ---------------------------------------------------------------------------
// createPrincipleFromDiagnosis — compilationRetryCount retired (PRI-737)
// The counter had zero readers after the worker heartbeat backfill retired;
// the reducer no longer persists any retry state (single-attempt compile,
// COMPILE_FAILED log is the only record).
// ---------------------------------------------------------------------------
describe('createPrincipleFromDiagnosis — compilationRetryCount retired (PRI-737)', () => {
  it('does not persist compilationRetryCount when evaluability is weak_heuristic', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = createPrinciple(reducer, 'weak_heuristic', '-wh');
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id];
    expect(principle).toBeDefined();
    // No retry-state is written anymore (counter retired in PRI-737)
    expect(principle?.compilationRetryCount).toBeUndefined();
  });

  it('does not persist compilationRetryCount when evaluability is deterministic', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = createPrinciple(reducer, 'deterministic', '-det');
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id];
    expect(principle).toBeDefined();
    expect(principle?.compilationRetryCount).toBeUndefined();
  });

  it('does not persist compilationRetryCount when evaluability is manual_only', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = createPrinciple(reducer, 'manual_only', '-mo');
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id];
    expect(principle).toBeDefined();
    expect(principle?.compilationRetryCount).toBeUndefined();
    expect(principle?.evaluability).toBe('manual_only');
  });

  it('does not persist compilationRetryCount when no evaluability provided (default)', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = createPrinciple(reducer, undefined, '-default');
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id];
    expect(principle).toBeDefined();
    expect(principle?.compilationRetryCount).toBeUndefined();
    expect(principle?.evaluability).toBe('weak_heuristic');
  });
});

// ---------------------------------------------------------------------------
// Principle schema — legacy compilationRetryCount values remain readable
// (old workspaces may carry the field; it must not break ledger load/write)
// ---------------------------------------------------------------------------

describe('Principle schema — legacy compilationRetryCount values remain readable', () => {
  it('a legacy compilationRetryCount value survives a ledger round-trip', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = createPrinciple(reducer, 'weak_heuristic', '-legacy');

    // Simulate legacy data written by the pre-PRI-737 worker chain.
    updatePrinciple(stateDir, id, { compilationRetryCount: 3 });
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id];
    expect(principle).toBeDefined();
    expect(principle?.compilationRetryCount).toBe(3);
  });
});
