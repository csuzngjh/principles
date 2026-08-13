import { describe, expect, it, vi } from 'vitest';
import type { HostEvent, HostEventResult } from '@principles/core/host';
import { createHostRuntime, HostRuntimeDispatchError } from '../src/index.js';

function event(kind: HostEvent['kind']): HostEvent {
  return {
    kind,
    context: { workspaceDir: '/workspace', sessionId: 'session-1' },
    rawPayload: {},
    source: `test:${kind}`,
  };
}

function result(decision: HostEventResult['decision'], source: string): HostEventResult {
  return { decision, source };
}

describe('createHostRuntime', () => {
  it('dispatches each approved MVP-Core event to its injected port and returns the port result', async () => {
    const beforePromptBuild = vi.fn(async (input: HostEvent) => result('modify', input.source));
    const beforeToolCall = vi.fn(async (input: HostEvent) => result('deny', input.source));
    const afterToolCall = vi.fn(async (input: HostEvent) => result('observe', input.source));
    const runtime = createHostRuntime({ beforePromptBuild, beforeToolCall, afterToolCall });

    await expect(runtime.dispatch(event('before_prompt_build'))).resolves.toEqual(result('modify', 'test:before_prompt_build'));
    await expect(runtime.dispatch(event('before_tool_call'))).resolves.toEqual(result('deny', 'test:before_tool_call'));
    await expect(runtime.dispatch(event('after_tool_call'))).resolves.toEqual(result('observe', 'test:after_tool_call'));

    expect(beforePromptBuild).toHaveBeenCalledOnce();
    expect(beforeToolCall).toHaveBeenCalledOnce();
    expect(afterToolCall).toHaveBeenCalledOnce();
  });

  it('fails loud for a valid but out-of-scope host event', async () => {
    const runtime = createHostRuntime({
      beforePromptBuild: vi.fn(),
      beforeToolCall: vi.fn(),
      afterToolCall: vi.fn(),
    });

    await expect(runtime.dispatch(event('session_start'))).rejects.toMatchObject({
      name: 'HostRuntimeDispatchError',
      reason: 'unsupported_host_event',
    });
  });

  it('fails loud when an unknown value reaches the dispatcher', async () => {
    const runtime = createHostRuntime({
      beforePromptBuild: vi.fn(),
      beforeToolCall: vi.fn(),
      afterToolCall: vi.fn(),
    });

    await expect(Reflect.apply(runtime.dispatch, runtime, [null])).rejects.toMatchObject({
      reason: 'invalid_host_event',
    });
  });

  it('fails loud when a port returns a malformed result', async () => {
    const runtime = createHostRuntime({
      beforePromptBuild: vi.fn(async () => ({ decision: 'modify' })),
      beforeToolCall: vi.fn(),
      afterToolCall: vi.fn(),
    });

    await expect(runtime.dispatch(event('before_prompt_build'))).rejects.toBeInstanceOf(HostRuntimeDispatchError);
  });

  it('reports the exact configured production routes and rejects an empty workspace health probe', async () => {
    const runtime = createHostRuntime({
      beforePromptBuild: vi.fn(),
      beforeToolCall: vi.fn(),
      afterToolCall: vi.fn(),
    });

    await expect(runtime.health('/workspace')).resolves.toMatchObject({
      ok: true,
      workspaceDir: '/workspace',
      routes: ['before_prompt_build', 'before_tool_call', 'after_tool_call'],
    });
    await expect(runtime.health('')).resolves.toMatchObject({
      ok: false,
      reason: 'workspace_dir_missing',
    });
  });
});
