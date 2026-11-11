/**
 * Trajectory retention — policy resolution, cutoff arithmetic and the batched
 * delete engine (SPEC-PD-TR-001).
 *
 * Ownership:
 * - owns: the `trajectoryRetention` config→policy mapping (including every
 *   fail-closed/degraded rule), the monotonic cutoff computation, the table
 *   plan set, and the batch loop that performs deletes.
 * - owns: `ensureTrajectoryRetentionIndexes` — the ONLY place that creates the
 *   retention indexes. It is never called from a hook/open path: the
 *   maintenance entry point calls it explicitly (SPEC §5.2).
 * - does NOT own: path resolution, file locks, the marker file, the export
 *   list, DB open/WAL assertions. Those are host I/O and live in
 *   `@principles/host-runtime` (`trajectory-retention.ts` there).
 * - does NOT own: blob-file deletion (`openclaw-plugin` trajectory store).
 *
 * Every function here is pure with respect to the filesystem: the only I/O is
 * the `Database` handle the caller passes in. That keeps core's I/O seam
 * registry unchanged.
 */
import type { Database } from 'better-sqlite3';

// ── Bounds (SPEC §3.1) ───────────────────────────────────────────────────────

export const TRAJECTORY_RETENTION_DEFAULTS = Object.freeze({
  enabled: true,
  retentionDays: 90,
  intervalHours: 6,
  batchSize: 2000,
  runBudgetMs: 3000,
});

/** `retentionDays = 0` disables retention; 1..6 is rejected (never "delete all"). */
export const RETENTION_MIN_ACCEPTED_DAYS = 7;
export const RETENTION_MAX_ACCEPTED_DAYS = 3650;
export const RETENTION_BATCH_SIZE_MIN = 100;
export const RETENTION_BATCH_SIZE_MAX = 10000;
export const RETENTION_RUN_BUDGET_MIN_MS = 500;
export const RETENTION_RUN_BUDGET_MAX_MS = 10000;
export const RETENTION_INTERVAL_HOURS_MIN = 1;
export const RETENTION_INTERVAL_HOURS_MAX = 168;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 单批墙钟上限；超过即提交后停止本次运行（SPEC §4.3）。 */
export const RETENTION_BATCH_BUDGET_MS = 250;
/** 截止线每次最多前进 7 天，防止一次时钟前跳清空历史（SPEC §3.3）。 */
export const RETENTION_MAX_CUTOFF_ADVANCE_MS = 7 * DAY_MS;
/** 系统时间后跳容差。 */
export const RETENTION_CLOCK_BACKWARDS_TOLERANCE_MS = HOUR_MS;
/** busy 让路后的指数退避序列，最后一档封顶（SPEC §4.4）。 */
export const RETENTION_BUSY_BACKOFF_MS: readonly number[] = Object.freeze([
  30 * 60 * 1000,
  HOUR_MS,
  2 * HOUR_MS,
  6 * HOUR_MS,
]);

// ── Policy ───────────────────────────────────────────────────────────────────

