/**
 * Trajectory Evidence Builder for CLI — PRI-341
 *
 * Reads trajectory.db directly to extract evidence entries for `pd pain record`.
 * This avoids a dependency on openclaw-plugin (which uses WorkspaceContext / TrajectoryRegistry)
 * while providing the same capability for the CLI path.
 *
 * Core/plugin boundary: this file lives in pd-cli (I/O boundary), not in principles-core.
 * Uses better-sqlite3 (already a pd-cli dependency) and sanitizeString from core.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_EVIDENCE_ENTRIES,
  MAX_EVIDENCE_NOTE_CHARS,
  sanitizeString,
} from '@principles/core/runtime-v2';
import type { PainEvidenceEntry } from '@principles/core/runtime-v2';

/**
 * PRI-642 (SPEC §7.3): discriminated acquisition result. `unavailable` carries
 * a distinct reasonCode so `pd pain record --session` can fail/degrade
 * explicitly BEFORE any LLM/task/candidate mutation, without placeholder
 * evidence.
 */
export type TrajectoryEvidenceAcquisition =
  | { status: 'available'; entries: PainEvidenceEntry[] }
  | {
      status: 'unavailable';
      reasonCode: 'trajectory_unavailable' | 'session_not_found' | 'empty_trajectory' | 'evidence_read_failed';
      detail: string;
    };

/** SourceRef markers that carry no real behavior trace (placeholder shapes). */
const PLACEHOLDER_SOURCE_REFS = new Set([
  'owner_reported:cli',
  'owner_message:unavailable',
  'agent_turn:unavailable',
  'tool_call_failure:unavailable',
  'trajectory:empty',
]);

interface TrajectoryDbCollection {
  entries: PainEvidenceEntry[];
  realEntryCount: number;
  readFailed: boolean;
}

/**
 * Collect evidence entries from an open trajectory.db for one session.
 * Shared by the typed acquisition API and the legacy array wrapper so the
 * two can never drift.
 */
function collectEvidenceFromDb(
  db: Database.Database,
  sessionId: string,
  workspaceDir?: string,
): TrajectoryDbCollection {
  const evidence: PainEvidenceEntry[] = [];
  let readFailed = false;

  // Try to read user turns with correction detection
  try {
    const userTurns = db.prepare(`
        SELECT id, raw_excerpt, correction_detected, correction_cue, created_at
        FROM user_turns
        WHERE session_id = ?
        ORDER BY id ASC
      `).all(sessionId) as Record<string, unknown>[];

    const lastCorrectionTurn = [...userTurns].reverse().find(t => Boolean(t.correction_detected));
    if (lastCorrectionTurn) {
      const rawExcerpt = typeof lastCorrectionTurn.raw_excerpt === 'string'
        ? lastCorrectionTurn.raw_excerpt
        : '';
      const sanitizedNote = sanitizeString(
        rawExcerpt.slice(0, MAX_EVIDENCE_NOTE_CHARS),
        workspaceDir,
      );
      evidence.push({
        sourceRef: `owner_message:${String(lastCorrectionTurn.created_at ?? 'unknown')}`,
        note: sanitizedNote,
      });
    }
  } catch {
    readFailed = true;
    // user_turns table may not exist — degrade gracefully
    if (evidence.length < MAX_EVIDENCE_ENTRIES) {
      evidence.push({
        sourceRef: 'owner_message:unavailable',
        note: 'trajectory_user_turns_unavailable',
      });
    }
  }

  // Try to read assistant turns (last 3)
  try {
    const assistantTurns = db.prepare(`
        SELECT id, sanitized_text, stop_reason, created_at
        FROM assistant_turns
        WHERE session_id = ?
        ORDER BY id ASC
      `).all(sessionId) as Record<string, unknown>[];

    const recentAssistant = assistantTurns.slice(-3);
    for (const turn of recentAssistant) {
      if (evidence.length >= MAX_EVIDENCE_ENTRIES) break;
      const sanitizedText = typeof turn.sanitized_text === 'string'
        ? turn.sanitized_text
        : '';
      const sanitizedNote = sanitizeString(
        sanitizedText.slice(0, MAX_EVIDENCE_NOTE_CHARS),
        workspaceDir,
      );
      // Enhanced: append truncation warning when stop_reason=length
      const stopReason = typeof turn.stop_reason === 'string' ? turn.stop_reason : null;
      const truncationWarning = stopReason === 'length' ? ' [TRUNCATED: output cut off by length limit]' : '';
      evidence.push({
        sourceRef: `agent_turn:${String(turn.created_at ?? 'unknown')}`,
        note: sanitizedNote + truncationWarning,
      });
    }
  } catch {
    readFailed = true;
    // assistant_turns table may not exist — degrade gracefully
    if (evidence.length < MAX_EVIDENCE_ENTRIES) {
      evidence.push({
        sourceRef: 'agent_turn:unavailable',
        note: 'trajectory_assistant_turns_unavailable',
      });
    }
  }

  // PRI-358: Try to read failed tool_calls (last 3 failures, chronological order)
  try {
    const failedToolCalls = db.prepare(`
        SELECT tool_name, error_type, exit_code, result_preview, created_at
        FROM (
          SELECT tool_name, error_type, exit_code, result_preview, created_at
          FROM tool_calls
          WHERE session_id = ? AND outcome = 'failure'
          ORDER BY created_at DESC
          LIMIT 3
        )
        ORDER BY created_at ASC
      `).all(sessionId) as Record<string, unknown>[];

    for (const tc of failedToolCalls) {
      if (evidence.length >= MAX_EVIDENCE_ENTRIES) break;
      const toolName = typeof tc.tool_name === 'string' ? tc.tool_name : 'unknown';
      const errorType = typeof tc.error_type === 'string' ? tc.error_type : 'unknown';
      const exitCode = tc.exit_code != null ? String(tc.exit_code) : 'N/A';
      // Enhanced: append resultPreview when available
      const resultPreview = typeof tc.result_preview === 'string' ? tc.result_preview : null;
      const previewSuffix = resultPreview ? ` | ${resultPreview.slice(0, 200)}` : '';
      const note = `Tool ${toolName} failed: ${errorType} (exitCode: ${exitCode})${previewSuffix}`;
      evidence.push({
        sourceRef: `tool_call_failure:${String(tc.created_at ?? 'unknown')}`,
        note: sanitizeString(note.slice(0, MAX_EVIDENCE_NOTE_CHARS), workspaceDir),
      });
    }
  } catch {
    readFailed = true;
    // tool_calls table may not exist — degrade gracefully (only when no other evidence)
    if (evidence.length === 0) {
      evidence.push({
        sourceRef: 'tool_call_failure:unavailable',
        note: 'trajectory_tool_calls_unavailable',
      });
    }
  }

  // If no evidence at all from trajectory, provide a meaningful placeholder
  if (evidence.length === 0) {
    evidence.push({
      sourceRef: 'trajectory:empty',
      note: 'trajectory_available_but_empty: no user correction or assistant turns found',
    });
  }

  const bounded = evidence.slice(0, MAX_EVIDENCE_ENTRIES);
  const realEntryCount = bounded.reduce(
    (count, entry) => count + (PLACEHOLDER_SOURCE_REFS.has(entry.sourceRef) ? 0 : 1),
    0,
  );
  return { entries: bounded, realEntryCount, readFailed };
}

