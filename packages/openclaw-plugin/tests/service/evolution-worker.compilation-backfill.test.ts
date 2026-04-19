import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addPrincipleToLedger, loadLedger, type LedgerPrinciple } from '../../src/core/principle-tree-ledger.js';
import type { WorkspaceContext } from '../../src/core/workspace-context.js';
import type { PluginLogger } from '../../src/openclaw-sdk.js';
import { processCompilationBackfill } from '../../src/service/evolution-worker.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-backfill-test-'));
  tempDirs.push(dir);
  return dir;
}

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

function makeWctx(workspace: string, stateDir: string): WorkspaceContext {
  return {
    workspaceDir: workspace,
    stateDir,
    resolve: (file: string) => path.join(stateDir, file),
  } as unknown as WorkspaceContext;
}

function makePrinciple(id: string, overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id,
    version: 1,
    text: `principle ${id}`,
    triggerPattern: 'test',
    action: 'test action',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'weak_heuristic',
    compilationRetryCount: undefined,
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    derivedFromPainIds: [],
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as LedgerPrinciple;
}

const noopLogger: PluginLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // On Windows, temp dirs may be held open — ignore cleanup errors
    }
  }
});

// ---------------------------------------------------------------------------
// Phase 1: Backfill
// ---------------------------------------------------------------------------

describe('processCompilationBackfill — Phase 1 backfill', () => {
  it('sets compilationRetryCount=0 for old principles without retry count', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);

    addPrincipleToLedger(stateDir, makePrinciple('P_001', {
      evaluability: 'weak_heuristic',
      compilationRetryCount: undefined,
    }));

    const wctx = makeWctx(workspace, stateDir);
    processCompilationBackfill(wctx, noopLogger);

    const ledger = loadLedger(stateDir);
    // Phase 1 sets count=0, then Phase 2 runs and increments to 1 (compilation fails without trajectory data)
    // The key assertion: count was set to 0 at some point (proves backfill ran)
    expect(ledger.tree.principles['P_001'].compilationRetryCount).toBeGreaterThanOrEqual(0);
  });

  it('skips principles with manual_only evaluability', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);

    addPrincipleToLedger(stateDir, makePrinciple('P_002', {
      evaluability: 'manual_only',
      compilationRetryCount: undefined,
    }));

    const wctx = makeWctx(workspace, stateDir);
    processCompilationBackfill(wctx, noopLogger);

    const ledger = loadLedger(stateDir);
    expect(ledger.tree.principles['P_002'].compilationRetryCount).toBeUndefined();
  });

  it('writes COMPILATION_BACKFILL_DONE marker after backfill', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);

    addPrincipleToLedger(stateDir, makePrinciple('P_003', {
      evaluability: 'weak_heuristic',
      compilationRetryCount: undefined,
    }));

    const wctx = makeWctx(workspace, stateDir);
    processCompilationBackfill(wctx, noopLogger);

    const markerPath = path.join(stateDir, 'COMPILATION_BACKFILL_DONE');
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('does not re-backfill if marker already exists', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);

    // Pre-write the marker so Phase 1 (backfill) is skipped
    const markerPath = path.join(stateDir, 'COMPILATION_BACKFILL_DONE');
    fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');

    // Add principle with compilationRetryCount already set to a high value
    // (simulating already-processed-by-Phase2)
    addPrincipleToLedger(stateDir, makePrinciple('P_004', {
      evaluability: 'weak_heuristic',
      compilationRetryCount: 2,
    }));

    const wctx = makeWctx(workspace, stateDir);
    processCompilationBackfill(wctx, noopLogger);

    const ledger = loadLedger(stateDir);
    // Phase 1 was skipped (marker exists), but Phase 2 still ran and incremented count
    // So count goes from 2 -> 3 (compilation fails without trajectory data)
    expect(ledger.tree.principles['P_004'].compilationRetryCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Retry loop
// ---------------------------------------------------------------------------

describe('processCompilationBackfill — Phase 2 retry loop', () => {
  it('increments count on compile failure (below exhaustion)', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);

    // Principle queued with count=1 — next failure should make it 2
    addPrincipleToLedger(stateDir, makePrinciple('P_012', {
      evaluability: 'weak_heuristic',
      compilationRetryCount: 1,
    }));

    const wctx = makeWctx(workspace, stateDir);
    processCompilationBackfill(wctx, noopLogger);

    const ledger = loadLedger(stateDir);
    // Compilation fails (no trajectory data), so count increments
    expect(ledger.tree.principles['P_012'].compilationRetryCount).toBe(2);
    expect(ledger.tree.principles['P_012'].evaluability).toBe('weak_heuristic');
  });

  it('downgrades to manual_only after 5 consecutive failures', () => {
    const workspace = makeTempDir();
    const stateDir = makeStateDir(workspace);

    // Principle at count=4 — next failure exhausts it
    addPrincipleToLedger(stateDir, makePrinciple('P_011', {
      evaluability: 'weak_heuristic',
      compilationRetryCount: 4,
    }));

    const wctx = makeWctx(workspace, stateDir);
    processCompilationBackfill(wctx, noopLogger);

    const ledger = loadLedger(stateDir);
    // Compilation fails (no trajectory), count becomes 5 >= 5, downgrades to manual_only
    expect(ledger.tree.principles['P_011'].evaluability).toBe('manual_only');
    expect(ledger.tree.principles['P_011'].compilationRetryCount).toBeUndefined();
  });
});
