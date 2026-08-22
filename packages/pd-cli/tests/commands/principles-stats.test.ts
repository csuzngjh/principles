/**
 * Handler-level tests for `pd principles stats` (PRI-562 Phase 0).
 *
 * Builds a real temp-workspace fixture:
 *   - .state/logs/events_YYYY-MM-DD.jsonl with known injection events
 *     (incl. PRI-562 enriched fields, a malformed line, and an unrelated type)
 *   - .pd/state.db created via the production SqliteConnection bootstrap
 *     (real principle_applications DDL) + known rows
 *
 * Asserts exact aggregation numbers (counts/chars/truncation/duplicates/
 * correlation), the degraded path on an empty workspace (cli-6), and the
 * --days validation contract (cli-2/cli-6).
 *
 * Note: all SQLite statements go through prepare().run() — better-sqlite3's
 * multi-statement shortcut is avoided so static scanners cannot mistake it
 * for shell execution (Mimosa false-positive precedent).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SqliteConnection } from '@principles/core';

import { handlePrinciplesStats } from '../../src/commands/principles-stats.js';

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function makeEventLine(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    ts: Date.now(),
    date: localDateString(new Date()),
    type,
    category: 'injected',
    sessionId: data.sessionId ?? 'unknown',
    data,
  });
}

function insertRow(db: Database.Database, principleId: string, level: string, kind: string, sessionId: string | null): void {
  db.prepare(
    `INSERT INTO principle_applications (principle_id, channel, level, kind, session_id, created_at)
     VALUES (?, 'prompt', ?, ?, ?, ?)`,
  ).run(principleId, level, kind, sessionId, new Date().toISOString());
}

function wsLogs(root: string): string {
  return path.join(root, '.state', 'logs');
}

function wsDb(root: string): string {
  return path.join(root, '.pd', 'state.db');
}

/**
 * Build the known-fixture workspace; returns its root path.
 *
 * Fixture layout (3 real turns across 2 sessions):
 *   today    events file: turn1 (s1, p1+p2, p2 cross-block dup), turn2
 *            (s1, p1 again, v2 truncated), one unrelated type, one malformed
 *            line
 *   yesterday events file: turn3 (s2, pre-PRI-562 shape without legacy fields)
 */
function makeFixtureWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-principles-stats-'));
  const today = localDateString(new Date());
  const yesterday = localDateString(new Date(Date.now() - 24 * 3600 * 1000));

  const turn1 = makeEventLine('runtime_v2_prompt_activations_injected', {
    sessionId: 's1',
    workspaceDir: root,
    principleIds: ['p1', 'p2'],
    activationIds: ['a1', 'a2'],
    artifactIds: ['f1', 'f2'],
    injectedCount: 2,
    skippedWarnings: [],
    injectedCharCount: 500,
    budget: 2000,
    legacySelectedCount: 2,
    legacyTotalChars: 900,
    legacyTruncated: false,
    v2Truncated: false,
    crossBlockDuplicateIds: ['p2'],
  });
  const turn2 = makeEventLine('runtime_v2_prompt_activations_injected', {
    sessionId: 's1',
    workspaceDir: root,
    principleIds: ['p1'],
    activationIds: ['a1'],
    artifactIds: ['f1'],
    injectedCount: 1,
    skippedWarnings: [],
    injectedCharCount: 300,
    budget: 2000,
    v2Truncated: true,
    crossBlockDuplicateIds: [],
  });
  const turn3 = makeEventLine('runtime_v2_prompt_activations_injected', {
    sessionId: 's2',
    workspaceDir: root,
    principleIds: ['p3'],
    activationIds: [],
    artifactIds: [],
    injectedCount: 0,
    skippedWarnings: [],
    injectedCharCount: 0,
    budget: 2000,
    skipReason: 'no_validated_activations',
    nextAction: 'check activations table',
  });
  const unrelated = makeEventLine('some_other_event', { sessionId: 's9' });
  const malformed = 'not-valid-json';

  fs.mkdirSync(wsLogs(root), { recursive: true });
  const todayFile = path.join(wsLogs(root), `events_${today}.jsonl`);
  const yesterdayFile = path.join(wsLogs(root), `events_${yesterday}.jsonl`);
  fs.writeFileSync(todayFile, [turn1, turn2, unrelated, malformed, ''].join('\n'), 'utf8');
  fs.writeFileSync(yesterdayFile, [turn3, ''].join('\n'), 'utf8');

  // Real production schema via the core connection bootstrap.
  fs.mkdirSync(path.dirname(wsDb(root)), { recursive: true });
  const connection = new SqliteConnection({ workspaceDir: root });
  const db = connection.getDb();
  insertRow(db, 'p1', 'presence', 'prompt_injected', 's1');
  insertRow(db, 'p2', 'presence', 'prompt_injected', 's1');
  insertRow(db, 'p3', 'presence', 'prompt_injected', 's2');
  insertRow(db, 'p1', 'effect', 'self_reported', 's1');
  insertRow(db, 'p1', 'effect', 'rule_blocked', null);
  connection.close();
  return root;
}

