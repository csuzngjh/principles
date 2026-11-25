/**
 * PRI-1287 — Intent-chain degradation reaches the durable workspace sink.
 *
 * Stage A has emitted `diag_rootcause_intent_doc_template_only` /
 * `diag_rootcause_intent_doc_read_failed` since #2663, but production runners
 * ride the process-wide `storeEmitter`, which has no subscriber, and neither
 * event was on the critical allowlist. Net effect: an Intent chain that
 * degraded to `not_configured` (relevance never configured, no snapshot, no
 * tension) left NOTHING to inspect afterwards — the shape PRI-1284 found by
 * accident in the 2026-11-22 ON/OFF pilot.
 *
 * These tests pin the allowlist entry itself: reason + nextAction must survive
 * as JSONL, and a non-allowlisted runner event must still only be forwarded.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1287-telemetry-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

function templateOnlyEvent(reason: 'placeholder_only' | 'no_parsed_section'): TelemetryEvent {
  return {
    eventType: 'diag_rootcause_intent_doc_template_only',
    traceId: 'diag_rootcause-diagnosis_pain-001',
    timestamp: '2026-11-22T00:00:00.000Z',
    sessionId: 'pd-auto-diagnostician',
    agentId: 'diagnostician',
    payload: {
      source: 'fresh_read',
      reason,
      parsedSectionCount: reason === 'no_parsed_section' ? 0 : 5,
      contentHash: 'sha256:ee',
      docPath: '/ws/.principles/INTENT.zh-CN.md',
      nextAction: 'Fix the INTENT.md headings or answers; see reason.',
    },
  };
}

function readFailedEvent(): TelemetryEvent {
  return {
    eventType: 'diag_rootcause_intent_doc_read_failed',
    traceId: 'diag_rootcause-diagnosis_pain-002',
    timestamp: '2026-11-22T00:00:01.000Z',
    sessionId: 'pd-auto-diagnostician',
    agentId: 'diagnostician',
    payload: {
      reason: 'not_found',
      nextAction: 'Create .principles/INTENT.zh-CN.md using "pd intent init --confirm --lang zh-CN --workspace \\"/ws\\"".',
      flagEnabled: true,
      found: false,
    },
  };
}

function readSink(workspaceDir: string): TelemetryEvent[] {
  const sink = path.join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
  if (!fs.existsSync(sink)) return [];
  const raw = fs.readFileSync(sink, 'utf8').trim();
  if (raw === '') return [];
  return raw.split('\n').map((line) => JSON.parse(line) as TelemetryEvent);
}

describe('PRI-1287 Intent degradation is durable and still forwarded', () => {
  it('persists both degradation reasons of the template-only event verbatim', () => {
    const workspaceDir = makeWorkspace();
    const upstream = new StoreEventEmitter();
    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, () => {});

    const placeholder = templateOnlyEvent('placeholder_only');
    const unrecognised = templateOnlyEvent('no_parsed_section');
    emitter.emitTelemetry(placeholder);
    emitter.emitTelemetry(unrecognised);

    const persisted = readSink(workspaceDir);
    expect(persisted.map((event) => event.eventType)).toEqual([
      'diag_rootcause_intent_doc_template_only',
      'diag_rootcause_intent_doc_template_only',
    ]);
    // The reason is the actionable half: "headings unrecognised" and "template
    // unanswered" must survive as distinct rows, not collapse into one verdict.
    expect(persisted.map((event) => event.payload.reason)).toEqual([
      'placeholder_only',
      'no_parsed_section',
    ]);
    expect(persisted[0]).toEqual(placeholder);
    expect(persisted[1]).toEqual(unrecognised);
  });

  it('persists the read-failure branch (missing / oversized / unreadable INTENT.md)', () => {
    const workspaceDir = makeWorkspace();
    const upstream = new StoreEventEmitter();
    const upstreamSpy = vi.spyOn(upstream, 'emitTelemetry');
    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, () => {});

    const event = readFailedEvent();
    expect(emitter.emitTelemetry(event)).toBe(true);

    const persisted = readSink(workspaceDir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(event);
    expect(persisted[0]?.payload.nextAction).toContain('pd intent init --confirm');
    expect(upstreamSpy).toHaveBeenCalledWith(event);
  });

  it('negative control: the normal path writes no Intent degradation row', () => {
    const workspaceDir = makeWorkspace();
    const upstream = new StoreEventEmitter();
    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, () => {});

    // What an authored INTENT.md produces: capture/persist signals only, no
    // degradation record at all.
    emitter.emitTelemetry({
      eventType: 'diag_rootcause_intent_snapshot_capture_incomplete',
      traceId: 'diag_rootcause-diagnosis_pain-003',
      timestamp: '2026-11-22T00:00:02.000Z',
      sessionId: 'pd-auto-diagnostician',
      payload: { attemptCount: 2, reason: 'no_persisted_snapshot_on_retry' },
    });

    expect(readSink(workspaceDir)).toEqual([]);
  });
});
