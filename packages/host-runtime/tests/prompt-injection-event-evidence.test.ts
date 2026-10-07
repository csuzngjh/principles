import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInjectionEventEvidence } from '../src/index.js';

/**
 * PD_PROMPT_CAPACITY_V1 Phase C / AC-12: the injection-event read model never
 * turns missing logs into zeros, dedupes duplicates, keeps workspaces
 * separate under the same runId, and flags old events with missing identity
 * fields instead of guessing.
 */

const tempDirs: string[] = [];

function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evidence-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function writeEvents(stateDir: string, date: string, entries: unknown[]): void {
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.appendFileSync(
    path.join(stateDir, 'logs', `events_${date}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
}

function injectedEvent(overrides: Partial<Record<string, unknown>> & { data: Record<string, unknown> }): unknown {
  return { ts: '2026-10-07T08:00:00.000Z', date: '2026-10-07', type: 'runtime_v2_prompt_activations_injected', category: 'injected', sessionId: 's-1', ...overrides };
}

describe('AC-12: readInjectionEventEvidence', () => {
  it('no logs at all → zero rows with an explicit unknown note (never "proven zero")', () => {
    const report = readInjectionEventEvidence({ stateDir: tempStateDir() });
    expect(report.rows).toEqual([]);
    expect(report.note).toContain('UNKNOWN');
  });

  it('counts proven injections, dedupes identical duplicate lines, and reports the dedupe count', () => {
    const dir = tempStateDir();
    const event = injectedEvent({
      data: { sessionId: 's-1', workspaceDir: 'ws-a', activationIds: ['act-1', 'act-2'], artifactIds: ['a', 'b'], principleIds: ['p1', 'p2'], injectedCount: 2, injectedCharCount: 480, budget: 2000, runId: 'run-1', selectionPolicy: 'fair_rotation_v1' },
    });
    writeEvents(dir, '2026-10-07', [event, event, event]);
    const report = readInjectionEventEvidence({ stateDir: dir });
    expect(report.rows).toHaveLength(2);
    for (const row of report.rows) {
      expect(row.provenInjections).toBe(1);
      expect(row.rawEventCount).toBe(3);
      expect(row.duplicateEventsDeduped).toBe(2);
      expect(row.runIds).toEqual(['run-1']);
      expect(row.runIdComplete).toBe(true);
    }
  });

  it('the same runId across two workspaces stays in separate rows (statistics never mix entities)', () => {
    const dir = tempStateDir();
    writeEvents(dir, '2026-10-07', [
      injectedEvent({ data: { sessionId: 's-1', workspaceDir: 'ws-a', activationIds: ['act-1'], artifactIds: ['a'], principleIds: ['p1'], injectedCount: 1, injectedCharCount: 240, budget: 2000, runId: 'SAME-RUN' } }),
      injectedEvent({ data: { sessionId: 's-1', workspaceDir: 'ws-b', activationIds: ['act-1'], artifactIds: ['a'], principleIds: ['p1'], injectedCount: 1, injectedCharCount: 240, budget: 2000, runId: 'SAME-RUN' } }),
    ]);
    const report = readInjectionEventEvidence({ stateDir: dir });
    expect(report.rows).toHaveLength(2);
    expect(new Set(report.rows.map((r) => r.workspaceDir))).toEqual(new Set(['ws-a', 'ws-b']));
  });

  it('old events missing runId still count as facts but flag runIdComplete=false', () => {
    const dir = tempStateDir();
    writeEvents(dir, '2026-10-06', [
      injectedEvent({ ts: '2026-10-06T08:00:00.000Z', date: '2026-10-06', data: { sessionId: 's-old', workspaceDir: 'ws-a', activationIds: ['act-1'], artifactIds: ['a'], principleIds: ['p1'], injectedCount: 1, injectedCharCount: 240, budget: 2000 } }),
    ]);
    const report = readInjectionEventEvidence({ stateDir: dir });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].provenInjections).toBe(1);
    expect(report.rows[0].runIdComplete).toBe(false);
    expect(report.rows[0].runIds).toEqual([]);
  });

  it('structurally invalid lines are skipped loudly (parseFailures), never guessed into counts', () => {
    const dir = tempStateDir();
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs', 'events_2026-10-07.jsonl'), [
      '{not json',
      JSON.stringify({ type: 'runtime_v2_prompt_activations_injected', data: { sessionId: 's', workspaceDir: 'ws' } }),
      JSON.stringify(injectedEvent({ data: { sessionId: 's-1', workspaceDir: 'ws-a', activationIds: ['act-1'], artifactIds: ['a'], principleIds: ['p1'], injectedCount: 1, injectedCharCount: 240, budget: 2000, runId: 'r1' } })),
    ].join('\n') + '\n', 'utf8');
    const report = readInjectionEventEvidence({ stateDir: dir });
    expect(report.parseFailures).toBe(2);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].provenInjections).toBe(1);
  });

  it('non-injection event types are ignored', () => {
    const dir = tempStateDir();
    writeEvents(dir, '2026-10-07', [
      { ts: '2026-10-07T08:00:00.000Z', type: 'some_other_event', data: {} },
    ]);
    const report = readInjectionEventEvidence({ stateDir: dir });
    expect(report.rows).toEqual([]);
    expect(report.parseFailures).toBe(0);
  });
});
