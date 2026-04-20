/**
 * Trajectory Store — correction sample primitives for SDK use.
 *
 * Extracts listCorrectionSamples and reviewCorrectionSample from TrajectoryDatabase
 * as pure functions that can be used without openclaw-plugin dependency.
 *
 * @example
 * import { listCorrectionSamples, reviewCorrectionSample } from '@principles/core/trajectory-store';
 */

import Database from 'better-sqlite3';
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

function getDbPath(workspaceDir: string): string {
  return join(workspaceDir, '.state', '.trajectory.db');
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * List correction samples by review status.
 *
 * @param workspaceDir - The workspace directory (DB path: {workspaceDir}/.state/.trajectory.db)
 * @param status - Filter by review status (default: 'pending')
 * @returns Array of CorrectionSampleRecord, or empty array if DB does not exist
 */
export function listCorrectionSamples(
  workspaceDir: string,
  status: CorrectionSampleReviewStatus = 'pending',
): CorrectionSampleRecord[] {
  const dbPath = getDbPath(workspaceDir);

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    // Graceful fallback: DB does not exist yet
    return [];
  }

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
 * @param workspaceDir - The workspace directory (DB path: {workspaceDir}/.state/.trajectory.db)
 * @returns The updated CorrectionSampleRecord
 * @throws Error if the sample is not found
 */
export function reviewCorrectionSample(
  sampleId: string,
  decision: 'approved' | 'rejected',
  note: string | undefined,
  workspaceDir: string,
): CorrectionSampleRecord {
  const dbPath = getDbPath(workspaceDir);
  const db = new Database(dbPath);
  const updatedAt = nowIso();

  try {
    const updateResult = db.prepare(`
      UPDATE correction_samples
      SET review_status = ?, updated_at = ?
      WHERE sample_id = ?
    `).run(decision, updatedAt, sampleId);

    if (updateResult.changes === 0) {
      throw new Error(`Sample not found: ${sampleId}`);
    }

    db.prepare(`
      INSERT INTO sample_reviews (sample_id, review_status, note, created_at)
      VALUES (?, ?, ?, ?)
    `).run(sampleId, decision, note ?? null, updatedAt);

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
  } finally {
    db.close();
  }
}
