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
 *
 * PRI-1283 R2: every list call resolves the LATEST conversation-ingestion
 * consent per governance host and excludes unauthorized hosts AT THE QUERY
 * BOUNDARY — a revoked host's turns are never read into the window. When no
 * port is wired the reader denies all governance hosts (fail-closed): serving
 * consent-gated conversation text without an authorization check is the exact
 * R2 gap. Fail-open-to-[] still applies to STORE failures only.
 */
import type {
  TrajectoryAssistantTurn,
  TrajectoryTurnReader,
  TrajectoryUserTurn,
} from '@principles/core/runtime';
import {
  denyAllSourceMaterialAuthorization,
  type SourceMaterialAuthorizationPort,
  type SourceMaterialHostKind,
} from '@principles/core/runtime';
import { listGovernanceObservations, listGovernanceTurnTexts, type GovernanceTurnTextRow } from './governance-observation-store.js';

/** Bound on turns per list call — the assembler bounds the window again. */
const MAX_TURNS_PER_SESSION = 200;

/** The governance-observation hosts whose turns this reader can serve. */
const GOVERNANCE_TURN_HOSTS: readonly SourceMaterialHostKind[] = ['codex', 'workbuddy'];

export interface GovernanceTrajectoryTurnReaderArgs {
  readonly workspaceDir: string;
  /**
   * PRI-1283 R2: latest-consent gate, consulted PER list call. Composition
   * roots inject `createConsentLedgerSourceMaterialAuthorization(workspaceDir)`.
   */
  readonly sourceMaterialAuthorization?: SourceMaterialAuthorizationPort;
}

function readTurnRows(
  workspaceDir: string,
  kind: 'user_turn' | 'assistant_turn',
  query: { sessionId: string; port: SourceMaterialAuthorizationPort },
): readonly GovernanceTurnTextRow[] {
  const { sessionId, port } = query;
  if (sessionId.trim().length === 0) return [];
  const authorizedHostKinds = GOVERNANCE_TURN_HOSTS.filter(
    (host) => port.isHostSourceMaterialAuthorized(host).authorized,
  );
  const result = listGovernanceTurnTexts({
    workspaceDir,
    kind,
    sessionId,
    authorizedHostKinds,
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
 * database mid-run can never serve stale turns) and re-resolves the consent
 * state (no cached authorization, so a mid-run revocation takes effect on the
 * next call).
 */
export function createGovernanceTrajectoryTurnReader(args: GovernanceTrajectoryTurnReaderArgs): TrajectoryTurnReader {
  const port = args.sourceMaterialAuthorization ?? denyAllSourceMaterialAuthorization;
  return {
    listUserTurnsForSession(sessionId: string): TrajectoryUserTurn[] {
      return readTurnRows(args.workspaceDir, 'user_turn', { sessionId, port }).map((row, index) => ({
        id: row.id,
        turnIndex: row.sourceOrdinal >= 0 ? row.sourceOrdinal : index,
        rawExcerpt: row.visibleText,
        correctionDetected: false,
        correctionCue: null,
        createdAt: row.observedAt,
      }));
    },
    listAssistantTurns(sessionId: string): TrajectoryAssistantTurn[] {
      return readTurnRows(args.workspaceDir, 'assistant_turn', { sessionId, port }).map((row) => ({
        id: row.id,
        sessionId,
        runId: '',
        provider: '',
        model: '',
        sanitizedText: row.visibleText,
        createdAt: row.observedAt,
      }));
    },
    /**
     * PRI-1274 (B1 / P1-3): exact (host, session, host turn id) read over the
     * same authorized governance store. `hostKind` keeps another host's
     * identically-named session+turn out of the window (the cross-host
     * isolation class PRI-1247 closes); retained-text filtering mirrors the
     * session-level reads (expired/quarantined rows carry NULL text).
     * Unreadable store ⇒ empty result — the assembler turns that into an
     * ambiguity note, never a session-wide substitution.
     */
    listTurnTextsForHostTurnId(
      sessionId: string,
      hostTurnId: string,
      hostKind?: 'openclaw' | 'codex' | 'workbuddy',
    ): { readonly userTurns: readonly TrajectoryUserTurn[]; readonly assistantTurns: readonly TrajectoryAssistantTurn[] } {
      if (sessionId.trim().length === 0 || hostTurnId.trim().length === 0) {
        return { userTurns: [], assistantTurns: [] };
      }
      // Exact-turn reads are a separate entry point from the session-level
      // list methods above. Require an explicit supported host and consult
      // the latest consent decision on EVERY call before opening the store.
      // An omitted/unsupported host must never become an unscoped read.
      const authorizedHostKind = GOVERNANCE_TURN_HOSTS.find((candidate) => candidate === hostKind);
      if (authorizedHostKind === undefined
        || !port.isHostSourceMaterialAuthorized(authorizedHostKind).authorized) {
        return { userTurns: [], assistantTurns: [] };
      }
      const result = listGovernanceObservations({
        workspaceDir: args.workspaceDir,
        rolloutIdentity: sessionId,
        hostKind: authorizedHostKind,
        hostTurnId,
        limit: 64,
      });
      if (!result.ok) return { userTurns: [], assistantTurns: [] };
      const retainedText = (row: (typeof result.observations)[number]): string | null =>
        (row.retentionClass === 'operational' || row.retentionClass === 'promoted')
        && typeof row.visibleText === 'string'
        && row.visibleText.trim() !== ''
          ? row.visibleText
          : null;
      const userRows = result.observations.filter((row) => row.kind === 'user_turn');
      return {
        userTurns: userRows.flatMap((row, index) => {
          const text = retainedText(row);
          return text === null ? [] : [{
            id: row.id,
            turnIndex: row.sourceOrdinal !== null && row.sourceOrdinal >= 0 ? row.sourceOrdinal : index,
            rawExcerpt: text,
            correctionDetected: false,
            correctionCue: null,
            createdAt: row.observedAt,
          }];
        }),
        assistantTurns: result.observations.filter((row) => row.kind === 'assistant_turn').flatMap((row) => {
          const text = retainedText(row);
          return text === null ? [] : [{
            id: row.id,
            sessionId,
            runId: '',
            provider: '',
            model: '',
            sanitizedText: text,
            createdAt: row.observedAt,
          }];
        }),
      };
    },
  };
}
