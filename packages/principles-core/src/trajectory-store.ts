/**
 * Trajectory Store — correction sample primitives for SDK use.
 *
 * Extracts listCorrectionSamples and reviewCorrectionSample from TrajectoryDatabase
 * as pure functions that can be used without openclaw-plugin dependency.
 *
 * Reads the canonical workspace trajectory database
 * (`{workspaceDir}/.state/trajectory.db`) written by openclaw-plugin
 * TrajectoryDatabase — the path pin below (`resolveTrajectoryDbPath`) is the
 * shared path contract: core must not import from openclaw-plugin, so the
 * relative path is pinned here, and the plugin-to-core round-trip test
 * (openclaw-plugin tests/core/trajectory-store-round-trip.test.ts) fails if
 * either side moves the file.
 *
 * @example
 * import { listCorrectionSamples, reviewCorrectionSample } from '@principles/core/trajectory-store';
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { resolveTrajectoryDbPath } from './runtime/store/storage-paths.js';
import type {
  CorrectionSampleReviewStatus,
  CorrectionExportMode,
  CorrectionSampleRecord,
} from './trajectory-types.js';

// ---------------------------------------------------------------------------
// Types (single-homed in src/trajectory-types.ts since PRI-774; re-exported
// here to preserve the historical @principles/core/trajectory-store surface)
// ---------------------------------------------------------------------------

export type {
  CorrectionSampleReviewStatus,
  CorrectionExportMode,
  CorrectionSampleRecord,
} from './trajectory-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Canonical database access (shared with evolution-store)
// ---------------------------------------------------------------------------

/**
 * Canonical trajectory.db location shared by every SDK reader.
 *
 * The location itself is owned by `runtime/store/storage-paths.ts` (the single
 * source of truth for workspace database paths). This module keeps the public
 * `@principles/core/trajectory-store` symbol so existing consumers are
 * unchanged; the production writer (openclaw-plugin `TrajectoryDatabase`) pins
 * the same relative path in its own `core/paths.ts`, and the plugin-to-core
 * round-trip test (openclaw-plugin/tests/core/trajectory-store-round-trip.test.ts)
 * fails if either side moves the file.
 *
 * A missing database is NOT the same as an empty database: readers open the
 * file through `openTrajectoryDbReadonly`, which throws
 * `TrajectoryDbUnavailableError` (carrying the path and reason) instead of
 * silently returning no rows (rc-3 fail-loud-missing, rc-9 no-silent-fallback).
 */
export { resolveTrajectoryDbPath };

/**
 * Machine-readable cause of a trajectory.db read failure.
 *
 * Why a code and not just a message: callers must distinguish "the source says
 * there is nothing" (`absent`) from "the source cannot be read" (`unknown`).
 * The message is for humans; this code is the fact the console/CLI branch on.
 */
type TrajectoryDbUnavailableCode = 'file_missing' | 'schema_missing' | 'locked' | 'corrupt' | 'io_error';

/**
 * The trajectory database cannot be read at its canonical location.
 *
 * Distinct from "the database exists and has no rows": callers (CLI commands)
 * must surface this as an operator-visible failure with a next action, never
 * as an empty result.
 */
export class TrajectoryDbUnavailableError extends Error {
  readonly dbPath: string;
  /** Machine-readable cause; `schema_missing` also carries the offending table. */
  readonly code: TrajectoryDbUnavailableCode;
  /** Set when `code === 'schema_missing'` and the table name could be parsed. */
  readonly table?: string;

  constructor(
    dbPath: string,
    failure: { code: TrajectoryDbUnavailableCode; detail: string; table?: string },
  ) {
    super(`Trajectory database unavailable at ${dbPath} (${failure.detail})`);
    this.name = 'TrajectoryDbUnavailableError';
    this.dbPath = dbPath;
    this.code = failure.code;
    if (failure.table !== undefined) this.table = failure.table;
  }
}

/** Classify a better-sqlite3/fs failure without inventing a reason. */
function classifyTrajectoryDbFailure(dbPath: string, err: unknown, phase: 'open' | 'query'): TrajectoryDbUnavailableError {
  const msg = err instanceof Error ? err.message : String(err);
  const tableMatch = /no such table:\s*([A-Za-z0-9_]+)/.exec(msg);
  if (tableMatch) {
    return new TrajectoryDbUnavailableError(dbPath, { code: 'schema_missing', detail: `query failed: ${msg}`, table: tableMatch[1] });
  }
  if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
    return new TrajectoryDbUnavailableError(dbPath, { code: 'locked', detail: `${phase} failed: ${msg}` });
  }
  if (msg.includes('SQLITE_NOTADB') || msg.includes('file is not a database') || msg.includes('database disk image is malformed')) {
    return new TrajectoryDbUnavailableError(dbPath, { code: 'corrupt', detail: `${phase} failed: ${msg}` });
  }
  if (msg.includes('ENOENT') || msg.includes('does not exist')) {
    return new TrajectoryDbUnavailableError(dbPath, { code: 'file_missing', detail: `${phase} failed: ${msg}` });
  }
  return new TrajectoryDbUnavailableError(dbPath, { code: 'io_error', detail: `${phase} failed: ${msg}` });
}

