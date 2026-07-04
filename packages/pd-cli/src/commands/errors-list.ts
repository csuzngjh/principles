/**
 * pd errors list — List PD pipeline errors (failed tasks + worker errors).
 *
 * Usage:
 *   pd errors list [--json] [--kind <runnerKind>] [--since <hours>] [--limit <n>] [--workspace <path>]
 *
 * Aggregates two error sources into a single operator-facing read-only view:
 *   1. SQLite state.db tasks where status IN ('failed', 'needs_human_review')
 *      (via SqliteTaskStore.listFailedTasks — Task 8).
 *   2. worker-status.json `errors` array written by EvolutionWorker
 *      (Task 2 extended the entry shape to { at, kind, principleId, error } | string).
 *
 * CLI gate compliance:
 *   - cli-1-strict-json: --json stdout is exactly one parseable JSON object.
 *   - cli-2-exit-stops: every process.exit(...) is immediately followed by return.
 *   - cli-6-output-next-action: empty result includes a `nextAction` field.
 *   - cli-4-dry-run-confirm-mutex: N/A (read-only command).
 *
 * Runtime contract compliance:
 *   - rc-1-treat-as-unknown: worker-status.json parsed content is treated as unknown.
 *   - rc-2-no-as-bypass: no `as` casts; runtime validation via typeof / Array.isArray.
 *   - rc-4-validate-array-elements: errors array elements are validated element-wise.
 *   - rc-5-object-hasown-not-in: Object.hasOwn used for untrusted object key checks.
 *   - rc-9-no-silent-fallback: missing worker-status.json → workerErrors=[] with
 *     a `workerStatusMissing` note; parse failures surface a `workerStatusWarning`.
 */
import * as path from 'path';
import * as fs from 'fs';
import type { Command } from 'commander';
import { SqliteConnection, SqliteTaskStore } from '@principles/core';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

/**
 * Options accepted by the `pd errors list` command.
 *
 * `since` is in hours (CLI surface); converted to a Unix-ms timestamp when
 * passed to SqliteTaskStore.listFailedTasks.
 */
export interface ErrorsListOptions {
  workspace?: string;
  json?: boolean;
  kind?: string;
  since?: number; // hours
  limit?: number;
}

/** Default and maximum values for --limit. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Type guard: narrow `unknown` to a plain record (rc-2: no `as` bypass).
 * Returns true only for non-null, non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalized worker-status.json error entry. WorkerStatusErrorEntry in
 * evolution-worker.ts is `{ at, kind, principleId, error }`; legacy entries
 * are bare strings. We normalize both shapes to a structured form for output.
 */
interface WorkerErrorEntry {
  at: string | null;
  kind: string | null;
  principleId: string | null;
  error: string;
  rawForm: 'object' | 'string';
}

/** Aggregated result returned by the command (JSON or text-rendered). */
interface ErrorsListResult {
  tasks: unknown[];
  workerErrors: WorkerErrorEntry[];
  total: number;
  workerStatusPath: string;
  workerStatusMissing?: boolean;
  workerStatusWarning?: string;
  nextAction?: string;
}

/**
 * Validate and normalize a single worker-status.json errors entry.
 *
 * rc-1: input is `unknown` (parsed from JSON).
 * rc-2: no `as` — uses typeof / Object.hasOwn guards.
 * rc-5: Object.hasOwn for key checks (not `in`).
 *
 * Accepts:
 *   - string → { error: <string>, rawForm: 'string', others null }
 *   - { at, kind, principleId, error } → normalized object
 * Anything else → null (skipped; caller records a warning).
 */
function normalizeWorkerErrorEntry(entry: unknown): WorkerErrorEntry | null {
  if (typeof entry === 'string') {
    return {
      at: null,
      kind: null,
      principleId: null,
      error: entry,
      rawForm: 'string',
    };
  }
  // rc-2: type guard instead of `as` cast (isRecord narrows unknown → record).
  if (!isRecord(entry)) {
    return null;
  }
  // rc-5: use Object.hasOwn, not `in`, for untrusted object key checks.
  const at = Object.hasOwn(entry, 'at') && typeof entry.at === 'string' ? entry.at : null;
  const kind = Object.hasOwn(entry, 'kind') && typeof entry.kind === 'string' ? entry.kind : null;
  const principleId =
    Object.hasOwn(entry, 'principleId') && typeof entry.principleId === 'string' ? entry.principleId : null;
  // `error` is the only required field for the object form; if missing or
  // non-string, fall back to JSON.stringify so we don't lose the entry.
  let errorStr: string;
  if (Object.hasOwn(entry, 'error') && typeof entry.error === 'string') {
    errorStr = entry.error;
  } else {
    try {
      errorStr = JSON.stringify(entry);
    } catch {
      errorStr = '[unserializable worker-status error entry]';
    }
  }
  return {
    at,
    kind,
    principleId,
    error: errorStr,
    rawForm: 'object',
  };
}

