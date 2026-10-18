/**
 * PRI-966 G2 P2 — OpenClawCliRuntimeAdapter declares its StartRunInput.
 * A present maxTokens fails as input_invalid before any CLI work. Legacy calls
 * without maxTokens are verified through an injected fake process runner; this
 * test must never spawn a real OpenClaw process or contact a model provider.
 */
import { describe, expect, it, vi } from 'vitest';

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

function fakeCliProcessRunner() {
  return vi.fn(async () => ({
    stdout: '{}',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
  }));
}

describe('P2: OpenClaw CLI adapter capability boundary for StartRunInput.maxTokens', () => {
  it('a present maxTokens fails loud as input_invalid before any CLI work', async () => {
    const cliProcessRunner = fakeCliProcessRunner();
    const adapter = new OpenClawCliRuntimeAdapter({ runtimeMode: 'local', cliProcessRunner });
    await expect(adapter.startRun(makeInput({ maxTokens: 512 }))).rejects.toMatchObject({
      category: 'input_invalid',
    });
    await expect(adapter.startRun(makeInput({ maxTokens: 1024 }))).rejects.toThrow(/does not support StartRunInput\.maxTokens/);
    expect(cliProcessRunner).not.toHaveBeenCalled();
  });

  it('an absent maxTokens preserves legacy behavior without spawning a real process', async () => {
    const cliProcessRunner = fakeCliProcessRunner();
    const adapter = new OpenClawCliRuntimeAdapter({ runtimeMode: 'local', cliProcessRunner });
    const handle = await adapter.startRun(makeInput());

    expect(handle.runtimeKind).toBe('openclaw-cli');
    expect(cliProcessRunner).toHaveBeenCalledTimes(1);
    expect(cliProcessRunner).toHaveBeenCalledWith(expect.objectContaining({
      command: 'openclaw',
      args: expect.arrayContaining(['agent', '--local']),
    }));
  });
});
