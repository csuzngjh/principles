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
import fs from 'node:fs';
import {
  admitGovernanceSignals,
  ensureGovernanceDiagnosticianTask,
  promoteAdmittedGovernanceEvidence,
  type GovernanceSignalCandidate,
} from '@principles/host-runtime';
import { resolveCodexHome } from './codex-home.js';
import { validateCodexTranscriptPath, type TranscriptPathValidation } from './transcript-path.js';
import { extractFields } from './ingestion-fields.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

/** Bounded tail read: the current turn's user record sits at the end. */
const VERBATIM_VERIFY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * PRI-1283 round 3 (owner_manual ruling): the trusted Owner interaction
 * record for the agent-assisted (`pd pain explicit`) channel. The submitted
 * statement is confirmed ONLY when it appears VERBATIM inside the CURRENT
 * turn's genuine user message in the host-validated transcript — i.e. the
 * Owner typed exactly those words, so the final submitted content is what
 * the Owner wrote, not an agent's paraphrase, summary or invention.
 *
 * Reads the same two user-turn record shapes the governance decoder
 * projects (response_item user.text / event_msg UserMessage item_completed)
 * so the confirmation is anchored on the SAME host-written substrate —
 * never on anything the agent claimed. Transcript CONTENT is only read here
 * under the conversation-ingestion consent (callers pass the flag); the
 * check fails closed (no confirmation) on any read/parse problem.
 */
