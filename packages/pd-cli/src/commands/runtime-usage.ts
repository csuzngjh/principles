/**
 * `pd runtime usage report` — "which pd commands actually run here?"
 *
 * Read-only aggregation over the CLI invocation lines written by the process
 * entry (`cli_invocation`, see services/cli-invocation-log.ts) into the
 * workspace's non-rotated telemetry sink.
 *
 * What it can and cannot answer (stated in the output, rc-9):
 *   - CAN: per-command count, per-source count, and the exit-code distribution
 *     of each, inside the requested window.
 *   - CANNOT: reconstruct an invocation that was never recorded. Lines written
 *     before the recorder existed simply are not there — an empty result means
 *     "no records", never "the command was never used".
 *
 * CLI gate compliance:
 *   - cli-1-strict-json: --json stdout is exactly one parseable JSON object.
 *   - cli-2-exit-stops: invalid arguments set process.exitCode = 1 then return.
 *   - cli-4-dry-run-confirm-mutex: N/A (read-only, no mutation flags).
 *   - cli-5-failure-no-mutation: read-only; no file is created by this command.
 *   - cli-6-output-next-action: empty/degraded results carry reason + nextAction.
 *
 * Runtime contract compliance:
 *   - rc-1-treat-as-unknown: every parsed line starts as unknown.
 *   - rc-2-no-as-bypass: runtime guards only (typeof/isRecord), no casts.
 *   - rc-3-fail-loud-missing: malformed lines are COUNTED, not skipped silently.
 *   - rc-4-validate-array-elements: aggregation input is validated per record.
 *   - rc-5-object-hasown-not-in: Object.hasOwn for untrusted key checks.
 *   - rc-8-safe-serialization: output is built from validated primitives only.
 *   - rc-9-no-silent-fallback: every degraded source carries reason/notes.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { emitError, emitResult } from '../services/cli-output.js';
import { CLI_INVOCATION_EVENT_TYPE, UNKNOWN, invocationLogPath } from '../services/cli-invocation-log.js';

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 365;

const DAY_MS = 24 * 3600 * 1000;

export interface RuntimeUsageReportOptions {
  workspace?: string;
  days?: number;
  json?: boolean;
}

export interface ExitCodeBucket {
  exitCode: string;
  count: number;
}

export interface UsageGroup {
  name: string;
  count: number;
  exitCodes: ExitCodeBucket[];
}

export interface RuntimeUsageReport {
  ok: true;
  status: 'ok' | 'empty' | 'degraded';
  command: 'runtime usage report';
  workspace: string;
  days: number;
  window: { from: string; to: string };
  sinkFile: string;
  coverage: {
    /** Lines in the sink that were NOT cli_invocation records (other event types). */
    otherEventLines: number;
    /** Lines that could not be parsed as JSON, or that carried no usable timestamp. */
    unreadableLines: number;
    /** Records inside the window that were missing a field (counted as UNKNOWN). */
    missingCommand: number;
    missingSource: number;
    missingExitCode: number;
  };
  totals: {
    invocations: number;
  };
  byCommand: UsageGroup[];
  bySource: UsageGroup[];
  notes: string[];
  reason?: string;
  nextAction?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read one untrusted string field, or UNKNOWN when absent/blank/wrong type. */
function readString(record: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(record, key)) return null;
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Group counts into a deterministic, count-descending list. */
function toGroups(counts: Map<string, number>, exitCodes: Map<string, Map<string, number>>): UsageGroup[] {
  return [...counts.entries()]
    .map(([name, count]) => {
      const buckets = [...(exitCodes.get(name) ?? new Map<string, number>()).entries()]
        .map(([exitCode, bucketCount]) => ({ exitCode, count: bucketCount }))
        .sort((a, b) => {
          if (a.exitCode === UNKNOWN) return 1;
          if (b.exitCode === UNKNOWN) return -1;
          return Number(a.exitCode) - Number(b.exitCode);
        });
      return { name, count, exitCodes: buckets };
    })
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)));
}

/**
 * Aggregate the sink for the window. Pure read; returns the report object.
 * Throws only when the workspace itself cannot be read — callers translate that
 * into the documented error shape.
 */
