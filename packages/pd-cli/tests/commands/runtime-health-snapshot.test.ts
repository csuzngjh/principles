/**
 * pd runtime health snapshot CLI unit tests.
 *
 * Tests the CLI adapter layer: validation, OperatorHealthReadModel delegation,
 * JSON/text output formatting, and exit code behavior.
 * OperatorHealthReadModel is mocked — its own contract is tested in principles-core.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock setup ──────────────────────────────────────────────────────────────

const mockSnapshotFn = vi.fn();
const mockCloseFn = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  OperatorHealthReadModel: vi.fn().mockImplementation(function () {
    return { getSnapshot: mockSnapshotFn, close: mockCloseFn };
  }),
}));

import { handleRuntimeHealthSnapshot } from '../../src/commands/runtime-health-snapshot.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const WS = '/fake/workspace';

function healthySnapshot() {
  return {
    generatedAt: '2026-05-03T12:00:00.000Z',
    workspace: WS,
    painChain: {
      lastSuccessfulChain: {
        painId: 'pain_001',
        taskId: 'task_001',
        runId: 'run_001',
        artifactId: 'art_001',
        candidateIds: ['c1'],
        ledgerEntryIds: ['l1'],
        status: 'succeeded',
        latencyMs: { painToTask: 100 },
        failureCategory: null,
        checkedAt: '2026-05-03T12:00:00.000Z',
        missingLinks: [],
      },
      failureCategory: null,
    },
    candidateLedger: {
      auditStatus: 'ok' as const,
      orphanCandidateCount: 0,
      missingLedgerCount: 0,
    },
    pruning: {
      watchCount: 0,
      reviewCount: 0,
      orphanDerivedCandidateCount: 0,
    },
    gfi: {
      active: null,
      staleSessionCount: 0,
      staleGfiRange: null,
      totalSessionCount: 0,
      activeSessionCount: 0,
      generatedAt: '2026-05-03T12:00:00.000Z',
    },
    overallStatus: 'healthy' as const,
    recommendedActions: [],
    totalTaskCount: 1,
  };
}

function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('handleRuntimeHealthSnapshot', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // ── Healthy ──────────────────────────────────────────────────────────────

  it('outputs healthy JSON snapshot with all required fields (--json)', async () => {
    mockSnapshotFn.mockResolvedValue(healthySnapshot());

    await handleRuntimeHealthSnapshot({ workspace: WS, json: true });

    expect(consoleLogSpy).toHaveBeenCalled();
    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.generatedAt).toBe('2026-05-03T12:00:00.000Z');
    expect(jsonOutput.workspace).toBe(WS);
    expect(jsonOutput.painChain).toBeDefined();
    expect(jsonOutput.painChain.lastSuccessfulChain).toBeDefined();
    expect(jsonOutput.candidateLedger.auditStatus).toBe('ok');
    expect(jsonOutput.pruning.watchCount).toBe(0);
    expect(jsonOutput.overallStatus).toBe('healthy');
    expect(jsonOutput.recommendedActions).toEqual([]);
  });

  it('outputs readable text for healthy snapshot', async () => {
    mockSnapshotFn.mockResolvedValue(healthySnapshot());

    await handleRuntimeHealthSnapshot({ workspace: WS, json: false });

    const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allOutput).toContain('HEALTHY');
    expect(allOutput).toContain('No actions recommended');
  });

  // ── Degraded: candidate audit ────────────────────────────────────────────

  it('reflects candidate audit degraded in overallStatus', async () => {
    const snapshot = {
      ...healthySnapshot(),
      candidateLedger: {
        auditStatus: 'degraded' as const,
        orphanCandidateCount: 2,
        missingLedgerCount: 2,
      },
      overallStatus: 'degraded' as const,
      recommendedActions: [
        'Run `pd candidate audit --workspace <path> --json` for details.',
      ],
    };
    mockSnapshotFn.mockResolvedValue(snapshot);
    const exitSpy = mockProcessExit();

    await handleRuntimeHealthSnapshot({ workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.overallStatus).toBe('degraded');
    expect(jsonOutput.recommendedActions).toContain(
      'Run `pd candidate audit --workspace <path> --json` for details.',
    );
    expect(process.exitCode).toBe(1);

    exitSpy.mockRestore();
  });

  // ── Degraded: pruning signals ────────────────────────────────────────────

  it('reflects pruning watch/review signals in recommendedActions', async () => {
    const snapshot = {
      ...healthySnapshot(),
      pruning: {
        watchCount: 2,
        reviewCount: 1,
        orphanDerivedCandidateCount: 0,
      },
      overallStatus: 'degraded' as const,
      recommendedActions: [
        'Run `pd runtime pruning report --workspace <path> --json` for lifecycle signals.',
      ],
    };
    mockSnapshotFn.mockResolvedValue(snapshot);
    const exitSpy = mockProcessExit();

    await handleRuntimeHealthSnapshot({ workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.overallStatus).toBe('degraded');
    expect(jsonOutput.pruning.watchCount).toBe(2);
    expect(jsonOutput.recommendedActions).toContain(
      'Run `pd runtime pruning report --workspace <path> --json` for lifecycle signals.',
    );

    exitSpy.mockRestore();
  });

  // ── Degraded: no successful chain ────────────────────────────────────────

  it('recommends UAT baseline when no successful chain exists', async () => {
    const snapshot = {
      ...healthySnapshot(),
      painChain: {
        lastSuccessfulChain: null,
        failureCategory: null,
      },
      overallStatus: 'degraded' as const,
      recommendedActions: [
        'Run `pd runtime uat --workspace <path> --count 3` to establish baseline.',
      ],
    };
    mockSnapshotFn.mockResolvedValue(snapshot);
    const exitSpy = mockProcessExit();

    await handleRuntimeHealthSnapshot({ workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.painChain.lastSuccessfulChain).toBeNull();
    expect(jsonOutput.recommendedActions).toContain(
      'Run `pd runtime uat --workspace <path> --count 3` to establish baseline.',
    );

    exitSpy.mockRestore();
  });

  // ── Error ────────────────────────────────────────────────────────────────

  it('handles error status from missing state.db', async () => {
    const snapshot = {
      ...healthySnapshot(),
      candidateLedger: {
        auditStatus: 'error' as const,
        orphanCandidateCount: 0,
        missingLedgerCount: 0,
      },
      overallStatus: 'error' as const,
      recommendedActions: ['Initialize workspace with `pd pain record`.'],
    };
    mockSnapshotFn.mockResolvedValue(snapshot);
    const exitSpy = mockProcessExit();

    await handleRuntimeHealthSnapshot({ workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.overallStatus).toBe('error');
    expect(jsonOutput.candidateLedger.auditStatus).toBe('error');
    expect(process.exitCode).toBe(1);

    exitSpy.mockRestore();
  });

  // ── Multiple degraded conditions ─────────────────────────────────────────

  it('accumulates multiple recommendedActions for multiple issues', async () => {
    const snapshot = {
      ...healthySnapshot(),
      painChain: { lastSuccessfulChain: null, failureCategory: null },
      candidateLedger: {
        auditStatus: 'degraded' as const,
        orphanCandidateCount: 2,
        missingLedgerCount: 2,
      },
      pruning: { watchCount: 3, reviewCount: 1, orphanDerivedCandidateCount: 0 },
      overallStatus: 'degraded' as const,
      recommendedActions: [
        'Run `pd candidate audit --workspace <path> --json` for details.',
        'Run `pd runtime pruning report --workspace <path> --json` for lifecycle signals.',
        'Run `pd runtime uat --workspace <path> --count 3` to establish baseline.',
      ],
    };
    mockSnapshotFn.mockResolvedValue(snapshot);
    const exitSpy = mockProcessExit();

    await handleRuntimeHealthSnapshot({ workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.recommendedActions).toHaveLength(3);

    exitSpy.mockRestore();
  });

  // ── GFI section (PRI-83) ──────────────────────────────────────────────────

  it('includes gfi section in JSON output with active session data', async () => {
    const snapshot = {
      ...healthySnapshot(),
      gfi: {
        active: {
          currentGfi: 42,
          stage: 'elevated',
          dominantSource: 'tool_failure',
          consecutiveErrors: 2,
          dailyGfiPeak: 55,
          consumers: {
            attitudeMode: 'conciliatory',
            painDiagnosticReason: 'high_gfi',
          },
        },
        staleSessionCount: 1,
        staleGfiRange: { min: 10, max: 20 },
        totalSessionCount: 2,
        activeSessionCount: 1,
        generatedAt: '2026-05-03T12:00:00.000Z',
      },
    };
    mockSnapshotFn.mockResolvedValue(snapshot);

    await handleRuntimeHealthSnapshot({ workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.gfi).toBeDefined();
    expect(jsonOutput.gfi.active).not.toBeNull();
    expect(jsonOutput.gfi.active.currentGfi).toBe(42);
    expect(jsonOutput.gfi.active.stage).toBe('elevated');
    expect(jsonOutput.gfi.active.dominantSource).toBe('tool_failure');
    expect(jsonOutput.gfi.activeSessionCount).toBe(1);
    expect(jsonOutput.gfi.staleSessionCount).toBe(1);
  });

  it('includes compact GFI line in text output', async () => {
    const snapshot = {
      ...healthySnapshot(),
      gfi: {
        active: {
          currentGfi: 42,
          stage: 'elevated',
          dominantSource: 'tool_failure',
          consecutiveErrors: 2,
          dailyGfiPeak: 55,
          consumers: {
            attitudeMode: 'conciliatory',
            painDiagnosticReason: 'high_gfi',
          },
        },
        staleSessionCount: 0,
        staleGfiRange: null,
        totalSessionCount: 1,
        activeSessionCount: 1,
        generatedAt: '2026-05-03T12:00:00.000Z',
      },
    };
    mockSnapshotFn.mockResolvedValue(snapshot);

    await handleRuntimeHealthSnapshot({ workspace: WS, json: false });

    const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allOutput).toContain('gfi:');
    expect(allOutput).toContain('elevated');
    expect(allOutput).toContain('42');
  });

  it('shows no active sessions in text when gfi.active is null', async () => {
    mockSnapshotFn.mockResolvedValue(healthySnapshot());

    await handleRuntimeHealthSnapshot({ workspace: WS, json: false });

    const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allOutput).toContain('no active sessions');
  });

  it('does not mark runtime unhealthy solely for missing GFI data', async () => {
    mockSnapshotFn.mockResolvedValue(healthySnapshot());

    await handleRuntimeHealthSnapshot({ workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.gfi.active).toBeNull();
    expect(jsonOutput.overallStatus).toBe('healthy');
  });
});
