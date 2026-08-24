import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  collectRuleCodeEventEntries,
  readShadowSummaryForActivation,
} from '../../src/commands/runtime-activation.js';

/**
 * PRI-577 regression tests — RuleCode shadow telemetry directory mismatch.
 *
 * Production writes rulehost_evaluated events to `{workspace}/.state/logs/` via the
 * v1 EventLog component, while the reader used to scan only `{workspace}/.pd/logs/`
 * (a directory no production code ever creates). These tests pin the real-world
 * directory layout so a future refactor cannot silently re-break the channel.
 */

const ACTIVATION_ID = 'act_code_test-rule';

function makeEventLine(eventOverrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: '2026-08-21T00:47:00.469Z',
    type: 'rulehost_evaluated',
    category: 'evaluated',
    data: {
      toolName: 'write_file',
      filePath: '<redacted>',
      matched: true,
      decision: 'block',
      ruleId: 'rule-1',
      activationId: ACTIVATION_ID,
      activationMode: 'shadow',
      ...dataOverrides,
    },
    ...eventOverrides,
  });
}

describe('PRI-577 shadow telemetry dual-directory reading', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri577-ws-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeEventsFile(relLogsDir: string, date: string, lines: string[]): void {
    const dir = path.join(workspaceDir, ...relLogsDir.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `events_${date}.jsonl`), lines.join('\n') + '\n', 'utf8');
  }

  it('reads shadow metrics when events live only in legacy .state/logs (production layout)', () => {
    writeEventsFile('.state/logs', '2026-08-21', [
      makeEventLine(),
      makeEventLine({}, { toolName: 'exec', filePath: 'x', matched: false, decision: 'allow' }),
    ]);

    const summary = readShadowSummaryForActivation(workspaceDir, ACTIVATION_ID);
    expect(summary.observed).toBe(2);
    expect(summary.matched).toBe(1);
    expect(summary.wouldBlock).toBe(1);
    expect(summary.firstObservedAt).not.toBeNull();
  });

  it('merges entries when both .pd/logs and .state/logs exist', () => {
    writeEventsFile('.state/logs', '2026-08-21', [makeEventLine()]);
    writeEventsFile('.pd/logs', '2026-08-22', [
      makeEventLine({ ts: '2026-08-22T10:00:00.000Z' }),
    ]);
    const summary = readShadowSummaryForActivation(workspaceDir, ACTIVATION_ID);
    expect(summary.observed).toBe(2);
    expect(summary.lastObservedAt).toBe('2026-08-22T10:00:00.000Z');
  });

  it('keeps distinct events from same-named daily files and deduplicates exact copied lines', () => {
    const copied = makeEventLine();
    writeEventsFile('.state/logs', '2026-08-21', [
      copied,
      makeEventLine({}, { toolName: 'exec', filePath: 'x', matched: false, decision: 'allow' }),
    ]);
    writeEventsFile('.pd/logs', '2026-08-21', [copied]);

    const summary = readShadowSummaryForActivation(workspaceDir, ACTIVATION_ID);
    expect(summary.observed).toBe(2);
    expect(summary.wouldAllow).toBe(1);
  });

  it('reports zero (not unavailable) when a log dir exists but has no matching events', () => {
    writeEventsFile('.state/logs', '2026-08-21', [
      JSON.stringify({ ts: '2026-08-21T00:00:00.000Z', type: 'other_event', category: 'x', data: {} }),
    ]);

    const summary = readShadowSummaryForActivation(workspaceDir, ACTIVATION_ID);
    // Distinguishes "channel alive, no data" (zeros) from "no channel" (nulls).
    expect(summary.observed).toBe(0);
    expect(summary.matched).toBe(0);
  });

  it('returns unavailable summary only when neither candidate directory exists', () => {
    const summary = readShadowSummaryForActivation(workspaceDir, ACTIVATION_ID);
    expect(summary).toEqual({
      observed: null, matched: null, wouldBlock: null, wouldAllow: null,
      requireApproval: null, autoCorrect: null, errors: null, neutralControl: null,
      firstObservedAt: null, lastObservedAt: null,
    });
  });

  it('does not report an unreadable candidate path as a healthy zero-event channel', () => {
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.state', 'logs'), 'not a directory');
    const summary = readShadowSummaryForActivation(workspaceDir, ACTIVATION_ID);
    expect(summary.observed).toBeNull();
  });

  it('excludes malformed telemetry lines instead of failing the whole scan', () => {
    writeEventsFile('.state/logs', '2026-08-21', [
      '{not-valid-json',
      makeEventLine(),
    ]);

    const collected = collectRuleCodeEventEntries(workspaceDir);
    expect(collected.entries.length).toBe(1);
    expect(collected.sourceDirsFound).toBeGreaterThanOrEqual(1);
  });
});
