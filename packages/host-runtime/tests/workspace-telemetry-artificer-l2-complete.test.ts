/**
 * PRI-795 review P1 — artificer_l2_complete must be in the durable-telemetry
 * allowlist so the Artificer L2 completion evidence (abortOwner/budgetMs/
 * elapsedMs/stopReason/tokenUsage) survives the process. The EP002-R3
 * investigation failed precisely because this evidence was emitted to the
 * in-process singleton only and vanished.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StoreEventEmitter, type TelemetryEvent } from '@principles/core/runtime-v2';
import { WorkspaceTelemetryEmitter } from '../src/workspace-telemetry-emitter.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-artificer-telemetry-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

function artificerCompleteEvent(): TelemetryEvent {
  return {
    eventType: 'artificer_l2_complete',
    traceId: 'task-art-1',
    timestamp: '2026-09-15T00:00:00.000Z',
    sessionId: 'l2-adapter',
    agentId: 'artificer-l2',
    payload: {
      taskId: 'task-art-1',
      runId: 'uuid-1',
      turnCount: 7,
      toolsInvoked: { read_rulecode_spec: 1, submit_rulecode: 1 },
      succeeded: true,
      abortOwner: 'none',
      budgetMs: 900_000,
      elapsedMs: 346_279,
      stopReason: 'toolUse',
      tokenUsage: { status: 'ok', inputTokens: 21_760, outputTokens: 23_042, totalTokens: 44_802 },
      model: { provider: 'zai', model: 'glm-5.3', maxTokens: 49_152 },
    },
  };
}

describe('PRI-795 artificer_l2_complete durable persistence', () => {
  it('persists artificer_l2_complete to the workspace sink and forwards upstream', () => {
    const workspaceDir = makeWorkspace();
    const upstream = new StoreEventEmitter();
    const upstreamSpy = vi.spyOn(upstream, 'emitTelemetry');
    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, () => {});

    emitter.emitTelemetry(artificerCompleteEvent());

    const sink = path.join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
    expect(fs.existsSync(sink)).toBe(true);
    const lines = fs.readFileSync(sink, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const persisted = JSON.parse(lines[0]!) as TelemetryEvent;
    expect(persisted.eventType).toBe('artificer_l2_complete');
    expect((persisted.payload as { abortOwner: string }).abortOwner).toBe('none');
    expect((persisted.payload as { tokenUsage: { totalTokens: number } }).tokenUsage.totalTokens).toBe(44_802);
    // Upstream forwarding semantics unchanged.
    expect(upstreamSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps non-critical events out of the sink (allowlist still bounds the write surface)', () => {
    const workspaceDir = makeWorkspace();
    const emitter = new WorkspaceTelemetryEmitter(new StoreEventEmitter(), workspaceDir, () => {});
    emitter.emitTelemetry({ ...artificerCompleteEvent(), eventType: 'artificer_l2_turn' });
    const sink = path.join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
    expect(fs.existsSync(sink)).toBe(false);
  });
});