/**
 * PRI-642 Scope A typed acquisition from trajectory.db (SPEC §7.3).
 *
 * Validates that the requested session exists in the trajectory `sessions`
 * table (every recorded turn/tool call upserts its session row, so an absent
 * row means the session was never seen) and classifies the outcome:
 *  - `available`            — session bound, ≥1 real behavior-trace entry;
 *  - `session_not_found`    — session absent from the sessions table (or a
 *                             `cli`/`unknown` sentinel — never a real session);
 *  - `trajectory_unavailable` — no trajectory.db in this workspace;
 *  - `evidence_read_failed` — the DB exists but cannot be opened/read;
 *  - `empty_trajectory`     — real session, no usable evidence rows.
 */
export function acquireTrajectoryEvidenceFromDb(
  stateDir: string,
  sessionId: string | undefined,
  workspaceDir?: string,
): TrajectoryEvidenceAcquisition {
  if (!sessionId || sessionId === 'cli' || sessionId === 'unknown') {
    return {
      status: 'unavailable',
      reasonCode: 'session_not_found',
      detail: sessionId ? `sentinel_session_id:${sessionId}` : 'missing_session_id',
    };
  }

  const dbPath = path.join(stateDir, 'trajectory.db');
  if (!fs.existsSync(dbPath)) {
    return {
      status: 'unavailable',
      reasonCode: 'trajectory_unavailable',
      detail: 'trajectory_db_missing',
    };
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return {
      status: 'unavailable',
      reasonCode: 'evidence_read_failed',
      detail: `trajectory_db_unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    // Session existence: rows are upserted by every turn/tool-call write, so
    // an absent row means the trajectory never saw this session.
    let sessionExists = false;
    try {
      const row = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
      sessionExists = row !== undefined;
    } catch {
      // sessions table missing → cannot validate existence; fall through and
      // let the evidence rows decide (legacy DBs may lack the table).
      sessionExists = true;
    }
    if (!sessionExists) {
      return {
        status: 'unavailable',
        reasonCode: 'session_not_found',
        detail: 'session_not_present_in_trajectory',
      };
    }

    const collection = collectEvidenceFromDb(db, sessionId, workspaceDir);
    if (collection.realEntryCount > 0) {
      return { status: 'available', entries: collection.entries };
    }
    if (collection.readFailed) {
      return {
        status: 'unavailable',
        reasonCode: 'evidence_read_failed',
        detail: 'trajectory_tables_unreadable',
      };
    }
    return {
      status: 'unavailable',
      reasonCode: 'empty_trajectory',
      detail: 'session_present_but_no_usable_evidence',
    };
  } finally {
    db.close();
  }
}
