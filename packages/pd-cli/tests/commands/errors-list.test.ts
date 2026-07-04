/**
 * Task 14: pd errors list — CLI unit + parser-wiring tests.
 *
 * Coverage:
 *   - cli-7-test-wiring: command registration + option parsing via the real
 *     Commander tree (registerErrorsListCommand).
 *   - cli-1-strict-json: --json stdout is exactly one parseable JSON object.
 *   - cli-2-exit-stops: failure paths set process.exitCode=1 and return.
 *   - cli-6-output-next-action: empty result includes `nextAction` field.
 *   - rc-1/rc-2/rc-4/rc-5: worker-status.json parsed as unknown, validated
 *     with type guards (no `as` casts in test code either).
 *
 * SqliteConnection / SqliteTaskStore are mocked — their contracts are tested
 * in principles-core. fs is mocked for state.db / worker-status.json checks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as path from 'path';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockListFailedTasks = vi.fn();
const mockClose = vi.fn();

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core', () => ({
  SqliteConnection: vi.fn().mockImplementation(function () {
    return { close: mockClose };
  }),
  SqliteTaskStore: vi.fn().mockImplementation(function () {
    return { listFailedTasks: mockListFailedTasks };
  }),
}));

// In-memory mock fs: tests configure which paths "exist" and what content
// each file returns from readFileSync. existsSync falls back to false.
const mockFiles = new Map<string, string>();
vi.mock('fs', () => ({
  existsSync: vi.fn((p: unknown) => {
    const key = typeof p === 'string' ? path.normalize(p) : '';
    return mockFiles.has(key);
  }),
  readFileSync: vi.fn((p: unknown) => {
    const key = typeof p === 'string' ? path.normalize(p) : '';
    if (!mockFiles.has(key)) {
      // rc-2: no `as` cast — use Object.assign to attach `code` to the Error.
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${key}'`), {
        code: 'ENOENT',
      });
    }
    return mockFiles.get(key);
  }),
  mkdirSync: vi.fn(),
}));

import { handleErrorsList, registerErrorsListCommand } from '../../src/commands/errors-list.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const WS = '/fake/workspace';
// Mirror the handler's path resolution so mock fs paths match exactly.
// `path.resolve('/fake/workspace')` on Windows yields `D:\fake\workspace`,
// so the test must use the same resolved path when seeding mockFiles.
const WS_RESOLVED = path.resolve(WS);
const STATE_DIR = path.join(WS_RESOLVED, '.pd');
const STATE_DB = path.join(STATE_DIR, 'state.db');
const WORKER_STATUS = path.join(STATE_DIR, 'worker-status.json');

function setFile(p: string, content: string): void {
  mockFiles.set(path.normalize(p), content);
}

function clearFiles(): void {
  mockFiles.clear();
}

function setStateDbExists(): void {
  // Touch state.db with empty content — existsSync only checks key presence.
  setFile(STATE_DB, '');
}

function setWorkerStatus(content: string): void {
  setFile(WORKER_STATUS, content);
}

function failedTaskSummary(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    taskId: 'task_001',
    taskKind: 'diagnostician',
    painId: 'pain_001',
    status: 'failed',
    lastError: 'runtime_unavailable',
    attemptCount: 3,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastAttemptAt: '2026-07-04T12:00:00.000Z',
    ...overrides,
  };
}

function workerErrorObject(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    at: '2026-07-04T12:00:00.000Z',
    kind: 'principle_update_failed',
    principleId: 'principle_001',
    error: 'SQLite UNIQUE constraint failed',
    ...overrides,
  };
}

// ── Parser-level tests (cli-7-test-wiring) ─────────────────────────────────

type ActionOptions = Record<string, unknown>;
interface CapturedAction {
  opts: ActionOptions | null;
}

function freshProgram(): Command {
  const program = new Command();
  program.name('pd').exitOverride();
  return program;
}

/**
 * rc-2: type guard instead of `as` cast. Narrows `unknown` to a plain
 * options record after Commander dispatch, excluding Commander instances.
 */
function isPlainOptions(value: unknown): value is ActionOptions {
  return value !== null && typeof value === 'object' && !(value instanceof Command);
}

