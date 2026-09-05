/**
 * PRI-655 — `pd codex worker` daemon loop resilience.
 *
 * Drives the REAL handleCodexWorker with only the cycle boundary mocked
 * (importOriginal spread — ERR-115): the first cycle rejects (an exception
 * escaping the adapter's internal component catches), the second resolves.
 * The daemon must (a) log the failure with a next action, (b) keep looping —
 * round two runs, (c) exit cleanly on SIGINT with signal listeners removed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockRunCycle } = vi.hoisted(() => {
  const mockRunCycle = vi.fn();
  return { mockRunCycle };
});

vi.mock('@principles/codex-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/codex-adapter')>();
  return {
    ...actual,
    runCodexWorkspaceWorkerCycle: mockRunCycle,
  };
});

const { resolveWorkspaceDir } = vi.hoisted(() => {
  const resolveWorkspaceDir = vi.fn();
  return { resolveWorkspaceDir };
});
vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir,
}));

import { handleCodexWorker } from '../../src/commands/codex-worker.js';

describe('codex worker daemon loop resilience (PRI-655)', () => {
  let workspaceDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-daemon-'));
    resolveWorkspaceDir.mockReturnValue(workspaceDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  async function waitForCalls(count: number, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (mockRunCycle.mock.calls.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(mockRunCycle.mock.calls.length).toBeGreaterThanOrEqual(count);
  }

  it('a rejected cycle logs with a next action and the daemon SURVIVES to the next round', async () => {
    mockRunCycle
      .mockRejectedValueOnce(new Error('boom: escaping exception'))
      .mockResolvedValue({ workspaceDir, mode: 'ready' });

    const handler = handleCodexWorker({ workspace: workspaceDir, intervalMs: 1000 });

    // Review fix (ERR-071 recurrence): the daemon keeps looping with real
    // timers and signal listeners — stop it in finally so assertion failures
    // cannot leak a live background loop into subsequent tests.
    try {
      // Round one rejects; the daemon reports it instead of crashing.
      await waitForCalls(1);
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[PD:CodexWorker] cycle failed: boom: escaping exception'));
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Investigate: pd codex worker --status'));
      });

      // Round two runs — the loop did not die (the bug: process crash).
      await waitForCalls(2);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`Codex workspace worker (${workspaceDir})`));
    } finally {
      process.emit('SIGINT');
      await handler.catch(() => undefined);
    }

    // Clean exit: signal listeners removed (only reached after the finally
    // stopped the daemon, on the happy path AND on assertion failure).
    expect(process.listenerCount('SIGINT')).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  }, 20_000);
});
