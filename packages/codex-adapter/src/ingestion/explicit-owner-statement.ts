/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-07 — the explicit Owner pain-report entry
 * for Codex: the user types `PD记录痛苦：<反馈原文>` as the CURRENT message
 * and this deterministic prefix parse turns exactly that text into one
 * canonical pain signal through the existing governance admission +
 * diagnostician-task continuation seams.
 *
 * Contract (SPEC §6.4):
 *   - ONLY an exact prefix match at the start of the CURRENT user prompt
 *     counts. Quoted text, tool output, model prose and ordinary corrections
 *     never trigger it (A17).
 *   - The statement is bounded at 500 chars (rejection, not truncation).
 *   - Identity comes from THIS hook payload's verified session/turn ids plus
 *     the transcript-path-derived rollout identity — the model never guesses
 *     ids and no other file is scanned.
 *   - The same logical observation key as the generic correction path
 *     (`codex|<rollout>|<turn>|user`) means explicit and generic detection of
 *     one turn converge on ONE canonical pain (unique marker dedup).
 *   - No LLM runs here: admission + durable enqueue only, well inside the
 *     5s hook budget; the receipt carries painId/taskId.
 */
import {
  admitGovernanceSignals,
  ensureGovernanceDiagnosticianTask,
  promoteAdmittedGovernanceEvidence,
  type GovernanceSignalCandidate,
} from '@principles/host-runtime';
import { resolveCodexHome } from './codex-home.js';
import { validateCodexTranscriptPath } from './transcript-path.js';
import { extractFields } from './ingestion-fields.js';

export { OWNER_STATEMENT_PREFIX as CODEX_OWNER_STATEMENT_PREFIX, MAX_OWNER_STATEMENT_CHARS, parseOwnerStatementPrefix, type OwnerStatementPrefixParse } from '@principles/host-runtime';

export type RecordOwnerStatementResult =
  | {
    status: 'received';
    painId: string;
    taskId: string;
    disposition: 'admitted' | 'already_admitted';
    logicalObservationKey: string;
    /**
     * SPEC §6.4.5: the durable task is what the receipt guarantees; evidence
     * promotion may degrade (e.g. conversation ingestion off — no ingested
     * rollout to promote from). The receipt discloses it instead of failing.
     */
    promotionDegraded?: string;
  }
  | {
    status: 'rejected';
    reason: 'statement_empty' | 'statement_too_long' | 'transcript_unavailable' | 'lineage_invalid' | 'rate_limited' | 'continuation_failed';
    nextAction: string;
  };

/**
 * Persist one explicit Owner statement. The consent-gated conversation
 * ingestion flag does NOT gate this path (no conversation tables or transcript
 * CONTENT are read — only the path is validated for the rollout identity),
 * mirroring SPEC §6.4 rule 3.
 */
export async function recordExplicitOwnerStatement(args: {
  rawPayload: unknown;
  workspaceDir: string;
  statementText: string;
  env?: { CODEX_HOME?: string | undefined };
  /**
   * Audit provenance: omitted = the native hook-read `PD记录痛苦：` prefix
   * entry; 'codex_explicit_agent' = the agent-assisted no-prefix bridge
   * (turn-context.ts). Admission semantics are identical either way.
   */
  explicitChannel?: 'codex_explicit_agent';
}): Promise<RecordOwnerStatementResult> {
  const fields = extractFields(args.rawPayload);
  if (fields === null || fields.sessionId.length === 0 || fields.turnId === null) {
    return { status: 'rejected', reason: 'lineage_invalid', nextAction: 'The hook payload lacks the session/turn identity this explicit submission requires; nothing was recorded.' };
  }
  if (fields.transcriptPath === null) {
    return { status: 'rejected', reason: 'transcript_unavailable', nextAction: 'Codex supplied no transcript path for this event; the explicit statement was NOT recorded — resubmit it in a new message.' };
  }
  const home = resolveCodexHome(args.env);
  if (!home.ok) {
    return { status: 'rejected', reason: 'transcript_unavailable', nextAction: `${home.reason}: ${home.nextAction}`.slice(0, 400) };
  }
  const validated = validateCodexTranscriptPath(fields.transcriptPath, home.home);
  if (!validated.ok) {
    return { status: 'rejected', reason: 'lineage_invalid', nextAction: `${validated.reason}: ${validated.nextAction}`.slice(0, 400) };
  }

  const candidate: GovernanceSignalCandidate = {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: `codex|${validated.rolloutIdentity}|${fields.turnId}|user`,
    rolloutIdentity: validated.rolloutIdentity,
    rootSessionId: fields.sessionId,
    hostTurnId: fields.turnId,
    text: args.statementText,
    observedAt: new Date().toISOString(),
    explicitOwnerStatement: true,
    ...(args.explicitChannel !== undefined ? { explicitChannel: args.explicitChannel } : {}),
  };

  const admitted = admitGovernanceSignals({ workspaceDir: args.workspaceDir, candidates: [candidate] });
  if (!admitted.ok) {
    return { status: 'rejected', reason: 'continuation_failed', nextAction: `${admitted.reason}: ${admitted.nextAction}`.slice(0, 400) };
  }
  const [outcome] = admitted.outcomes;
  if (outcome === undefined || !('disposition' in outcome)) {
    return { status: 'rejected', reason: 'continuation_failed', nextAction: 'The governance admission returned no disposition; nothing was recorded.' };
  }
  if (outcome.disposition === 'not_a_signal' || outcome.disposition === 'not_admitted') {
    return { status: 'rejected', reason: 'continuation_failed', nextAction: 'reason' in outcome ? String(outcome.reason) : 'the signal was not admitted' };
  }
  if (outcome.disposition === 'rate_limited') {
    return { status: 'rejected', reason: 'rate_limited', nextAction: 'The per-root-session correction quota (5/hour) is exhausted; resubmit later — the statement was NOT recorded.' };
  }

  // Task ensure is the receipt's hard guarantee; evidence promotion is
  // best-effort (SPEC §6.4.5 — a degraded promotion is disclosed, never a
  // failed receipt: the pain + task are durably recorded).
  const ensured = await ensureGovernanceDiagnosticianTask({
    workspaceDir: args.workspaceDir,
    logicalObservationKey: candidate.logicalObservationKey,
    canonicalPainId: outcome.canonicalPainId,
  });
  if (!ensured.ok) {
    return { status: 'rejected', reason: 'continuation_failed', nextAction: `${ensured.reason}: ${ensured.nextAction}`.slice(0, 400) };
  }
  let promotionDegraded: string | undefined;
  const promoted = promoteAdmittedGovernanceEvidence({
    workspaceDir: args.workspaceDir,
    rolloutIdentity: validated.rolloutIdentity,
    triggerLogicalKey: candidate.logicalObservationKey,
    canonicalPainId: outcome.canonicalPainId,
  });
  if (!promoted.ok) {
    promotionDegraded = `${promoted.reason}`.slice(0, 160);
  }

  return {
    status: 'received',
    painId: outcome.canonicalPainId,
    taskId: ensured.taskId,
    disposition: outcome.disposition === 'already_admitted' ? 'already_admitted' : 'admitted',
    logicalObservationKey: candidate.logicalObservationKey,
    ...(promotionDegraded !== undefined ? { promotionDegraded } : {}),
  };
}
