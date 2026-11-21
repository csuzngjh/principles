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
  /**
   * PRI-1274 (B1 / P1-3): EXACT (host, session, host turn id) read for
   * submissions that named a target turn. Optional — readers over stores
   * without host turn ids may omit it. When the diagnosis knows a target
   * turn, the assembler uses ONLY this method: the session's other turns
   * must never substitute the named one, so an absent/empty result stays
   * absent (with an ambiguity note), never a session-wide fallback. The
   * host kind keeps another host's identically-named session+turn out.
   */
  listTurnTextsForHostTurnId?(
    sessionId: string,
    hostTurnId: string,
    hostKind?: 'openclaw' | 'codex' | 'workbuddy',
  ): {
    readonly userTurns: readonly TrajectoryUserTurn[];
    readonly assistantTurns: readonly TrajectoryAssistantTurn[];
  };
}
