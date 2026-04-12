/**
 * Nocturnal Trajectory Extractor — Structured Session Snapshot API
 * ==============================================================
 *
 * PURPOSE: Provide minimal necessary structured trajectory extraction
 * for the nocturnal reflection pipeline. NOT a general-purpose data mirror.
 *
 * DESIGN PRINCIPLES:
 * - Uses sanitized text ONLY — never raw_text or blob payloads
 * - Two distinct query paths:
 *     1. Analytics query (listRecentNocturnalCandidateSessions) — for target selection
 *     2. Runtime query (getNocturnalSessionSnapshot) — for sample generation
 * - All snapshots are self-contained and principle-relevant metadata-rich
 *
 * WHAT THIS MODULE DOES:
 * - List recent sessions with metadata relevant to nocturnal target selection
 * - Extract structured session snapshots for a selected violating session
 *
 * WHAT THIS MODULE DOES NOT DO:
 * - NO snapshot database cloning
 * - NO full trajectory export
 * - NO raw text exposure
 * - NO target selection logic
 * - NO sample generation
 *
 * ARTIFACT OUTPUTS go to:
 *   .state/nocturnal/samples/    ← structured JSON artifacts
 *
 * FILE: {stateDir}/nocturnal/snapshots/  (cached snapshots if needed, optional)
 */

import type { TrajectoryDatabase} from './trajectory.js';
import { TrajectoryRegistry } from './trajectory.js';
import { detectThinkingModelMatches, listThinkingModels } from './thinking-models.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal sanitized assistant turn for nocturnal snapshot.
 * Contains ONLY sanitizedText — raw_text is never exposed.
 */
export interface NocturnalAssistantTurn {
  turnIndex: number;
  sanitizedText: string;
  model: string;
  createdAt: string;
}

/**
 * Minimal sanitized user turn for nocturnal snapshot.
 * Contains only derived cues — NO raw user text.
 */
export interface NocturnalUserTurn {
  turnIndex: number;
  correctionDetected: boolean;
  correctionCue: string | null;
  createdAt: string;
}

/**
 * Tool call event for nocturnal snapshot.
 */
export interface NocturnalToolCall {
  toolName: string;
  outcome: 'success' | 'failure' | 'blocked';
  filePath: string | null;
  durationMs: number | null;
  exitCode: number | null;
  errorType: string | null;
  errorMessage: string | null;
  createdAt: string;
}

/**
 * Pain signal for nocturnal snapshot.
 */
export interface NocturnalPainEvent {
  source: string;
  score: number;
  severity: string | null;
  reason: string | null;
  createdAt: string;
}

/**
 * Gate block event for nocturnal snapshot.
 */
export interface NocturnalGateBlock {
  toolName: string;
  filePath: string | null;
  reason: string;
  planStatus: string | null;
  createdAt: string;
}

/**
 * A structured nocturnal session snapshot.
 * Contains all information needed for a reflector to generate decision-point samples.
 *
 * GUARANTEES:
 * - NO raw_text exposed
 * - NO blob references resolved
 * - All text is sanitized or derived-cue only
 * - Self-contained (principle-relevant metadata included)
 */
export interface NocturnalSessionSnapshot {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  assistantTurns: NocturnalAssistantTurn[];
  userTurns: NocturnalUserTurn[];
  toolCalls: NocturnalToolCall[];
  painEvents: NocturnalPainEvent[];
  gateBlocks: NocturnalGateBlock[];
  /**
  * Summary statistics for quick triage.
  * Stats are always numeric — fallback snapshots use 0 as default when
  * trajectory data is unavailable, or real counts when the session summary
  * can be retrieved from the trajectory DB.
  */
  stats: {
    totalAssistantTurns: number;
    totalToolCalls: number;
    totalPainEvents: number;
    totalGateBlocks: number;
    failureCount: number;
  };
  /**
   * #219: Marker for data source to identify fallback/partial stats.
   * - 'pain_context_fallback': Stats derived from pain context only (trajectory extractor failed)
   */
  _dataSource?: 'pain_context_fallback';
}

