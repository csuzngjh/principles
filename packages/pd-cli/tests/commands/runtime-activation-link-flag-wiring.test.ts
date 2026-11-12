/**
 * PRI-1114 `pd activation link` — CLI gate rule 7 (test the real wiring) and
 * the read-only output contract: stdout = one JSON document, stderr =
 * diagnostics, no writes.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import {
  handleRuntimeActivationLink,
  registerRuntimeActivationLinkCommand,
} from '../../src/commands/runtime-activation.js';

const TMP: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-link-'));
  TMP.push(dir);
  return dir;
}

function writeEvents(workspaceDir: string, dateKey: string, lines: string[]): void {
  const dir = path.join(workspaceDir, '.pd', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `events_${dateKey}.jsonl`), lines.map((line) => `${line}\n`).join(''), 'utf8');
}

function adaptiveLine(id: string, ts: string, state: 'open' | 'closed', workspaceDir: string): string {
  const data: Record<string, unknown> = {
    host: 'openclaw',
    workspaceDir,
    sessionId: 'sess-1',
    runId: 'run-1',
    artifactId: 'art-1',
    activationId: 'act-1',
    hookInvocationId: id,
    receiptState: state,
    execution: state === 'open' ? 'unknown' : 'completed',
    payload: state === 'open' ? 'unknown' : 'prepared',
    selection: state === 'open' ? 'unavailable' : 'selected',
    submission: 'unknown',
  };
  if (state === 'open') data.selectionPending = true;
  else data.reason = 'native_entry_preserved';
  return JSON.stringify({
    ts,
    date: ts.slice(0, 10),
    type: 'adaptive_delivery',
    category: 'written',
    sessionId: 'sess-1',
    data,
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

interface LinkWindow {
  start: string;
  end: string;
  endIsNow: boolean;
  requestedStart: string;
  clampedByRetention: boolean;
}

function requestWindow(report: Record<string, unknown>): LinkWindow {
  return (report.request as { window: LinkWindow }).window;
}

/**
 * The linkage window starts at `now - retentionDays`, so a suite that writes
 * events at a literal timestamp is only green while that literal happens to sit
 * inside the window. Freeze `Date` (timers stay real) so the window is
 * deterministic instead of calendar-dependent.
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

describe('pd activation link — flag wiring (CLI gate rule 7)', () => {
  it('registers the documented flags and the -w shorthand', () => {
    const program = new Command();
    program.name('pd').exitOverride();
    const cmd = registerRuntimeActivationLinkCommand(program.command('activation'));
    const longs = cmd.options.map((option) => option.long);
    expect(longs).toEqual(expect.arrayContaining([
      '--workspace',
      '--since',
      '--until',
      '--host',
      '--max-invocations',
      '--max-date-files',
      '--max-file-bytes',
      '--max-event-lines',
      '--max-trajectory-rows',
      '--json',
    ]));
    expect(cmd.options.find((option) => option.short === '-w')?.long).toBe('--workspace');
    expect(cmd.options.find((option) => option.long === '--no-json')).toBeUndefined();
  });

  it('parses option values through the real command wiring', async () => {
    const program = new Command();
    program.name('pd').exitOverride();
    const cmd = registerRuntimeActivationLinkCommand(program.command('activation'));
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
      'node', 'pd', 'activation', 'link',
      '-w', 'D:\\ws',
      '--since', '2026-11-01T00:00:00.000Z',
      '--max-invocations', '7',
      '--max-date-files', '3',
      '--max-event-lines', '100',
      '--max-trajectory-rows', '50',
      '--json',
    ]);
    expect(captured).not.toBeNull();
    const opts = captured as Record<string, unknown>;
    expect(opts.workspace).toBe('D:\\ws');
    expect(opts.since).toBe('2026-11-01T00:00:00.000Z');
    expect(opts.maxInvocations).toBe('7');
    expect(opts.maxDateFiles).toBe('3');
    expect(opts.maxEventLines).toBe('100');
    expect(opts.maxTrajectoryRows).toBe('50');
    expect(opts.json).toBe(true);
    expect(opts.host).toBe('openclaw');
  });
});

describe('pd activation link — output contract', () => {
  it('writes exactly one JSON document to stdout and diagnostics to stderr', async () => {
    freezeClock();
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine('inv-1', '2026-11-05T09:00:00.000Z', 'open', dir),
      adaptiveLine('inv-1', '2026-11-05T09:05:00.000Z', 'closed', dir),
    ]);
    const streams = captureStreams();
    await handleRuntimeActivationLink({ workspace: dir, json: true });
    expect(process.exitCode).toBeUndefined();
    const report = parseSingleJson(streams.stdout);
    expect(report.schemaVersion).toBe('pd-aa-behavior-linkage/v1');
    expect(report.readOnly).toBe(true);
    expect((report.totals as { invocations: number }).invocations).toBe(1);
    expect((report.totals as { byAssociation: { strong_run: number } }).byAssociation.strong_run).toBe(1);
    // The default window is `now - 7d`; pinning it proves the clock is frozen
    // (an ambient clock after 2026-11-12T09:00Z would start the window later
    // than the fixture events, dropping the counts above to 0).
    const window = requestWindow(report);
    expect(window.start).toBe('2026-10-29T12:00:00.000Z');
    expect(window.clampedByRetention).toBe(false);
    expect(streams.stderr.join('\n')).toContain('[activation link]');
    expect(streams.stdout.join('\n')).not.toContain('[activation link]');
    // Exactly one stdout write: pretty JSON is a single argument, not a banner + document.
    expect(streams.stdout).toHaveLength(1);
  });

  it('sets exit code 2 and emits a structured JSON error for parameter failures', async () => {
    const dir = workspace();
    const streams = captureStreams();
    await handleRuntimeActivationLink({ workspace: dir, until: '2999-01-01T00:00:00.000Z' });
    expect(process.exitCode).toBe(2);
    const payload = parseSingleJson(streams.stdout);
    expect(payload.readOnly).toBe(true);
    expect((payload.error as { code: string }).code).toBe('until_after_now');
    expect(streams.stderr.join('\n')).toContain('nextAction');
  });

  it('sets exit code 3 when no journal directory is readable', async () => {
    const dir = workspace();
    const streams = captureStreams();
    await handleRuntimeActivationLink({ workspace: dir });
    expect(process.exitCode).toBe(3);
    const report = parseSingleJson(streams.stdout);
    expect((report.coverage as { journal: { status: string } }).journal.status).toBe('unavailable');
    expect(streams.stderr.join('\n')).toContain('unknown, not absent');
  });

  it('is byte-for-byte read-only through the CLI path', async () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine('inv-1', '2026-11-05T09:00:00.000Z', 'open', dir),
      adaptiveLine('inv-1', '2026-11-05T09:05:00.000Z', 'closed', dir),
    ]);
    const file = path.join(dir, '.pd', 'logs', 'events_2026-11-05.jsonl');
    const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    captureStreams();
    await handleRuntimeActivationLink({ workspace: dir });
    const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect(before).toBe(after);
  });
});
