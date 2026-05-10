import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRepair = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  InternalizationIntegrityRemediation: vi.fn().mockImplementation(function () {
    return { repair: mockRepair };
  }),
}));

import { handleRuntimeInternalizationIntegrityRepair } from '../../src/commands/runtime-internalization-integrity-repair.js';

const WS = '/fake/workspace';

function makeResult(overrides: Partial<{ dryRun: boolean; repairedCount: number; skippedCount: number; actions: unknown[] }> = {}) {
  return {
    dryRun: overrides.dryRun ?? true,
    repairedCount: overrides.repairedCount ?? 0,
    skippedCount: overrides.skippedCount ?? 0,
    actions: overrides.actions ?? [],
    generatedAt: new Date().toISOString(),
  };
}

describe('handleRuntimeInternalizationIntegrityRepair', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('outputs JSON result on dry-run', async () => {
    mockRepair.mockReturnValue(makeResult({ dryRun: true }));

    await handleRuntimeInternalizationIntegrityRepair({ workspace: WS, dryRun: true, confirm: false, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.dryRun).toBe(true);
  });

  it('outputs JSON result on confirm', async () => {
    mockRepair.mockReturnValue(makeResult({ dryRun: false, repairedCount: 1 }));

    await handleRuntimeInternalizationIntegrityRepair({ workspace: WS, dryRun: false, confirm: true, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.dryRun).toBe(false);
    expect(jsonOutput.repairedCount).toBe(1);
  });

  it('outputs text format when --json not specified', async () => {
    mockRepair.mockReturnValue(makeResult({ dryRun: true }));

    await handleRuntimeInternalizationIntegrityRepair({ workspace: WS, dryRun: true, confirm: false, json: false });

    const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allOutput).toContain('Integrity Repair');
    expect(allOutput).toContain('DRY-RUN');
  });

  it('defaults to dry-run when --confirm not specified', async () => {
    mockRepair.mockReturnValue(makeResult({ dryRun: true }));

    await handleRuntimeInternalizationIntegrityRepair({ workspace: WS, dryRun: true, confirm: false, json: true });

    expect(mockRepair).toHaveBeenCalledWith({ dryRun: true });
  });

  it('passes confirm=false when --confirm is set', async () => {
    mockRepair.mockReturnValue(makeResult({ dryRun: false }));

    await handleRuntimeInternalizationIntegrityRepair({ workspace: WS, dryRun: false, confirm: true, json: true });

    expect(mockRepair).toHaveBeenCalledWith({ dryRun: false });
  });
});
