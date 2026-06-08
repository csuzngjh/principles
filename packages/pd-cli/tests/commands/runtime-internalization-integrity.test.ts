import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheck = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  InternalizationChainIntegrityReadModel: vi.fn().mockImplementation(function () {
    return { check: mockCheck };
  }),
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
}));

import { handleRuntimeInternalizationIntegrity } from '../../src/commands/runtime-internalization-integrity.js';

const WS = '/fake/workspace';

function okResult() {
  return {
    overallStatus: 'ok' as const,
    brokenLinks: [],
    chainSummaries: {
      totalCandidates: 1,
      totalDreamerTasks: 1,
      totalPhilosopherTasks: 0,
      totalPIArtifacts: 1,
      chainsWithBrokenLinks: 0,
    },
    generatedAt: new Date().toISOString(),
  };
}

function degradedResult() {
  return {
    overallStatus: 'degraded' as const,
    brokenLinks: [{
      type: 'missing_dreamer_task',
      severity: 'warning' as const,
      candidateId: 'c1',
      reason: 'No dreamer task for candidate c1',
      recommendedAction: 'Seed a dreamer task.',
    }],
    chainSummaries: {
      totalCandidates: 1,
      totalDreamerTasks: 0,
      totalPhilosopherTasks: 0,
      totalPIArtifacts: 0,
      chainsWithBrokenLinks: 1,
    },
    generatedAt: new Date().toISOString(),
  };
}

describe('handleRuntimeInternalizationIntegrity', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('outputs ok JSON result', async () => {
    mockCheck.mockReturnValue(okResult());

    await handleRuntimeInternalizationIntegrity({ workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.overallStatus).toBe('ok');
    expect(jsonOutput.brokenLinks).toEqual([]);
  });

  it('outputs degraded result with broken links', async () => {
    mockCheck.mockReturnValue(degradedResult());

    await handleRuntimeInternalizationIntegrity({ workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.overallStatus).toBe('degraded');
    expect(jsonOutput.brokenLinks.length).toBeGreaterThan(0);
  });

  it('outputs text format when --json not specified', async () => {
    mockCheck.mockReturnValue(okResult());

    await handleRuntimeInternalizationIntegrity({ workspace: WS, json: false });

    const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allOutput).toContain('Internalization Chain Integrity');
    expect(allOutput).toContain('OK');
  });

  it('sets exit code on non-ok status', async () => {
    mockCheck.mockReturnValue(degradedResult());

    await handleRuntimeInternalizationIntegrity({ workspace: WS, json: true });

    expect(process.exitCode).toBe(1);
  });
});
