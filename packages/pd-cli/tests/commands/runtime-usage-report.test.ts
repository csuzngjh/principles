/**
 * `pd runtime usage report` — aggregation + output contract.
 *
 * The report is the only consumer of the cli_invocation records, so these tests
 * pin what an operator can conclude from it: command×source counts, exit-code
 * distribution, and the honest treatment of everything that is NOT a readable
 * record (other event types, malformed lines, out-of-window lines, missing
 * fields → UNKNOWN, never 0).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPdProgram } from '../../src/program.js';
import {
  buildRuntimeUsageReport,
  handleRuntimeUsageReport,
  formatRuntimeUsageReport,
} from '../../src/commands/runtime-usage.js';
import { invocationLogPath } from '../../src/services/cli-invocation-log.js';

const NOW = new Date('2026-11-14T12:00:00.000Z');

let tmpRoot: string;
let workspace: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-usage-report-'));
  workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(path.join(workspace, '.pd', 'telemetry'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function writeLines(lines: unknown[]): void {
  fs.writeFileSync(
    invocationLogPath(workspace),
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n',
    'utf8',
  );
}

function record(command: string | null, exitCode: number | string | null, source: string | null, at: string) {
  const payload: Record<string, unknown> = {};
  if (command !== null) payload.command = command;
  if (exitCode !== null) payload.exitCode = exitCode;
  if (source !== null) payload.source = source;
  return { eventType: 'cli_invocation', timestamp: at, payload };
}

describe('buildRuntimeUsageReport', () => {
  it('reports an empty status (not a zero-filled success) when no sink exists', () => {
    const report = buildRuntimeUsageReport(path.join(tmpRoot, 'fresh'), 7, NOW);
    expect(report.status).toBe('empty');
    expect(report.reason).toBe('no_invocation_records');
    expect(report.nextAction).toContain('Run any pd command');
    expect(report.totals.invocations).toBe(0);
  });

  it('counts command × source and distributes exit codes', () => {
    writeLines([
      record('pain record', 0, 'companion', '2026-11-13T10:00:00.000Z'),
      record('pain record', 1, 'companion', '2026-11-13T11:00:00.000Z'),
      record('health', 0, 'console', '2026-11-13T12:00:00.000Z'),
    ]);

    const report = buildRuntimeUsageReport(workspace, 7, NOW);
    expect(report.status).toBe('ok');
    expect(report.totals.invocations).toBe(3);
    expect(report.byCommand[0]).toEqual({
      name: 'pain record',
      count: 2,
      exitCodes: [
        { exitCode: '0', count: 1 },
        { exitCode: '1', count: 1 },
      ],
    });
    expect(report.bySource).toEqual([
      { name: 'companion', count: 2, exitCodes: [{ exitCode: '0', count: 1 }, { exitCode: '1', count: 1 }] },
      { name: 'console', count: 1, exitCodes: [{ exitCode: '0', count: 1 }] },
    ]);
  });

  it('separates other event types, malformed lines and out-of-window records', () => {
    writeLines([
      record('health', 0, 'human', '2026-11-13T10:00:00.000Z'),
      { eventType: 'evaluator_adversarial_replay', timestamp: '2026-11-13T10:00:00.000Z', payload: {} },
      '{not json',
      record('health', 0, 'human', '2026-01-01T00:00:00.000Z'),
    ]);

    const report = buildRuntimeUsageReport(workspace, 7, NOW);
    expect(report.totals.invocations).toBe(1);
    expect(report.coverage.otherEventLines).toBe(1);
    expect(report.coverage.unreadableLines).toBe(2);
  });

  it('buckets missing fields as UNKNOWN and counts them instead of dropping them', () => {
    writeLines([
      record(null, null, null, '2026-11-13T10:00:00.000Z'),
      record('task show', 0, null, '2026-11-13T11:00:00.000Z'),
    ]);

    const report = buildRuntimeUsageReport(workspace, 7, NOW);
    expect(report.totals.invocations).toBe(2);
    expect(report.coverage.missingCommand).toBe(1);
    expect(report.coverage.missingSource).toBe(2);
    expect(report.coverage.missingExitCode).toBe(1);
    expect(report.byCommand).toContainEqual({
      name: 'UNKNOWN',
      count: 1,
      exitCodes: [{ exitCode: 'UNKNOWN', count: 1 }],
    });
    expect(report.bySource).toContainEqual(expect.objectContaining({ name: 'UNKNOWN', count: 2 }));
  });

  it('reports degraded with a closed reason code when the sink cannot be read', () => {
    fs.mkdirSync(invocationLogPath(workspace), { recursive: true }); // a directory, not a file
    const report = buildRuntimeUsageReport(workspace, 7, NOW);
    expect(report.status).toBe('degraded');
    expect(report.reason).toBe('sink_unreadable');
    expect(report.nextAction).toContain('permissions');
    // No filesystem message leaks into the report (EP-08 / ERR-198).
    expect(JSON.stringify(report)).not.toMatch(/EISDIR|EPERM|ENOENT/);
  });

  it('reports no_records_in_window when the sink has no record inside the window', () => {
    writeLines([record('health', 0, 'human', '2026-01-01T00:00:00.000Z')]);
    const report = buildRuntimeUsageReport(workspace, 7, NOW);
    expect(report.status).toBe('empty');
    expect(report.reason).toBe('no_records_in_window');
  });
});

describe('handleRuntimeUsageReport', () => {
  it('emits exactly one parseable JSON object', async () => {
    writeLines([record('health', 0, 'companion', new Date(NOW.getTime() - 3600_000).toISOString())]);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });

    await handleRuntimeUsageReport({ workspace, days: 7, json: true });

    expect(output).toHaveLength(1);
    const parsed: unknown = JSON.parse(output[0] ?? '');
    expect(parsed).toMatchObject({ ok: true, command: 'runtime usage report', days: 7 });
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects an invalid --days before touching the filesystem', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });

    await handleRuntimeUsageReport({ workspace, days: 0, json: true });

    expect(process.exitCode).toBe(1);
    const parsed: unknown = JSON.parse(output[0] ?? '');
    expect(parsed).toMatchObject({ ok: false });
  });

  it('renders a human-readable report with the coverage section', () => {
    const text = formatRuntimeUsageReport(buildRuntimeUsageReport(workspace, 7, NOW));
    expect(text).toContain('PD CLI usage report');
    expect(text).toContain('Coverage');
    expect(text).toContain('Next action:');
  });
});

describe('registration', () => {
  it('registers `pd runtime usage report` in the real command tree (cli-7)', () => {
    const runtime = buildPdProgram().commands.find((command) => command.name() === 'runtime');
    const usage = runtime?.commands.find((command) => command.name() === 'usage');
    const report = usage?.commands.find((command) => command.name() === 'report');
    expect(report, 'pd runtime usage report must be registered').toBeDefined();
    const flags = report?.options.map((option) => option.long);
    expect(flags).toContain('--days');
    expect(flags).toContain('--json');
  });
});
