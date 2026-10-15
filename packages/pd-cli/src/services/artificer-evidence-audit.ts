/**
 * Artificer evidence-pack failure history audit (read-only).
 *
 * SPEC-PD-IAER-001 FR-09 / PRI-985: scan a workspace's runtime state DB for
 * tasks whose runs failed with the `behavior_example_pack_missing` signature
 * (both `pi-ai-l2` and `pi-ai` runtime kinds — the L1 path produced the same
 * failure class), aggregate them BY TASK (not by run), and surface four
 * anomaly markers:
 *
 * - repeatedRetryConsumption     — the same task consumed more than one failing run;
 * - succeededRunThenFailed       — the task also has a succeeded run but finally failed;
 * - hasGovernanceSideEffects     — an approval trace exists for one of the task's artifacts;
 * - packMissingFailure           — the task has >=1 pack-missing run (the scan signature).
 *
 * Split (P6): `aggregateArtificerEvidenceRuns` is a pure function over
 * validated row arrays (unit-testable); `loadArtificerEvidenceAuditInputs`
 * is a thin read-only DB layer that produces those arrays with fully bound
 * SQL parameters. The command handler owns no SQL and no aggregation logic.
 *
 * Trust boundary (rc-1..rc-4): SQLite rows are untrusted. Every field read
 * here is validated by an explicit guard; a row that fails validation fails
 * the audit loudly (rc-3) — silently skipping rows would distort an audit.
 *
 * Governance detection: `approvals.artifact_id` → `pi_artifacts.artifact_id`
 * → `pi_artifacts.source_task_id` is the verified authority — the approval
 * store enforces that FK at write time (sqlite-approval-store.ts enqueue).
 * If either table does not exist (older state.db), detection is reported as
 * `unavailable` and every task's flag is false — never guessed.
 */
import type { Database as SqliteDatabase } from 'better-sqlite3';

/** Runs whose reason matches the pack-missing failure signature (both runtime kinds). */
export interface ArtificerEvidenceRunRow {
  taskId: string;
  runtimeKind: string;
  executionStatus: string;
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
  errorCategory: string | null;
  attemptNumber: number;
}

/** Current task-row state for the audited task ids. */
export interface ArtificerEvidenceTaskRow {
  taskId: string;
  taskKind: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
}

export interface ArtificerEvidenceAnomalies {
  repeatedRetryConsumption: boolean;
  succeededRunThenFailed: boolean;
  hasGovernanceSideEffects: boolean;
  packMissingFailure: boolean;
}

export interface ArtificerEvidenceTaskAudit {
  taskId: string;
  taskKind: string | null;
  taskStatus: string | null;
  taskRowFound: boolean;
  attemptCount: number | null;
  maxAttempts: number | null;
  runCount: number;
  /** error_category → count; falls back to execution_status, then 'unknown'. */
  failureCategories: Record<string, number>;
  firstFailureAt: string | null;
  lastFailureAt: string | null;
  anomalies: ArtificerEvidenceAnomalies;
  nextAction: string;
}

export interface ArtificerEvidenceAuditReport {
  summary: {
    totalRuns: number;
    distinctTasks: number;
    byRuntimeKind: Record<string, number>;
    byFinalTaskStatus: Record<string, number>;
    anomalyCounts: {
      repeatedRetryConsumption: number;
      succeededRunThenFailed: number;
      hasGovernanceSideEffects: number;
      packMissingFailure: number;
    };
  };
  tasks: ArtificerEvidenceTaskAudit[];
  /** How governance traces were detected; `unavailable` when the source tables are absent. */
  governanceDetection: string;
}

export const GOVERNANCE_DETECTION_METHOD = 'approvals JOIN pi_artifacts ON source_task_id';
export const GOVERNANCE_DETECTION_UNAVAILABLE = 'unavailable';