export interface TrajectoryRetentionPolicy {
  enabled: boolean;
  retentionDays: number;
  intervalHours: number;
  batchSize: number;
  runBudgetMs: number;
  /**
   * Present ⇒ the configured values are unusable. The runner MUST delete
   * nothing while this is set (SPEC §3.1 fail-closed, A10).
   */
  degradedReason?: string;
  /**
   * True when `retentionDays: 0` deliberately switched retention off. This is
   * NOT a degraded state: the Owner asked for no sweeping.
   */
  disabledByZeroDays?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwn(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readInteger(record: Record<string, unknown>, key: string): number | 'absent' | 'invalid' {
  const value = readOwn(record, key);
  if (value === undefined) return 'absent';
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'invalid';
  return value;
}

/**
 * Map the raw `trajectoryRetention` config section to an effective policy.
 *
 * Three distinct states, deliberately separated:
 * - absent  → defaults, sweeping enabled;
 * - valid   → the configured values;
 * - unusable → `degradedReason` set, sweeping must delete 0 rows.
 *
 * A missing section never degrades; a present-but-wrong section never falls
 * back to "delete with defaults" (that would turn a config typo into
 * irreversible deletion).
 */
export function resolveTrajectoryRetentionPolicy(raw: unknown): TrajectoryRetentionPolicy {
  const defaults = TRAJECTORY_RETENTION_DEFAULTS;
  if (raw === undefined || raw === null) {
    return { ...defaults };
  }
  if (!isRecord(raw)) {
    return { ...defaults, degradedReason: 'config_not_object' };
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(defaults, key)) {
      return { ...defaults, degradedReason: `unknown_key:${key}` };
    }
  }

  const enabledRaw = readOwn(raw, 'enabled');
  if (enabledRaw !== undefined && typeof enabledRaw !== 'boolean') {
    return { ...defaults, enabled: false, degradedReason: 'enabled_not_boolean' };
  }
  const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : defaults.enabled;

  const retentionDaysRaw = readInteger(raw, 'retentionDays');
  if (retentionDaysRaw === 'invalid') {
    return { ...defaults, enabled, degradedReason: 'retention_days_not_integer' };
  }
  if (retentionDaysRaw === 0) {
    // SPEC §3.1: zero means STOP, never "delete everything".
    return { ...defaults, enabled: false, disabledByZeroDays: true };
  }
  if (retentionDaysRaw !== 'absent' && retentionDaysRaw < RETENTION_MIN_ACCEPTED_DAYS) {
    return {
      ...defaults,
      enabled,
      degradedReason: `retention_days_out_of_range:${retentionDaysRaw}`,
    };
  }
  if (retentionDaysRaw !== 'absent' && retentionDaysRaw > RETENTION_MAX_ACCEPTED_DAYS) {
    return {
      ...defaults,
      enabled,
      retentionDays: RETENTION_MAX_ACCEPTED_DAYS,
      degradedReason: `retention_days_out_of_range:${retentionDaysRaw}`,
    };
  }
  const retentionDays = retentionDaysRaw === 'absent' ? defaults.retentionDays : retentionDaysRaw;

  const intervalHoursRaw = readInteger(raw, 'intervalHours');
  if (
    intervalHoursRaw === 'invalid'
    || (intervalHoursRaw !== 'absent'
      && (intervalHoursRaw < RETENTION_INTERVAL_HOURS_MIN
        || intervalHoursRaw > RETENTION_INTERVAL_HOURS_MAX))
  ) {
    return {
      ...defaults,
      enabled,
      retentionDays,
      degradedReason: `interval_hours_out_of_range:${String(intervalHoursRaw)}`,
    };
  }
  const intervalHours = intervalHoursRaw === 'absent' ? defaults.intervalHours : intervalHoursRaw;

  const batchSizeRaw = readInteger(raw, 'batchSize');
  if (
    batchSizeRaw === 'invalid'
    || (batchSizeRaw !== 'absent'
      && (batchSizeRaw < RETENTION_BATCH_SIZE_MIN || batchSizeRaw > RETENTION_BATCH_SIZE_MAX))
  ) {
    return {
      ...defaults,
      enabled,
      retentionDays,
      intervalHours,
      degradedReason: `batch_size_out_of_range:${String(batchSizeRaw)}`,
    };
  }
  const batchSize = batchSizeRaw === 'absent' ? defaults.batchSize : batchSizeRaw;

  const runBudgetRaw = readInteger(raw, 'runBudgetMs');
  if (
    runBudgetRaw === 'invalid'
    || (runBudgetRaw !== 'absent'
      && (runBudgetRaw < RETENTION_RUN_BUDGET_MIN_MS || runBudgetRaw > RETENTION_RUN_BUDGET_MAX_MS))
  ) {
    return {
      ...defaults,
      enabled,
      retentionDays,
      intervalHours,
      batchSize,
      degradedReason: `run_budget_out_of_range:${String(runBudgetRaw)}`,
    };
  }
  const runBudgetMs = runBudgetRaw === 'absent' ? defaults.runBudgetMs : runBudgetRaw;

  return { enabled, retentionDays, intervalHours, batchSize, runBudgetMs };
}

// ── Marker ───────────────────────────────────────────────────────────────────

/**
 * `<workspace>/.state/trajectory-retention.json` — durable retention control
 * state, not a cache.
 *
 * It is the ONLY record of how far the cutoff has advanced and when the clock
 * baseline was last observed. That is why losing it must be handled
 * conservatively (the host re-derives a baseline from the oldest stored row
 * instead of treating it as a first run) and why it is written atomically.
 *
 * It is also the ledger for the run named by `lastOutcome`: `deletedByTable`,
 * `durationMs` and `totalDurationMs` always describe THAT run, including a run
 * that failed midway (the host writes the committed counts before returning).
 */
export interface TrajectoryRetentionMarker {
  lastRunAt: string | null;
  lastCutoff: string | null;
  lastOutcome: string | null;
  /** Rows committed for the run named by `lastOutcome` (never cumulative). */
  deletedByTable: Record<string, number>;
  /** Batch-engine duration only (kept for backward-compatible readers). */
  durationMs: number | null;
  /** Wall clock of the whole maintenance run, including DB open/DDL/marker. */
  totalDurationMs: number | null;
  partial: boolean;
  backoffUntil: string | null;
  consecutiveBusy: number;
  reason: string | null;
}

export const EMPTY_RETENTION_MARKER: TrajectoryRetentionMarker = Object.freeze({
  lastRunAt: null,
  lastCutoff: null,
  lastOutcome: null,
  deletedByTable: {},
  durationMs: null,
  totalDurationMs: null,
  partial: false,
  backoffUntil: null,
  consecutiveBusy: 0,
  reason: null,
});

function normalizeTimestampField(value: unknown): { value: string | null; damaged: boolean } {
  if (value === null) return { value: null, damaged: false };
  if (typeof value !== 'string') return { value: null, damaged: true };
  // A timestamp we cannot parse is unusable as a clock baseline. Keeping the
  // bad string would make every later run hit `marker_timestamp_invalid` — a
  // permanent stall. Normalising it to null makes the next run recover.
  return Number.isFinite(Date.parse(value))
    ? { value, damaged: false }
    : { value: null, damaged: true };
}

/**
 * Coerce any parsed JSON into a usable marker.
 *
 * Returns `damaged: true` when a field was missing or malformed. Unparseable
 * timestamps are normalised to `null` instead of being preserved, so a single
 * bad value can never wedge retention forever (review finding P1-2).
 */
export function normalizeRetentionMarker(value: unknown): {
  marker: TrajectoryRetentionMarker;
  damaged: boolean;
} {
  if (!isRecord(value)) {
    return { marker: { ...EMPTY_RETENTION_MARKER, deletedByTable: {} }, damaged: true };
  }
  let damaged = false;

  const timestamp = (key: string): string | null => {
    const field = normalizeTimestampField(readOwn(value, key));
    if (field.damaged) damaged = true;
    return field.value;
  };
  const nullableString = (key: string): string | null => {
    const field = readOwn(value, key);
    if (field === null || field === undefined) {
      if (field === undefined) damaged = true;
      return null;
    }
    if (typeof field !== 'string') {
      damaged = true;
      return null;
    }
    return field;
  };
  const nullableNumber = (key: string): number | null => {
    const field = readOwn(value, key);
    if (field === null) return null;
    if (typeof field !== 'number' || !Number.isFinite(field)) {
      damaged = true;
      return null;
    }
    return field;
  };

  const deletedByTable: Record<string, number> = {};
  const rawCounts = readOwn(value, 'deletedByTable');
  if (isRecord(rawCounts)) {
    for (const [table, count] of Object.entries(rawCounts)) {
      if (typeof count === 'number' && Number.isFinite(count)) deletedByTable[table] = count;
      else damaged = true;
    }
  } else {
    damaged = true;
  }

  const partial = readOwn(value, 'partial');
  if (typeof partial !== 'boolean') damaged = true;
  const consecutiveBusy = readOwn(value, 'consecutiveBusy');
  if (typeof consecutiveBusy !== 'number' || !Number.isFinite(consecutiveBusy)) damaged = true;

  return {
    marker: {
      lastRunAt: timestamp('lastRunAt'),
      lastCutoff: timestamp('lastCutoff'),
      lastOutcome: nullableString('lastOutcome'),
      deletedByTable,
      durationMs: nullableNumber('durationMs'),
      totalDurationMs: nullableNumber('totalDurationMs'),
      partial: partial === true,
      backoffUntil: timestamp('backoffUntil'),
      consecutiveBusy: typeof consecutiveBusy === 'number' ? consecutiveBusy : 0,
      reason: nullableString('reason'),
    },
    damaged,
  };
}

export function isRetentionMarker(value: unknown): value is TrajectoryRetentionMarker {
  return !normalizeRetentionMarker(value).damaged;
}

// ── Cutoff ───────────────────────────────────────────────────────────────────

export type RetentionCutoffDecision =
  | {
    kind: 'run';
    cutoff: string;
    computedCutoff: string;
    advanceCapped: boolean;
    /** A stored lastCutoff was outside the window and was discarded (F1). */
    discardedMarkerCutoff: boolean;
  }
  | {
    kind: 'skip';
    reason: 'clock_backwards' | 'clock_forward_anomaly' | 'marker_timestamp_invalid';
  };

/**
 * Whether a stored `lastCutoff` may be used as a lower bound.
 *
 * A surviving cutoff is only meaningful while it lies inside the current
 * retention window. A future value can arrive from a clock that ran fast (the
 * cutoff advanced while the clock was wrong) or from a hand-edited marker.
 * Such a value must be DISCARDED, not clamped: clamping still leaves a cutoff
 * inside the window and deletes rows that should be kept (F1).
 */
export function isRetentionCutoffInWindow(args: {
  lastCutoff: string | null;
  nowMs: number;
  retentionDays: number;
}): boolean {
  const { lastCutoff, nowMs, retentionDays } = args;
  if (lastCutoff === null) return true;
  const parsed = Date.parse(lastCutoff);
  if (!Number.isFinite(parsed)) return false;
  const computedCutoffMs = nowMs - retentionDays * DAY_MS;
  return parsed <= computedCutoffMs && parsed <= nowMs;
}

function parseTimestamp(value: string | null): number | 'invalid' | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 'invalid';
}

