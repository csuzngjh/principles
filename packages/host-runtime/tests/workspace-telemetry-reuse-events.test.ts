/**
 * PRI-939 Option A — the Reuse Review Gate's degradation signals must reach
 * the durable workspace sink. Before this change `reuse_gate_triggered` and
 * `reuse_evaluation_unavailable` were emitted into the unsubscribed process
 * singleton only: an evaluation failure silently degraded to CREATE (Rule 4)
 * and the Owner could never reconstruct why no duplicate protection ran
 * (the 94e4dd62 near-duplicate on the live Codex workspace).
 *
 * reuse_evaluation_recommended stays OUT of the allowlist by design — the
 * recommendation is already carried durably by candidateOutcomes and (after an
 * Owner reuse decision) reuseEvidence[]; persisting it here would create a
 * second decision log.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-reuse-telemetry-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

function reuseUnavailableEvent(): TelemetryEvent {
  return {
    eventType: 'reuse_evaluation_unavailable',
    traceId: 'cand-unavailable-1',
    timestamp: '2026-10-06T00:00:00.000Z',
    sessionId: 'pd-cli-review',
    agentId: 'reuse-evaluation',
    payload: {
      candidateId: 'cand-unavailable-1',
      reason: 'LLM execution failed: 404 No endpoints found for stealth/space-bunny-alpha.',
    },
  };
}

function reuseGateTriggeredEvent(): TelemetryEvent {
  return {
    eventType: 'reuse_gate_triggered',
    traceId: 'cand-parked-1',
    timestamp: '2026-10-06T00:00:01.000Z',
    sessionId: '',
    payload: {
      candidateId: 'cand-parked-1',
      selectedPrincipleId: 'p-1',
      recommendation: 'reuse',
      confidence: 0.95,
    },
  };
}

function readSink(workspaceDir: string): TelemetryEvent[] {
  const sink = path.join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
  if (!fs.existsSync(sink)) return [];
  return fs.readFileSync(sink, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TelemetryEvent);
}

describe('PRI-939 reuse gate degradation signals reach the durable workspace sink', () => {
  it('persists reuse_evaluation_unavailable with the degradation reason preserved (T2 sink layer)', () => {
    const workspaceDir = makeWorkspace();
    const upstream = new StoreEventEmitter();
    const upstreamSpy = vi.spyOn(upstream, 'emitTelemetry');
    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, () => {});

    emitter.emitTelemetry(reuseUnavailableEvent());

    const persisted = readSink(workspaceDir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.eventType).toBe('reuse_evaluation_unavailable');
    expect((persisted[0]!.payload as { candidateId: string }).candidateId).toBe('cand-unavailable-1');
    expect((persisted[0]!.payload as { reason: string }).reason).toContain('404 No endpoints found');
    // Upstream forwarding semantics unchanged.
    expect(upstreamSpy).toHaveBeenCalledTimes(1);
  });

  it('persists reuse_gate_triggered (the park observation) (T2 sink layer)', () => {
    const workspaceDir = makeWorkspace();
    const emitter = new WorkspaceTelemetryEmitter(new StoreEventEmitter(), workspaceDir, () => {});

    emitter.emitTelemetry(reuseGateTriggeredEvent());

    const persisted = readSink(workspaceDir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.eventType).toBe('reuse_gate_triggered');
    expect((persisted[0]!.payload as { confidence: number }).confidence).toBe(0.95);
  });

  it('keeps reuse_evaluation_recommended OUT of the sink (no second decision log)', () => {
    const workspaceDir = makeWorkspace();
    const emitter = new WorkspaceTelemetryEmitter(new StoreEventEmitter(), workspaceDir, () => {});

    emitter.emitTelemetry({
      ...reuseUnavailableEvent(),
      eventType: 'reuse_evaluation_recommended',
      payload: { candidateId: 'cand-rec-1', recommendation: 'create', confidence: 0.8 },
    });

    expect(readSink(workspaceDir)).toEqual([]);
  });

  it('keeps routine events out of the sink (allowlist still bounds the write surface)', () => {
    const workspaceDir = makeWorkspace();
    const emitter = new WorkspaceTelemetryEmitter(new StoreEventEmitter(), workspaceDir, () => {});

    emitter.emitTelemetry({ ...reuseUnavailableEvent(), eventType: 'runtime_adapter_selected' });

    expect(readSink(workspaceDir)).toEqual([]);
  });
});
