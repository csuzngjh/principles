/**
 * PRI-1184 / F4: the OpenClaw adapter must surface the plugin-owned deny copy.
 *
 * The shared production gate returns `deny`, and the plugin's
 * `onBeforeToolResult` hook is the only producer of the owner-facing receipt
 * copy (`principle_receipt_block_copy`). Before this contract was pinned, the
 * adapter discarded that return value and emitted the raw gate reason, which
 * left `principle_receipt_block_copy` with no producer on the shared path.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HostEvent, HostEventResult } from '@principles/core/host';

const denyResult = { decision: 'deny', source: 'openclaw:before_tool_call', reason: 'gate reason' } as HostEventResult;

vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/host-runtime')>();
  return {
    ...actual,
    createProductionHostRuntime: vi.fn(() => ({ dispatch: async (_event: HostEvent) => denyResult })),
  };
});

const { createOpenClawHostRuntime } = await import('../src/host-runtime/openclaw-host-runtime.js');

function makeRuntime(onBeforeToolResult?: () => { block?: boolean; blockReason?: string } | void) {
  return createOpenClawHostRuntime({
    beforePromptBuild: async () => undefined,
    onBeforeToolResult,
  });
}

describe('OpenClaw shared deny copy mapping (PRI-1184 / F4)', () => {
  it('surfaces the receipt copy returned by the shared-path producer', async () => {
    const receiptCopy = '⛔ [PD 原则]「删除前确认目标」拦截了 exec build/';
    const runtime = makeRuntime(() => ({ block: true, blockReason: receiptCopy }));

    const result = await runtime.dispatchBeforeToolCall(
      { toolName: 'exec', params: { command: 'rm -rf build/' } },
      { workspaceDir: '/mock/workspace', sessionId: 'sess-copy' },
    );

    expect(result).toEqual({ block: true, blockReason: receiptCopy });
  });

  it('keeps the gate reason when the producer returns nothing', async () => {
    const runtime = makeRuntime(() => undefined);

    const result = await runtime.dispatchBeforeToolCall(
      { toolName: 'exec', params: { command: 'rm -rf build/' } },
      { workspaceDir: '/mock/workspace', sessionId: 'sess-copy' },
    );

    expect(result).toEqual({ block: true, blockReason: 'gate reason' });
  });

  it('never downgrades a deny when the producer returns a non-block value', async () => {
    const runtime = makeRuntime(() => ({ block: false }));

    const result = await runtime.dispatchBeforeToolCall(
      { toolName: 'exec', params: { command: 'rm -rf build/' } },
      { workspaceDir: '/mock/workspace', sessionId: 'sess-copy' },
    );

    expect(result).toEqual({ block: true, blockReason: 'gate reason' });
  });
});