/** runtime_kind values scanned for the pack-missing signature (production evidence: both occurred). */
export const AUDITED_RUNTIME_KINDS = ['pi-ai-l2', 'pi-ai'] as const;
export const PACK_MISSING_REASON_LIKE = '%behavior_example_pack_missing%';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateRunRow(raw: unknown, index: number): ArtificerEvidenceRunRow {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`run row #${index} is not an object`);
  }
  const row = raw as Record<string, unknown>;
  if (!isNonEmptyString(row.task_id)) throw new Error(`run row #${index}: task_id missing or not a non-empty string`);
  if (!isNonEmptyString(row.runtime_kind)) throw new Error(`run row #${index} (task ${row.task_id}): runtime_kind missing`);
  if (!isNonEmptyString(row.execution_status)) throw new Error(`run row #${index} (task ${row.task_id}): execution_status missing`);
  if (!isNonEmptyString(row.started_at)) throw new Error(`run row #${index} (task ${row.task_id}): started_at missing`);
  if (!isStringOrNull(row.ended_at)) throw new Error(`run row #${index} (task ${row.task_id}): ended_at not string|null`);
  if (!isStringOrNull(row.reason)) throw new Error(`run row #${index} (task ${row.task_id}): reason not string|null`);
  if (!isStringOrNull(row.error_category)) throw new Error(`run row #${index} (task ${row.task_id}): error_category not string|null`);
  if (!isFiniteNumber(row.attempt_number)) throw new Error(`run row #${index} (task ${row.task_id}): attempt_number not a number`);
  return {
    taskId: row.task_id,
    runtimeKind: row.runtime_kind,
    executionStatus: row.execution_status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    reason: row.reason,
    errorCategory: row.error_category,
    attemptNumber: row.attempt_number,
  };
}

function validateTaskRow(raw: unknown, index: number): ArtificerEvidenceTaskRow {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`task row #${index} is not an object`);
  }
  const row = raw as Record<string, unknown>;
  if (!isNonEmptyString(row.task_id)) throw new Error(`task row #${index}: task_id missing`);
  if (!isNonEmptyString(row.task_kind)) throw new Error(`task row #${index} (task ${row.task_id}): task_kind missing`);
  if (!isNonEmptyString(row.status)) throw new Error(`task row #${index} (task ${row.task_id}): status missing`);
  if (!isFiniteNumber(row.attempt_count)) throw new Error(`task row #${index} (task ${row.task_id}): attempt_count not a number`);
  if (!isFiniteNumber(row.max_attempts)) throw new Error(`task row #${index} (task ${row.task_id}): max_attempts not a number`);
  return {
    taskId: row.task_id,
    taskKind: row.task_kind,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
  };
}

function validateSingleStringColumn(row: unknown, column: string): string {
  if (row === null || typeof row !== 'object') {
    throw new Error(`${column} row is not an object`);
  }
  const value = (row as Record<string, unknown>)[column];
  if (!isNonEmptyString(value)) {
    throw new Error(`${column} value is missing or not a non-empty string`);
  }
  return value;
}

/**
 * Build a per-task nextAction that points at a real recovery entry point
 * (cli-6). Branch on the authoritative task status, never on id shape:
 * - needs_human_review → `pd runtime internalization retry --confirm` (owner attention out-edge);
 * - failed → `pd runtime recovery failed-tasks --confirm` (exhausted attempts need --force);
 * - anything else → owner evidence attachment first, then inspect.
 */
function buildTaskNextAction(
  taskId: string,
  taskStatus: string | null,
  attemptsExhausted: boolean,
): string {
  const evidenceStep = `owner: attach evidence via recovery entry (PRI-983)`;
  if (taskStatus === 'needs_human_review') {
    return `${evidenceStep}, then: pd runtime internalization retry --task ${taskId} --confirm`;
  }
  if (taskStatus === 'failed') {
    return attemptsExhausted
      ? `${evidenceStep}, then: pd runtime recovery failed-tasks --confirm --force (attempts exhausted)`
      : `${evidenceStep}, then: pd runtime recovery failed-tasks --confirm`;
  }
  if (taskStatus === null) {
    return `Task row missing from tasks table — ${evidenceStep}; inspect DB integrity first: pd runtime internalization integrity --json`;
  }
  return `${evidenceStep}, then inspect current state: pd runtime internalization queue --json`;
}

export interface AggregateArtificerEvidenceInput {
  runs: readonly ArtificerEvidenceRunRow[];
  tasks: readonly ArtificerEvidenceTaskRow[];
  /** Task ids that have at least one succeeded run (any runtime kind). */
  succeededTaskIds: ReadonlySet<string>;
  /** Task ids that have at least one approval trace (see GOVERNANCE_DETECTION_METHOD). */
  governanceTaskIds: ReadonlySet<string>;
  governanceDetection?: string;
}

