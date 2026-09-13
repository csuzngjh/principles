import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createProductionHostRuntime } from '../src/index.js';
import type { HostEventEmitter } from '@principles/core/host';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri750-emit-'));
}

function makeEvent(kind: 'before_prompt_build' | 'after_tool_call', workspaceDir: string): unknown {
  const context: Record<string, unknown> = {
    workspaceDir,
    sessionId: 'sess-1',
    turnId: 'turn-1',
  };
  if (kind === 'after_tool_call') {
    context.toolName = 'edit';
    context.toolInput = { file_path: 'x.txt' };
    context.toolOutput = { result: { exitCode: 1 }, error: 'boom' };
    context.toolCallId = 'call-1';
  } else {
    context.promptContent = 'hi';
  }
  return {
    kind,
    context,
    rawPayload: {},
    source: kind === 'before_prompt_build' ? 'test:prompt' : 'test:tool',
  };
}

describe('PRI-750 shared-path event emission (Codex host)', () => {
  it('emits the injection event with turnId mapped to runId on before_prompt_build', async () => {
    const workspaceDir = tempWorkspace();
    const events: HostEventEmitter = { recordRuntimeV2ActivationsInjected: vi.fn(), recordToolCall: vi.fn() };
    const runtime = createProductionHostRuntime({ events });
    const result = await runtime.dispatch(makeEvent('before_prompt_build', workspaceDir) as never);
    expect(result).toMatchObject({ decision: 'allow' });
    expect(events.recordRuntimeV2ActivationsInjected).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', runId: 'turn-1' }),
    );
  });

  it('emits the tool event with turnId/toolCallId on after_tool_call', async () => {
    const workspaceDir = tempWorkspace();
    const events: HostEventEmitter = { recordRuntimeV2ActivationsInjected: vi.fn(), recordToolCall: vi.fn() };
    const runtime = createProductionHostRuntime({
      events,
      painDatabaseFactory: () => new Database(':memory:'),
    });
    const result = await runtime.dispatch(makeEvent('after_tool_call', workspaceDir) as never);
    expect(result).toMatchObject({ decision: 'observe' });
    expect(events.recordToolCall).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ toolName: 'edit', runId: 'turn-1', toolCallId: 'call-1' }),
    );
  });

  it('stays silent and succeeds when no events port is supplied (OpenClaw plugin path)', async () => {
    const workspaceDir = tempWorkspace();
    const runtime = createProductionHostRuntime({});
    await expect(runtime.dispatch(makeEvent('before_prompt_build', workspaceDir) as never)).resolves.toMatchObject({ decision: 'allow' });
    await expect(runtime.dispatch(makeEvent('after_tool_call', workspaceDir) as never)).resolves.toMatchObject({ decision: 'observe' });
  });
});