/**
 * Compute this run's cutoff.
 *
 * Deletion is irreversible, so every ambiguity resolves to "delete less":
 * - the cutoff never moves backwards;
 * - it advances at most `RETENTION_MAX_CUTOFF_ADVANCE_MS` per run;
 * - a backwards clock tick (> 1 h) and an implausible forward jump skip the
 *   run entirely instead of deleting a range that may be wrong.
 */
export function computeRetentionCutoff(args: {
  nowMs: number;
  retentionDays: number;
  intervalHours: number;
  marker: TrajectoryRetentionMarker;
}): RetentionCutoffDecision {
  const { nowMs, retentionDays, intervalHours, marker } = args;
  const lastRunAtMs = parseTimestamp(marker.lastRunAt);
  const lastCutoffMs = parseTimestamp(marker.lastCutoff);
  if (lastRunAtMs === 'invalid' || lastCutoffMs === 'invalid') {
    return { kind: 'skip', reason: 'marker_timestamp_invalid' };
  }

  if (lastRunAtMs !== null) {
    if (nowMs < lastRunAtMs - RETENTION_CLOCK_BACKWARDS_TOLERANCE_MS) {
      return { kind: 'skip', reason: 'clock_backwards' };
    }
    const forwardLimit = lastRunAtMs
      + intervalHours * 2 * HOUR_MS
      + RETENTION_MAX_CUTOFF_ADVANCE_MS;
    if (nowMs > forwardLimit) {
      return { kind: 'skip', reason: 'clock_forward_anomaly' };
    }
  }

  const computedCutoffMs = nowMs - retentionDays * DAY_MS;
  // Never trust a cutoff that is not inside the current window (F1). An
  // in-window cutoff is by definition <= `computedCutoffMs`, so the cutoff is
  // inherently monotonic: it can never end up earlier than the stored value.
  const trustedLastCutoffMs = isRetentionCutoffInWindow({
    lastCutoff: marker.lastCutoff,
    nowMs,
    retentionDays,
  })
    ? lastCutoffMs
    : null;
  let effectiveCutoffMs = computedCutoffMs;
  let advanceCapped = false;
  if (trustedLastCutoffMs !== null) {
    const capped = trustedLastCutoffMs + RETENTION_MAX_CUTOFF_ADVANCE_MS;
    if (computedCutoffMs > capped) {
      effectiveCutoffMs = capped;
      advanceCapped = true;
    }
  }

  return {
    kind: 'run',
    cutoff: new Date(effectiveCutoffMs).toISOString(),
    computedCutoff: new Date(computedCutoffMs).toISOString(),
    advanceCapped,
    discardedMarkerCutoff: lastCutoffMs !== null && trustedLastCutoffMs === null,
  };
}