/**
 * Open the workspace trajectory database read-only or throw.
 *
 * Read-only on purpose: these primitives never create or migrate the file —
 * the writer (openclaw-plugin TrajectoryDatabase / `pd runtime init`) owns
 * creation, so a missing file is reported, not papered over.
 */
export function openTrajectoryDbReadonly(workspaceDir: string): Database.Database {
  const dbPath = resolveTrajectoryDbPath(workspaceDir);

  if (!existsSync(dbPath)) {
    throw new TrajectoryDbUnavailableError(dbPath, { code: 'file_missing', detail: 'database file does not exist' });
  }

  try {
    return new Database(dbPath, { readonly: true });
  } catch (err: unknown) {
    throw classifyTrajectoryDbFailure(dbPath, err, 'open');
  }
}

/**
 * Translate unexpected query/DDL failures into the same typed unavailability
 * the CLI layer knows how to present (PRI-753 review: malformed or
 * schema-less databases must not escape as raw stack traces). The underlying
 * SQLite message is preserved in the reason. Domain errors (sample not
 * found) and existing unavailability errors pass through unchanged.
 */
export function rethrowAsQueryFailed(dbPath: string, err: unknown): never {
  if (err instanceof TrajectoryDbUnavailableError) throw err;
  if (err instanceof Error && err.message.startsWith('Sample not found')) throw err;
  throw classifyTrajectoryDbFailure(dbPath, err, 'query');
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * PRI-904: the next session-local user-turn ordinal — the deterministic
 * round fact the prompt principle fair rotation advances on.
 *
 * Reads the ALREADY-PERSISTED `user_turns.turn_index` counter for one
 * session (written by openclaw-plugin `TrajectoryDatabase.recordUserTurn`).
 * It is the same fact the correction pipeline anchors on
 * (`nextUserTurnIndex` in the prompt hook), so no new column, table, file or
 * cursor is introduced: this is a read of production state through the
 * registered trajectory-store seam.
 *
 * Determinism contract (SPEC INV-F02): for one session the value is
 * `max(turn_index) + 1`, so consecutive recorded user turns yield consecutive
 * ordinals. Modulo the eligible-ring size N, N consecutive turns therefore
 * cover every ring position exactly once — a bounded, provable opportunity
 * window, unlike hashing an opaque run identity.
 *
 * @param workspaceDir - The workspace directory (DB path: {workspaceDir}/.state/trajectory.db)
 * @param sessionId - Session whose next user-turn ordinal is requested
 * @returns The next ordinal (>= 1); 1 when the session has no recorded turn yet
 * @throws TrajectoryDbUnavailableError if the database does not exist or
 *         cannot be opened — callers must degrade observably, never assume 0
 */
export function nextSessionTurnOrdinal(workspaceDir: string, sessionId: string): number {
  const db = openTrajectoryDbReadonly(workspaceDir);
  try {
    // idx_user_turns_session_id covers this filter; the aggregate is O(matches).
    const row = db
      .prepare('SELECT MAX(turn_index) AS max_turn FROM user_turns WHERE session_id = ?')
      .get(sessionId) as { max_turn: number | null } | undefined;
    const max = row?.max_turn;
    return typeof max === 'number' && Number.isFinite(max) ? max + 1 : 1;
  } catch (err: unknown) {
    rethrowAsQueryFailed(resolveTrajectoryDbPath(workspaceDir), err);
  } finally {
    db.close();
  }
}

/**
 * List correction samples by review status.
 *
 * @param workspaceDir - The workspace directory (DB path: {workspaceDir}/.state/trajectory.db)
 * @param status - Filter by review status (default: 'pending')
 * @returns Array of CorrectionSampleRecord; empty array means the database
 *          exists and has no matching rows
 * @throws TrajectoryDbUnavailableError if the database does not exist or
 *         cannot be opened — never silently treated as "no samples"
 */
export function listCorrectionSamples(
  workspaceDir: string,
  status: CorrectionSampleReviewStatus = 'pending',
): CorrectionSampleRecord[] {
  const db = openTrajectoryDbReadonly(workspaceDir);
  const dbPath = resolveTrajectoryDbPath(workspaceDir);

  try {
    const rows = db.prepare(`
      SELECT sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
             recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
             review_status, export_mode, created_at, updated_at
      FROM correction_samples
      WHERE review_status = ?
      ORDER BY created_at DESC
    `).all(status) as Record<string, unknown>[];

    return rows.map((row) => ({
      sampleId: String(row.sample_id),
      sessionId: String(row.session_id),
      badAssistantTurnId: Number(row.bad_assistant_turn_id),
      userCorrectionTurnId: Number(row.user_correction_turn_id),
      recoveryToolSpanJson: String(row.recovery_tool_span_json ?? ''),
      diffExcerpt: String(row.diff_excerpt ?? ''),
      principleIdsJson: String(row.principle_ids_json ?? '[]'),
      qualityScore: Number(row.quality_score),
      reviewStatus: row.review_status as CorrectionSampleReviewStatus,
      exportMode: row.export_mode as CorrectionExportMode,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  } catch (err: unknown) {
    rethrowAsQueryFailed(dbPath, err);
  } finally {
    db.close();
  }
}

/**
 * Review a correction sample (approve or reject).
 *
 * @param sampleId - The sample ID to review
 * @param decision - 'approved' or 'rejected'
 * @param note - Optional review note
 * @param workspaceDir - The workspace directory (DB path: {workspaceDir}/.state/trajectory.db)
 * @returns The updated CorrectionSampleRecord
 * @throws TrajectoryDbUnavailableError if the database does not exist,
 *         cannot be opened, or the schema/query fails
 * @throws Error if the sample is not found
 */
// eslint-disable-next-line @typescript-eslint/max-params
export function reviewCorrectionSample(
  sampleId: string,
  decision: 'approved' | 'rejected',
  note: string | undefined,
  workspaceDir: string,
): CorrectionSampleRecord {
  const dbPath = resolveTrajectoryDbPath(workspaceDir);

  if (!existsSync(dbPath)) {
    throw new TrajectoryDbUnavailableError(dbPath, { code: 'file_missing', detail: 'database file does not exist' });
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (err: unknown) {
    throw classifyTrajectoryDbFailure(dbPath, err, 'open');
  }

  const updatedAt = nowIso();
  let updated = false;

  try {
    // Status change and audit row commit together: a failure in either rolls
    // back both, so an Owner decision never lands without its audit record.
    db.transaction(() => {
      const updateResult = db.prepare(`
        UPDATE correction_samples
        SET review_status = ?, updated_at = ?
        WHERE sample_id = ?
      `).run(decision, updatedAt, sampleId);

      if (updateResult.changes === 0) {
        return;
      }

      db.prepare(`
        INSERT INTO sample_reviews (sample_id, review_status, note, created_at)
        VALUES (?, ?, ?, ?)
      `).run(sampleId, decision, note ?? null, updatedAt);

      updated = true;
    })();

    if (!updated) {
      throw new Error(`Sample not found: ${sampleId}`);
    }

    const record = db.prepare(`
      SELECT sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
             recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
             review_status, export_mode, created_at, updated_at
      FROM correction_samples
      WHERE sample_id = ?
    `).get(sampleId) as Record<string, unknown> | undefined;

    if (!record) {
      throw new Error(`Sample not found after update: ${sampleId}`);
    }

    // Pain Phase 0 (SPEC PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 §6.4):
    // the correction_rejected pain event write was removed — sample rejection
    // is learning-quality feedback, not host Pain. This mirrors the plugin
    // writer (openclaw-plugin TrajectoryDatabase.reviewCorrectionSample).

    return {
      sampleId: String(record.sample_id),
      sessionId: String(record.session_id),
      badAssistantTurnId: Number(record.bad_assistant_turn_id),
      userCorrectionTurnId: Number(record.user_correction_turn_id),
      recoveryToolSpanJson: String(record.recovery_tool_span_json ?? ''),
      diffExcerpt: String(record.diff_excerpt ?? ''),
      principleIdsJson: String(record.principle_ids_json ?? '[]'),
      qualityScore: Number(record.quality_score),
      reviewStatus: record.review_status as CorrectionSampleReviewStatus,
      exportMode: record.export_mode as CorrectionExportMode,
      createdAt: String(record.created_at),
      updatedAt: String(record.updated_at),
    };
  } catch (err: unknown) {
    rethrowAsQueryFailed(dbPath, err);
  } finally {
    db.close();
  }
}