/**
 * Summary entry for session listing (used by nocturnal target selector).
 * Lightweight — only identification and basic metadata, no turns.
 */
export interface NocturnalSessionSummary {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  /** Number of assistant turns (for relevance scoring) */
  assistantTurnCount: number;
  /** Number of tool calls (for violation signal density) */
  toolCallCount: number;
  /** Number of pain events (for pain signal density) */
  painEventCount: number;
  /** Number of gate blocks (for constraint violation evidence) */
  gateBlockCount: number;
  /** Number of failed tool calls (for violation signal) */
  failureCount: number;
}

/**
 * Options for listing recent nocturnal candidate sessions.
 */
export interface ListNocturnalSessionsOptions {
  /** Maximum number of sessions to return (default: 20) */
  limit?: number;
  /** Only return sessions updated after this date */
  dateFrom?: string;
  /** Only return sessions updated before this date */
  dateTo?: string;
  /** Minimum tool call count threshold (default: 1) */
  minToolCalls?: number;
}

// ---------------------------------------------------------------------------
// Core Extractor
// ---------------------------------------------------------------------------

/**
 * Nocturnal Trajectory Extractor.
 *
 * Provides sanitized, structured access to session data for the nocturnal
 * reflection pipeline. All queries return sanitized text only.
 *
 * This class is a thin, focused wrapper around TrajectoryDatabase.
 * It does NOT cache snapshots or maintain its own state.
 */
export class NocturnalTrajectoryExtractor {
  private readonly trajectory: TrajectoryDatabase;

  constructor(trajectory: TrajectoryDatabase) {
    this.trajectory = trajectory;
  }

  /**
   * List recent sessions suitable for nocturnal target selection.
   *
   * ANALYTICS QUERY — used by nocturnal target selector to find candidate sessions.
   *
   * @param options - Query options
   * @returns Lightweight session summaries ordered by most recently updated
   */
  listRecentNocturnalCandidateSessions(
    options: ListNocturnalSessionsOptions = {}
  ): NocturnalSessionSummary[] {
    const limit = options.limit ?? 20;
    const minToolCalls = options.minToolCalls ?? 1;

    // Get recent sessions from trajectory DB
    const sessions = this.trajectory.listRecentSessions({
      limit: limit * 3, // Over-fetch to allow filtering
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
    });

    if (sessions.length === 0) {
      return [];
    }

    // For each session, get counts
    // We batch these by fetching tool_calls count per session
    const summaries: NocturnalSessionSummary[] = [];

    for (const session of sessions) {
      if (summaries.length >= limit) break;

      const toolCalls = this.trajectory.listToolCallsForSession(session.sessionId);
      const painEvents = this.trajectory.listPainEventsForSession(session.sessionId);
      const gateBlocks = this.trajectory.listGateBlocksForSession(session.sessionId);

      // Filter by minimum tool calls threshold
      if (toolCalls.length < minToolCalls) {
        continue;
      }

      const failureCount = toolCalls.filter((tc) => tc.outcome === 'failure').length;

      summaries.push({
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        assistantTurnCount: 0, // Not readily available without extra query
        toolCallCount: toolCalls.length,
        painEventCount: painEvents.length,
        gateBlockCount: gateBlocks.length,
        failureCount,
      });
    }

    return summaries;
  }

