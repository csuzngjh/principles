/**
 * PRI-1202 — the console request budget is the single authority.
 *
 * The console wrapper answers 504 when `REQUEST_TIMEOUT_MS` expires, and the
 * CLI recovery probes it awaits must finish strictly inside that budget.
 * Before this test the two budgets were independent literals (probe 15s,
 * request 10s), so a single probe could be reported as a 504 while it was
 * still running. Restoring a larger probe literal turns the second assertion
 * red.
 */
import { describe, expect, it } from 'vitest';
import { REQUEST_TIMEOUT_MS } from '../../src/server/index.js';
import { CLI_RECOVERY_PROBE_TIMEOUT_MS, CONSOLE_REQUEST_BUDGET_MS } from '@principles/host-runtime';

describe('PRI-1202 console request budget authority', () => {
  it('takes the console request timeout from the shared budget instead of a local literal', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(CONSOLE_REQUEST_BUDGET_MS);
  });

  it('keeps the CLI recovery probe strictly inside one console request budget', () => {
    expect(CLI_RECOVERY_PROBE_TIMEOUT_MS).toBeLessThan(REQUEST_TIMEOUT_MS);
  });
});