export function aggregateArtificerEvidenceRuns(input: AggregateArtificerEvidenceInput): ArtificerEvidenceAuditReport {
  const tasksById = new Map(input.tasks.map((t) => [t.taskId, t]));

  interface MutableTaskAudit {
    taskId: string;
    runCount: number;
    failureCategories: Record<string, number>;
    firstFailureAt: string;
    lastFailureAt: string;
  }

  const perTask = new Map<string, MutableTaskAudit>();
  const byRuntimeKind: Record<string, number> = {};

  for (const run of input.runs) {
    byRuntimeKind[run.runtimeKind] = (byRuntimeKind[run.runtimeKind] ?? 0) + 1;

    let agg = perTask.get(run.taskId);
    if (!agg) {
      agg = {
        taskId: run.taskId,
        runCount: 0,
        failureCategories: {},
        firstFailureAt: run.startedAt,
        lastFailureAt: run.startedAt,
      };
      perTask.set(run.taskId, agg);
    }
    agg.runCount += 1;
    if (run.startedAt < agg.firstFailureAt) agg.firstFailureAt = run.startedAt;
    if (run.startedAt > agg.lastFailureAt) agg.lastFailureAt = run.startedAt;
    const category = run.errorCategory ?? run.executionStatus ?? 'unknown';
    agg.failureCategories[category] = (agg.failureCategories[category] ?? 0) + 1;
  }

  const taskAudits: ArtificerEvidenceTaskAudit[] = [...perTask.values()]
    .sort((a, b) => (a.firstFailureAt === b.firstFailureAt
      ? a.taskId.localeCompare(b.taskId)
      : a.firstFailureAt.localeCompare(b.firstFailureAt)))
    .map((agg) => {
      const task = tasksById.get(agg.taskId);
      const taskStatus = task?.status ?? null;
      const attemptsExhausted = task !== undefined && task.attemptCount >= task.maxAttempts;
      const anomalies: ArtificerEvidenceAnomalies = {
        repeatedRetryConsumption: agg.runCount > 1,
        succeededRunThenFailed: input.succeededTaskIds.has(agg.taskId) && taskStatus === 'failed',
        hasGovernanceSideEffects: input.governanceTaskIds.has(agg.taskId),
        packMissingFailure: true,
      };
      return {
        taskId: agg.taskId,
        taskKind: task?.taskKind ?? null,
        taskStatus,
        taskRowFound: task !== undefined,
        attemptCount: task?.attemptCount ?? null,
        maxAttempts: task?.maxAttempts ?? null,
        runCount: agg.runCount,
        failureCategories: agg.failureCategories,
        firstFailureAt: agg.firstFailureAt,
        lastFailureAt: agg.lastFailureAt,
        anomalies,
        nextAction: buildTaskNextAction(agg.taskId, taskStatus, attemptsExhausted),
      };
    });

  const byFinalTaskStatus: Record<string, number> = {};
  const anomalyCounts = {
    repeatedRetryConsumption: 0,
    succeededRunThenFailed: 0,
    hasGovernanceSideEffects: 0,
    packMissingFailure: 0,
  };
  for (const task of taskAudits) {
    const statusKey = task.taskStatus ?? 'unknown_missing_task_row';
    byFinalTaskStatus[statusKey] = (byFinalTaskStatus[statusKey] ?? 0) + 1;
    if (task.anomalies.repeatedRetryConsumption) anomalyCounts.repeatedRetryConsumption += 1;
    if (task.anomalies.succeededRunThenFailed) anomalyCounts.succeededRunThenFailed += 1;
    if (task.anomalies.hasGovernanceSideEffects) anomalyCounts.hasGovernanceSideEffects += 1;
    if (task.anomalies.packMissingFailure) anomalyCounts.packMissingFailure += 1;
  }

  return {
    summary: {
      totalRuns: input.runs.length,
      distinctTasks: taskAudits.length,
      byRuntimeKind,
      byFinalTaskStatus,
      anomalyCounts,
    },
    tasks: taskAudits,
    governanceDetection: input.governanceDetection ?? GOVERNANCE_DETECTION_METHOD,
  };
}

