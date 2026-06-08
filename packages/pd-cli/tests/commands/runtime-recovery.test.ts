import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDetectExpiredLeases = vi.hoisted(() => vi.fn());
const mockRecoverTask = vi.hoisted(() => vi.fn());
const mockServiceClose = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  createRecoverySweepService: vi.fn().mockResolvedValue({
    service: {
      detectExpiredLeases: mockDetectExpiredLeases,
      recoverTask: mockRecoverTask,
    },
    close: mockServiceClose,
  }),
  createRemediationResult: vi.fn((input) => ({
    mode: input.mode,
    status: input.status ?? (input.mode === 'dry_run'
      ? (input.actions?.length > 0 ? 'would_change' : 'no_op')
      : (input.repairedCount > 0 ? 'changed' : 'no_op')),
    safeToConfirm: input.safeToConfirm ?? false,
    repairedCount: input.repairedCount ?? 0,
    skippedCount: input.skippedCount ?? 0,
    actions: input.actions ?? [],
    warnings: input.warnings ?? [],
  })),
  remediationAction: vi.fn((input) => input),
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
}));

import { handleRuntimeRecoverySweep } from '../../src/commands/runtime-recovery.js';

describe('pd runtime recovery sweep remediation contract', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectExpiredLeases.mockResolvedValue([]);
    mockRecoverTask.mockResolvedValue(null);
    mockServiceClose.mockResolvedValue(undefined);
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('dry-run JSON uses shared remediation contract and does not recover tasks', async () => {
    mockDetectExpiredLeases.mockResolvedValue(['task-1']);

    await handleRuntimeRecoverySweep({ workspace: '/fake/workspace', dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      mode: 'dry_run',
      status: 'would_change',
      safeToConfirm: true,
      repairedCount: 0,
      skippedCount: 0,
    });
    expect(output.actions[0]).toMatchObject({ action: 'recover_expired_lease', targetId: 'task-1' });
    expect(mockRecoverTask).not.toHaveBeenCalled();
    expect(mockServiceClose).toHaveBeenCalledTimes(1);
  });

  it('confirm JSON reports changed after recovering expired leases', async () => {
    mockDetectExpiredLeases.mockResolvedValue(['task-1']);
    mockRecoverTask.mockResolvedValue({ previousStatus: 'leased', newStatus: 'retry_wait' });

    await handleRuntimeRecoverySweep({ workspace: '/fake/workspace', confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.mode).toBe('confirm');
    expect(output.status).toBe('changed');
    expect(output.repairedCount).toBe(1);
    expect(mockRecoverTask).toHaveBeenCalledWith('task-1');
    expect(mockServiceClose).toHaveBeenCalledTimes(1);
  });

  it('rejects --dry-run and --confirm together before writing (no service created)', async () => {
    await handleRuntimeRecoverySweep({ workspace: '/fake/workspace', dryRun: true, confirm: true, json: true });

    expect(mockRecoverTask).not.toHaveBeenCalled();
    expect(mockServiceClose).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('mutually exclusive'));
  });

  it('uses createRecoverySweepService (no RuntimeStateManager)', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(require.resolve('../../src/commands/runtime-recovery.ts'), 'utf-8');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).toContain('createRecoverySweepService');
  });
});
