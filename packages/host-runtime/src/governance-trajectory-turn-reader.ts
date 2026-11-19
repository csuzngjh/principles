/**
 * PRI-1265: a TrajectoryTurnReader over the workspace's governance observation
 * store (trajectory.db) — the SAME authorized store conversation ingestion
 * writes. OpenClaw's hook passes its own TrajectoryDatabase adapter; Codex /
 * WorkBuddy workers and the pd-cli diagnosis entries had NO reader at all, so
 * a bound session with stored turns still produced a context window without
 * the original text. This adapter closes that gap with one implementation the
 * CLI (`pd diagnose run`, `pd pain retry`), the Codex/WorkBuddy workers and
 * the host-runtime auto-run all inject.
 *
 * Read semantics (fail-open to [] — the assembler records the empty fallback
 * as an ambiguity note, rc-9):
 *   - user turns: `kind='user_turn'` rows with retained `visible_text`;
 *   - assistant turns: `kind='assistant_turn'` rows with retained text;
 *   - a session matches by `root_session_id` OR `rollout_identity` (Codex
 *     rollout uuid / WorkBuddy sessionId), so either spelling of the same
 *     session resolves;
 *   - expired/quarantined rows are excluded naturally: retention NULLed their
 *     text at write time (PRI-1179), so nothing new is re-derived here.
 */
import type {
  TrajectoryAssistantTurn,
  TrajectoryTurnReader,
  TrajectoryUserTurn,
} from '@principles/core/runtime';
import { listGovernanceTurnTexts, type GovernanceTurnTextRow } from './governance-observation-store.js';

/** Bound on turns per list call — the assembler bounds the window again. */
const MAX_TURNS_PER_SESSION = 200;

function readTurnRows(
  workspaceDir: string,
  kind: 'user_turn' | 'assistant_turn',
  sessionId: string,
): readonly GovernanceTurnTextRow[] {
  if (sessionId.trim().length === 0) return [];
  const result = listGovernanceTurnTexts({
    workspaceDir,
    kind,
    sessionId,
    limit: MAX_TURNS_PER_SESSION,
  });
  // Unreadable store: the empty result surfaces as an assembler ambiguity
  // note ("no turns found"), never as a fabricated window.
  return result.ok ? result.turns : [];
}

/**
 * Build the governance-observation-backed turn reader for a workspace. The
 * returned object is cheap to construct per invocation; each list call opens
 * the store read (no cached handle across worker cycles, so a replaced
 * database mid-run can never serve stale turns).
 */
export function createGovernanceTrajectoryTurnReader(args: { readonly workspaceDir: string }): TrajectoryTurnReader {
  return {
    listUserTurnsForSession(sessionId: string): TrajectoryUserTurn[] {
      return readTurnRows(args.workspaceDir, 'user_turn', sessionId).map((row, index) => ({
        id: row.id,
        turnIndex: row.sourceOrdinal >= 0 ? row.sourceOrdinal : index,
        rawExcerpt: row.visibleText,
        correctionDetected: false,
        correctionCue: null,
        createdAt: row.observedAt,
      }));
    },
    listAssistantTurns(sessionId: string): TrajectoryAssistantTurn[] {
      return readTurnRows(args.workspaceDir, 'assistant_turn', sessionId).map((row) => ({
        id: row.id,
        sessionId,
        runId: '',
        provider: '',
        model: '',
        sanitizedText: row.visibleText,
        createdAt: row.observedAt,
      }));
    },
  };
}