// ---------------------------------------------------------------------------
// Thin read-only DB layer (SQL fully parameter-bound; results rc-validated).
// ---------------------------------------------------------------------------

/** Read the pack-missing runs for both audited runtime kinds. */
export function loadPackMissingRuns(db: SqliteDatabase): ArtificerEvidenceRunRow[] {
  const rows = db
    .prepare(
      `SELECT task_id, runtime_kind, execution_status, started_at, ended_at, reason, error_category, attempt_number
       FROM runs
       WHERE runtime_kind IN (?, ?) AND reason LIKE ?
       ORDER BY task_id, started_at, run_id`,
    )
    .all(...AUDITED_RUNTIME_KINDS, PACK_MISSING_REASON_LIKE);
  return rows.map(validateRunRow);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Read the current tasks rows for the audited task ids (chunked IN clauses). */
export function loadTaskRows(db: SqliteDatabase, taskIds: readonly string[]): ArtificerEvidenceTaskRow[] {
  const out: ArtificerEvidenceTaskRow[] = [];
  for (const chunkIds of chunk(taskIds, 500)) {
    const placeholders = chunkIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT task_id, task_kind, status, attempt_count, max_attempts
         FROM tasks WHERE task_id IN (${placeholders})`,
      )
      .all(...chunkIds);
    out.push(...rows.map(validateTaskRow));
  }
  return out;
}

/** Task ids (of the audited set) that have at least one succeeded run of ANY runtime kind. */
export function loadSucceededTaskIds(db: SqliteDatabase, taskIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const chunkIds of chunk(taskIds, 500)) {
    const placeholders = chunkIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT DISTINCT task_id FROM runs
         WHERE execution_status = 'succeeded' AND task_id IN (${placeholders})`,
      )
      .all(...chunkIds);
    for (const row of rows) out.add(validateSingleStringColumn(row, 'task_id'));
  }
  return out;
}

/**
 * Task ids (of the audited set) with an approval trace, via the verified
 * approvals → pi_artifacts join. When either table is absent (older state.db)
 * returns null so the caller reports detection as unavailable (rc-9) — the
 * absence of the detection source must not silently read as "no side effects".
 */
export function loadGovernanceTaskIds(db: SqliteDatabase, taskIds: readonly string[]): Set<string> | null {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('approvals', 'pi_artifacts')`)
    .all();
  const present = new Set(tables.map((row) => validateSingleStringColumn(row, 'name')));
  if (!present.has('approvals') || !present.has('pi_artifacts')) {
    return null;
  }
  const out = new Set<string>();
  for (const chunkIds of chunk(taskIds, 500)) {
    const placeholders = chunkIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT DISTINCT pa.source_task_id AS task_id
         FROM approvals a
         JOIN pi_artifacts pa ON pa.artifact_id = a.artifact_id
         WHERE pa.source_task_id IN (${placeholders})`,
      )
      .all(...chunkIds);
    for (const row of rows) out.add(validateSingleStringColumn(row, 'task_id'));
  }
  return out;
}

export interface ArtificerEvidenceAuditInputs {
  runs: ArtificerEvidenceRunRow[];
  tasks: ArtificerEvidenceTaskRow[];
  succeededTaskIds: Set<string>;
  governanceTaskIds: Set<string>;
  governanceDetection: string;
}

/** Load every input of the audit report from an open read-only DB handle. */
export function loadArtificerEvidenceAuditInputs(db: SqliteDatabase): ArtificerEvidenceAuditInputs {
  const runs = loadPackMissingRuns(db);
  const taskIds = [...new Set(runs.map((r) => r.taskId))];
  const tasks = loadTaskRows(db, taskIds);
  const succeededTaskIds = loadSucceededTaskIds(db, taskIds);
  const governance = loadGovernanceTaskIds(db, taskIds);
  return {
    runs,
    tasks,
    succeededTaskIds,
    governanceTaskIds: governance ?? new Set<string>(),
    governanceDetection: governance === null ? GOVERNANCE_DETECTION_UNAVAILABLE : GOVERNANCE_DETECTION_METHOD,
  };
}