export function buildRuntimeUsageReport(
  workspaceDir: string,
  days: number,
  now: Date = new Date(),
): RuntimeUsageReport {
  const sinkFile = invocationLogPath(workspaceDir);
  const from = new Date(now.getTime() - days * DAY_MS);
  const base: RuntimeUsageReport = {
    ok: true,
    status: 'ok',
    command: 'runtime usage report',
    workspace: workspaceDir,
    days,
    window: { from: from.toISOString(), to: now.toISOString() },
    sinkFile,
    coverage: { otherEventLines: 0, unreadableLines: 0, missingCommand: 0, missingSource: 0, missingExitCode: 0 },
    totals: { invocations: 0 },
    byCommand: [],
    bySource: [],
    notes: [
      'Only recorded invocations are counted: a command that ran before this recorder existed leaves no line.',
      'Exit code UNKNOWN means the field was absent or unreadable in the record, not that the command succeeded.',
    ],
  };

  if (!fs.existsSync(sinkFile)) {
    return {
      ...base,
      status: 'empty',
      reason: 'no_invocation_records',
      nextAction: `Run any pd command in this workspace, then retry (records land in ${sinkFile}).`,
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sinkFile, 'utf8');
  } catch {
    // EP-08/ERR-198: a closed reason code only — a filesystem message can embed
    // absolute paths or config fragments and must not be copied into the report.
    return {
      ...base,
      status: 'degraded',
      reason: 'sink_unreadable',
      notes: [
        ...base.notes,
        'Reading the telemetry sink failed (permissions or corruption); no counts are derived from it.',
      ],
      nextAction: 'Check file permissions/ownership on the telemetry sink, then retry.',
    };
  }

  const commandCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const commandExitCodes = new Map<string, Map<string, number>>();
  const sourceExitCodes = new Map<string, Map<string, number>>();
  const coverage = { ...base.coverage };

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      coverage.unreadableLines += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      coverage.unreadableLines += 1;
      continue;
    }
    if (readString(parsed, 'eventType') !== CLI_INVOCATION_EVENT_TYPE) {
      coverage.otherEventLines += 1;
      continue;
    }

    const timestamp = readString(parsed, 'timestamp');
    const at = timestamp === null ? Number.NaN : Date.parse(timestamp);
    if (!Number.isFinite(at) || at < from.getTime() || at > now.getTime()) {
      coverage.unreadableLines += 1;
      continue;
    }

    const payload = isRecord(parsed.payload) ? parsed.payload : {};
    const command = readString(payload, 'command');
    const source = readString(payload, 'source');
    const exitCodeRaw = Object.hasOwn(payload, 'exitCode') ? payload.exitCode : undefined;
    const exitCode = typeof exitCodeRaw === 'number' && Number.isInteger(exitCodeRaw) ? String(exitCodeRaw) : UNKNOWN;

    if (command === null) coverage.missingCommand += 1;
    if (source === null) coverage.missingSource += 1;
    if (exitCode === UNKNOWN) coverage.missingExitCode += 1;

    const commandKey = command ?? UNKNOWN;
    const sourceKey = source ?? UNKNOWN;

    bump(commandCounts, commandKey);
    bump(sourceCounts, sourceKey);
    const commandBuckets = commandExitCodes.get(commandKey) ?? new Map<string, number>();
    commandExitCodes.set(commandKey, commandBuckets);
    bump(commandBuckets, exitCode);
    const sourceBuckets = sourceExitCodes.get(sourceKey) ?? new Map<string, number>();
    sourceExitCodes.set(sourceKey, sourceBuckets);
    bump(sourceBuckets, exitCode);
  }

  const report: RuntimeUsageReport = {
    ...base,
    coverage,
    totals: { invocations: [...commandCounts.values()].reduce((sum, n) => sum + n, 0) },
    byCommand: toGroups(commandCounts, commandExitCodes),
    bySource: toGroups(sourceCounts, sourceExitCodes),
  };

  if (report.totals.invocations === 0) {
    return {
      ...report,
      status: 'empty',
      reason: 'no_records_in_window',
      nextAction: `Widen the window (--days ${Math.min(days * 4, MAX_DAYS)}) or run a pd command to start recording.`,
    };
  }
  return report;
}