export function nextBackoffUntil(nowMs: number, consecutiveBusy: number): string {
  const index = Math.min(
    Math.max(consecutiveBusy - 1, 0),
    RETENTION_BUSY_BACKOFF_MS.length - 1,
  );
  const backoffMs = RETENTION_BUSY_BACKOFF_MS[index] ?? RETENTION_BUSY_BACKOFF_MS[0] ?? 30 * 60 * 1000;
  return new Date(nowMs + backoffMs).toISOString();
}

// ── Table plan ───────────────────────────────────────────────────────────────

export interface TrajectoryRetentionTablePlan {
  readonly table: string;
  readonly timeColumn: 'created_at' | 'expired_at';
  /**
   * Fixed predicate — never user input. `governance_observations` only ever
   * loses rows that are already de-identified AND terminal (SPEC §2.1).
   */
  readonly extraPredicate?: string;
}

export const TRAJECTORY_RETENTION_TABLES: readonly TrajectoryRetentionTablePlan[] = Object.freeze([
  { table: 'tool_calls', timeColumn: 'created_at' },
  { table: 'assistant_turns', timeColumn: 'created_at' },
  { table: 'user_turns', timeColumn: 'created_at' },
  {
    table: 'governance_observations',
    timeColumn: 'expired_at',
    extraPredicate: "retention_class IN ('expired','rolled_back')",
  },
]);

