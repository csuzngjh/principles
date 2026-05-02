/**
 * PainChainReadModel unit tests.
 *
 * Tests the read model's external contract via mocked RuntimeStateManager and ledger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WORKSPACE = '/tmp/ws';

// Shared mutable mock state
const S = {
  task: null as { taskId: string; status: string; createdAt: string; lastError?: string | null } | null,
  runs: [] as { runId: string; taskId: string; startedAt: string; endedAt: string }[],
  artifactRow: undefined as { artifact_id: string; created_at: string } | undefined,
  candidates: [] as { candidateId: string; status: string; createdAt: string }[],
  ledgerPrinciples: [] as { id: string; derivedFromPainIds?: string[]; createdAt?: string }[],
  initError: null as Error | null,
};

function makeDb() {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((..._args: unknown[]) => {
        if (sql.includes('artifacts') && sql.includes('run_id')) return S.artifactRow;
        return undefined;
      }),
      all: vi.fn(() => []),
    })),
  };
}

function makeMgr() {
  const mgr = {
    initialize: vi.fn(async () => { if (S.initError) throw S.initError; }),
    getTask: vi.fn(async (_id: string) => S.task),
    getRunsByTask: vi.fn(async (_id: string) => S.runs),
    getCandidatesByTaskId: vi.fn(async (_id: string) => S.candidates),
    connection: { getDb: vi.fn(() => makeDb()) },
    close: vi.fn(async () => { return; }),
  };
  // getStateManager is called on the class instance, not the raw class
  (mgr as Record<string, unknown>).getStateManager = vi.fn(async () => mgr);
  return mgr;
}

vi.mock('../store/runtime-state-manager.js', () => ({
  RuntimeStateManager: vi.fn(() => makeMgr()),
}));

vi.mock('../../principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(() => ({
    tree: { principles: Object.fromEntries(S.ledgerPrinciples.map(p => [p.id, p])) },
  })),
}));

import { PainChainReadModel } from '../pain-chain-read-model.js';

function reset() {
  S.task = null;
  S.runs = [];
  S.artifactRow = undefined;
  S.candidates = [];
  S.ledgerPrinciples = [];
  S.initError = null;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('PainChainReadModel', () => {
  beforeEach(() => { reset(); });

  it('init failure: error status with runtime_unavailable', async () => {
    S.initError = new Error('disk unavailable');
    const model = new PainChainReadModel({ workspaceDir: WORKSPACE });
    const trace = await model.traceByPainId('pain-001');
    expect(trace.status).toBe('error');
    expect(trace.failureCategory).toBe('runtime_unavailable');
    expect(trace.missingLinks).toContain('internal_error');
    await model.close();
  });

  it('getLastSuccessfulChain: init failure returns undefined', async () => {
    S.initError = new Error('disk unavailable');
    const model = new PainChainReadModel({ workspaceDir: WORKSPACE });
    const chain = await model.getLastSuccessfulChain();
    expect(chain).toBeUndefined();
    await model.close();
  });

  it('getLastSuccessfulChain: no succeeded tasks returns undefined', async () => {
    const model = new PainChainReadModel({ workspaceDir: WORKSPACE });
    const chain = await model.getLastSuccessfulChain();
    expect(chain).toBeUndefined();
    await model.close();
  });
});
