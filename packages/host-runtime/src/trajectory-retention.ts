/**
 * Trajectory retention runner — the I/O boundary of SPEC-PD-TR-001.
 *
 * Ownership:
 * - owns: the workspace paths, the single-instance lock, the marker file, the
 *   deleted-row export list, opening `trajectory.db`, the WAL assertion, and
 *   the explicit `vacuum` entry point.
 * - does NOT own: the retention policy, cutoff arithmetic, table plan or the
 *   batch loop — those are pure and live in
 *   `@principles/core/runtime/trajectory-retention`.
 * - does NOT own: blob-file pruning (`openclaw-plugin` trajectory store).
 *
 * Hard constraints inherited from the SPEC:
 * - never called from a hook; callers are the host workers and the explicit
 *   `pd trajectory` commands;
 * - never switches `journal_mode` (a mode switch needs an exclusive lock and
 *   is exactly the SQLITE_BUSY shape this design avoids);
 * - never runs VACUUM automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import {
  EMPTY_RETENTION_MARKER,
  computeRetentionCutoff,
  ensureTrajectoryRetentionIndexes,
  normalizeRetentionMarker,
  nextBackoffUntil,
  resolveTrajectoryRetentionPolicy,
  runTrajectoryRetentionBatches,
  TRAJECTORY_RETENTION_TABLES,
  type RetentionIndexReport,
  type TrajectoryRetentionMarker,
  type TrajectoryRetentionOutcome,
  type TrajectoryRetentionPolicy,
  type TrajectoryRetentionRunResult,
} from '@principles/core/runtime';
import { loadPdConfigForPlugin } from './pd-config.js';
import {
  releaseExclusiveLock,
  tryAcquireExclusiveLockSync,
  type ExclusiveLockHandle,
} from './product-telemetry/control-state-lock.js';

export const TRAJECTORY_RETENTION_MARKER_FILENAME = 'trajectory-retention.json';
export const TRAJECTORY_RETENTION_LOCK_FILENAME = 'trajectory-retention.lock';
/** 10 minutes: far above the 3 s run budget, so a live run is never taken over. */
export const TRAJECTORY_RETENTION_LOCK_STALE_MS = 10 * 60 * 1000;
/**
 * The maintenance connection waits at most this long for the write lock.
 *
 * SPEC §4.2 says `busy_timeout = 5000`; acceptance criterion A8 requires the
 * maintenance run to yield within 300 ms when another writer holds the lock.
 * Those two cannot both hold, and A8 is the measurable one, so the write lock
 * wait wins: a sweeper that queues behind the user's writer turns a background
 * chore into user-visible latency. Reads in WAL mode do not need this wait.
 *
 * 100 ms (not 250) because SQLite's busy handler overshoots its timeout by up
 * to one sleep step (~100 ms): a 250 ms timeout was measured at ~355 ms
 * wall-clock, which breaks A8. Ordinary host writes hold the lock for
 * milliseconds, so 100 ms is still enough to ride out normal contention.
 */
export const TRAJECTORY_RETENTION_WRITE_LOCK_WAIT_MS = 100;
/**
 * Index DDL is NOT the hot path: it runs once per table and must be allowed to
 * win the write lock against a continuously writing host. It therefore uses
 * its own, longer wait instead of the 100 ms delete budget (review finding 7).
 */
export const TRAJECTORY_RETENTION_DDL_BUSY_TIMEOUT_MS = 5000;
/** VACUUM is a foreground, explicit action; it may wait properly. */
export const TRAJECTORY_RETENTION_VACUUM_BUSY_TIMEOUT_MS = 5000;

const GOVERNANCE_EXPIRED_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_governance_observations_expired_at "
  + "ON governance_observations(expired_at) "
  + "WHERE retention_class IN ('expired','rolled_back')";

export type TrajectoryRetentionTrigger = 'worker' | 'manual';

export type TrajectoryRetentionReportOutcome =
  | 'completed'
  | 'partial'
  | 'deadline'
  | 'invariant_violation'
  | 'deferred:busy'
  | 'skipped';

export interface TrajectoryRetentionReport {
  outcome: TrajectoryRetentionReportOutcome;
  reason: string | null;
  workspaceDir: string;
  cutoff: string | null;
  deletedByTable: Record<string, number>;
  batches: number;
  /** Batch-engine wall clock only. */
  durationMs: number;
  /** Whole run, including DB open, WAL check, index DDL and marker write (A1). */
  totalDurationMs: number;
  maxBatchDurationMs: number;
  partial: boolean;
  backoffUntil: string | null;
  policy: TrajectoryRetentionPolicy;
  indexes: RetentionIndexReport | null;
  /** Non-null when index creation failed but the sweep continued anyway. */
  indexesError: string | null;
  /** Present on refused/failed outcomes (cli-6). */
  nextAction?: string;
}

