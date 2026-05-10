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

import { Command } from 'commander';
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

function createTestProgram(): Command {
  const program = new Command();
  program.exitOverride();

  const internalizationCmd = program.command('internalization');

  internalizationCmd
    .command('integrity-repair')
    .description('Repair broken internalization chain links (operator repair path)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--dry-run', 'Report only, no modifications')
    .option('--confirm', 'Actually repair broken links')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRuntimeInternalizationIntegrityRepair({ workspace: opts.workspace, confirm: opts.confirm, dryRun: opts.dryRun, json: opts.json });
    });

  return program;
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

    await handleRuntimeInternalizationIntegrityRepair({ workspace: WS, confirm: true, json: true });

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

    await handleRuntimeInternalizationIntegrityRepair({ workspace: WS, json: true });

    expect(mockRepair).toHaveBeenCalledWith({ dryRun: true });
  });

  it('enters confirm mode when only --confirm is passed', async () => {
    mockRepair.mockReturnValue(makeResult({ dryRun: false }));

    await handleRuntimeInternalizationIntegrityRepair({ workspace: WS, confirm: true, json: true });

    expect(mockRepair).toHaveBeenCalledWith({ dryRun: false });
  });

  it('rejects --dry-run and --confirm together', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`process.exit:${code}`); });

    await expect(
      handleRuntimeInternalizationIntegrityRepair({ workspace: WS, dryRun: true, confirm: true, json: true }),
    ).rejects.toThrow('process.exit:1');

    exitSpy.mockRestore();
  });
});

describe('Commander wiring for integrity-repair', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('no flags → dry-run mode (confirm=undefined, dryRun=undefined)', async () => {
    mockRepair.mockReturnValue(makeResult({ dryRun: true }));

    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'integrity-repair', '--workspace', WS, '--json']);

    expect(mockRepair).toHaveBeenCalledWith({ dryRun: true });
  });

  it('--confirm alone → confirm mode (not blocked by dryRun default)', async () => {
    mockRepair.mockReturnValue(makeResult({ dryRun: false }));

    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'integrity-repair', '--workspace', WS, '--confirm', '--json']);

    expect(mockRepair).toHaveBeenCalledWith({ dryRun: false });
  });

  it('--dry-run alone → dry-run mode', async () => {
    mockRepair.mockReturnValue(makeResult({ dryRun: true }));

    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'integrity-repair', '--workspace', WS, '--dry-run', '--json']);

    expect(mockRepair).toHaveBeenCalledWith({ dryRun: true });
  });

  it('--dry-run --confirm together → rejected', async () => {
    mockRepair.mockReturnValue(makeResult({ dryRun: true }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`process.exit:${code}`); });

    const program = createTestProgram();
    await expect(
      program.parseAsync(['node', 'pd', 'internalization', 'integrity-repair', '--workspace', WS, '--dry-run', '--confirm', '--json']),
    ).rejects.toThrow('process.exit:1');

    exitSpy.mockRestore();
  });
});
