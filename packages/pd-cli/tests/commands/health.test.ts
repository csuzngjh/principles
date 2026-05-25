/**
 * pd health command unit tests.
 *
 * Tests the health command's external contract via mocked read models.
 * Tests JSON/text output formatting, exit code behavior, and error handling.
 * Note: PainChainReadModel is only created when state.db exists.
 * These tests focus on the PruningReadModel and auditCandidateLedgerConsistency layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPruningGetHealthSummary, mockAuditCandidateLedgerConsistency } = vi.hoisted(() => {
  return {
    mockPruningGetHealthSummary: vi.fn(),
    mockAuditCandidateLedgerConsistency: vi.fn(),
  };
});

vi.mock('@principles/core/runtime-v2', () => ({
  PruningReadModel: vi.fn().mockImplementation(function () {
    return { getHealthSummary: mockPruningGetHealthSummary };
  }),
  PainChainReadModel: vi.fn().mockImplementation(function () {
    return { getLastSuccessfulChain: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
  }),
  auditCandidateLedgerConsistency: mockAuditCandidateLedgerConsistency,
  getLedgerFilePathPublic: vi.fn().mockReturnValue('/fake/workspace/.state/principle_training_state.json'),
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

import { handleHealth } from '../../src/commands/health.js';

const WS = '/fake/workspace';

function healthyPruningSummary() {
  return {
    totalPrinciples: 5,
    byStatus: { probation: 3, active: 2 },
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
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('outputs health report with pruning summary and audit results', async () => {
    mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
    mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });

    await handleHealth({ workspace: WS, json: true });

    expect(consoleLogSpy).toHaveBeenCalled();
    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.generatedAt).toBeDefined();
    expect(jsonOutput.workspace).toBe(WS);
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
    expect(allOutput).toContain(`workspace: ${WS}`);
    expect(allOutput).toContain('ledger.totalPrinciples: 5');
    expect(allOutput).toContain('candidateLedgerConsistency.status: ok');
    expect(allOutput).toContain('pdStateDb.exists: false');
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

  it('calls PruningReadModel.getHealthSummary', async () => {
    mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
    mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });

    await handleHealth({ workspace: WS, json: true });

    expect(mockPruningGetHealthSummary).toHaveBeenCalled();
  });

  it('calls auditCandidateLedgerConsistency', async () => {
    mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
    mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });

    await handleHealth({ workspace: WS, json: true });

    expect(mockAuditCandidateLedgerConsistency).toHaveBeenCalled();
  });

  it('reports zero counts when database does not exist', async () => {
    mockPruningGetHealthSummary.mockReturnValue(healthyPruningSummary());
    mockAuditCandidateLedgerConsistency.mockResolvedValue({ missingLedgerCount: 0 });

    await handleHealth({ workspace: WS, json: false });

    const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allOutput).toContain('candidates.total: 0');
    expect(allOutput).toContain('tasks.total: 0');
  });
});
