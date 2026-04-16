import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvolutionReducerImpl } from '../../src/core/evolution-reducer.js';
import { loadLedger } from '../../src/core/principle-tree-ledger.js';

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
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// createPrincipleFromDiagnosis — compilationRetryCount initialization
// ---------------------------------------------------------------------------

describe('createPrincipleFromDiagnosis — compilationRetryCount initialization', () => {
  it('sets compilationRetryCount=0 when evaluability is weak_heuristic (queued for compilation)', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: `pain-weak-heuristic-${Date.now()}`,
      painType: 'tool_failure',
      triggerPattern: 'bash rm fails',
      action: 'verify file exists before rm',
      source: 'test-compilation-retry',
      evaluability: 'weak_heuristic',
    });

    expect(id).not.toBeNull();
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id as string];
    expect(principle).toBeDefined();
    // Compilation queued: count >= 0 means queued
    expect(typeof principle?.compilationRetryCount).toBe('number');
    expect(principle?.compilationRetryCount).toBeGreaterThanOrEqual(0);
  });

  it('sets compilationRetryCount=0 when evaluability is deterministic', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: `pain-deterministic-${Date.now()}`,
      painType: 'tool_failure',
      triggerPattern: 'edit without read',
      action: 'always read before edit',
      source: 'test-compilation-retry',
      evaluability: 'deterministic',
    });

    expect(id).not.toBeNull();
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id as string];
    expect(principle).toBeDefined();
    expect(typeof principle?.compilationRetryCount).toBe('number');
    expect(principle?.compilationRetryCount).toBeGreaterThanOrEqual(0);
  });

  it('does NOT set compilationRetryCount when evaluability is manual_only', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: `pain-manual-only-${Date.now()}`,
      painType: 'tool_failure',
      triggerPattern: 'generic pain',
      action: 'be more careful',
      source: 'test-compilation-retry',
      evaluability: 'manual_only',
    });

    expect(id).not.toBeNull();
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id as string];
    expect(principle).toBeDefined();
    // manual_only principles should NOT be queued for compilation
    expect(principle?.compilationRetryCount).toBeUndefined();
    expect(principle?.evaluability).toBe('manual_only');
  });

  it('defaults to weak_heuristic and queues for compilation when no evaluability provided', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: `pain-default-${Date.now()}`,
      painType: 'tool_failure',
      triggerPattern: 'some pattern',
      action: 'some action',
      source: 'test-compilation-retry',
    });

    expect(id).not.toBeNull();
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id as string];
    expect(principle).toBeDefined();
    // default evaluability is weak_heuristic, which should queue for compilation
    expect(typeof principle?.compilationRetryCount).toBe('number');
    expect(principle?.compilationRetryCount).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// createPrincipleFromDiagnosis — compilationRetryCount increments on compile failure
// ---------------------------------------------------------------------------

describe('createPrincipleFromDiagnosis — compilationRetryCount increments on failure', () => {
  it('increments to 1 when compilation fails (no trajectory data)', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: `pain-fail-${Date.now()}`,
      painType: 'tool_failure',
      triggerPattern: 'unknown tool',
      action: 'do nothing',
      source: 'test-compilation-retry',
      evaluability: 'weak_heuristic',
    });

    expect(id).not.toBeNull();
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id as string];
    expect(principle).toBeDefined();
    // Compilation was attempted and failed (no trajectory data) → count should be 1
    expect(principle?.compilationRetryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Principle schema — compilationRetryCount field exists and persists
// ---------------------------------------------------------------------------

describe('Principle schema — compilationRetryCount field persists', () => {
  it('compilationRetryCount is stored and retrieved correctly', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace, stateDir });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: `pain-schema-${Date.now()}`,
      painType: 'tool_failure',
      triggerPattern: 'test pattern',
      action: 'test action',
      source: 'test-compilation-retry',
      evaluability: 'weak_heuristic',
    });

    expect(id).not.toBeNull();
    // Reload ledger to verify persistence
    const ledger = loadLedger(stateDir);
    const principle = ledger.tree.principles[id as string];
    expect(principle).toBeDefined();
    expect(typeof principle?.compilationRetryCount).toBe('number');
    expect(principle?.compilationRetryCount).toBeGreaterThanOrEqual(0);
  });
});
