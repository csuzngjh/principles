/**
 * Interface for reading trajectory turns from a session.
 *
 * Implemented by TrajectoryDatabase in openclaw-plugin; injected into
 * SqliteContextAssembler for conversationWindow fallback (PRI-350).
 *
 * When HistoryQuery returns empty entries but a sessionIdHint is available,
 * the assembler reads turns from the trajectory database to populate
 * conversationWindow instead of leaving it empty.
 */

export interface TrajectoryUserTurn {
  id: number;
  turnIndex: number;
  rawExcerpt: string;
  correctionDetected: boolean;
  correctionCue: string | null;
  createdAt: string;
}

export interface TrajectoryAssistantTurn {
  id: number;
  sessionId: string;
  runId: string;
  provider: string;
  model: string;
  sanitizedText: string;
  createdAt: string;
}

export interface TrajectoryTurnReader {
  listUserTurnsForSession(sessionId: string): TrajectoryUserTurn[];
  listAssistantTurns(sessionId: string): TrajectoryAssistantTurn[];
}