/**
 * Read and validate the worker-status.json `errors` array.
 *
 * Returns `{ entries, missing, warning }`:
 *   - `missing: true` if the file does not exist (not an error — worker hasn't run).
 *   - `warning: string` if the file exists but is unparseable / wrong shape
 *     (rc-9: surface the reason, do not silently swallow).
 *   - `entries: WorkerErrorEntry[]` validated element-wise (rc-4).
 */
function readWorkerStatusErrors(stateDir: string): {
  entries: WorkerErrorEntry[];
  missing: boolean;
  warning: string | null;
} {
  const statusPath = path.join(stateDir, 'worker-status.json');
  if (!fs.existsSync(statusPath)) {
    return { entries: [], missing: true, warning: null };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(statusPath, 'utf8');
  } catch (err) {
    return {
      entries: [],
      missing: false,
      warning: `Failed to read worker-status.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // rc-1: parsed JSON is unknown.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      entries: [],
      missing: false,
      warning: `Failed to parse worker-status.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      entries: [],
      missing: false,
      warning: 'worker-status.json root is not a JSON object',
    };
  }
  // rc-5: Object.hasOwn for untrusted key check.
  if (!Object.hasOwn(parsed, 'errors')) {
    // No `errors` field — treat as empty (older worker-status.json may lack it).
    return { entries: [], missing: false, warning: null };
  }
  const errorsField = parsed.errors;
  if (!Array.isArray(errorsField)) {
    return {
      entries: [],
      missing: false,
      warning: 'worker-status.json `errors` field is not an array',
    };
  }
  // rc-4: validate array element types; skip malformed entries.
  const entries: WorkerErrorEntry[] = [];
  let skipped = 0;
  for (const item of errorsField) {
    const normalized = normalizeWorkerErrorEntry(item);
    if (normalized === null) {
      skipped++;
      continue;
    }
    entries.push(normalized);
  }
  const warning =
    skipped > 0
      ? `Skipped ${skipped} malformed worker-status.json error entr${skipped === 1 ? 'y' : 'ies'}`
      : null;
  return { entries, missing: false, warning };
}

function formatTextOutput(result: ErrorsListResult, workspaceDir: string): string {
  const lines: string[] = [];
  lines.push('PD Errors List');
  lines.push(`  workspace:   ${workspaceDir}`);
  lines.push(`  total:       ${result.total}  (tasks: ${result.tasks.length}, workerErrors: ${result.workerErrors.length})`);
  lines.push('');
  if (result.workerStatusMissing) {
    lines.push(`  workerStatus: (missing — ${result.workerStatusPath} not found)`);
  } else if (result.workerStatusWarning) {
    lines.push(`  workerStatus: WARNING — ${result.workerStatusWarning}`);
  }
  if (result.tasks.length > 0) {
    lines.push('');
    lines.push('Failed tasks:');
    for (const t of result.tasks) {
      // rc-2: type guard instead of `as` cast — tasks come from SqliteTaskStore
      // which returns FailedTaskSummary[], but we typed tasks as unknown[] to
      // keep the result interface decoupled from core's type exports.
      const task = isRecord(t) ? t : null;
      const taskId = task && typeof task.taskId === 'string' ? task.taskId : '?';
      const taskKind = task && typeof task.taskKind === 'string' ? task.taskKind : '?';
      const status = task && typeof task.status === 'string' ? task.status : '?';
      const lastError = task && typeof task.lastError === 'string' ? task.lastError : '-';
      const attemptCount = task && typeof task.attemptCount === 'number' ? task.attemptCount : 0;
      const painId = task && typeof task.painId === 'string' ? task.painId : '-';
      const lastAttemptAt = task && typeof task.lastAttemptAt === 'string' ? task.lastAttemptAt : '-';
      lines.push(`  - ${taskId} (${taskKind}) [${status}]`);
      lines.push(`    painId:        ${painId}`);
      lines.push(`    lastError:     ${lastError}`);
      lines.push(`    attemptCount:  ${attemptCount}`);
      lines.push(`    lastAttemptAt: ${lastAttemptAt}`);
    }
  }
  if (result.workerErrors.length > 0) {
    lines.push('');
    lines.push('Worker errors:');
    for (const e of result.workerErrors) {
      const at = e.at ?? '-';
      const kind = e.kind ?? '-';
      const pid = e.principleId ?? '-';
      lines.push(`  - [${at}] kind=${kind} principleId=${pid}`);
      lines.push(`    error: ${e.error}`);
    }
  }
  if (result.total === 0) {
    lines.push('');
    lines.push('No errors found. PD pipeline is healthy.');
  }
  return lines.join('\n');
}