/**
 * Retention indexes.
 *
 * Kept out of `applyTrajectorySchemaBase` on purpose: creating an index on a
 * million-row table costs seconds, and that function runs every time a host
 * opens the database. Only the maintenance entry point calls this (SPEC §5.2).
 *
 * `idx_assistant_turns_session_id` / `idx_user_turns_session_id` /
 * `idx_tool_calls_created_at` / `idx_assistant_turns_created_at` already exist
 * in the canonical schema; only the genuinely missing ones are here.
 */
export const TRAJECTORY_RETENTION_INDEXES: readonly string[] = Object.freeze([
  'CREATE INDEX IF NOT EXISTS idx_user_turns_created_at ON user_turns(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_pain_events_created_at ON pain_events(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_assistant_turns_blob_ref ON assistant_turns(blob_ref) WHERE blob_ref IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_user_turns_blob_ref ON user_turns(blob_ref) WHERE blob_ref IS NOT NULL',
]);

export interface RetentionIndexReport {
  /**
   * Statements the maintenance entry actually executed. `IF NOT EXISTS` means
   * this is "applied", not "newly created" — an index that already existed is
   * still applied (review finding 9).
   */
  applied: string[];
  skipped: string[];
}

/**
 * Create the retention indexes if their tables exist. Idempotent.
 * `skipped` names indexes whose table is absent (Profile A databases do not
 * carry governance tables, for example) — never an error.
 */