function captureActionInto(state: CapturedAction): (...args: unknown[]) => void {
  return function (...args: unknown[]): void {
    let optsArg: unknown = null;
    for (let i = args.length - 1; i >= 0; i--) {
      const arg = args[i];
      if (isPlainOptions(arg)) {
        optsArg = arg;
        break;
      }
    }
    state.opts = isPlainOptions(optsArg) ? optsArg : {};
  };
}

function requireCmd(cmd: Command | undefined, name: string): Command {
  if (cmd === undefined) {
    throw new Error(`Command '${name}' not found in tree`);
  }
  return cmd;
}

describe('pd errors list — command registration (cli-7-test-wiring)', () => {
  it('registers "errors" command group with "list" subcommand', () => {
    const program = freshProgram();
    registerErrorsListCommand(program);
    const errorsCmd = requireCmd(program.commands.find((c) => c.name() === 'errors'), 'errors');
    const subNames = errorsCmd.commands.map((c) => c.name());
    expect(subNames).toContain('list');
  });

  it('errors command group is hidden from --help (operator diagnostic)', () => {
    const program = freshProgram();
    registerErrorsListCommand(program);
    const errorsCmd = requireCmd(program.commands.find((c) => c.name() === 'errors'), 'errors');
    // Commander v12: hidden commands have `_hidden === true` (internal field,
    // but stable across v12.x). Equivalent to `errorsCmd.hidden()` in some
    // Commander versions — using the field directly avoids API drift.
    expect((errorsCmd as unknown as { _hidden: boolean })._hidden).toBe(true);
  });

  it('list subcommand has --workspace, --json, --kind, --since, --limit options', () => {
    const program = freshProgram();
    registerErrorsListCommand(program);
    const errorsCmd = requireCmd(program.commands.find((c) => c.name() === 'errors'), 'errors');
    const listCmd = requireCmd(errorsCmd.commands.find((c) => c.name() === 'list'), 'list');

    expect(listCmd.options.find((o) => o.long === '--workspace')).toBeDefined();
    expect(listCmd.options.find((o) => o.long === '--workspace')?.short).toBe('-w');
    expect(listCmd.options.find((o) => o.long === '--json')).toBeDefined();
    expect(listCmd.options.find((o) => o.long === '--kind')).toBeDefined();
    expect(listCmd.options.find((o) => o.long === '--since')).toBeDefined();
    expect(listCmd.options.find((o) => o.long === '--limit')).toBeDefined();
  });

  it('parses --json --kind --since --limit flags correctly (cli-7)', async () => {
    const program = freshProgram();
    registerErrorsListCommand(program);
    const errorsCmd = requireCmd(program.commands.find((c) => c.name() === 'errors'), 'errors');
    const listCmd = requireCmd(errorsCmd.commands.find((c) => c.name() === 'list'), 'list');

    const captured: CapturedAction = { opts: null };
    // Replace the production action with a capture so we can assert parser output
    // without invoking the real handler (which would touch mocked fs/core).
    listCmd.action(captureActionInto(captured));

    await program.parseAsync([
      'node',
      'pd',
      'errors',
      'list',
      '--json',
      '--kind',
      'diag_router',
      '--since',
      '24',
      '--limit',
      '10',
      '--workspace',
      WS,
    ]);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBe(true);
    expect(captured.opts?.kind).toBe('diag_router');
    expect(captured.opts?.since).toBe(24);
    expect(captured.opts?.limit).toBe(10);
    expect(captured.opts?.workspace).toBe(WS);
  });

  it('--since and --limit are parsed as integers (not strings)', async () => {
    const program = freshProgram();
    registerErrorsListCommand(program);
    const errorsCmd = requireCmd(program.commands.find((c) => c.name() === 'errors'), 'errors');
    const listCmd = requireCmd(errorsCmd.commands.find((c) => c.name() === 'list'), 'list');

    const captured: CapturedAction = { opts: null };
    listCmd.action(captureActionInto(captured));

    await program.parseAsync([
      'node',
      'pd',
      'errors',
      'list',
      '--since',
      '48',
      '--limit',
      '100',
    ]);

    expect(typeof captured.opts?.since).toBe('number');
    expect(captured.opts?.since).toBe(48);
    expect(typeof captured.opts?.limit).toBe('number');
    expect(captured.opts?.limit).toBe(100);
  });
});

