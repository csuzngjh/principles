/**
 * PRI-1109 `pd activation journal` — CLI gate rule 7 (test the real wiring)
 * and CLI output contract (stdout = one JSON document, stderr = diagnostics).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import {
  handleRuntimeActivationJournal,
  registerRuntimeActivationJournalCommand,
} from '../../src/commands/runtime-activation.js';

const TMP: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-journal-'));
  TMP.push(dir);
  return dir;
}

function writeEvents(workspaceDir: string, dateKey: string, lines: string[]): void {
  const dir = path.join(workspaceDir, '.pd', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `events_${dateKey}.jsonl`), lines.map((line) => `${line}\n`).join(''), 'utf8');
}

function openLine(id: string, ts: string, workspaceDir: string): string {
  return JSON.stringify({
    ts,
    date: ts.slice(0, 10),
    type: 'adaptive_delivery',
    category: 'written',
    sessionId: 'sess-1',
    data: {
      host: 'openclaw',
      workspaceDir,
      sessionId: 'sess-1',
      runId: 'run-1',
      artifactId: 'art-1',
      activationId: 'act-1',
      hookInvocationId: id,
      receiptState: 'open',
      execution: 'unknown',
      payload: 'unknown',
      selection: 'unavailable',
      submission: 'unknown',
      selectionPending: true,
    },
  });
}

function closedLine(id: string, ts: string, workspaceDir: string): string {
  return JSON.stringify({
    ts,
    date: ts.slice(0, 10),
    type: 'adaptive_delivery',
    category: 'written',
    sessionId: 'sess-1',
    data: {
      host: 'openclaw',
      workspaceDir,
      sessionId: 'sess-1',
      runId: 'run-1',
      artifactId: 'art-1',
      activationId: 'act-1',
      hookInvocationId: id,
      receiptState: 'closed',
      execution: 'completed',
      payload: 'prepared',
      selection: 'selected',
      submission: 'unknown',
      reason: 'native_entry_preserved',
    },
  });
}

interface CapturedStreams {
  stdout: string[];
  stderr: string[];
}

function captureStreams(): CapturedStreams {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  return { stdout, stderr };
}

function parseSingleJson(stream: string[]): Record<string, unknown> {
  const text = stream.join('\n');
  expect(text.trim().startsWith('{')).toBe(true);
  expect(text.trim().endsWith('}')).toBe(true);
  return JSON.parse(text) as Record<string, unknown>;
}

interface JournalWindow {
  start: string;
  end: string;
  endIsNow: boolean;
  requestedStart: string;
  clampedByRetention: boolean;
}

function requestWindow(report: Record<string, unknown>): JournalWindow {
  return (report.request as { window: JournalWindow }).window;
}

/**
 * The window start is clamped to `now - retentionDays`, so any assertion on a
 * literal `window.start` is coupled to the calendar day the suite runs on.
 * Freeze `Date` (timers stay real) to make the window deterministic while still
 * driving the real reconciler and the real clamp branch.
 */
const FROZEN_NOW = new Date('2026-11-05T12:00:00.000Z');