function formatExitCodes(buckets: ExitCodeBucket[]): string {
  return buckets.map((bucket) => `${bucket.exitCode}:${bucket.count}`).join(' ');
}

export function formatRuntimeUsageReport(report: RuntimeUsageReport): string {
  const lines: string[] = [];
  lines.push('PD CLI usage report (recorded invocations only)');
  lines.push(`  workspace: ${report.workspace}`);
  lines.push(`  window:    ${report.window.from} → ${report.window.to} (${report.days} day(s))`);
  lines.push(`  sink:      ${report.sinkFile}`);
  lines.push(`  status:    ${report.status}`);
  lines.push(`  totals:    ${report.totals.invocations} invocation(s)`);
  lines.push('');
  lines.push('By command (count, exit codes)');
  if (report.byCommand.length === 0) lines.push('  (none)');
  for (const group of report.byCommand) {
    lines.push(`  ${String(group.count).padStart(4)}  pd ${group.name}  [${formatExitCodes(group.exitCodes)}]`);
  }
  lines.push('');
  lines.push('By source (count, exit codes)');
  if (report.bySource.length === 0) lines.push('  (none)');
  for (const group of report.bySource) {
    lines.push(`  ${String(group.count).padStart(4)}  ${group.name}  [${formatExitCodes(group.exitCodes)}]`);
  }
  lines.push('');
  lines.push('Coverage');
  lines.push(`  other event lines in sink: ${report.coverage.otherEventLines}`);
  lines.push(`  unreadable/out-of-window:  ${report.coverage.unreadableLines}`);
  lines.push(`  records missing command:   ${report.coverage.missingCommand}`);
  lines.push(`  records missing source:    ${report.coverage.missingSource}`);
  lines.push(`  records missing exitCode:  ${report.coverage.missingExitCode}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  if (report.reason !== undefined) lines.push(`  reason: ${report.reason}`);
  if (report.nextAction !== undefined) {
    lines.push('');
    lines.push(`Next action: ${report.nextAction}`);
  }
  return lines.join('\n');
}

export async function handleRuntimeUsageReport(options: RuntimeUsageReportOptions): Promise<void> {
  const json = options.json === true;
  const days = options.days ?? DEFAULT_DAYS;

  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    process.exitCode = emitError(new Error(`--days must be an integer between 1 and ${MAX_DAYS}, got ${days}`), {
      json,
      nextAction: `Pass --days as an integer in [1, ${MAX_DAYS}] (e.g. --days 30). Omit for the default (${DEFAULT_DAYS}).`,
    });
    return; // cli-2-exit-stops
  }

  try {
    const workspaceDir = options.workspace ? path.resolve(options.workspace) : resolveWorkspaceDir();
    const report = buildRuntimeUsageReport(workspaceDir, days);
    emitResult(report, { json, formatText: formatRuntimeUsageReport });
  } catch (err: unknown) {
    process.exitCode = emitError(err, {
      json,
      nextAction: 'Check the workspace path (-w) and that .pd/telemetry is readable, then retry.',
    });
  }
}

/** `pd runtime usage report` registration (cli-7: real tree, tested). */
export function registerRuntimeUsageCommand(runtimeCmd: Command): void {
  const usageCmd = runtimeCmd
    .command('usage')
    .description('Inspect recorded pd CLI usage for this workspace (read-only)');

  usageCmd
    .command('report')
    .description('Count recorded pd invocations by command and source, with exit-code distribution')
    .option('--days <n>', `Window in days (1-${MAX_DAYS})`, String(DEFAULT_DAYS))
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Emit a single machine-readable JSON object')
    .action(async (opts: { days?: string; workspace?: string; json?: boolean }) => {
      const parsed = Number(opts.days);
      await handleRuntimeUsageReport({
        workspace: opts.workspace,
        days: Number.isFinite(parsed) ? parsed : Number.NaN,
        json: opts.json === true,
      });
    });
}