function verifyOwnerVerbatimTurnMatch(args: {
  validated: Extract<TranscriptPathValidation, { ok: true }>;
  turnId: string;
  statementText: string;
}): boolean {
  const needle = args.statementText;
  if (needle.length === 0) return false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(args.validated.canonicalPath, 'r');
    const stat = fs.fstatSync(fd);
    // Post-open revalidation: same physical file the path validator proved.
    if (stat.dev !== args.validated.identity.dev || stat.ino !== args.validated.identity.ino) return false;
    const start = Math.max(0, stat.size - VERBATIM_VERIFY_MAX_BYTES);
    const length = Math.min(VERBATIM_VERIFY_MAX_BYTES, stat.size);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.subarray(0, read).toString('utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(record)) continue;
      const payload = own(record, 'payload');
      if (!isRecord(payload)) continue;
      const recordType = own(record, 'type');
      if (recordType === 'response_item' && own(payload, 'type') === 'message' && own(payload, 'role') === 'user') {
        const passthrough = own(payload, 'internal_chat_message_metadata_passthrough');
        if (!isRecord(passthrough) || own(passthrough, 'turn_id') !== args.turnId) continue;
        const kinds = own(passthrough, 'content_item_kinds');
        if (!Array.isArray(kinds) || kinds[0] !== 'user.text') continue;
        const content = own(payload, 'content');
        if (!Array.isArray(content)) continue;
        const parts: string[] = [];
        for (const item of content) {
          if (isRecord(item) && own(item, 'type') === 'input_text' && typeof own(item, 'text') === 'string') parts.push(own(item, 'text') as string);
        }
        if (parts.join('').includes(needle)) return true;
        continue;
      }
      if (recordType === 'event_msg' && own(payload, 'type') === 'item_completed' && own(payload, 'turn_id') === args.turnId) {
        const item = own(payload, 'item');
        if (!isRecord(item) || own(item, 'type') !== 'UserMessage') continue;
        const content = own(item, 'content');
        if (!Array.isArray(content)) continue;
        const parts: string[] = [];
        for (const entry of content) {
          if (isRecord(entry) && (own(entry, 'type') === 'text' || own(entry, 'type') === 'Text') && typeof own(entry, 'text') === 'string') parts.push(own(entry, 'text') as string);
        }
        if (parts.join('').includes(needle)) return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

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
    /**
     * PainIngress warning when the Owner statement legitimately degraded
     * (e.g. ingestion OFF → no persisted observation to use as behavior
     * evidence). The Pain + task still exist; the receipt discloses the basis.
     */
    ingressWarning?: string;
  }
  | {
    status: 'rejected';
    reason: 'statement_empty' | 'statement_too_long' | 'transcript_unavailable' | 'lineage_invalid' | 'rate_limited' | 'continuation_failed';
    nextAction: string;
  };

/**
 * Persist one explicit Owner statement. The consent-gated conversation
 * ingestion flag does NOT gate the REGISTRATION (no conversation tables or
 * transcript CONTENT are read — only the path is validated for the rollout
 * identity), mirroring SPEC §6.4 rule 3. It DOES gate evidence promotion:
 *
 *   - `conversationIngestionEnabled: true` — the caller MUST have run the
 *     live observation ingestion for this same hook payload BEFORE calling
 *     this function: promotion requires the trigger observation
 *     (`codex|<rollout>|<turn>|user`) to already be persisted, otherwise the
 *     FIRST submission of a rollout degrades with rollout_not_found /
 *     trigger_not_found (the observation used to be written only by the
 *     ingestion pass that ran after the explicit registration).
 *   - `conversationIngestionEnabled: false` — no session observation exists
 *     and none may be written (privacy boundary), so promotion is SKIPPED
 *     and disclosed as `conversation_ingestion_disabled` instead of
 *     attempting it and misreporting a missing substrate.
 */
export async function recordExplicitOwnerStatement(args: {
  /**
   * Audit provenance: omitted = the native hook-read `PD记录痛苦：` prefix
   * entry; 'codex_explicit_agent' = the agent-assisted no-prefix bridge
   * (turn-context.ts). Admission semantics are identical either way.
   */
  explicitChannel?: 'codex_explicit_agent';
  rawPayload: unknown;
  workspaceDir: string;
  statementText: string;
  env?: { CODEX_HOME?: string | undefined };
  conversationIngestionEnabled: boolean;
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
    // PRI-1283 round 3 (owner_manual ruling): an agent-assisted statement is
    // owner_manual ONLY when the submitted text matches the Owner's own words
    // in the current turn's transcript record. The check reads transcript
    // CONTENT, so it runs only under the conversation-ingestion consent;
    // when consent is off (or the match fails) the statement persists as
    // Agent-derived — classified down, never rejected outright.
    ...(args.explicitChannel === 'codex_explicit_agent' && args.conversationIngestionEnabled
      && verifyOwnerVerbatimTurnMatch({ validated, turnId: fields.turnId, statementText: args.statementText })
      ? { ownerVerbatimConfirmed: true }
      : {}),
  };

  const admitted = admitGovernanceSignals({ workspaceDir: args.workspaceDir, candidates: [candidate] });
  if (!admitted.ok) {
    return { status: 'rejected', reason: 'continuation_failed', nextAction: `${admitted.reason}: ${admitted.nextAction}`.slice(0, 400) };
  }
  const [outcome] = admitted.outcomes;
  if (outcome === undefined || !('disposition' in outcome)) {
    return { status: 'rejected', reason: 'continuation_failed', nextAction: 'The governance admission returned no disposition; nothing was recorded.' };
  }
  if (outcome.disposition === 'not_a_signal') {
    return { status: 'rejected', reason: 'continuation_failed', nextAction: 'reason' in outcome ? String(outcome.reason) : 'the signal was not admitted' };
  }
  if (outcome.disposition === 'rate_limited') {
    return { status: 'rejected', reason: 'rate_limited', nextAction: 'The per-root-session correction quota (5/hour) is exhausted; resubmit later — the statement was NOT recorded.' };
  }
  if (outcome.disposition !== 'admitted' && outcome.disposition !== 'already_admitted') {
    // An explicit Owner statement bypasses keyword detection entirely, so it
    // can never legitimately land in the Stage-2 review state machine.
    return { status: 'rejected', reason: 'continuation_failed', nextAction: `unexpected admission disposition for an explicit statement: ${outcome.disposition}` };
  }

  // Promotion runs BEFORE the task enqueue (deliberate): the durable task is
  // the receipt's hard guarantee, and promoting first closes the window in
  // which the background worker could start the first diagnosis before the
  // already-available evidence window is promoted. Both steps are
  // independently idempotent and recovered by reconcileGovernanceContinuation
  // (Case A: task missing → created later; Case C: promotion missing →
  // retried once the trigger observation arrives).
  let promotionDegraded: string | undefined;
  if (args.conversationIngestionEnabled) {
    const promoted = promoteAdmittedGovernanceEvidence({
      workspaceDir: args.workspaceDir,
      rolloutIdentity: validated.rolloutIdentity,
      triggerLogicalKey: candidate.logicalObservationKey,
      canonicalPainId: outcome.canonicalPainId,
    });
    if (!promoted.ok) {
      promotionDegraded = `${promoted.reason}`.slice(0, 160);
    }
  } else {
    // Ingestion is consent-gated OFF: no session observation was (or may be)
    // written, so promotion is skipped by design, never attempted-and-failed.
    promotionDegraded = 'conversation_ingestion_disabled';
  }

  // Task ensure is the receipt's hard guarantee (SPEC §6.4.5 — a degraded
  // promotion is disclosed, never a failed receipt: the pain + task are
  // durably recorded).
  const ensured = await ensureGovernanceDiagnosticianTask({
    workspaceDir: args.workspaceDir,
    logicalObservationKey: candidate.logicalObservationKey,
    canonicalPainId: outcome.canonicalPainId,
  });
  if (!ensured.ok) {
    return { status: 'rejected', reason: 'continuation_failed', nextAction: `${ensured.reason}: ${ensured.nextAction}`.slice(0, 400) };
  }

  return {
    status: 'received',
    painId: outcome.canonicalPainId,
    taskId: ensured.taskId,
    disposition: outcome.disposition === 'already_admitted' ? 'already_admitted' : 'admitted',
    logicalObservationKey: candidate.logicalObservationKey,
    ...(promotionDegraded !== undefined ? { promotionDegraded } : {}),
    ...(ensured.ingressWarning !== undefined ? { ingressWarning: ensured.ingressWarning } : {}),
  };
}
