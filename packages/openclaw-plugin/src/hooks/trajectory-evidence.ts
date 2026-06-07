/**
 * Trajectory Evidence Builder — PRI-326
 *
 * Extracted from pain.ts to avoid circular imports between
 * pain.ts and after-tool-call-helpers.ts.
 *
 * Pure data extraction — reads from trajectory DB, sanitizes, returns evidence entries.
 */

import { sanitizeAssistantText } from './message-sanitize.js';
import type { PainEvidenceEntry } from '@principles/core/runtime-v2';
import { MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_NOTE_CHARS } from '@principles/core/runtime-v2';
import type { WorkspaceContext } from '../core/workspace-context.js';

export function buildTrajectoryEvidence(wctx: WorkspaceContext, sessionId: string): PainEvidenceEntry[] {
  const evidence: PainEvidenceEntry[] = [];

  if (!wctx.trajectory || sessionId === 'unknown') {
    evidence.push({
      sourceRef: 'owner_message:unavailable',
      note: `trajectory_unavailable: ${!wctx.trajectory ? 'no_trajectory_db' : 'unknown_session'}`,
    });
    return evidence.slice(0, MAX_EVIDENCE_ENTRIES);
  }

  try {
    const userTurns = wctx.trajectory.listUserTurnsForSession(sessionId) ?? [];
    const lastCorrectionTurn = [...userTurns].reverse().find(t => t.correctionDetected);
    if (lastCorrectionTurn) {
      const sanitizedOwnerMessage = sanitizeAssistantText(
        (lastCorrectionTurn.rawExcerpt ?? '').slice(0, MAX_EVIDENCE_NOTE_CHARS)
      );
      evidence.push({
        sourceRef: `owner_message:${lastCorrectionTurn.createdAt}`,
        note: sanitizedOwnerMessage,
      });
    }
  } catch (e) {
    evidence.push({
      sourceRef: 'owner_message:unavailable',
      note: `trajectory_user_turns_unavailable: ${String(e).slice(0, 100)}`,
    });
  }

  try {
    const assistantTurns = wctx.trajectory.listAssistantTurns(sessionId) ?? [];
    const recentAssistant = assistantTurns.slice(-3);
    for (const turn of recentAssistant) {
      if (evidence.length >= MAX_EVIDENCE_ENTRIES) break;
      const sanitizedNote = sanitizeAssistantText(
        (turn.sanitizedText ?? '').slice(0, MAX_EVIDENCE_NOTE_CHARS)
      );
      evidence.push({
        sourceRef: `agent_turn:${turn.createdAt}`,
        note: sanitizedNote,
      });
    }
  } catch (e) {
    if (evidence.length < MAX_EVIDENCE_ENTRIES) {
      evidence.push({
        sourceRef: 'agent_turn:unavailable',
        note: `trajectory_assistant_turns_unavailable: ${String(e).slice(0, 100)}`,
      });
    }
  }

  return evidence.slice(0, MAX_EVIDENCE_ENTRIES);
}