function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN_NOW);
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (TMP.length > 0) {
    const dir = TMP.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('pd activation journal — flag wiring (CLI gate rule 7)', () => {
  function journalCommand(): Command {
    const program = new Command();
    program.name('pd').exitOverride();
    const activation = program.command('activation');
    return registerRuntimeActivationJournalCommand(activation);
  }

  it('registers the documented flags and -w shorthand', () => {
    const cmd = journalCommand();
    const longs = cmd.options.map((option) => option.long);
    expect(longs).toEqual(expect.arrayContaining([
      '--workspace',
      '--since',
      '--until',
      '--host',
      '--max-invocations',
      '--max-date-files',
      '--max-file-bytes',
      '--max-terminal-variants',
    ]));
    expect(cmd.options.find((option) => option.short === '-w')?.long).toBe('--workspace');
    expect(cmd.options.find((option) => option.long === '--no-json')).toBeUndefined();
  });

  it('parses option values through the real command wiring', async () => {
    const program = new Command();
    program.name('pd').exitOverride();
    const activation = program.command('activation');
    const cmd = registerRuntimeActivationJournalCommand(activation);
    let captured: Record<string, unknown> | null = null;
    cmd.action(function captureAction(...args: unknown[]): void {
      for (let index = args.length - 1; index >= 0; index -= 1) {
        const arg = args[index];
        if (arg !== null && typeof arg === 'object' && !(arg instanceof Command)) {
          captured = arg as Record<string, unknown>;
          return;
        }
      }
      captured = {};
    });
    await program.parseAsync([
      'node', 'pd', 'activation', 'journal',
      '-w', 'D:\\ws',
      '--since', '2026-11-01T00:00:00.000Z',
      '--until', '2026-11-05T00:00:00.000Z',
      '--max-invocations', '7',
      '--max-date-files', '3',
      '--max-file-bytes', '1024',
      '--max-terminal-variants', '2',
    ]);
    expect(captured).not.toBeNull();
    const opts = captured as Record<string, unknown>;
    expect(opts.workspace).toBe('D:\\ws');
    expect(opts.since).toBe('2026-11-01T00:00:00.000Z');
    expect(opts.until).toBe('2026-11-05T00:00:00.000Z');
    expect(opts.maxInvocations).toBe('7');
    expect(opts.maxDateFiles).toBe('3');
    expect(opts.maxFileBytes).toBe('1024');
    expect(opts.maxTerminalVariants).toBe('2');
    expect(opts.host).toBe('openclaw');
  });
});

describe('pd activation journal — output contract', () => {
  it('writes exactly one JSON document to stdout and diagnostics to stderr', async () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      openLine('inv-1', '2026-11-05T09:00:00.000Z', dir),
      closedLine('inv-1', '2026-11-05T09:05:00.000Z', dir),
    ]);
    const streams = captureStreams();
    await handleRuntimeActivationJournal({ workspace: dir });
    expect(process.exitCode).toBeUndefined();
    const report = parseSingleJson(streams.stdout);
    expect(report.schemaVersion).toBe('pd-aa-journal-reconciliation/v1');
    expect(report.readOnly).toBe(true);
    expect((report.answers as Record<string, { count: number }>).q1_open_and_terminal.count).toBe(1);
    expect(streams.stderr.join('\n')).toContain('effective window');
    expect(streams.stderr.join('\n')).toContain('coverage=complete');
    expect(streams.stdout.join('\n')).not.toContain('[activation journal]');
  });

  it('sets exit code 2 and emits a structured JSON error for parameter failures', async () => {
    const dir = workspace();
    const streams = captureStreams();
    await handleRuntimeActivationJournal({ workspace: dir, until: '2999-01-01T00:00:00.000Z' });
    expect(process.exitCode).toBe(2);
    const payload = parseSingleJson(streams.stdout);
    expect(payload.readOnly).toBe(true);
    expect((payload.error as { code: string }).code).toBe('until_after_now');
    expect(streams.stderr.join('\n')).toContain('nextAction');
  });

  it('sets exit code 3 when no log directory is readable, without claiming zero invocations', async () => {
    const dir = workspace();
    const streams = captureStreams();
    await handleRuntimeActivationJournal({ workspace: dir });
    expect(process.exitCode).toBe(3);
    const report = parseSingleJson(streams.stdout);
    expect((report.coverage as { status: string }).status).toBe('unavailable');
    expect((report.totals as { uniqueInvocations: number | null }).uniqueInvocations).toBeNull();
    expect(streams.stderr.join('\n')).toContain('unknown, not zero invocations');
  });

  it('applies limit flags and echoes the effective window', async () => {
    freezeClock();
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      openLine('inv-1', '2026-11-05T08:00:00.000Z', dir),
      closedLine('inv-1', '2026-11-05T08:10:00.000Z', dir),
      openLine('inv-2', '2026-11-05T08:20:00.000Z', dir),
      closedLine('inv-2', '2026-11-05T08:30:00.000Z', dir),
    ]);
    const streams = captureStreams();
    await handleRuntimeActivationJournal({
      workspace: dir,
      since: '2026-11-05T00:00:00.000Z',
      maxInvocations: '1',
    });
    const report = parseSingleJson(streams.stdout);
    expect(report.outputTruncated).toBe(true);
    expect((report.truncation as { omitted: number }).omitted).toBe(1);
    const window = requestWindow(report);
    // `--since` is inside the 7-day retention window relative to FROZEN_NOW,
    // so the effective start is the requested instant, unclamped.
    expect(window.start).toBe('2026-11-05T00:00:00.000Z');
    expect(window.requestedStart).toBe('2026-11-05T00:00:00.000Z');
    expect(window.clampedByRetention).toBe(false);
    expect(window.endIsNow).toBe(true);
    expect(streams.stderr.join('\n')).toContain('effective window');
    expect(streams.stderr.join('\n')).toContain('clampedByRetention=false');
    expect(streams.stderr.join('\n')).toContain('lower bounds');
  });

  it('clamps an explicit --since older than the retention boundary and reports it', async () => {
    freezeClock();
    const dir = workspace();
    writeEvents(dir, '2026-10-30', [
      openLine('inv-1', '2026-10-30T08:00:00.000Z', dir),
      closedLine('inv-1', '2026-10-30T08:10:00.000Z', dir),
    ]);
    const streams = captureStreams();
    await handleRuntimeActivationJournal({
      workspace: dir,
      // Older than FROZEN_NOW - 7 days (2026-10-29T12:00:00.000Z).
      since: '2026-10-01T00:00:00.000Z',
    });
    const report = parseSingleJson(streams.stdout);
    const window = requestWindow(report);
    expect(window.requestedStart).toBe('2026-10-01T00:00:00.000Z');
    expect(window.clampedByRetention).toBe(true);
    expect(window.start).toBe('2026-10-29T12:00:00.000Z');
    expect(window.endIsNow).toBe(true);
    expect(streams.stderr.join('\n')).toContain('clampedByRetention=true');
  });

  it('is byte-for-byte read-only through the CLI path', async () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      openLine('inv-1', '2026-11-05T09:00:00.000Z', dir),
      closedLine('inv-1', '2026-11-05T09:05:00.000Z', dir),
    ]);
    const file = path.join(dir, '.pd', 'logs', 'events_2026-11-05.jsonl');
    const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    captureStreams();
    await handleRuntimeActivationJournal({ workspace: dir });
    const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect(before).toBe(after);
  });
});
