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
      // Enhanced: append truncation warning when stop_reason=length
      const truncationWarning = turn.stopReason === 'length' ? ' [TRUNCATED: output cut off by length limit]' : '';
      evidence.push({
        sourceRef: `agent_turn:${turn.createdAt}`,
        note: sanitizedNote + truncationWarning,
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

  // PRI-358: Extract failed tool_calls as evidence
  try {
    const allToolCalls = wctx.trajectory.listToolCallsForSession(sessionId) ?? [];
    const failedToolCalls = allToolCalls.filter(tc => tc.outcome === 'failure').slice(-3);
    for (const tc of failedToolCalls) {
      if (evidence.length >= MAX_EVIDENCE_ENTRIES) break;
      // Enhanced: append resultPreview when available
      const previewSuffix = tc.resultPreview ? ` | ${tc.resultPreview.slice(0, 200)}` : '';
      const note = `Tool ${tc.toolName} failed: ${tc.errorType ?? 'unknown'} (exitCode: ${tc.exitCode ?? 'N/A'})${previewSuffix}`;
      evidence.push({
        sourceRef: `tool_call_failure:${tc.createdAt}`,
        note: sanitizeAssistantText(note.slice(0, MAX_EVIDENCE_NOTE_CHARS)),
      });
    }
  } catch (e) {
    // Only add unavailable entry when no other evidence exists (avoid noise)
    if (evidence.length === 0) {
      evidence.push({
        sourceRef: 'tool_call_failure:unavailable',
        note: `trajectory_tool_calls_unavailable: ${String(e).slice(0, 100)}`,
      });
    }
  }

  if (evidence.length === 0) {
    evidence.push({
      sourceRef: 'trajectory:empty',
      note: 'trajectory_available_but_empty: no user correction or assistant turns found',
    });
  }

  return evidence.slice(0, MAX_EVIDENCE_ENTRIES);
}