export function ensureTrajectoryRetentionIndexes(db: Database): RetentionIndexReport {
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const statement of TRAJECTORY_RETENTION_INDEXES) {
    const table = / ON ([a-z_]+)\(/.exec(statement)?.[1];
    if (table !== undefined) {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (exists === undefined) {
        skipped.push(statement);
        continue;
      }
    }
    db.exec(statement);
    applied.push(statement);
  }
  return { applied, skipped };
}

function tableExists(db: Database, table: string): boolean {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined;
}

/**
 * Read-only existence check for the retention indexes. The regular sweep must
 * never create them: `CREATE INDEX` on a busy database can block for seconds,
 * which is exactly the host stall F2 forbids. Index creation is an explicit
 * maintenance action (`pd trajectory vacuum --yes`).
 */
export function missingTrajectoryRetentionIndexes(db: Database): string[] {
  const missing: string[] = [];
  for (const statement of TRAJECTORY_RETENTION_INDEXES) {
    const name = /CREATE INDEX IF NOT EXISTS ([a-z_]+)/.exec(statement)?.[1];
    const table = / ON ([a-z_]+)\(/.exec(statement)?.[1];
    if (name === undefined) continue;
    if (table !== undefined && !tableExists(db, table)) continue;
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name);
    if (row === undefined) missing.push(name);
  }
  return missing;
}

// ── Batch engine ─────────────────────────────────────────────────────────────

export interface RetentionBatchRow {
  id: number;
  at: string;
}

export interface TrajectoryRetentionHooks {
  /** Injectable clock: batch budgets and the run budget must be measurable. */
  now(): number;
  /**
   * Called AFTER the batch ids are selected and BEFORE the delete
   * transaction, i.e. with no write lock held. The export list is written from
   * here.
   *
   * Return a non-null reason to abort the run WITHOUT deleting this batch: the
   * audit trail must exist before irreversible deletion (SPEC §8.2). Returning
   * `null` means "audit committed, proceed".
   */
  onBatchPrepared?(batch: { table: string; rows: RetentionBatchRow[] }): string | null;
  /** Called after a batch commits, with the ids that were actually eligible. */
  onBatchCommitted?(batch: {
    table: string;
    rows: RetentionBatchRow[];
    changes: number;
  }): void;
}

export type TrajectoryRetentionOutcome =
  | 'completed'
  | 'partial'
  | 'deferred_busy'
  | 'invariant_violation'
  | 'deadline';

export interface TrajectoryRetentionRunResult {
  outcome: TrajectoryRetentionOutcome;
  cutoff: string;
  deletedByTable: Record<string, number>;
  batches: number;
  maxBatchDurationMs: number;
  /** Batch-engine wall clock only; the host also measures totalDurationMs. */
  durationMs: number;
  reason?: string;
}

function isBusyError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED') {
    return true;
  }
  const message = typeof error.message === 'string' ? error.message : '';
  return message.includes('SQLITE_BUSY') || message.includes('database is locked');
}

function isRetentionBatchRow(value: unknown): value is RetentionBatchRow {
  if (!isRecord(value)) return false;
  return typeof value.id === 'number' && typeof value.at === 'string';
}

function readCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  const count = value.c;
  return typeof count === 'number' ? count : 0;
}

function retainedPredicate(plan: TrajectoryRetentionTablePlan): string {
  const base = `${plan.timeColumn} IS NOT NULL AND ${plan.timeColumn} < ?`;
  return plan.extraPredicate === undefined ? base : `${base} AND ${plan.extraPredicate}`;
}

interface RetentionTableSql {
  readonly count: string;
  readonly select: string;
  readonly deletePrefix: string;
  readonly deleteSuffix: string;
}

