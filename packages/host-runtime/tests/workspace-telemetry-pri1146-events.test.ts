/**
 * PRI-1146 P1-01 — the two new skip/degradation telemetry events must reach
 * the durable workspace sink (critical-events.jsonl) and still forward
 * upstream unchanged. Mirrors the PRI-939 reuse-events pattern: the in-process
 * singleton has zero production subscribers, so allowlisted events that are
 * not persisted are lost.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StoreEventEmitter, type TelemetryEvent } from '@principles/core/runtime';
import { WorkspaceTelemetryEmitter } from '../src/workspace-telemetry-emitter.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1146-telemetry-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

function trustedContextUnavailableEvent(reason: 'ledger_unavailable' | 'ledger_corrupt'): TelemetryEvent {
  return {
    eventType: 'diag_router_trusted_context_unavailable',
    traceId: 'diag_router-diagnosis_pain-001',
    timestamp: '2026-11-10T00:00:00.000Z',
    sessionId: 'pd-cli-diagnose',
    agentId: 'diagnostician',
    payload: { reason },
  };
}

function replayReviewSourceInvalidEvent(reason: 'owning_output_unparseable' | 'owning_output_not_v2'): TelemetryEvent {
  return {
    eventType: 'replay_review_source_invalid',
    traceId: 'cand-001',
    timestamp: '2026-11-10T00:00:01.000Z',
    sessionId: 'pd-cli-diagnose',
    payload: {
      candidateId: 'cand-001',
      reason,
      nextAction: 'Re-run the diagnosis so the candidate is minted from a V2 artifact.',
    },
  };
}

function readSink(workspaceDir: string): TelemetryEvent[] {
  const sink = path.join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
  if (!fs.existsSync(sink)) return [];
  return fs.readFileSync(sink, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as TelemetryEvent);
}

describe('PRI-1146 P1-01 skip/degradation events reach the durable workspace sink', () => {
  it('persists diag_router_trusted_context_unavailable with the reason and forwards it upstream', () => {
    const workspaceDir = makeWorkspace();
    const upstream = new StoreEventEmitter();
    const upstreamSpy = vi.spyOn(upstream, 'emitTelemetry');
    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, () => {});

    const event = trustedContextUnavailableEvent('ledger_corrupt');
    expect(emitter.emitTelemetry(event)).toBe(true);

    const persisted = readSink(workspaceDir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(event);
    expect(upstreamSpy).toHaveBeenCalledWith(event);
  });

  it('persists replay_review_source_invalid for both skip reasons (JSONL round-trip)', () => {
    const workspaceDir = makeWorkspace();
    const upstream = new StoreEventEmitter();
    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, () => {});

    const unparseable = replayReviewSourceInvalidEvent('owning_output_unparseable');
    const notV2 = replayReviewSourceInvalidEvent('owning_output_not_v2');
    emitter.emitTelemetry(unparseable);
    emitter.emitTelemetry(notV2);

    const persisted = readSink(workspaceDir);
    expect(persisted.map((event) => event.eventType)).toEqual([
      'replay_review_source_invalid',
      'replay_review_source_invalid',
    ]);
    expect(persisted[0]).toEqual(unparseable);
    expect(persisted[1]).toEqual(notV2);
  });

  it('negative control: a registered but non-allowlisted event is forwarded, not persisted', () => {
    const workspaceDir = makeWorkspace();
    const upstream = new StoreEventEmitter();
    const upstreamSpy = vi.spyOn(upstream, 'emitTelemetry');
    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, () => {});

    const event: TelemetryEvent = {
      eventType: 'diag_router_run_started',
      traceId: 'diag_router-diagnosis_pain-001',
      timestamp: '2026-11-10T00:00:02.000Z',
      sessionId: 'pd-cli-diagnose',
      payload: { runId: 'run-1' },
    };
    expect(emitter.emitTelemetry(event)).toBe(true);

    expect(readSink(workspaceDir)).toEqual([]);
    expect(upstreamSpy).toHaveBeenCalledWith(event);
  });
});