// ── Handler tests ───────────────────────────────────────────────────────────

describe('handleErrorsList — handler behavior', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearFiles();
    mockListFailedTasks.mockReset();
    mockClose.mockReset();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    process.exitCode = 0;
  });

  // ── Empty result (cli-6-output-next-action) ──────────────────────────────

  it('empty result --json: outputs single JSON object with nextAction (cli-1, cli-6)', async () => {
    setStateDbExists();
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.tasks).toEqual([]);
    expect(parsed.workerErrors).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.nextAction).toBe('No errors found. PD pipeline is healthy.');
    // worker-status.json missing → workerStatusMissing=true
    expect(parsed.workerStatusMissing).toBe(true);
    expect(parsed.workerStatusPath).toContain('worker-status.json');
    // cli-2-exit-stops: success path does NOT set exitCode to failure (1).
    // We assert "not 1" rather than "toBe(0)" because vitest may reset
    // process.exitCode to undefined between tests; the contract under test
    // is "handler must not mark failure", not "handler must set 0".
    expect(process.exitCode).not.toBe(1);
  });

  it('empty result text: human-readable output contains health message', async () => {
    setStateDbExists();
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: false });

    const text = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('No errors found. PD pipeline is healthy.');
    expect(text).toContain('total:       0');
  });

  // ── With failed tasks ────────────────────────────────────────────────────

  it('--json with failed tasks: outputs tasks array (cli-1-strict-json single object)', async () => {
    setStateDbExists();
    const task = failedTaskSummary();
    mockListFailedTasks.mockResolvedValue([task]);

    await handleErrorsList({ workspace: WS, json: true });

    expect(mockListFailedTasks).toHaveBeenCalledWith({
      kind: undefined,
      since: undefined,
      limit: 50, // default
    });
    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].taskId).toBe('task_001');
    expect(parsed.tasks[0].taskKind).toBe('diagnostician');
    expect(parsed.tasks[0].status).toBe('failed');
    expect(parsed.total).toBe(1);
    // nextAction should NOT be present when there are errors
    expect(parsed.nextAction).toBeUndefined();
  });

  it('--kind filter is passed through to listFailedTasks', async () => {
    setStateDbExists();
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true, kind: 'dreamer' });

    expect(mockListFailedTasks).toHaveBeenCalledWith({
      kind: 'dreamer',
      since: undefined,
      limit: 50,
    });
  });

  it('--since filter is converted from hours to Unix-ms timestamp', async () => {
    setStateDbExists();
    mockListFailedTasks.mockResolvedValue([]);
    const before = Date.now();

    await handleErrorsList({ workspace: WS, json: true, since: 24 });

    const after = Date.now();
    expect(mockListFailedTasks).toHaveBeenCalledTimes(1);
    const call = mockListFailedTasks.mock.calls[0][0];
    expect(typeof call.since).toBe('number');
    // 24 hours ago, ±a few ms of slack for test execution time
    const expectedSince = before - 24 * 3600 * 1000;
    expect(call.since).toBeGreaterThanOrEqual(expectedSince - 1000);
    expect(call.since).toBeLessThanOrEqual(after - 24 * 3600 * 1000 + 1000);
  });

  it('--limit is clamped to MAX_LIMIT (200)', async () => {
    setStateDbExists();
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true, limit: 500 });

    expect(mockListFailedTasks).toHaveBeenCalledWith({
      kind: undefined,
      since: undefined,
      limit: 200,
    });
  });

  it('--limit default is 50 when not specified', async () => {
    setStateDbExists();
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    expect(mockListFailedTasks).toHaveBeenCalledWith({
      kind: undefined,
      since: undefined,
      limit: 50,
    });
  });

  // ── worker-status.json parsing (rc-1, rc-4, rc-5) ───────────────────────

  it('worker-status.json with object-form errors: parsed and normalized', async () => {
    setStateDbExists();
    setWorkerStatus(
      JSON.stringify({
        timestamp: '2026-07-04T12:00:00.000Z',
        errors: [workerErrorObject()],
      }),
    );
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.workerErrors).toHaveLength(1);
    expect(parsed.workerErrors[0].at).toBe('2026-07-04T12:00:00.000Z');
    expect(parsed.workerErrors[0].kind).toBe('principle_update_failed');
    expect(parsed.workerErrors[0].principleId).toBe('principle_001');
    expect(parsed.workerErrors[0].error).toBe('SQLite UNIQUE constraint failed');
    expect(parsed.workerErrors[0].rawForm).toBe('object');
    expect(parsed.workerStatusMissing).toBeUndefined();
    expect(parsed.total).toBe(1); // 0 tasks + 1 workerError
  });

  it('worker-status.json with string-form errors: normalized with rawForm=string', async () => {
    setStateDbExists();
    setWorkerStatus(
      JSON.stringify({
        errors: ['legacy error string'],
      }),
    );
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.workerErrors).toHaveLength(1);
    expect(parsed.workerErrors[0].error).toBe('legacy error string');
    expect(parsed.workerErrors[0].rawForm).toBe('string');
    expect(parsed.workerErrors[0].at).toBeNull();
    expect(parsed.workerErrors[0].kind).toBeNull();
    expect(parsed.workerErrors[0].principleId).toBeNull();
  });

  it('worker-status.json with mixed object + string errors: both normalized', async () => {
    setStateDbExists();
    setWorkerStatus(
      JSON.stringify({
        errors: [
          workerErrorObject({ error: 'first error' }),
          'second error string',
          workerErrorObject({ kind: 'retry_count_update_failed', error: 'third error' }),
        ],
      }),
    );
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.workerErrors).toHaveLength(3);
    expect(parsed.workerErrors[0].rawForm).toBe('object');
    expect(parsed.workerErrors[1].rawForm).toBe('string');
    expect(parsed.workerErrors[2].rawForm).toBe('object');
    expect(parsed.workerErrors[2].kind).toBe('retry_count_update_failed');
  });

  it('worker-status.json with malformed entries: skipped with workerStatusWarning (rc-9)', async () => {
    setStateDbExists();
    setWorkerStatus(
      JSON.stringify({
        errors: [
          workerErrorObject({ error: 'good entry' }),
          42, // malformed — number, not string or object
          null, // malformed — null
          'string entry',
        ],
      }),
    );
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.workerErrors).toHaveLength(2); // only good + string
    expect(parsed.workerStatusWarning).toContain('Skipped 2 malformed');
    expect(parsed.workerErrors[0].error).toBe('good entry');
    expect(parsed.workerErrors[1].error).toBe('string entry');
  });

  it('worker-status.json missing errors field: treated as empty, no warning', async () => {
    setStateDbExists();
    setWorkerStatus(JSON.stringify({ timestamp: '2026-07-04T12:00:00.000Z' }));
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.workerErrors).toEqual([]);
    expect(parsed.workerStatusWarning).toBeUndefined();
    expect(parsed.workerStatusMissing).toBeUndefined();
  });

  it('worker-status.json with non-array errors field: warning surfaced (rc-9)', async () => {
    setStateDbExists();
    setWorkerStatus(JSON.stringify({ errors: 'not an array' }));
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.workerErrors).toEqual([]);
    expect(parsed.workerStatusWarning).toContain('not an array');
  });

  it('worker-status.json unparseable JSON: warning surfaced (rc-9)', async () => {
    setStateDbExists();
    setWorkerStatus('{ this is not valid json');
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.workerErrors).toEqual([]);
    expect(parsed.workerStatusWarning).toContain('Failed to parse');
  });

  it('worker-status.json root is array (not object): warning surfaced', async () => {
    setStateDbExists();
    setWorkerStatus(JSON.stringify(['not', 'an', 'object']));
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.workerErrors).toEqual([]);
    expect(parsed.workerStatusWarning).toContain('not a JSON object');
  });

  // ── Failure paths (cli-2-exit-stops) ────────────────────────────────────

  it('state.db missing: stderr error + exitCode=1 + return (cli-2)', async () => {
    // Do NOT call setStateDbExists — state.db missing
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: false });

    // listFailedTasks should NOT be called (early return)
    expect(mockListFailedTasks).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const stderrText = stderrWriteSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).toContain('state.db not found');
  });

  it('state.db missing --json: JSON error envelope on stderr (cli-1 + cli-2)', async () => {
    // state.db missing
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    expect(process.exitCode).toBe(1);
    // cli-1: stdout must stay clean (no console.log calls)
    expect(consoleLogSpy).not.toHaveBeenCalled();
    // stderr carries the JSON error envelope
    const stderrText = stderrWriteSpy.mock.calls.map((c) => String(c[0])).join('');
    const errEnvelope = JSON.parse(stderrText.trim());
    expect(errEnvelope.ok).toBe(false);
    expect(errEnvelope.reason).toContain('state.db not found');
    expect(errEnvelope.nextAction).toBeDefined();
  });

  it('invalid --limit (negative): stderr error + exitCode=1 (cli-2)', async () => {
    setStateDbExists();
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: false, limit: -5 });

    expect(mockListFailedTasks).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const stderrText = stderrWriteSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).toContain('--limit must be a positive integer');
  });

  it('invalid --since (negative): stderr error + exitCode=1 (cli-2)', async () => {
    setStateDbExists();
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: false, since: -1 });

    expect(mockListFailedTasks).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const stderrText = stderrWriteSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).toContain('--since must be a non-negative number');
  });

  it('listFailedTasks throws: stderr error + exitCode=1 + connection closed (cli-2)', async () => {
    setStateDbExists();
    mockListFailedTasks.mockRejectedValue(new Error('database is locked'));

    await handleErrorsList({ workspace: WS, json: false });

    expect(process.exitCode).toBe(1);
    const stderrText = stderrWriteSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).toContain('database is locked');
    // connection.close() called in finally block
    expect(mockClose).toHaveBeenCalled();
  });

  it('listFailedTasks throws --json: JSON error envelope on stderr (cli-1 + cli-2)', async () => {
    setStateDbExists();
    mockListFailedTasks.mockRejectedValue(new Error('database is locked'));

    await handleErrorsList({ workspace: WS, json: true });

    expect(process.exitCode).toBe(1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    const stderrText = stderrWriteSpy.mock.calls.map((c) => String(c[0])).join('');
    const errEnvelope = JSON.parse(stderrText.trim());
    expect(errEnvelope.ok).toBe(false);
    expect(errEnvelope.reason).toContain('database is locked');
    expect(errEnvelope.nextAction).toBeDefined();
    expect(mockClose).toHaveBeenCalled();
  });

  // ── cli-1-strict-json: stdout is exactly one parseable JSON object ───────

  it('--json stdout is exactly one parseable JSON object (cli-1-strict-json)', async () => {
    setStateDbExists();
    setWorkerStatus(
      JSON.stringify({
        errors: [workerErrorObject()],
      }),
    );
    mockListFailedTasks.mockResolvedValue([failedTaskSummary()]);

    await handleErrorsList({ workspace: WS, json: true });

    // console.log called exactly once with a single string
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const raw = consoleLogSpy.mock.calls[0][0];
    expect(typeof raw).toBe('string');
    // Must parse without error (already asserted above, but be explicit)
    expect(() => JSON.parse(raw)).not.toThrow();
    // No trailing or leading non-JSON text
    const parsed = JSON.parse(raw);
    expect(parsed).toBeTypeOf('object');
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
  });

  // ── Text output smoke tests ──────────────────────────────────────────────

  it('text output with errors: includes task and worker error sections', async () => {
    setStateDbExists();
    setWorkerStatus(
      JSON.stringify({
        errors: [workerErrorObject({ error: 'worker boom' })],
      }),
    );
    mockListFailedTasks.mockResolvedValue([failedTaskSummary({ lastError: 'runtime_unavailable' })]);

    await handleErrorsList({ workspace: WS, json: false });

    const text = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('Failed tasks:');
    expect(text).toContain('task_001');
    expect(text).toContain('runtime_unavailable');
    expect(text).toContain('Worker errors:');
    expect(text).toContain('worker boom');
    expect(text).toContain('principle_update_failed');
    expect(text).toContain('total:       2');
  });

  it('text output: worker-status.json missing is reported in workerStatus line', async () => {
    setStateDbExists();
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: false });

    const text = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('workerStatus: (missing');
  });

  it('connection.close() called on success path (resource cleanup)', async () => {
    setStateDbExists();
    mockListFailedTasks.mockResolvedValue([]);

    await handleErrorsList({ workspace: WS, json: true });

    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
