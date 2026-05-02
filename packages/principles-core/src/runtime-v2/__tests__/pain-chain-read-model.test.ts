/**
 * PainChainReadModel unit tests.
 *
 * Tests the read model's external contract via dependency-injected RuntimeStateManager.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { PainChainReadModel } from '../pain-chain-read-model.js';

const WORKSPACE = '/tmp/ws';

let ledgerData: { tree: { principles: Record<string, unknown> } } = { tree: { principles: {} } };

vi.mock('../../principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(() => ledgerData),
}));

function setLedgerData(data: typeof ledgerData) {
  ledgerData = data;
}

function resetLedgerData() {
  ledgerData = { tree: { principles: {} } };
}

function makeMockManager(overrides?: {
  task?: { taskId: string; status: string; createdAt: string; lastError?: string | null } | null;
  runs?: { runId: string; taskId: string; startedAt: string; endedAt: string }[];
  artifactRow?: { artifact_id: string; created_at: string } | undefined;
  candidates?: { candidateId: string; status: string; createdAt: string }[];
  initError?: Error | null;
  dbQueries?: {
    lastSucceeded?: { task_id: string; input_ref: string | null; created_at: string } | undefined;
    run?: { run_id: string; started_at: string; ended_at: string } | undefined;
    artifact?: { artifact_id: string; created_at: string } | undefined;
  };
}) {
  const dbQueries = overrides?.dbQueries;
  const artifactRow = overrides?.artifactRow;
  const db = {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((..._args: unknown[]) => {
        if (sql.includes('tasks') && sql.includes('succeeded')) return dbQueries?.lastSucceeded;
        if (sql.includes('runs') && sql.includes('succeeded')) return dbQueries?.run;
        if (sql.includes('artifacts') && sql.includes('run_id')) return dbQueries?.artifact ?? artifactRow;
        return undefined;
      }),
      all: vi.fn(() => []),
    })),
  };
  return {
    initialize: vi.fn(async () => { if (overrides?.initError) throw overrides.initError; }),
    getTask: vi.fn(async () => overrides?.task ?? null),
    getRunsByTask: vi.fn(async () => overrides?.runs ?? []),
    getCandidatesByTaskId: vi.fn(async () => overrides?.candidates ?? []),
    connection: { getDb: vi.fn(() => db) },
    close: vi.fn(async () => { /* noop */ }),
  } as unknown as RuntimeStateManager;
}

const TASK_SUCCEEDED = {
  taskId: 'diagnosis_pain-001',
  status: 'succeeded',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastError: null as string | null,
};

const RUN_SUCCEEDED = {
  runId: 'run-001',
  taskId: 'diagnosis_pain-001',
  startedAt: '2026-01-01T00:01:00.000Z',
  endedAt: '2026-01-01T00:05:00.000Z',
};

const ARTIFACT_ROW = {
  artifact_id: 'art-001',
  created_at: '2026-01-01T00:05:30.000Z',
};

const CANDIDATE_CONSUMED = {
  candidateId: 'c1',
  status: 'consumed',
  createdAt: '2026-01-01T00:06:00.000Z',
};

const CANDIDATES_CONSUMED = [
  { candidateId: 'c2', status: 'consumed', createdAt: '2026-01-01T00:08:00.000Z' },
  { candidateId: 'c1', status: 'consumed', createdAt: '2026-01-01T00:06:00.000Z' },
  { candidateId: 'c3', status: 'consumed', createdAt: '2026-01-01T00:07:00.000Z' },
];

const LEDGER_WITH_ENTRY = {
  tree: {
    principles: {
      'l1': { id: 'l1', derivedFromPainIds: ['c1'], createdAt: '2026-01-01T00:07:00.000Z' },
    },
  },
};

const LEDGER_WITH_MULTI_ENTRY = {
  tree: {
    principles: {
      'l1': { id: 'l1', derivedFromPainIds: ['c1', 'c2', 'c3'], createdAt: '2026-01-01T00:10:00.000Z' },
    },
  },
};

