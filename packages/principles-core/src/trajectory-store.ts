/**
 * Trajectory Store — correction sample primitives for SDK use.
 *
 * Extracts listCorrectionSamples and reviewCorrectionSample from TrajectoryDatabase
 * as pure functions that can be used without openclaw-plugin dependency.
 *
 * Reads the canonical workspace trajectory database
 * (`{workspaceDir}/.state/trajectory.db`) written by openclaw-plugin
 * TrajectoryDatabase — see trajectory-db.ts for the shared path contract.
 *
 * @example
 * import { listCorrectionSamples, reviewCorrectionSample } from '@principles/core/trajectory-store';
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types (copied from trajectory-types.ts — do NOT import from openclaw-plugin)
// ---------------------------------------------------------------------------

export type CorrectionSampleReviewStatus = 'pending' | 'approved' | 'rejected';

export type CorrectionExportMode = 'raw' | 'redacted';

export interface CorrectionSampleRecord {
  sampleId: string;
  sessionId: string;
  badAssistantTurnId: number;
  userCorrectionTurnId: number;
  recoveryToolSpanJson: string;
  diffExcerpt: string;
  principleIdsJson: string;
  qualityScore: number;
  reviewStatus: CorrectionSampleReviewStatus;
  exportMode: CorrectionExportMode;
  createdAt: string;
  updatedAt: string;
}

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
 * The production writer is openclaw-plugin `TrajectoryDatabase`, whose path
 * authority is openclaw-plugin `core/paths.ts`
 * (`PD_FILES.TRAJECTORY_DB = .state/trajectory.db`). principles-core must not
 * import from openclaw-plugin, so the relative path is pinned here; the
 * plugin-to-core round-trip test
 * (openclaw-plugin/tests/core/trajectory-store-round-trip.test.ts) writes
 * through TrajectoryDatabase and reads through this module — if either side
 * moves the file, that test fails.
 *
 * A missing database is NOT the same as an empty database: readers open the
 * file through `openTrajectoryDbReadonly`, which throws
 * `TrajectoryDbUnavailableError` (carrying the path and reason) instead of
 * silently returning no rows (rc-3 fail-loud-missing, rc-9 no-silent-fallback).
 */
export function resolveTrajectoryDbPath(workspaceDir: string): string {
  return join(workspaceDir, '.state', 'trajectory.db');
}

/**
 * The trajectory database cannot be read at its canonical location.
 *
 * Distinct from "the database exists and has no rows": callers (CLI commands)
 * must surface this as an operator-visible failure with a next action, never
 * as an empty result.
 */
export class TrajectoryDbUnavailableError extends Error {
  readonly dbPath: string;

  constructor(dbPath: string, reason: string) {
    super(`Trajectory database unavailable at ${dbPath} (${reason})`);
    this.name = 'TrajectoryDbUnavailableError';
    this.dbPath = dbPath;
  }
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
    throw new TrajectoryDbUnavailableError(dbPath, 'database file does not exist');
  }

  try {
    return new Database(dbPath, { readonly: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TrajectoryDbUnavailableError(dbPath, `cannot be opened: ${msg}`);
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
  const msg = err instanceof Error ? err.message : String(err);
  throw new TrajectoryDbUnavailableError(dbPath, `query failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

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
 * Mirror of openclaw-plugin TrajectoryDatabase.recordCorrectionRejectedPain:
 * the two review surfaces (pd-cli and /pd-samples) must produce the same
 * correction_rejected pain event, otherwise Owner rejections recorded via the
 * CLI silently drop out of the pain pipeline. host_kind stays 'openclaw'
 * because correction samples are only mined from OpenClaw sessions.
 * Non-fatal: failures warn and leave the review result intact.
 */
function recordCorrectionRejectedPain(
  db: Database.Database,
  record: {
    sessionId: string;
    qualityScore: number;
    diffExcerpt: string;
    principleIdsJson: string;
    createdAt: string;
  },
): void {
  try {
    const painScore = Math.max(0, Math.min(100, Math.round(Number(record.qualityScore) || 0)));
    const reason = `Correction rejected (quality ${record.qualityScore.toFixed(2)}). Principles: ${record.principleIdsJson}${record.diffExcerpt ? ` — ${record.diffExcerpt.slice(0, 120)}` : ''}`;
    const severity = painScore >= 70 ? 'severe' : painScore >= 40 ? 'moderate' : 'mild';

    db.transaction(() => {
      db.prepare(`
        INSERT INTO sessions (session_id, started_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(record.sessionId, record.createdAt, record.createdAt);

      db.prepare(`
        INSERT INTO pain_events (
          session_id, source, score, reason, severity, origin, confidence, text, created_at, host_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.sessionId,
        'correction_rejected',
        painScore,
        reason,
        severity,
        'system_infer',
        1,
        record.diffExcerpt || null,
        record.createdAt,
        'openclaw',
      );
    })();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[PD:TrajectoryStore] Failed to record correction_rejected pain event: ${msg}`);
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
    throw new TrajectoryDbUnavailableError(dbPath, 'database file does not exist');
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TrajectoryDbUnavailableError(dbPath, `cannot be opened: ${msg}`);
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

    // Rejection parity with the plugin writer (openclaw-plugin
    // TrajectoryDatabase.recordCorrectionRejectedPain): a rejected correction
    // feeds the pain pipeline as source 'correction_rejected'. Non-fatal by
    // contract — the review result must survive a pain-write failure.
    if (decision === 'rejected') {
      recordCorrectionRejectedPain(db, {
        sessionId: String(record.session_id),
        qualityScore: Number(record.quality_score),
        diffExcerpt: String(record.diff_excerpt ?? ''),
        principleIdsJson: String(record.principle_ids_json ?? '[]'),
        createdAt: String(record.created_at),
      });
    }

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
