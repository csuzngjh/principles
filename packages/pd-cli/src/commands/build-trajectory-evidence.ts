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
 * Build trajectory evidence entries by reading trajectory.db directly.
 *
 * @param stateDir   - The .state directory containing trajectory.db
 * @param sessionId  - The session ID to query turns for
 * @param workspaceDir - Workspace directory for path redaction (sanitizeString)
 * @returns Array of PainEvidenceEntry (never empty; degraded entries on failure)
 */
export function buildTrajectoryEvidenceFromDb(
  stateDir: string,
  sessionId: string | undefined,
  workspaceDir?: string,
): PainEvidenceEntry[] {
  const evidence: PainEvidenceEntry[] = [];

  // No session or empty → placeholder entry (ERR-002: never return empty array silently)
  if (!sessionId || sessionId === 'cli' || sessionId === 'unknown') {
    evidence.push({
      sourceRef: 'owner_reported:cli',
      note: 'No session context available',
    });
    return evidence;
  }

  const dbPath = path.join(stateDir, 'trajectory.db');
  if (!fs.existsSync(dbPath)) {
    evidence.push({
      sourceRef: 'owner_reported:cli',
      note: 'No session context available',
    });
    return evidence;
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    evidence.push({
      sourceRef: 'owner_reported:cli',
      note: 'No session context available',
    });
    return evidence;
  }

  try {
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
        SELECT id, sanitized_text, created_at
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
        evidence.push({
          sourceRef: `agent_turn:${String(turn.created_at ?? 'unknown')}`,
          note: sanitizedNote,
        });
      }
    } catch {
      // assistant_turns table may not exist — degrade gracefully
      if (evidence.length < MAX_EVIDENCE_ENTRIES) {
        evidence.push({
          sourceRef: 'agent_turn:unavailable',
          note: 'trajectory_assistant_turns_unavailable',
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

    return evidence.slice(0, MAX_EVIDENCE_ENTRIES);
  } finally {
    db.close();
  }
}