export async function handleErrorsList(opts: ErrorsListOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const stateDir = path.join(workspaceDir, '.pd');
  const stateDbPath = path.join(stateDir, 'state.db');

  // Pre-check: if state.db does not exist, fail loud (cli-2-exit-stops + rc-9).
  if (!fs.existsSync(stateDbPath)) {
    const msg = `Error: state.db not found at ${stateDbPath}. Workspace may not be initialized.`;
    if (opts.json) {
      // cli-1: even error JSON is a single object on stdout? No — cli-2 says
      // failure paths write to stderr. JSON error envelope goes to stderr too
      // so stdout stays clean (cli-1-strict-json guarantees stdout is parseable).
      process.stderr.write(
        JSON.stringify(
          {
            ok: false,
            reason: msg,
            nextAction: 'Run "pd runtime init --confirm --workspace <dir>" to initialize databases, then retry.',
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(msg + '\n');
    }
    process.exitCode = 1;
    return; // cli-2-exit-stops
  }

  // Resolve and validate --limit.
  let limit = DEFAULT_LIMIT;
  if (opts.limit !== undefined) {
    if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
      const msg = `Error: --limit must be a positive integer, got ${opts.limit}`;
      process.stderr.write(msg + '\n');
      process.exitCode = 1;
      return; // cli-2-exit-stops
    }
    limit = Math.min(opts.limit, MAX_LIMIT);
  }

  // Resolve --since (hours → Unix-ms timestamp).
  let sinceMs: number | undefined;
  if (opts.since !== undefined) {
    if (!Number.isFinite(opts.since) || opts.since < 0) {
      const msg = `Error: --since must be a non-negative number of hours, got ${opts.since}`;
      process.stderr.write(msg + '\n');
      process.exitCode = 1;
      return; // cli-2-exit-stops
    }
    sinceMs = Date.now() - opts.since * 3600 * 1000;
  }

  const connection = new SqliteConnection({ workspaceDir, readonly: true });
  try {
    const taskStore = new SqliteTaskStore(connection);
    const tasks = await taskStore.listFailedTasks({
      kind: opts.kind,
      since: sinceMs,
      limit,
    });

    const { entries: workerErrors, missing, warning } = readWorkerStatusErrors(stateDir);

    const total = tasks.length + workerErrors.length;
    const result: ErrorsListResult = {
      tasks,
      workerErrors,
      total,
      workerStatusPath: path.join(stateDir, 'worker-status.json'),
    };
    if (missing) {
      result.workerStatusMissing = true;
    }
    if (warning) {
      result.workerStatusWarning = warning;
    }
    // cli-6-output-next-action: include nextAction only when there are no errors.
    if (total === 0) {
      result.nextAction = 'No errors found. PD pipeline is healthy.';
    }

    if (opts.json) {
      // cli-1-strict-json: stdout is exactly one parseable JSON object.
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTextOutput(result, workspaceDir));
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stderr.write(
        JSON.stringify(
          {
            ok: false,
            reason: `Failed to list errors: ${message}`,
            nextAction: 'Check workspace path and state.db readability, then retry.',
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }
    process.exitCode = 1;
    return; // cli-2-exit-stops
  } finally {
    connection.close();
  }
}

/**
 * Register the `errors` command group with `list` subcommand on a Commander
 * program. Used by both production CLI (src/index.ts) and parser-level tests
 * (cli-7-test-wiring).
 *
 * The `errors` command group is hidden from `pd --help` (operator diagnostic,
 * same convention as `legacy` / `artifact` / `runtime recovery`).
 */
export function registerErrorsListCommand(program: Command): Command {
  const errorsCmd = program
    .command('errors', { hidden: true })
    .description('PD pipeline error inspection (failed tasks + worker errors)');

  errorsCmd
    .command('list')
    .description('List PD pipeline errors — failed tasks + worker-status.json errors')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON (cli-1-strict-json: stdout is exactly one JSON object)')
    .option('--kind <runnerKind>', 'Filter failed tasks by task_kind (e.g. diagnostician, dreamer)')
    .option('--since <hours>', 'Only show errors from the last N hours (non-negative number)', parseInt)
    .option('--limit <n>', 'Max failed tasks to return (default: 50, max: 200)', parseInt)
    .action(async (opts) => {
      await handleErrorsList({
        workspace: opts.workspace,
        json: opts.json === true,
        kind: opts.kind,
        since: opts.since,
        limit: opts.limit,
      });
    });

  return errorsCmd;
}