/**
 * Statement text assembled from the frozen plan list above.
 *
 * Every *value* stays bound with `?`. The only things that reach the SQL text
 * are identifiers from `TRAJECTORY_RETENTION_TABLES` and its fixed predicate —
 * neither can come from user input. No statement is built from runtime data.
 *
 * Built here rather than inline in `db.prepare(\`...\`)` because SEC-BASE-4
 * scans template literals directly inside `prepare`/`exec`; keeping the
 * assembly in one helper makes the guard read a constant expression while the
 * SQL stays fully parameterized.
 */
function retentionTableSql(plan: TrajectoryRetentionTablePlan): RetentionTableSql {
  const predicate = retainedPredicate(plan);
  return {
    count: 'SELECT COUNT(*) AS c FROM ' + plan.table + ' WHERE ' + predicate,
    select: 'SELECT id, ' + plan.timeColumn + ' AS at FROM ' + plan.table
      + ' WHERE ' + predicate + ' ORDER BY id LIMIT ?',
    deletePrefix: 'DELETE FROM ' + plan.table + ' WHERE id IN (',
    deleteSuffix: ') AND ' + predicate,
  };
}

function countExpired(db: Database, plan: TrajectoryRetentionTablePlan, cutoff: string): number {
  const row = db.prepare(retentionTableSql(plan).count).get(cutoff);
  return readCount(row);
}

function retentionTableExists(db: Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

/** Selection runs outside any write transaction (WAL readers never block). */
function selectExpiredBatch(args: {
  db: Database;
  plan: TrajectoryRetentionTablePlan;
  cutoff: string;
  batchSize: number;
}): RetentionBatchRow[] {
  const { db, plan, cutoff, batchSize } = args;
  const rawRows = db
    .prepare(retentionTableSql(plan).select)
    .all(cutoff, batchSize);
  if (!Array.isArray(rawRows)) throw new Error('retention_batch_rows_not_array');
  const rows: RetentionBatchRow[] = [];
  for (const raw of rawRows) {
    if (!isRetentionBatchRow(raw)) throw new Error('retention_batch_row_invalid');
    rows.push(raw);
  }
  return rows;
}

type BatchOutcome =
  | { kind: 'ok'; selected: number; changes: number }
  | { kind: 'busy' }
  | { kind: 'invariant'; reason: string };

/**
 * Delete exactly the selected ids inside one write transaction.
 *
 * The row-count invariant is checked INSIDE that transaction, between a
 * pre-count and a post-count taken under the same write lock. That removes the
 * false-positive window a run-level pre/post pair has: a third-party writer
 * cannot interleave between the counts (review finding 8).
 *
 * The predicate is re-applied on the DELETE: a `governance_observations` row
 * whose class changed after selection must not be deleted.
 */
function deleteSelectedBatch(args: {
  db: Database;
  plan: TrajectoryRetentionTablePlan;
  cutoff: string;
  rows: RetentionBatchRow[];
}): BatchOutcome {
  const { db, plan, cutoff, rows } = args;
  try {
    // IMMEDIATE takes the write lock up front. DEFERRED would read first and
    // then fail to upgrade under concurrent writers — the exact SQLITE_BUSY
    // shape this design exists to avoid (SPEC §4.2).
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    if (isBusyError(error)) return { kind: 'busy' };
    throw error;
  }

  try {
    const pre = countExpired(db, plan, cutoff);
    const placeholders = rows.map(() => '?').join(',');
    const sql = retentionTableSql(plan);
    const deleteSql = sql.deletePrefix + placeholders + sql.deleteSuffix;
    const info = db.prepare(deleteSql).run(...rows.map((row) => row.id), cutoff);
    const post = countExpired(db, plan, cutoff);
    if (pre - post !== info.changes) {
      db.exec('ROLLBACK');
      return {
        kind: 'invariant',
        reason: `row_count_mismatch:${plan.table}:pre=${pre}:post=${post}:deleted=${info.changes}`,
      };
    }
    db.exec('COMMIT');
    return { kind: 'ok', selected: rows.length, changes: info.changes };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // no open transaction; the original error is what matters
    }
    if (isBusyError(error)) return { kind: 'busy' };
    throw error;
  }
}

