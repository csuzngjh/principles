/**
 * Trajectory Evidence Builder — PRI-326, PRI-642
 *
 * Extracted from pain.ts to avoid circular imports between
 * pain.ts and after-tool-call-helpers.ts.
 *
 * Pure data extraction — reads from trajectory DB, sanitizes, returns evidence entries.
 *
 * PRI-642 Scope A adds the typed acquisition API `acquireTrajectoryEvidence`
 * (discriminated available/unavailable, SPEC §7.2). The legacy array API
 * `buildTrajectoryEvidence` remains as a compatibility wrapper for automatic
 * emitters and MUST keep its exact sentinel shapes until Scope B migrates
 * those consumers (frozen decision #3).
 */

import { sanitizeAssistantText } from './message-sanitize.js';
import type { PainEvidenceEntry } from '@principles/core/runtime-v2';
import { MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_NOTE_CHARS } from '@principles/core/runtime-v2';
import type { WorkspaceContext } from '../core/workspace-context.js';

/**
 * PRI-642 (SPEC §7.2): discriminated acquisition result. `unavailable` carries
 * a distinct reasonCode so callers can degrade explicitly instead of counting
 * sentinel placeholder entries as trajectory evidence.
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
  'owner_message:unavailable',
  'agent_turn:unavailable',
  'tool_call_failure:unavailable',
  'trajectory:empty',
]);

interface TrajectoryEvidenceCollection {
  /** Exact entries the legacy array API returns. */
  entries: PainEvidenceEntry[];
  /** Count of entries that reference real behavior traces. */
  realEntryCount: number;
  /** True when any trajectory read threw. */
  readFailed: boolean;
  firstError: string | null;
}

function collectTrajectoryEvidence(
  wctx: WorkspaceContext,
  sessionId: string,
): TrajectoryEvidenceCollection {
  const evidence: PainEvidenceEntry[] = [];
  let readFailed = false;
  let firstError: string | null = null;

  const noteError = (e: unknown): void => {
    readFailed = true;
    if (firstError === null) firstError = String(e).slice(0, 100);
  };

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
    noteError(e);
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
    noteError(e);
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
    noteError(e);
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

  const bounded = evidence.slice(0, MAX_EVIDENCE_ENTRIES);
  const realEntryCount = bounded.reduce(
    (count, entry) => count + (PLACEHOLDER_SOURCE_REFS.has(entry.sourceRef) ? 0 : 1),
    0,
  );
  return { entries: bounded, realEntryCount, readFailed, firstError };
}

/**
 * PRI-642 Scope A typed acquisition — returns the discriminated
 * available/unavailable result. `available` requires at least one entry that
 * references a real behavior trace; sentinel placeholder entries never count
 * as available evidence.
 */
export function acquireTrajectoryEvidence(
  wctx: WorkspaceContext,
  sessionId: string,
): TrajectoryEvidenceAcquisition {
  if (!wctx.trajectory) {
    return { status: 'unavailable', reasonCode: 'trajectory_unavailable', detail: 'no_trajectory_db' };
  }
  if (!sessionId || sessionId === 'unknown') {
    return { status: 'unavailable', reasonCode: 'session_not_found', detail: sessionId ? 'unknown_session' : 'missing_session_id' };
  }

  const collection = collectTrajectoryEvidence(wctx, sessionId);
  if (collection.realEntryCount > 0) {
    return { status: 'available', entries: collection.entries };
  }
  if (collection.readFailed) {
    return {
      status: 'unavailable',
      reasonCode: 'evidence_read_failed',
      detail: collection.firstError ?? 'trajectory read failed',
    };
  }
  return {
    status: 'unavailable',
    reasonCode: 'empty_trajectory',
    detail: 'trajectory_available_but_empty: no user correction, assistant turns, or failed tool calls found',
  };
}

/**
 * Legacy array API (compatibility wrapper, PRI-642 frozen decision #3).
 * Automatic emitters still consume this shape; Scope B migrates them to the
 * typed API one family at a time before this wrapper may be removed.
 */
export function buildTrajectoryEvidence(wctx: WorkspaceContext, sessionId: string): PainEvidenceEntry[] {
  if (!wctx.trajectory || sessionId === 'unknown') {
    return [{
      sourceRef: 'owner_message:unavailable',
      note: `trajectory_unavailable: ${!wctx.trajectory ? 'no_trajectory_db' : 'unknown_session'}`,
    }];
  }

  return collectTrajectoryEvidence(wctx, sessionId).entries;
}