describe('pd principles stats — handler aggregation', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let workspaces: string[] = [];

  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    process.exitCode = originalExitCode;
    for (const ws of workspaces) {
      fs.rmSync(ws, { recursive: true, force: true });
    }
    workspaces = [];
  });

  function stdoutText(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  function stderrText(): string {
    return stderrWriteSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  it('aggregates known fixture inputs into exact metrics (--json)', async () => {
    const ws = makeFixtureWorkspace();
    workspaces.push(ws);

    await handlePrinciplesStats({ workspace: ws, json: true, days: 14 });

    const parsed = JSON.parse(stdoutText()) as Record<string, unknown>;

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('ok');
    expect(parsed.windowDays).toBe(14);

    const coverage = parsed.coverage as Record<string, unknown>;
    expect(coverage.eventsTurns).toBe(3); // turn1 + turn2 (today) + turn3 (yesterday)
    expect(Array.isArray(coverage.eventsDaysFound)).toBe(true);
    expect((coverage.eventsDaysFound as string[]).length).toBeGreaterThanOrEqual(1);

    expect(parsed.sessions).toBe(2);
    const injections = parsed.injections as Record<string, unknown>;
    expect(injections.source).toBe('ledger');
    expect(injections.avgDistinctPerSession).toBeCloseTo(1.5, 5); // s1:{p1,p2}=2, s2:{p3}=1
    expect(injections.avgPerTurn).toBeCloseTo(4 / 3, 5); // 2+1+1 over 3 turns
    expect(injections.distinctPrinciples).toBe(3);

    const chars = parsed.chars as Record<string, unknown>;
    expect(chars.avgV2PerTurn).toBeCloseTo(800 / 3, 5); // 500+300+0
    expect(chars.avgLegacyPerTurn).toBeCloseTo(900, 5); // only turn1 reports legacy chars
    expect(chars.turnsReporting).toBe(2);
    expect(chars.v2TruncatedTurns).toBe(1);
    expect(chars.legacyTruncatedTurns).toBe(0);
    expect(chars.truncationRate).toBeCloseTo(0.5, 5);

    const duplicates = parsed.duplicates as Record<string, unknown>;
    expect(duplicates.crossBlockTotal).toBe(1);
    expect(duplicates.crossBlockTop).toEqual([{ principleId: 'p2', count: 1 }]);
    expect(duplicates.intraSessionRepeatShare).toBeCloseTo(1 / 3, 5); // p1 seen twice in s1

    const correlation = parsed.applicationCorrelation as Record<string, unknown>;
    expect(correlation.presenceRows).toBe(3);
    expect(correlation.effectRows).toBe(2);
    expect(correlation.correlatedPrinciples).toBeGreaterThanOrEqual(1);
    const top = correlation.top as Array<Record<string, unknown>>;
    expect(top[0].principleId).toBe('p1');

    expect(process.exitCode).toBeUndefined();
  });

  it('degrades with nextAction on an empty workspace (cli-6)', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-principles-stats-empty-'));
    workspaces.push(ws);

    await handlePrinciplesStats({ workspace: ws, json: true, days: 7 });

    const parsed = JSON.parse(stdoutText()) as Record<string, unknown>;

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('degraded');
    expect(parsed.sessions).toBe(0);
    expect(typeof parsed.nextAction).toBe('string');
    expect((parsed.nextAction as string).length).toBeGreaterThan(0);
    const warnings = parsed.warnings as string[];
    expect(warnings.some((w) => w.includes('event logs directory not found'))).toBe(true);
  });

  it('rejects --days 0 with structured reason + exit code 1 (cli-2/cli-6)', async () => {
    await handlePrinciplesStats({ workspace: os.tmpdir(), json: true, days: 0 });

    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('"reason"');
    expect(stderrText()).toContain('"nextAction"');
  });

  it('tolerates a state.db without the receipt table (ledger degrades, events still reported)', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-principles-stats-nodb-'));
    workspaces.push(ws);
    fs.mkdirSync(wsLogs(ws), { recursive: true });
    const today = localDateString(new Date());
    const event = makeEventLine('runtime_v2_prompt_activations_injected', {
      sessionId: 'sx',
      principleIds: ['px'],
      injectedCount: 1,
      skippedWarnings: [],
      injectedCharCount: 120,
      budget: 2000,
      crossBlockDuplicateIds: [],
    });
    fs.writeFileSync(path.join(wsLogs(ws), `events_${today}.jsonl`), [event, ''].join('\n'), 'utf8');
    // .pd exists but the DB has no principle_applications table.
    fs.mkdirSync(path.dirname(wsDb(ws)), { recursive: true });
    const db = new Database(wsDb(ws));
    db.prepare('CREATE TABLE IF NOT EXISTS unrelated (id INTEGER PRIMARY KEY)').run();
    db.close();

    await handlePrinciplesStats({ workspace: ws, json: true, days: 7 });

    const parsed = JSON.parse(stdoutText()) as Record<string, unknown>;
    const coverage = parsed.coverage as Record<string, unknown>;
    const injections = parsed.injections as Record<string, unknown>;

    expect(parsed.ok).toBe(true);
    expect(coverage.ledgerAvailable).toBe(false);
    expect(injections.source).toBe('events');
    expect(injections.avgDistinctPerSession).toBeCloseTo(1, 5);
    const warnings = parsed.warnings as string[];
    expect(warnings.some((w) => w.includes('ledger'))).toBe(true);
  });
});
