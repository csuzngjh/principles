/**
 * PRI-1202 — the CLI recovery probe must stay inside ONE console request.
 *
 * The console wraps every route in `asyncHandler`, which answers 504 when its
 * request budget expires. Before this fix the probe carried its own 15s
 * literal while the request budget was 10s, so a single probe could outlive
 * the request and be reported as a timeout even when it later succeeded.
 *
 * The regression is behavioural on purpose: it advances fake time to the
 * DERIVED probe budget and asserts the probe has already timed out. Restoring
 * a literal budget larger than the request budget turns this test red (the
 * probe is still pending at the derived deadline).
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  // A CLI that never answers: only the probe's own timeout can settle the run.
  spawn: () => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  }),
}));

import {
  CLI_RECOVERY_PROBE_HEADROOM_MS,
  CLI_RECOVERY_PROBE_TIMEOUT_MS,
  CONSOLE_REQUEST_BUDGET_MS,
  probeCliActivationStatus,
} from '../src/cli-recovery-probe.js';

describe('PRI-1202 CLI recovery probe budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives the probe budget from the console request budget with positive headroom', () => {
    expect(CLI_RECOVERY_PROBE_HEADROOM_MS).toBeGreaterThan(0);
    expect(CLI_RECOVERY_PROBE_TIMEOUT_MS).toBe(CONSOLE_REQUEST_BUDGET_MS - CLI_RECOVERY_PROBE_HEADROOM_MS);
    expect(CLI_RECOVERY_PROBE_TIMEOUT_MS).toBeLessThan(CONSOLE_REQUEST_BUDGET_MS);
  });

  it('fails the probe closed before the console request budget can expire', async () => {
    vi.useFakeTimers();
    let outcome: Awaited<ReturnType<typeof probeCliActivationStatus>> | null = null;
    void probeCliActivationStatus({ cliEntry: 'unused-mocked-entry', workspaceDir: '/governed/workspace' })
      .then(result => { outcome = result; });

    // The request budget is the authority: one millisecond before it expires
    // a probe that respects the derived budget has already timed out. A probe
    // budget restored to 15s leaves the probe pending here and turns this red.
    await vi.advanceTimersByTimeAsync(CONSOLE_REQUEST_BUDGET_MS - 1);
    expect(outcome).not.toBeNull();
    expect(outcome?.ok).toBe(false);
    expect(outcome?.detail).toContain('timeout');
  });
});
