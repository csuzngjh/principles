/**
 * PRI-966 G2 P2 — OpenClawCliRuntimeAdapter declares its StartRunInput.
 * maxTokens capability boundary: the host CLI owns its model calls and exposes
 * no per-request output-token control, so a present maxTokens fails loud as
 * input_invalid BEFORE any CLI process starts (silently ignoring the cap is
 * forbidden, rc-9). No process is spawned in this test.
 */
import { describe, expect, it } from 'vitest';

import { OpenClawCliRuntimeAdapter } from '../openclaw-cli-runtime-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';

function makeInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
    inputPayload: 'diagnose',
    contextItems: [],
    timeoutMs: 30_000,
    ...overrides,
  };
}

describe('P2: OpenClaw CLI adapter capability boundary for StartRunInput.maxTokens', () => {
  it('a present maxTokens fails loud as input_invalid before any CLI work', async () => {
    const adapter = new OpenClawCliRuntimeAdapter({ runtimeMode: 'local' });
    await expect(adapter.startRun(makeInput({ maxTokens: 512 }))).rejects.toMatchObject({
      category: 'input_invalid',
    });
    await expect(adapter.startRun(makeInput({ maxTokens: 1024 }))).rejects.toThrow(/does not support StartRunInput\.maxTokens/);
  });

  it('an absent maxTokens is unchanged (legacy callers unaffected)', async () => {
    const adapter = new OpenClawCliRuntimeAdapter({ runtimeMode: 'local' });
    // The contract check passes; the run then proceeds to CLI construction.
    // No CLI binary exists in the test environment, so the run fails with a
    // NON-contract error — that failure is out of scope here, we only assert
    // the failure is NOT the capability-boundary rejection.
    let caught: unknown;
    try {
      await adapter.startRun(makeInput());
    } catch (err) {
      caught = err;
    }
    if (caught !== undefined) {
      expect((caught as Error).message).not.toMatch(/does not support StartRunInput\.maxTokens/);
    }
  });
});