/**
 * Delete expired rows in bounded batches.
 *
 * Contract:
 * - select (plain read) → audit (outside any lock) → one
 *   `BEGIN IMMEDIATE`/`COMMIT` per batch, so a kill loses at most one batch;
 * - an audit failure stops before the delete: no trace, no deletion;
 * - busy ⇒ yield immediately (never retry the same batch in this run);
 * - `runBudgetMs` is a hard budget: a batch starts only when at least
 *   `RETENTION_BATCH_BUDGET_MS` remains.
 */
export interface TrajectoryRetentionBatchRequest {
  policy: Pick<TrajectoryRetentionPolicy, 'batchSize' | 'runBudgetMs'>;
  cutoff: string;
  hooks: TrajectoryRetentionHooks;
}

export function runTrajectoryRetentionBatches(
  db: Database,
  request: TrajectoryRetentionBatchRequest,
): TrajectoryRetentionRunResult {
  const { policy, cutoff, hooks } = request;
  const startedAt = hooks.now();
  const deletedByTable: Record<string, number> = {};
  let batches = 0;
  let maxBatchDurationMs = 0;

  const base = (outcome: TrajectoryRetentionOutcome, reason?: string): TrajectoryRetentionRunResult => ({
    outcome,
    cutoff,
    deletedByTable,
    batches,
    maxBatchDurationMs,
    durationMs: hooks.now() - startedAt,
    ...(reason === undefined ? {} : { reason }),
  });

  // A Profile A workspace has no governance tables, and an older database may
  // be missing any of them. An absent table is "nothing to sweep", never a
  // failure: the runner must not require the caller to pre-create every table.
  const plans = TRAJECTORY_RETENTION_TABLES.filter((plan) => retentionTableExists(db, plan.table));

  for (const plan of plans) {
    deletedByTable[plan.table] = 0;
    for (;;) {
      const remaining = policy.runBudgetMs - (hooks.now() - startedAt);
      if (remaining < RETENTION_BATCH_BUDGET_MS) {
        return base('deadline', 'run_budget_exhausted');
      }

      const batchStartedAt = hooks.now();
      const rows = selectExpiredBatch({ db, plan, cutoff, batchSize: policy.batchSize });
      if (rows.length === 0) break;

      // Audit BEFORE the write transaction: a failed export must not delete.
      const auditError = hooks.onBatchPrepared?.({ table: plan.table, rows }) ?? null;
      if (auditError !== null) {
        return base('partial', `audit_failed:${auditError}`);
      }

      const batch = deleteSelectedBatch({ db, plan, cutoff, rows });
      const batchDuration = hooks.now() - batchStartedAt;
      maxBatchDurationMs = Math.max(maxBatchDurationMs, batchDuration);

      if (batch.kind === 'busy') {
        return base('deferred_busy', 'sqlite_busy');
      }
      if (batch.kind === 'invariant') {
        return base('invariant_violation', batch.reason);
      }

      batches += 1;
      deletedByTable[plan.table] = (deletedByTable[plan.table] ?? 0) + batch.changes;
      hooks.onBatchCommitted?.({ table: plan.table, rows, changes: batch.changes });

      if (batch.changes === 0) {
        // Every selected row became ineligible between select and delete.
        // Stop rather than loop on the same predicate forever.
        return base('partial', `no_progress:${plan.table}`);
      }
      if (batchDuration > RETENTION_BATCH_BUDGET_MS) {
        // Committed, but over budget: stop instead of gambling on the next one.
        return base('partial', 'batch_over_budget');
      }
      if (batch.selected < policy.batchSize) break;
    }
  }

  return base('completed');
}