export interface RunTrajectoryRetentionOptions {
  workspaceDir: string;
  trigger?: TrajectoryRetentionTrigger;
  /** Injectable clock (tests, deterministic marker/cutoff assertions). */
  now?: () => number;
}

export function trajectoryRetentionPaths(workspaceDir: string): {
  stateDir: string;
  dbPath: string;
  markerPath: string;
  lockPath: string;
  exportsDir: string;
} {
  const stateDir = path.join(workspaceDir, '.state');
  return {
    stateDir,
    dbPath: path.join(stateDir, 'trajectory.db'),
    markerPath: path.join(stateDir, TRAJECTORY_RETENTION_MARKER_FILENAME),
    lockPath: path.join(stateDir, TRAJECTORY_RETENTION_LOCK_FILENAME),
    exportsDir: path.join(stateDir, 'exports'),
  };
}

function readMarkerFile(markerPath: string): { marker: TrajectoryRetentionMarker; reason?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
      ? String((error as Record<string, unknown>).code)
      : '';
    // A missing marker is the normal first-run state, not a degradation.
    return { marker: EMPTY_RETENTION_MARKER, ...(code === 'ENOENT' ? {} : { reason: 'marker_unreadable' }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { marker: EMPTY_RETENTION_MARKER, reason: 'marker_unparseable' };
  }
  // Unparseable timestamps are normalised to null by the marker normaliser, so
  // one corrupt field can never wedge retention (review finding 2).
  const normalized = normalizeRetentionMarker(parsed);
  return {
    marker: normalized.marker,
    ...(normalized.damaged ? { reason: 'marker_shape_invalid' } : {}),
  };
}

function writeMarkerAtomic(markerPath: string, marker: TrajectoryRetentionMarker): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmpPath = `${markerPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, markerPath);
}

function markerEquals(a: TrajectoryRetentionMarker, b: TrajectoryRetentionMarker): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A skip is still observable, but it must not rewrite the marker on every
 * 120 s worker cycle. Only a CHANGED skip is persisted.
 */
function recordSkip(args: {
  markerPath: string;
  marker: TrajectoryRetentionMarker;
  outcome: string;
  reason: string;
}): TrajectoryRetentionMarker {
  const { markerPath, marker, outcome, reason } = args;
  const next: TrajectoryRetentionMarker = {
    ...marker,
    lastOutcome: outcome,
    reason,
  };
  if (!markerEquals(marker, next)) {
    try {
      writeMarkerAtomic(markerPath, next);
    } catch {
      // Observability must never turn a skip into a failure.
    }
  }
  return next;
}

function readJournalMode(db: DatabaseHandle): string {
  const value = db.pragma('journal_mode', { simple: true });
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * Batch export writer: ONE synchronous append per committed batch.
 *
 * The caller writes outside any write transaction (review finding 3), so this
 * never holds SQLite's write lock during file I/O. It deliberately throws on
 * failure: the caller must fail closed and NOT delete a batch it could not
 * audit (SPEC §8.2, review finding 5).
 */
function createExportWriter(exportsDir: string, runDate: string): (entries: {
  table: string;
  id: number;
  column: string;
  at: string;
}[]) => void {
  let initialized = false;
  return (entries) => {
    if (entries.length === 0) return;
    if (!initialized) {
      fs.mkdirSync(exportsDir, { recursive: true });
      initialized = true;
    }
    const filePath = path.join(exportsDir, `trajectory-retention-${runDate}.jsonl`);
    const payload = entries
      .map((entry) => `${JSON.stringify({
        table: entry.table,
        id: entry.id,
        [entry.column]: entry.at,
      })}\n`)
      .join('');
    fs.appendFileSync(filePath, payload, 'utf8');
  };
}

function tableExists(db: DatabaseHandle, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Oldest stored timestamp across every swept table.
 *
 * Used as the conservative cutoff baseline when the marker carries no
 * `lastCutoff` (first run OR lost marker). It is a durable observation point
 * already present in the database, so it needs no second source of truth, and
 * it caps the first sweep at 7 days just like every later sweep.
 */
function oldestStoredTimestamp(db: DatabaseHandle): string | null {
  let oldest: string | null = null;
  for (const plan of TRAJECTORY_RETENTION_TABLES) {
    if (!tableExists(db, plan.table)) continue;
    const row = db
      .prepare(`SELECT MIN(${plan.timeColumn}) AS at FROM ${plan.table}`)
      .get();
    if (!isRecordValue(row)) continue;
    const { at } = row;
    if (typeof at !== 'string' || at.length === 0) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest;
}

/**
 * Maintenance-only DDL. Runs here — never in a schema/open path — because
 * creating an index on a large table costs seconds (SPEC §5.2).
 *
 * Throws on failure; the caller treats that as a degraded run and keeps
 * sweeping (indexes are a performance concern, not a correctness precondition).
 */
function ensureRetentionIndexes(db: DatabaseHandle): RetentionIndexReport {
  const report = ensureTrajectoryRetentionIndexes(db);
  if (tableExists(db, 'governance_observations')) {
    db.exec(GOVERNANCE_EXPIRED_INDEX_SQL);
    report.applied.push(GOVERNANCE_EXPIRED_INDEX_SQL);
  } else {
    report.skipped.push(GOVERNANCE_EXPIRED_INDEX_SQL);
  }
  return report;
}

function emptyCounts(): Record<string, number> {
  return { tool_calls: 0, assistant_turns: 0, user_turns: 0, governance_observations: 0 };
}

function publicOutcome(outcome: TrajectoryRetentionOutcome): TrajectoryRetentionReportOutcome {
  return outcome === 'deferred_busy' ? 'deferred:busy' : outcome;
}

function readCountField(value: unknown): number {
  if (!isRecordValue(value)) return 0;
  const count = value.c;
  return typeof count === 'number' ? count : 0;
}

function skipReport(args: {
  workspaceDir: string;
  policy: TrajectoryRetentionPolicy;
  outcome: TrajectoryRetentionReportOutcome;
  reason: string;
  nextAction?: string;
  durationMs?: number;
  totalDurationMs?: number;
  marker?: TrajectoryRetentionMarker;
  /**
   * Counts already committed before the failure. Never reset to zero: a run
   * that deleted N rows must not report 0 (review finding 4).
   */
  deletedByTable?: Record<string, number>;
  batches?: number;
  indexes?: RetentionIndexReport | null;
  indexesError?: string | null;
}): TrajectoryRetentionReport {
  return {
    outcome: args.outcome,
    reason: args.reason,
    workspaceDir: args.workspaceDir,
    cutoff: args.marker?.lastCutoff ?? null,
    deletedByTable: args.deletedByTable ?? emptyCounts(),
    batches: args.batches ?? 0,
    durationMs: args.durationMs ?? 0,
    totalDurationMs: args.totalDurationMs ?? args.durationMs ?? 0,
    maxBatchDurationMs: 0,
    partial: false,
    backoffUntil: args.marker?.backoffUntil ?? null,
    policy: args.policy,
    indexes: args.indexes ?? null,
    indexesError: args.indexesError ?? null,
    ...(args.nextAction === undefined ? {} : { nextAction: args.nextAction }),
  };
}

/**
 * One retention attempt for one workspace.
 *
 * Synchronous on purpose: callers are a worker cycle and a CLI command, both
 * of which already own their concurrency, and a fire-and-forget promise in a
 * worker loop is a crash risk with no upside.
 */
export function runTrajectoryRetention(
  options: RunTrajectoryRetentionOptions,
): TrajectoryRetentionReport {
  const now = options.now ?? (() => Date.now());
  const trigger: TrajectoryRetentionTrigger = options.trigger ?? 'worker';
  const startedAt = now();
  const workspaceDir = path.resolve(options.workspaceDir);
  const paths = trajectoryRetentionPaths(workspaceDir);

  // Config first: a malformed .pd/config.yaml must delete NOTHING (fail closed).
  const configResult = loadPdConfigForPlugin(workspaceDir);
  if (!configResult.ok) {
    return skipReport({
      workspaceDir,
      policy: { ...resolveTrajectoryRetentionPolicy(undefined), enabled: false },
      outcome: 'skipped',
      reason: `config_invalid: ${configResult.errors.map((error) => error.reason).join('; ') || 'unknown'}`,
      nextAction: `Fix .pd/config.yaml (${configResult.configPath}); retention stays off until it loads`,
      durationMs: now() - startedAt,
    });
  }

  const policy = resolveTrajectoryRetentionPolicy(configResult.effective.config.trajectoryRetention);
  if (policy.degradedReason !== undefined) {
    return skipReport({
      workspaceDir,
      policy,
      outcome: 'skipped',
      reason: `degraded:${policy.degradedReason}`,
      nextAction: 'Fix trajectoryRetention in .pd/config.yaml (see docs/specs/SPEC-PD-TR-001 §3.1); nothing was deleted',
      durationMs: now() - startedAt,
    });
  }
  if (!policy.enabled) {
    return skipReport({
      workspaceDir,
      policy,
      outcome: 'skipped',
      reason: policy.disabledByZeroDays === true ? 'retention_days_zero' : 'retention_disabled',
      nextAction: 'Set trajectoryRetention.enabled=true (and retentionDays>=7) to resume sweeping',
      durationMs: now() - startedAt,
    });
  }

  if (!fs.existsSync(paths.dbPath)) {
    return skipReport({
      workspaceDir,
      policy,
      outcome: 'skipped',
      reason: 'trajectory_db_missing',
      nextAction: 'Initialize the PD workspace (pd runtime init) before expecting a trajectory sweep',
      durationMs: now() - startedAt,
    });
  }

  const { marker: readMarker, reason: markerReason } = readMarkerFile(paths.markerPath);
  let marker = readMarker;
  if (markerReason !== undefined) {
    // A damaged marker costs at most one extra sweep, but it must be visible.
    marker = recordSkip({
      markerPath: paths.markerPath,
      marker,
      outcome: 'marker_damaged',
      reason: markerReason,
    });
  }

  const nowMs = now();
  if (trigger === 'worker') {
    if (marker.backoffUntil !== null) {
      const backoffMs = Date.parse(marker.backoffUntil);
      if (Number.isFinite(backoffMs) && nowMs < backoffMs) {
        return skipReport({
          workspaceDir,
          policy,
          outcome: 'skipped',
          reason: `backoff:until ${marker.backoffUntil}`,
          nextAction: 'No action needed; the next worker cycle retries after the backoff window',
          durationMs: now() - startedAt,
          marker,
        });
      }
    }
    if (marker.lastRunAt !== null) {
      const lastRunMs = Date.parse(marker.lastRunAt);
      if (Number.isFinite(lastRunMs)) {
        if (nowMs - lastRunMs < policy.intervalHours * 60 * 60 * 1000) {
          return skipReport({
            workspaceDir,
            policy,
            outcome: 'skipped',
            reason: `not_due: interval ${policy.intervalHours}h`,
            durationMs: now() - startedAt,
            marker,
          });
        }
      }
    }
  }

  // ── Single instance (SPEC §4.6) ──────────────────────────────────────────
  fs.mkdirSync(paths.stateDir, { recursive: true });
  let lock: ExclusiveLockHandle | undefined;
  try {
    lock = tryAcquireExclusiveLockSync(paths.dbPath, {
      lockPath: paths.lockPath,
      staleMs: TRAJECTORY_RETENTION_LOCK_STALE_MS,
    });
  } catch {
    lock = undefined;
  }
  if (lock === undefined) {
    return skipReport({
      workspaceDir,
      policy,
      outcome: 'skipped',
      reason: 'locked',
      nextAction: `Inspect ${paths.lockPath}; a stale lock is taken over automatically after 10 minutes`,
      durationMs: now() - startedAt,
      marker,
    });
  }

  let db: DatabaseHandle | undefined;
  // Declared before the try so the catch path can report committed work
  // instead of zeroing it (review finding 4).
  const deletedByTable: Record<string, number> = {};
  let batches = 0;
  let indexes: RetentionIndexReport | null = null;
  let indexesError: string | null = null;
  try {
    db = new Database(paths.dbPath);
    db.pragma(`busy_timeout = ${TRAJECTORY_RETENTION_WRITE_LOCK_WAIT_MS}`);

    const journalMode = readJournalMode(db);
    if (journalMode !== 'wal') {
      const nextMarker = recordSkip({
        markerPath: paths.markerPath,
        marker,
        outcome: 'skipped',
        reason: 'journal_mode_not_wal',
      });
      return skipReport({
        workspaceDir,
        policy,
        outcome: 'skipped',
        reason: `journal_mode_not_wal:${journalMode || 'unknown'}`,
        nextAction: 'Let the host open the trajectory database once (it enables WAL); retention never switches the mode itself',
        durationMs: now() - startedAt,
        marker: nextMarker,
      });
    }

    // Marker loss must not bypass the 7-day cutoff cap. A missing `lastCutoff`
    // covers both "first run" and "marker deleted/corrupted"; the oldest stored
    // row is a durable observation point, so use it as the conservative
    // baseline instead of jumping straight to `now - retentionDays`.
    if (marker.lastCutoff === null) {
      const oldest = oldestStoredTimestamp(db);
      if (oldest !== null) marker = { ...marker, lastCutoff: oldest };
    }

    const decision = computeRetentionCutoff({
      nowMs,
      retentionDays: policy.retentionDays,
      intervalHours: policy.intervalHours,
      marker,
    });
    if (decision.kind === 'skip') {
      // Advancing the clock baseline is what makes the skip recoverable: with
      // `intervalHours=6` the forward limit is 7.5 days, so a laptop that was
      // off longer than that would otherwise skip forever. `lastCutoff` is
      // deliberately NOT advanced (review finding 2).
      const clockSkip = decision.reason === 'clock_backwards'
        || decision.reason === 'clock_forward_anomaly'
        || decision.reason === 'marker_timestamp_invalid';
      const nextMarker = recordSkip({
        markerPath: paths.markerPath,
        marker: clockSkip
          ? { ...marker, lastRunAt: new Date(nowMs).toISOString() }
          : marker,
        outcome: 'skipped',
        reason: decision.reason,
      });
      return skipReport({
        workspaceDir,
        policy,
        outcome: 'skipped',
        reason: decision.reason,
        nextAction: 'Check the system clock; retention resumes on the next run once time is plausible again',
        durationMs: now() - startedAt,
        marker: nextMarker,
      });
    }

    let retentionIndexes: RetentionIndexReport | null = null;
    try {
      // DDL is not the hot path: give it the DDL budget, then restore the
      // short delete budget (A8) before any batch runs.
      db.pragma(`busy_timeout = ${TRAJECTORY_RETENTION_DDL_BUSY_TIMEOUT_MS}`);
      retentionIndexes = ensureRetentionIndexes(db);
    } catch (error) {
      // Indexes are a performance concern, not a precondition for deleting.
      // A failed DDL degrades the plan but must not stop the sweep, and it is
      // surfaced in the report/marker instead of silently disappearing.
      indexesError = error instanceof Error ? error.message : String(error);
    } finally {
      db.pragma(`busy_timeout = ${TRAJECTORY_RETENTION_WRITE_LOCK_WAIT_MS}`);
    }
    indexes = retentionIndexes;

    const runDate = new Date(nowMs).toISOString().slice(0, 10);
    const appendExport = createExportWriter(paths.exportsDir, runDate);

    const run: TrajectoryRetentionRunResult = runTrajectoryRetentionBatches(db, {
      policy,
      cutoff: decision.cutoff,
      hooks: {
        now,
        onBatchPrepared: ({ table, rows }) => {
          const column = table === 'governance_observations' ? 'expired_at' : 'created_at';
          try {
            // Outside the write transaction: one append for the whole batch.
            appendExport(rows.map((row) => ({ table, id: row.id, column, at: row.at })));
            return null;
          } catch (error) {
            // Fail closed: no audit entry ⇒ this batch is not deleted.
            return error instanceof Error ? error.message : String(error);
          }
        },
        onBatchCommitted: ({ table, changes }) => {
          batches += 1;
          deletedByTable[table] = (deletedByTable[table] ?? 0) + changes;
        },
      },
    });

    const totalDurationMs = now() - startedAt;
    // Fill in tables the engine reached even when no batch committed, so a
    // stopped run reports `{ tool_calls: 0 }` rather than an empty object.
    for (const [table, count] of Object.entries(run.deletedByTable)) {
      if (deletedByTable[table] === undefined) deletedByTable[table] = count;
    }
    const busyOutcome = run.outcome === 'deferred_busy';
    const outcomeReason = run.reason
      ?? (indexesError === null ? null : `index_failed:${indexesError}`);
    const markerNext: TrajectoryRetentionMarker = {
      // Busy is not a completed attempt: keep lastRunAt so the backoff window
      // is what gates the retry, not a fresh intervalHours wait.
      lastRunAt: busyOutcome ? marker.lastRunAt : new Date(nowMs).toISOString(),
      // Only a complete sweep may advance the cutoff; a partial run resumes
      // against the SAME predicate (it is naturally idempotent).
      lastCutoff: run.outcome === 'completed' ? decision.cutoff : marker.lastCutoff,
      // SPEC §4.4 records the yield token as `deferred:busy`.
      lastOutcome: publicOutcome(run.outcome),
      deletedByTable,
      durationMs: run.durationMs,
      totalDurationMs,
      partial: run.outcome === 'partial' || run.outcome === 'deadline',
      backoffUntil: busyOutcome
        ? nextBackoffUntil(nowMs, marker.consecutiveBusy + 1)
        : null,
      consecutiveBusy: busyOutcome ? marker.consecutiveBusy + 1 : 0,
      reason: outcomeReason,
    };
    writeMarkerAtomic(paths.markerPath, markerNext);

    const auditFailed = run.reason?.startsWith('audit_failed:') === true;
    return {
      outcome: publicOutcome(run.outcome),
      reason: outcomeReason,
      workspaceDir,
      cutoff: run.cutoff,
      deletedByTable,
      batches,
      durationMs: run.durationMs,
      totalDurationMs,
      maxBatchDurationMs: run.maxBatchDurationMs,
      partial: markerNext.partial,
      backoffUntil: markerNext.backoffUntil,
      policy,
      indexes,
      indexesError,
      ...(run.outcome === 'invariant_violation'
        ? {
          nextAction:
            'Row counts did not reconcile; sweeping stopped without deleting further. Inspect trajectory.db and the marker before retrying',
        }
        : {}),
      ...(auditFailed
        ? {
          nextAction:
            'The deleted-row audit list could not be written, so the batch was NOT deleted. Check .state/exports permissions and free space',
        }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const busy = message.includes('SQLITE_BUSY') || message.includes('database is locked');
    const elapsedMs = now() - startedAt;
    // The marker is the ledger, so it must carry THIS run's committed counts.
    // `recordSkip` alone would leave the previous run's numbers in place while
    // the CLI report shows the new ones (review item 2).
    const failedMarker = recordSkip({
      markerPath: paths.markerPath,
      marker: {
        ...marker,
        deletedByTable,
        durationMs: elapsedMs,
        totalDurationMs: elapsedMs,
        partial: !busy,
      },
      outcome: busy ? 'deferred' : 'failed',
      reason: message,
    });
    return skipReport({
      workspaceDir,
      policy,
      outcome: busy ? 'deferred:busy' : 'skipped',
      reason: busy ? `sqlite_busy:${message}` : `failed:${message}`,
      nextAction: busy
        ? 'The next worker cycle retries after the backoff window'
        : 'Inspect the trajectory database; nothing further was deleted',
      durationMs: elapsedMs,
      totalDurationMs: elapsedMs,
      marker: failedMarker,
      // Never zero out what already committed before the exception (review 4).
      deletedByTable,
      batches,
      indexes,
      indexesError,
    });
  } finally {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // closing a failed connection must not mask the real outcome
      }
    }
    if (lock !== undefined) releaseExclusiveLock(lock);
  }
}

// ── Long-lived host scheduler (OpenClaw gateway) ─────────────────────────────

export interface TrajectoryRetentionLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

const scheduledWorkspaces = new Set<string>();
const warnedRetention = new Map<string, string>();

/**
 * Long-lived failure reasons repeat on every worker cycle. Return a message
 * only when the reason for THIS workspace changed, so a permanently wrong
 * `journal_mode` or a failing index DDL is visible once, not every 120 s
 * (review finding 7).
 */
export function retentionWarning(report: TrajectoryRetentionReport): string | null {
  const reason = report.reason ?? '';
  const persistent = report.outcome === 'invariant_violation'
    || reason.startsWith('journal_mode_not_wal')
    || reason.startsWith('index_failed')
    || reason.startsWith('clock_')
    || reason.startsWith('failed:')
    || reason.startsWith('audit_failed:')
    || reason === 'marker_damaged';
  if (!persistent) {
    if (report.outcome === 'completed' || report.outcome === 'partial') {
      warnedRetention.delete(report.workspaceDir);
    }
    return null;
  }
  const key = `${report.outcome}|${reason}|${report.indexesError ?? ''}`;
  if (warnedRetention.get(report.workspaceDir) === key) return null;
  warnedRetention.set(report.workspaceDir, key);
  return `[PD:TrajectoryRetention] ${report.outcome} reason=${reason}`
    + (report.indexesError === null ? '' : ` indexError=${report.indexesError}`);
}

/**
 * Schedule the periodic retention run for a long-lived host process.
 *
 * SPEC §4.1: an unref'd interval in the gateway process. Deliberately does NOT
 * run at scheduling time — that call happens inside `before_prompt_build`, and
 * a 3 s sweep there would be exactly the hook latency A3 forbids. The first
 * attempt happens one minute later, off the hook path.
 *
 * Idempotent per workspace: repeated plugin initialisation cannot stack timers.
 * Config is read once here (interval); the runner re-reads it every cycle, so
 * `enabled`/range changes still take effect.
 */
export function scheduleTrajectoryRetention(
  workspaceDirInput: string,
  logger?: TrajectoryRetentionLogger,
): void {
  const workspaceDir = path.resolve(workspaceDirInput);
  if (scheduledWorkspaces.has(workspaceDir)) return;
  scheduledWorkspaces.add(workspaceDir);

  const configResult = loadPdConfigForPlugin(workspaceDir);
  const policy = resolveTrajectoryRetentionPolicy(
    configResult.ok ? configResult.effective.config.trajectoryRetention : undefined,
  );
  const jitterMs = Math.floor(Math.random() * 10 * 60 * 1000) - 5 * 60 * 1000;
  const intervalMs = Math.max(60_000, policy.intervalHours * 60 * 60 * 1000 + jitterMs);

  const tick = (): void => {
    try {
      const report = runTrajectoryRetention({ workspaceDir, trigger: 'worker' });
      const warning = retentionWarning(report);
      if (warning !== null) {
        logger?.warn?.(warning);
        return;
      }
      // Busy is an expected yield, already covered by the backoff window.
      if (report.outcome === 'deferred:busy') return;
      const deleted = Object.values(report.deletedByTable).reduce((sum, count) => sum + count, 0);
      if (report.outcome === 'skipped' && deleted === 0) return;
      const message = `[PD:TrajectoryRetention] ${report.outcome} deleted=${deleted} `
        + `batches=${report.batches} durationMs=${report.totalDurationMs}`
        + (report.reason === null ? '' : ` reason=${report.reason}`);
      if (report.outcome === 'completed' || report.outcome === 'partial') {
        logger?.info?.(message);
      } else {
        logger?.warn?.(message);
      }
    } catch (error) {
      logger?.warn?.(
        `[PD:TrajectoryRetention] failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const initial = setTimeout(tick, 60_000);
  initial.unref?.();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

// ── Read-only status (CLI) ───────────────────────────────────────────────────
export interface TrajectoryRetentionStatus {
  workspaceDir: string;
  dbPath: string;
  dbExists: boolean;
  marker: TrajectoryRetentionMarker;
  markerError: string | null;
  policy: TrajectoryRetentionPolicy;
  expiredByTable: Record<string, number> | null;
  dbError: string | null;
}

/**
 * Read-only status: never creates the marker, never opens the database for
 * writing, never creates an index.
 */
export function readTrajectoryRetentionStatus(workspaceDirInput: string): TrajectoryRetentionStatus {
  const workspaceDir = path.resolve(workspaceDirInput);
  const paths = trajectoryRetentionPaths(workspaceDir);
  const configResult = loadPdConfigForPlugin(workspaceDir);
  const policy = resolveTrajectoryRetentionPolicy(
    configResult.ok ? configResult.effective.config.trajectoryRetention : undefined,
  );
  const read = readMarkerFile(paths.markerPath);
  const dbExists = fs.existsSync(paths.dbPath);
  if (!dbExists) {
    return {
      workspaceDir,
      dbPath: paths.dbPath,
      dbExists,
      marker: read.marker,
      markerError: read.reason ?? null,
      policy,
      expiredByTable: null,
      dbError: null,
    };
  }

  let db: DatabaseHandle | undefined;
  let expiredByTable: Record<string, number> | null = null;
  let dbError: string | null = null;
  try {
    db = new Database(paths.dbPath, { readonly: true });
    const counts: Record<string, number> = {};
    for (const [table, column, extra] of [
      ['tool_calls', 'created_at', null],
      ['assistant_turns', 'created_at', null],
      ['user_turns', 'created_at', null],
      ['governance_observations', 'expired_at', "retention_class IN ('expired','rolled_back')"],
    ] as const) {
      if (!tableExists(db, table)) {
        counts[table] = 0;
        continue;
      }
      const predicate = `${column} IS NOT NULL AND ${column} < ?${extra === null ? '' : ` AND ${extra}`}`;
      const row: unknown = db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${predicate}`)
        .get(new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000).toISOString());
      counts[table] = readCountField(row);
    }
    expiredByTable = counts;
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  } finally {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // read-only handle; nothing to recover
      }
    }
  }

  return {
    workspaceDir,
    dbPath: paths.dbPath,
    dbExists,
    marker: read.marker,
    markerError: read.reason ?? null,
    policy,
    expiredByTable,
    dbError,
  };
}

// ── Explicit VACUUM (CLI only) ───────────────────────────────────────────────

export interface TrajectoryVacuumReport {
  workspaceDir: string;
  dbPath: string;
  applied: boolean;
  refusedReason: string | null;
  nextAction?: string;
  sizeBeforeBytes: number;
  sizeAfterBytes: number | null;
  freeBytes: number | null;
  requiredBytes: number | null;
  freelistBefore: number | null;
  freelistAfter: number | null;
  durationMs: number;
}

/**
 * `pd trajectory vacuum` — the ONLY place VACUUM may run (SPEC §6).
 *
 * VACUUM takes an exclusive lock and cannot be interrupted, which is why it is
 * never scheduled. Default is a dry run: it reports the space requirement and
 * refuses to start when the filesystem cannot hold `2 × size + 10%`.
 */
export function vacuumTrajectoryDatabase(args: {
  workspaceDir: string;
  apply: boolean;
  now?: () => number;
}): TrajectoryVacuumReport {
  const now = args.now ?? (() => Date.now());
  const startedAt = now();
  const workspaceDir = path.resolve(args.workspaceDir);
  const paths = trajectoryRetentionPaths(workspaceDir);
  const report: TrajectoryVacuumReport = {
    workspaceDir,
    dbPath: paths.dbPath,
    applied: false,
    refusedReason: null,
    sizeBeforeBytes: 0,
    sizeAfterBytes: null,
    freeBytes: null,
    requiredBytes: null,
    freelistBefore: null,
    freelistAfter: null,
    durationMs: 0,
  };

  if (!fs.existsSync(paths.dbPath)) {
    return {
      ...report,
      refusedReason: 'trajectory_db_missing',
      nextAction: 'Initialize the PD workspace before vacuuming',
      durationMs: now() - startedAt,
    };
  }

  report.sizeBeforeBytes = fs.statSync(paths.dbPath).size;
  report.requiredBytes = Math.ceil(report.sizeBeforeBytes * 2.1);
  try {
    const stats = fs.statfsSync(path.dirname(paths.dbPath));
    report.freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    report.freeBytes = null;
  }

  let db: DatabaseHandle | undefined;
  try {
    db = new Database(paths.dbPath);
    db.pragma(`busy_timeout = ${TRAJECTORY_RETENTION_VACUUM_BUSY_TIMEOUT_MS}`);
    const freePages = db.pragma('freelist_count', { simple: true });
    report.freelistBefore = typeof freePages === 'number' ? freePages : null;
    const mode = readJournalMode(db);

    if (report.freeBytes === null) {
      return {
        ...report,
        refusedReason: 'free_space_unknown',
        nextAction: `Cannot read free space for ${path.dirname(paths.dbPath)}; close hosts and re-run with --yes only after confirming free disk space`,
        durationMs: now() - startedAt,
      };
    }
    if (report.freeBytes < report.requiredBytes) {
      return {
        ...report,
        refusedReason: 'insufficient_free_space',
        nextAction: `Free at least ${report.requiredBytes - report.freeBytes} more bytes in ${path.dirname(paths.dbPath)} (need 2 x file + 10%)`,
        durationMs: now() - startedAt,
      };
    }
    if (!args.apply) {
      return {
        ...report,
        refusedReason: null,
        nextAction: 'Dry run: re-run with --yes to execute VACUUM (close other hosts first; VACUUM needs an exclusive lock)',
        durationMs: now() - startedAt,
      };
    }
    if (mode !== 'wal' && mode !== 'delete') {
      return {
        ...report,
        refusedReason: `journal_mode_not_supported:${mode}`,
        nextAction: 'Let the host open the trajectory database once, then retry',
        durationMs: now() - startedAt,
      };
    }

    db.exec('VACUUM');
    const afterPages = db.pragma('freelist_count', { simple: true });
    report.freelistAfter = typeof afterPages === 'number' ? afterPages : null;
    report.applied = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const busy = message.includes('SQLITE_BUSY') || message.includes('database is locked');
    return {
      ...report,
      refusedReason: busy ? 'database_busy' : `vacuum_failed:${message}`,
      nextAction: busy
        ? 'Close the host (it holds a connection) and retry; VACUUM needs an exclusive lock'
        : 'SQLite leaves the original database intact on failure; retry after checking free space',
      durationMs: now() - startedAt,
    };
  } finally {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // the report already describes the outcome
      }
    }
  }

  report.sizeAfterBytes = fs.statSync(paths.dbPath).size;
  report.durationMs = now() - startedAt;
  return report;
}