  /**
   * Get a full structured snapshot for a specific session.
   *
   * RUNTIME QUERY — used by nocturnal service after target selection.
   *
   * SECURITY GUARANTEES:
   * - Only sanitizedText from assistant turns (never raw_text)
   * - Only correction cues from user turns (never raw user text)
   * - Tool calls with outcome and error info (no raw parameters)
   * - Pain events with score and reason (no raw event data)
   * - Gate blocks with tool/reason info (no file content)
   *
   * @param sessionId - Session ID to snapshot
   * @returns Full structured snapshot, or null if session not found
   */
  getNocturnalSessionSnapshot(sessionId: string): NocturnalSessionSnapshot | null {
    // Verify session exists — must use a large enough limit to cover all candidates,
    // not just the single most-recent session (which would cause false negatives when
    // the selector targets an older session).
    const sessions = this.trajectory.listRecentSessions({ limit: 1000 });
    const sessionExists = sessions.some((s) => s.sessionId === sessionId);
    if (!sessionExists) {
      // Session might not be in trajectory DB — try to get basic info
      // If no data at all, return null for fail-safe
      return null;
    }

    // Fetch all turn data
    const assistantTurns = this.trajectory.listAssistantTurns(sessionId);
    const userTurns = this.trajectory.listUserTurnsForSession(sessionId);
    const toolCalls = this.trajectory.listToolCallsForSession(sessionId);
    const painEvents = this.trajectory.listPainEventsForSession(sessionId);
    const gateBlocks = this.trajectory.listGateBlocksForSession(sessionId);

    // Map to sanitized structures
    // SECURITY: Only sanitizedText from assistant turns
    const sanitizedAssistantTurns: NocturnalAssistantTurn[] = assistantTurns.map(
      (turn, index) => ({
        turnIndex: index,
        sanitizedText: turn.sanitizedText,
        model: turn.model,
        createdAt: turn.createdAt,
      })
    );

    // SECURITY: Only derived cues from user turns
    const sanitizedUserTurns: NocturnalUserTurn[] = userTurns.map((turn) => ({
      turnIndex: turn.turnIndex,
      correctionDetected: turn.correctionDetected,
      correctionCue: turn.correctionCue,
      createdAt: turn.createdAt,
    }));

    // Tool calls — include outcome and error info but not raw params
    const nocturnalToolCalls: NocturnalToolCall[] = toolCalls.map((tc) => ({
      toolName: tc.toolName,
      outcome: tc.outcome as 'success' | 'failure' | 'blocked',
      filePath: tc.filePath,
      durationMs: tc.durationMs,
      exitCode: tc.exitCode,
      errorType: tc.errorType,
      errorMessage: tc.errorMessage,
      createdAt: tc.createdAt,
    }));

    // Pain events — score and reason only
    const nocturnalPainEvents: NocturnalPainEvent[] = painEvents.map((pe) => ({
      source: pe.source,
      score: pe.score,
      severity: pe.severity,
      reason: pe.reason,
      createdAt: pe.createdAt,
    }));

    // Gate blocks — tool and reason only
    const nocturnalGateBlocks: NocturnalGateBlock[] = gateBlocks.map((gb) => ({
      toolName: gb.toolName,
      filePath: gb.filePath,
      reason: gb.reason,
      planStatus: gb.planStatus,
      createdAt: gb.createdAt,
    }));

    // Compute summary stats
    const failureCount = toolCalls.filter((tc) => tc.outcome === 'failure').length;

    // Get session metadata (use trajectory data)
    const sessionMeta = sessions.find((s) => s.sessionId === sessionId);

    return {
      sessionId,
      startedAt: sessionMeta?.startedAt ?? new Date(0).toISOString(),
      updatedAt: sessionMeta?.updatedAt ?? new Date(0).toISOString(),
      assistantTurns: sanitizedAssistantTurns,
      userTurns: sanitizedUserTurns,
      toolCalls: nocturnalToolCalls,
      painEvents: nocturnalPainEvents,
      gateBlocks: nocturnalGateBlocks,
      stats: {
        totalAssistantTurns: sanitizedAssistantTurns.length,
        totalToolCalls: nocturnalToolCalls.length,
        totalPainEvents: nocturnalPainEvents.length,
        totalGateBlocks: nocturnalGateBlocks.length,
        failureCount,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a NocturnalTrajectoryExtractor from a workspace directory.
 *
 * USAGE:
 *   const extractor = createNocturnalTrajectoryExtractor(workspaceDir);
 *   const sessions = extractor.listRecentNocturnalCandidateSessions({ limit: 10 });
 *   const snapshot = extractor.getNocturnalSessionSnapshot(sessionId);
 */
 
export function createNocturnalTrajectoryExtractor(
  workspaceDir: string,
  _stateDir?: string
): NocturnalTrajectoryExtractor {
  // Use the registry to get or create the TrajectoryDatabase instance
  const trajectory = TrajectoryRegistry.get(workspaceDir);
  return new NocturnalTrajectoryExtractor(trajectory);
}

// ---------------------------------------------------------------------------
// Direct module helpers (for cases where you already have TrajectoryDatabase)
// ---------------------------------------------------------------------------

/**
 * List recent sessions for nocturnal target selection.
 * Convenience wrapper around NocturnalTrajectoryExtractor.
 */
export function listNocturnalCandidateSessions(
  trajectory: TrajectoryDatabase,
  options: ListNocturnalSessionsOptions = {}
): NocturnalSessionSummary[] {
  return new NocturnalTrajectoryExtractor(trajectory).listRecentNocturnalCandidateSessions(options);
}

/**
 * Get a session snapshot for nocturnal reflection.
 * Convenience wrapper around NocturnalTrajectoryExtractor.
 */
export function getNocturnalSessionSnapshot(
  trajectory: TrajectoryDatabase,
  sessionId: string
): NocturnalSessionSnapshot | null {
  return new NocturnalTrajectoryExtractor(trajectory).getNocturnalSessionSnapshot(sessionId);
}

// ---------------------------------------------------------------------------
// Reflection Quality Metrics
// ---------------------------------------------------------------------------

/**
 * Compute thinking model activation for a text.
 * Returns 0-1 ratio of matched thinking models to total available models.
 *
 * @param text - Text to analyze
 * @returns Activation ratio (0-1)
 */
export function computeThinkingModelActivation(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  const matches = detectThinkingModelMatches(text);
  const totalModels = listThinkingModels().length;
  return Math.round((matches.length / totalModels) * 100) / 100;
}

/**
 * Compute planning ratio from a session snapshot.
 * Planning ratio = write operations preceded immediately by a read tool / total write operations.
 * A higher ratio indicates more careful planning behavior (reading before writing).
 *
 * Only the immediately preceding tool is checked — each write needs its own
 * preceding read to count as planned. This prevents a single read from satisfying
 * multiple writes in sequence.
 *
 * @param snapshot - Session snapshot to analyze
 * @returns Planning ratio (0-1), or 0 if no write operations
 */
export function computePlanningRatio(snapshot: NocturnalSessionSnapshot): number {
  const {toolCalls} = snapshot;

  let totalWrites = 0;
  let writesWithPrecedingRead = 0;

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const isWriteTool = /^(edit|write|create|delete|remove|move|rename)/i.test(tc.toolName);

    if (isWriteTool) {
      totalWrites++;
      // Check only the immediately preceding tool
      if (i > 0) {
        const prevTc = toolCalls[i - 1];
        const isReadTool = /^(read|grep|search|find|inspect|look)/i.test(prevTc.toolName);
        if (isReadTool) {
          writesWithPrecedingRead++;
        }
      }
    }
  }

  if (totalWrites === 0) return 0;
  return Math.round((writesWithPrecedingRead / totalWrites) * 100) / 100;
}

/**
 * Compute thinking model delta between original and improved decisions.
 * Positive delta means the improved decision uses more thinking models.
 *
 * @param originalText - Original (bad) decision text
 * @param improvedText - Improved (better) decision text
 * @returns Delta in thinking model activation (-1 to 1)
 */
export function computeThinkingModelDelta(originalText: string, improvedText: string): number {
  const originalActivation = computeThinkingModelActivation(originalText);
  const improvedActivation = computeThinkingModelActivation(improvedText);
  const delta = improvedActivation - originalActivation;
  return Math.round(delta * 100) / 100;
}

/**
 * Compute planning ratio gain between original and improved snapshots.
 * Positive gain means the improved behavior has better planning (more reads before writes).
 *
 * @param originalSnapshot - Original session snapshot
 * @param improvedSnapshot - Improved session snapshot
 * @returns Planning ratio gain (-1 to 1)
 */
export function computePlanningRatioGain(
  originalSnapshot: NocturnalSessionSnapshot,
  improvedSnapshot: NocturnalSessionSnapshot
): number {
  const originalRatio = computePlanningRatio(originalSnapshot);
  const improvedRatio = computePlanningRatio(improvedSnapshot);
  const gain = improvedRatio - originalRatio;
  return Math.round(gain * 100) / 100;
}