describe('PainChainReadModel', () => {
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let model: PainChainReadModel;

  beforeEach(() => {
    vi.clearAllMocks();
    resetLedgerData();
  });

  // ── traceByPainId ──────────────────────────────────────────────────────

  it('traceByPainId: init failure returns error status', async () => {
    const mgr = makeMockManager({ initError: new Error('database is locked') });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const trace = await model.traceByPainId('pain-001');
    expect(trace.status).toBe('error');
    expect(trace.failureCategory).toBe('runtime_unavailable');
    expect(trace.missingLinks).toContain('internal_error');
    await model.close();
  });

  it('traceByPainId: config error returns config_missing', async () => {
    const mgr = makeMockManager({ initError: new Error('API key not found in env') });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const trace = await model.traceByPainId('pain-001');
    expect(trace.status).toBe('error');
    expect(trace.failureCategory).toBe('config_missing');
    expect(trace.missingLinks).toContain('state_manager_init');
    await model.close();
  });

  it('traceByPainId: no task returns not_found', async () => {
    const mgr = makeMockManager({ task: null });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const trace = await model.traceByPainId('pain-001');
    expect(trace.status).toBe('not_found');
    expect(trace.failureCategory).toBe('runtime_unavailable');
    expect(trace.missingLinks).toContain('task');
    expect(trace.painId).toBe('pain-001');
    expect(trace.taskId).toBe('diagnosis_pain-001');
    await model.close();
  });

  it('traceByPainId: full chain success with latency', async () => {
    setLedgerData(LEDGER_WITH_ENTRY);
    const mgr = makeMockManager({
      task: TASK_SUCCEEDED,
      runs: [RUN_SUCCEEDED],
      artifactRow: ARTIFACT_ROW,
      candidates: [CANDIDATE_CONSUMED],
    });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const trace = await model.traceByPainId('pain-001');
    expect(trace.status).toBe('succeeded');
    expect(trace.painId).toBe('pain-001');
    expect(trace.runId).toBe('run-001');
    expect(trace.artifactId).toBe('art-001');
    expect(trace.candidateIds).toEqual(['c1']);
    expect(trace.ledgerEntryIds).toEqual(['l1']);
    expect(trace.latencyMs.painToTask).toBe(60000);
    expect(trace.latencyMs.taskToRun).toBe(240000);
    expect(trace.latencyMs.runToArtifact).toBe(30000);
    expect(trace.latencyMs.artifactToCandidate).toBe(30000);
    expect(trace.latencyMs.candidateToLedger).toBe(60000);
    expect(trace.missingLinks).toEqual([]);
    await model.close();
  });

  it('traceByPainId: failed task with errorCategory', async () => {
    const mgr = makeMockManager({
      task: { ...TASK_SUCCEEDED, status: 'failed', lastError: 'timeout' },
      runs: [],
      candidates: [],
    });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const trace = await model.traceByPainId('pain-001');
    expect(trace.status).toBe('failed');
    expect(trace.failureCategory).toBe('runtime_timeout');
    await model.close();
  });

  it('traceByPainId: failed task with JSON lastError', async () => {
    const mgr = makeMockManager({
      task: { ...TASK_SUCCEEDED, status: 'failed', lastError: JSON.stringify({ category: 'execution_failed' }) },
      runs: [],
      candidates: [],
    });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const trace = await model.traceByPainId('pain-001');
    expect(trace.status).toBe('failed');
    expect(trace.failureCategory).toBe('runtime_unavailable');
    await model.close();
  });

  it('traceByPainId: succeeded task with no candidates → candidate_missing', async () => {
    const mgr = makeMockManager({
      task: TASK_SUCCEEDED,
      runs: [RUN_SUCCEEDED],
      artifactRow: ARTIFACT_ROW,
      candidates: [],
    });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const trace = await model.traceByPainId('pain-001');
    expect(trace.status).toBe('failed');
    expect(trace.failureCategory).toBe('candidate_missing');
    expect(trace.missingLinks.length).toBeGreaterThan(0);
    await model.close();
  });

  it('traceByPainId: consumed candidate missing from ledger → degraded + missingLinks', async () => {
    const mgr = makeMockManager({
      task: TASK_SUCCEEDED,
      runs: [RUN_SUCCEEDED],
      artifactRow: ARTIFACT_ROW,
      candidates: [CANDIDATE_CONSUMED],
    });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const trace = await model.traceByPainId('pain-001');
    expect(trace.status).toBe('degraded');
    expect(trace.failureCategory).toBe('ledger_write_failed');
    expect(trace.missingLinks).toEqual(
      expect.arrayContaining([expect.stringContaining('consumed but missing from ledger')])
    );
    await model.close();
  });

  it('traceByPainId: multiple candidates ordered by createdAt DESC — uses earliest for artifactToCandidate', async () => {
    setLedgerData(LEDGER_WITH_MULTI_ENTRY);
    const mgr = makeMockManager({
      task: TASK_SUCCEEDED,
      runs: [RUN_SUCCEEDED],
      artifactRow: ARTIFACT_ROW,
      candidates: CANDIDATES_CONSUMED,
    });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const trace = await model.traceByPainId('pain-001');
    expect(trace.status).toBe('succeeded');
    expect(trace.candidateIds).toEqual(['c2', 'c1', 'c3']);
    expect(trace.ledgerEntryIds).toEqual(['l1']);
    expect(trace.latencyMs.artifactToCandidate).toBe(30000);
    expect(trace.latencyMs.candidateToLedger).toBe(120000);
    await model.close();
  });

  // ── getLastSuccessfulChain ─────────────────────────────────────────────

  it('getLastSuccessfulChain: init failure returns undefined', async () => {
    const mgr = makeMockManager({ initError: new Error('database is locked') });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const chain = await model.getLastSuccessfulChain();
    expect(chain).toBeUndefined();
    await model.close();
  });

  it('getLastSuccessfulChain: no succeeded tasks returns undefined', async () => {
    const mgr = makeMockManager({ dbQueries: { lastSucceeded: undefined } });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const chain = await model.getLastSuccessfulChain();
    expect(chain).toBeUndefined();
    await model.close();
  });

  it('getLastSuccessfulChain: full chain with segment latencies', async () => {
    setLedgerData(LEDGER_WITH_ENTRY);
    const mgr = makeMockManager({
      candidates: [CANDIDATE_CONSUMED],
      dbQueries: {
        lastSucceeded: { task_id: 'diagnosis_pain-001', input_ref: 'pain-001', created_at: '2026-01-01T00:00:00.000Z' },
        run: { run_id: 'run-001', started_at: '2026-01-01T00:01:00.000Z', ended_at: '2026-01-01T00:05:00.000Z' },
        artifact: { artifact_id: 'art-001', created_at: '2026-01-01T00:05:30.000Z' },
      },
    });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const chain = await model.getLastSuccessfulChain();
    expect(chain).toBeDefined();
    if (!chain) return;
    expect(chain.status).toBe('succeeded');
    expect(chain.painId).toBe('pain-001');
    expect(chain.runId).toBe('run-001');
    expect(chain.artifactId).toBe('art-001');
    expect(chain.latencyMs.painToTask).toBe(60000);
    expect(chain.latencyMs.taskToRun).toBe(240000);
    expect(chain.latencyMs.runToArtifact).toBe(30000);
    await model.close();
  });

  it('getLastSuccessfulChain: no run returns undefined', async () => {
    const mgr = makeMockManager({
      candidates: [CANDIDATE_CONSUMED],
      dbQueries: {
        lastSucceeded: { task_id: 'diagnosis_pain-001', input_ref: 'pain-001', created_at: '2026-01-01T00:00:00.000Z' },
        run: undefined,
      },
    });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const chain = await model.getLastSuccessfulChain();
    expect(chain).toBeUndefined();
    await model.close();
  });

  it('getLastSuccessfulChain: multiple candidates — uses earliest for artifactToCandidate', async () => {
    setLedgerData(LEDGER_WITH_MULTI_ENTRY);
    const mgr = makeMockManager({
      candidates: CANDIDATES_CONSUMED,
      dbQueries: {
        lastSucceeded: { task_id: 'diagnosis_pain-001', input_ref: 'pain-001', created_at: '2026-01-01T00:00:00.000Z' },
        run: { run_id: 'run-001', started_at: '2026-01-01T00:01:00.000Z', ended_at: '2026-01-01T00:05:00.000Z' },
        artifact: { artifact_id: 'art-001', created_at: '2026-01-01T00:05:30.000Z' },
      },
    });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    const chain = await model.getLastSuccessfulChain();
    expect(chain).toBeDefined();
    if (!chain) return;
    expect(chain.status).toBe('succeeded');
    expect(chain.candidateIds).toEqual(['c2', 'c1', 'c3']);
    expect(chain.ledgerEntryIds).toEqual(['l1']);
    expect(chain.latencyMs.artifactToCandidate).toBe(30000);
    expect(chain.latencyMs.candidateToLedger).toBe(120000);
    await model.close();
  });

  // ── Dependency injection ───────────────────────────────────────────────

  it('does not close injected stateManager', async () => {
    const mgr = makeMockManager({ task: null });
    model = new PainChainReadModel({ workspaceDir: WORKSPACE, stateManager: mgr });
    await model.traceByPainId('pain-001');
    await model.close();
    expect(mgr.close).not.toHaveBeenCalled();
  });
});
