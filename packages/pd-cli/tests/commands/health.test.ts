/**
 * pd health command unit tests.
 *
 * Tests the health command's external contract via mocked read models.
 * Tests JSON/text output formatting, exit code behavior, and error handling.
 * Covers both the no-database path and the state.db path (PainChainReadModel).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

const {
  mockPruningGetHealthSummary,
  mockAuditCandidateLedgerConsistency,
  mockGetLastSuccessfulChain,
  mockPainChainClose,
  mockExistsSync,
  mockDbPrepare,
  mockDbAll,
  mockDbClose,
} = vi.hoisted(() => {
  return {
    mockPruningGetHealthSummary: vi.fn(),
    mockAuditCandidateLedgerConsistency: vi.fn(),
    mockGetLastSuccessfulChain: vi.fn(),
    mockPainChainClose: vi.fn().mockResolvedValue(undefined),
    mockExistsSync: vi.fn(),
    mockDbPrepare: vi.fn(),
    mockDbAll: vi.fn(),
    mockDbClose: vi.fn(),
  };
});

vi.mock('@principles/core/runtime-v2', () => ({
  // PRI-634-F R2: full-module mocks must track new public exports — the
  // activation graph imports buildToolSemanticRegistry transitively
  // (workspace-tool-semantics), and vitest throws on the missing property
  // access at import time even when never called.
  buildToolSemanticRegistry: vi.fn().mockReturnValue({ ok: true, registry: {} }),
  PruningReadModel: vi.fn().mockImplementation(function () {
    return { getHealthSummary: mockPruningGetHealthSummary };
  }),
  PainChainReadModel: vi.fn().mockImplementation(function () {
    return { getLastSuccessfulChain: mockGetLastSuccessfulChain, close: mockPainChainClose };
  }),
  auditCandidateLedgerConsistency: mockAuditCandidateLedgerConsistency,
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
  // host-runtime's workspace-telemetry-emitter (transitively imported via the
  // host-runtime barrel) extends this class at module-load time — the mock
  // must provide a constructible base or the import chain throws.
  StoreEventEmitter: class {},
}));

// PRI-443 Phase 5: getLedgerFilePathPublic now imported from
// @principles/core/principle-tree-ledger (I/O module) instead of runtime-v2 barrel
vi.mock('@principles/core/principle-tree-ledger', () => ({
  getLedgerFilePathPublic: vi.fn().mockReturnValue('/fake/workspace/.state/principle_training_state.json'),
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

// PRI-662: the reliability section reads REAL declaration files through the
// host-runtime seam — mock the three functions (this file mocks `fs`
// wholesale, so the real loader cannot run here). Real-file coverage lives in
// health-reliability.test.ts.
const { mockLoadHostToolDeclarations, mockResolveWorkspaceHostToolSemantics, mockCreateEvaluatorRuntimeContext } = vi.hoisted(() => {
  return {
    mockLoadHostToolDeclarations: vi.fn().mockReturnValue({
      ok: true,
      declarations: [
        { version: 1, hostKind: 'openclaw', mappings: [{}, {}, {}], declaredAt: '2026-09-04T00:00:00.000Z' },
      ],
    }),
    mockResolveWorkspaceHostToolSemantics: vi.fn().mockReturnValue({ ok: true, registry: {}, hostKinds: ['openclaw'] }),
    mockCreateEvaluatorRuntimeContext: vi.fn().mockReturnValue({ ok: true, gateDeps: {} }),
  };
});
vi.mock('@principles/host-runtime', () => ({
  loadHostToolDeclarations: mockLoadHostToolDeclarations,
  resolveWorkspaceHostToolSemantics: mockResolveWorkspaceHostToolSemantics,
  createEvaluatorRuntimeContext: mockCreateEvaluatorRuntimeContext,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      return {
        prepare: mockDbPrepare.mockReturnValue({ all: mockDbAll }),
        close: mockDbClose,
      };
    }),
  };
});

import { handleHealth } from '../../src/commands/health.js';

const WS = '/fake/workspace';

function healthyPruningSummary() {
  return {
    totalPrinciples: 5,
    byStatus: { probation: 3, active: 2 },
  };
}

function healthyLastChain() {
  return {
    painId: 'pain_001',
    taskId: 'diagnosis_pain_001',
    runId: 'run_001',
    artifactId: 'art_001',
    candidateIds: ['c1'],
    ledgerEntryIds: ['l1'],
    status: 'succeeded',
    latencyMs: {
      painToTask: 100,
      taskToRun: 200,
      runToArtifact: 50,
    },
    failureCategory: null,
    checkedAt: '2026-05-03T12:00:00.000Z',
    missingLinks: [],
  };
}

function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
}

describe('handleHealth', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('without state.db', () => {
    it('outputs health report with pruning summary and audit results', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });

      await handleHealth({ workspace: WS, json: true });

      expect(consoleLogSpy).toHaveBeenCalled();
      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.generatedAt).toBeDefined();
      expect(jsonOutput.workspace).toBe(path.resolve(WS));
      expect(jsonOutput.ledger.totalPrinciples).toBe(5);
      expect(jsonOutput.ledger.byStatus).toEqual({ probation: 3, active: 2 });
      expect(jsonOutput.candidateLedgerConsistency.status).toBe('ok');
      expect(jsonOutput.candidateLedgerConsistency.missing).toBe(0);
      expect(jsonOutput.pdStateDb.exists).toBe(false);
    });

    it('outputs readable text format', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });

      await handleHealth({ workspace: WS, json: false });

      const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allOutput).toContain(`workspace: ${path.resolve(WS)}`);
      expect(allOutput).toContain('ledger.totalPrinciples: 5');
      expect(allOutput).toContain('candidateLedgerConsistency.status: ok');
      expect(allOutput).toContain('pdStateDb.exists: false');
    });

    it('reports the reliability readiness section (PRI-662) — declared workspace', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });

      await handleHealth({ workspace: WS, json: true });

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.reliability).toEqual({
        registry: { status: 'ok', hosts: ['openclaw'], declaredTools: 3 },
        resolver: 'ready',
        replay: 'ready',
      });
    });

    it('reports reliability as explicitly degraded (host_tool_declaration_missing) without failing health', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockLoadHostToolDeclarations.mockReturnValueOnce({
        ok: false,
        reason: 'host_tool_declaration_missing',
        nextAction: 'start each workspace host once (OpenClaw plugin / Codex worker) so it persists its tool declaration',
      });
      mockResolveWorkspaceHostToolSemantics.mockReturnValueOnce({
        ok: false,
        reason: 'host_tool_declaration_missing',
        nextAction: 'start each workspace host once (OpenClaw plugin / Codex worker) so it persists its tool declaration',
      });
      mockCreateEvaluatorRuntimeContext.mockReturnValueOnce({
        ok: false,
        reason: 'host_tool_declaration_missing',
        nextAction: 'start each workspace host once (OpenClaw plugin / Codex worker) so it persists its tool declaration',
      });

      await handleHealth({ workspace: WS, json: false });

      const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allOutput).toContain('reliability.registry.status: degraded');
      expect(allOutput).toContain('reliability.resolver: not_ready');
      expect(allOutput).toContain('reliability.replay: not_ready');
      expect(allOutput).toContain('reliability.reason: host_tool_declaration_missing');
      // Fresh-install expected state: informational only, health exit code unchanged.
      expect(process.exitCode).toBeUndefined();
      expect(consoleWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('DEGRADED'));
    });

    it('reports zero candidate and task counts', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });

      await handleHealth({ workspace: WS, json: false });

      const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allOutput).toContain('candidates.total: 0');
      expect(allOutput).toContain('tasks.total: 0');
    });

    it('reports degraded consistency with exit code 1', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 2 });
      const exitSpy = mockProcessExit();

      await handleHealth({ workspace: WS, json: false });

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('DEGRADED'));
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });

    it('outputs degraded consistency JSON with exit code 1', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 2 });
      const exitSpy = mockProcessExit();

      await handleHealth({ workspace: WS, json: true });

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.candidateLedgerConsistency.status).toBe('degraded');
      expect(jsonOutput.candidateLedgerConsistency.missing).toBe(2);
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });

    it('does not include lastSuccessfulChain when no database exists', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });

      await handleHealth({ workspace: WS, json: true });

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.lastSuccessfulChain).toBeUndefined();
    });
  });

  describe('with state.db', () => {
    beforeEach(() => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p.includes('state.db')) return true;
        return false;
      });
      mockDbPrepare.mockReturnValue({ all: mockDbAll });
      mockDbAll.mockReturnValue([]);
    });

    it('reads candidate counts from database', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockDbAll
        .mockReturnValueOnce([{ total: 3, status: 'consumed' }, { total: 2, status: 'pending' }])
        .mockReturnValueOnce([]);

      await handleHealth({ workspace: WS, json: true });

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.pdStateDb.exists).toBe(true);
      expect(jsonOutput.candidates.total).toBe(5);
      expect(jsonOutput.candidates.consumed).toBe(3);
      expect(jsonOutput.candidates.pending).toBe(2);
    });

    it('reads task counts from database', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockDbAll
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ total: 4, status: 'succeeded' }, { total: 1, status: 'failed' }]);

      await handleHealth({ workspace: WS, json: true });

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.tasks.total).toBe(5);
      expect(jsonOutput.tasks.byStatus).toEqual({ succeeded: 4, failed: 1 });
    });

    it('includes lastSuccessfulChain from PainChainReadModel', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockGetLastSuccessfulChain.mockResolvedValue(healthyLastChain());

      await handleHealth({ workspace: WS, json: true });

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.lastSuccessfulChain).toBeDefined();
      expect(jsonOutput.lastSuccessfulChain.taskId).toBe('diagnosis_pain_001');
      expect(jsonOutput.lastSuccessfulChain.runId).toBe('run_001');
      expect(jsonOutput.lastSuccessfulChain.artifactId).toBe('art_001');
      expect(jsonOutput.lastSuccessfulChain.candidateIds).toEqual(['c1']);
      expect(jsonOutput.lastSuccessfulChain.ledgerEntryIds).toEqual(['l1']);
    });

    it('computes totalMs latency from chain trace', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockGetLastSuccessfulChain.mockResolvedValue(healthyLastChain());

      await handleHealth({ workspace: WS, json: true });

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.lastSuccessfulChain.latencyMs).toBeDefined();
      expect(jsonOutput.lastSuccessfulChain.latencyMs.totalMs).toBe(350);
    });

    it('closes PainChainReadModel after use', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockGetLastSuccessfulChain.mockResolvedValue(healthyLastChain());

      await handleHealth({ workspace: WS, json: true });

      expect(mockPainChainClose).toHaveBeenCalled();
    });

    it('closes database after use', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockGetLastSuccessfulChain.mockResolvedValue(healthyLastChain());

      await handleHealth({ workspace: WS, json: true });

      expect(mockDbClose).toHaveBeenCalled();
    });

    it('sets partialHealth when PainChainReadModel throws', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockGetLastSuccessfulChain.mockRejectedValue(new Error('Chain read error'));

      await handleHealth({ workspace: WS, json: true });

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.partialHealth).toBe(true);
      expect(jsonOutput.lastSuccessfulChain).toBeUndefined();
    });

    it('sets partialHealth when database read throws', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockDbPrepare.mockImplementation(() => { throw new Error('Corrupt DB'); });

      await handleHealth({ workspace: WS, json: true });

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.partialHealth).toBe(true);
    });

    it('handles missing lastSuccessfulChain gracefully', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockGetLastSuccessfulChain.mockResolvedValue(undefined);

      await handleHealth({ workspace: WS, json: true });

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.lastSuccessfulChain).toBeUndefined();
    });

    it('includes lastSuccessfulChain in text output', async () => {
      mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
      mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });
      mockGetLastSuccessfulChain.mockResolvedValue(healthyLastChain());

      await handleHealth({ workspace: WS, json: false });

      const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allOutput).toContain('lastSuccessfulChain:');
      expect(allOutput).toContain('taskId:');
      expect(allOutput).toContain('diagnosis_pain_001');
    });
  });
});
