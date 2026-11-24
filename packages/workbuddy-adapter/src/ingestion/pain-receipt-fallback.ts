/**
 * PRI-1275 (B2) — WorkBuddy PostToolUse structured-receipt fallback.
 *
 * When a `pd_submit_pain` MCP request carried no trusted host `_meta`, the
 * original Pain/Task was legally persisted unbound (`host_session_claim_empty`
 * — the WorkBuddy designated fallback territory, PRI-1275 extension of the
 * PRI-1274 P1-2 whitelist). WorkBuddy's formal PostToolUse completion event
 * then carries PD's own structured receipt (`pd.pain-submit-receipt.v1`) in
 * the CallToolResult CONTENT BLOCK ARRAY (`[{type:'text',text:...}, ...]`),
 * probe-verified on the REAL installed engine (CodeBuddy Code 2.165.0,
 * 2026-11-24) — never assumed from Codex's single object envelope. Together
 * with the event's own host-authoritative identity (`session_id` /
 * `generation_id` / `call_id` — never model parameters), this module
 * restores the SAME original task's submission identity through the Core
 * CAS recovery.
 *
 * P1-1 (mirrored from PRI-1274): the gate is an exact parse of
 * `mcp__<server>__<tool>` against the PD server id `pd-recall` + the tool id
 * `pd_submit_pain`. The real WorkBuddy engine keeps the hyphen (probe
 * 2026-11-24) — the sanitized `pd_recall` spelling is NOT admitted, because a
 * locally registered server literally named `pd_recall` is a DIFFERENT
 * third-party server. A bare `pd_submit_pain` or an identically-named tool on
 * another MCP server never enters this path.
 *
 * Authorization: the Workspace-level `host_identity_minimal_metadata` quiet
 * flag — deliberately INDEPENDENT of `workbuddy_conversation_ingestion`
 * (full conversation ingestion may stay off; this path reads no transcript
 * and persists ids only).
 *
 * No recovery is EVER attempted from free text, ordinary tool_call rows, or
 * look-alike strings (SPEC TD §1.3).
 */
import * as path from 'node:path';
import { readSourceMaterialAuthorization } from '@principles/host-runtime';
import { isSentinelSessionId } from '@principles/core/runtime';
import type { TargetTurnEvidenceRead } from '@principles/core/runtime';
import { listGovernanceConversationTextsForHostTurn } from '@principles/host-runtime';
import {
  recoverTaskIdentityFromReceipt,
  validatePainSubmitReceipt,
  type PainReceiptRecoveryOutcome,
} from '@principles/core/runtime';
import { isPainSubmitWorkbuddyToolName } from '../codec/input-decoder.js';

/** The MCP tool id this fallback processes (the server gate lives in the
 * codec parser — exact match on both namespace segments, never a pattern). */
export const PAIN_SUBMIT_TOOL_NAME = 'pd_submit_pain' as const;

export type PainReceiptFallbackResult =
  | { readonly status: 'not_applicable' }
  | { readonly status: 'attempted'; readonly outcome: PainReceiptRecoveryOutcome };

/**
 * WorkBuddy MCP envelope: the tool_response is the CallToolResult content
 * block ARRAY. More than one text block is AMBIGUOUS — two text blocks
 * could each carry a different task's receipt, so the whole envelope is
 * rejected instead of quietly trusting the first block (P2 rule, mirrored
 * from the Codex adapter).
 */
export function extractReceiptText(toolResponse: unknown): { ok: true; text: string } | { ok: false; reasonCode: string } {
  if (!Array.isArray(toolResponse)) {
    return { ok: false, reasonCode: 'receipt_envelope_not_content_array' };
  }
  const textBlocks: string[] = [];
  for (const block of toolResponse) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      return { ok: false, reasonCode: 'receipt_envelope_block_invalid' };
    }
    const record = block as Record<string, unknown>;
    const type = Object.hasOwn(record, 'type') ? record.type : undefined;
    const text = Object.hasOwn(record, 'text') ? record.text : undefined;
    if (type === 'text' && typeof text === 'string') textBlocks.push(text);
  }
  if (textBlocks.length === 0) return { ok: false, reasonCode: 'receipt_envelope_content_missing' };
  const [firstText] = textBlocks;
  if (firstText === undefined) return { ok: false, reasonCode: 'receipt_envelope_content_missing' };
  if (textBlocks.length > 1) return { ok: false, reasonCode: 'receipt_envelope_ambiguous_content' };
  return { ok: true, text: firstText };
}

/**
 * Normalize host ids at the adapter boundary, matching the trusted `_meta`
 * reader. `null` means malformed; `undefined` means absent (or an empty
 * optional id). Only the normalized value may cross into Core.
 */
function normalizeEventId(value: unknown, opts: { readonly allowEmpty: boolean }): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (opts.allowEmpty && id.length === 0) return undefined;
  return id.length > 0 && id.length <= 200 && !isSentinelSessionId(id) ? id : null;
}

/**
 * The structured target-turn evidence read for the WorkBuddy host boundary —
 * the exact contract the Codex adapter froze (PRI-1273): the consent ledger
 * FIRST (a denial returns blocked_by_consent BEFORE any store query), then
 * the EXACT (rollout identity, host turn id) — never a session scan, never
 * the submission turn, never a recent-turn fallback.
 */
export function readWorkbuddyTargetTurnEvidence(workspaceDir: string, sessionId: string, turnId: string): TargetTurnEvidenceRead {
  const authorization = readSourceMaterialAuthorization({ workspaceDir, hostKind: 'workbuddy' });
  if (authorization.status === 'blocked') {
    return { status: 'blocked_by_consent', reason: authorization.reason };
  }
  try {
    const result = listGovernanceConversationTextsForHostTurn({
      workspaceDir,
      hostKind: 'workbuddy',
      rolloutIdentity: sessionId,
      hostTurnId: turnId,
      limit: 12,
    });
    if (!result.ok) {
      return { status: 'read_failed', reason: result.reason };
    }
    const entries = result.rows.map((row) => ({
      sourceRef: 'governance_observation:' + row.logicalKey,
      note: row.visibleText.slice(0, 2000),
    }));
    return entries.length > 0
      ? { status: 'available', entries }
      : { status: 'not_found' };
  } catch (error) {
    return { status: 'read_failed', reason: error instanceof Error ? error.message.slice(0, 120) : 'store_exception' };
  }
}

/**
 * Does the authorized governance store already hold readable text for the
 * EXACT (session, turn)? Shared by the receipt fallback (disposition choice)
 * and the workspace worker's waiting-task reconcile (the flip).
 */
export function workbuddyTargetTurnTextAvailable(workspaceDir: string, sessionId: string, turnId: string): boolean {
  return readWorkbuddyTargetTurnEvidence(workspaceDir, sessionId, turnId).status === 'available';
}

export interface PainReceiptFallbackInput {
  readonly workspaceDir: string;
  /** Raw host event `tool_name` — gated by the codec MCP namespace parser
   * before anything else happens (P1-1). */
  readonly toolName: string;
  /** Raw `tool_response` from the PostToolUse payload. */
  readonly toolResponse: unknown;
  /** Host-authoritative identity from the event itself. NO submission turn:
   * the WorkBuddy event's `generation_id` is not a proven turn id (SPEC TD
   * §1.3 field rules), so the type physically omits it (review round). */
  readonly identity: {
    readonly sessionId: string;
    readonly toolCallId: string;
  };
  /** Caller-resolved `host_identity_minimal_metadata` flag verdict. */
  readonly minimalMetadataGranted: boolean;
  readonly now?: () => Date;
}

/**
 * Attempt the receipt fallback for one PostToolUse event. Never throws —
 * every failure is a structured result the hook surfaces as one bounded
 * diagnostic (rc-9); the hook result itself is unaffected (fail-open belt).
 */
export async function attemptPainReceiptFallback(input: PainReceiptFallbackInput): Promise<PainReceiptFallbackResult> {
  // P1-1: exact namespace gate first — only the PD MCP server's
  // `pd_submit_pain` completion may enter the recovery path.
  if (!isPainSubmitWorkbuddyToolName(input.toolName)) {
    return { status: 'not_applicable' };
  }
  // P2: validate AND normalize at the host boundary. Validating a trimmed
  // copy while forwarding the raw value would create a second identity
  // spelling in Core/SQLite (and make exact target-turn joins miss).
  const sessionId = normalizeEventId(input.identity.sessionId, { allowEmpty: false });
  const toolCallId = normalizeEventId(input.identity.toolCallId, { allowEmpty: false });
  if (sessionId === null || toolCallId === null) {
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: 'event_identity_invalid' } };
  }
  if (sessionId === undefined || toolCallId === undefined) {
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: 'event_identity_missing' } };
  }
  const envelope = extractReceiptText(input.toolResponse);
  if (!envelope.ok) {
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: envelope.reasonCode } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope.text);
  } catch {
    // Degraded transport forms (plain-text statement) and foreign payloads
    // are not receipts — no recovery from free text.
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: 'receipt_text_not_json' } };
  }
  // P2: normalize the workspace spellings BEFORE validation — the same
  // directory written differently (`/w/p` vs `/w/p/.`) is the same
  // workspace; a genuinely different directory is still rejected by the
  // validated exact comparison. Platform path knowledge stays in the
  // adapter (Core stays path-free).
  const normalizedWorkspace = path.resolve(input.workspaceDir);
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const parsedRecord = parsed as Record<string, unknown>;
    const rawDir = Object.hasOwn(parsedRecord, 'workspaceDir') ? parsedRecord.workspaceDir : undefined;
    if (typeof rawDir === 'string' && rawDir.length > 0) {
      parsed = { ...parsedRecord, workspaceDir: path.resolve(rawDir) };
    }
  }
  const validated = validatePainSubmitReceipt(parsed, { workspaceDir: normalizedWorkspace });
  if (!validated.ok) {
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: validated.reasonCode } };
  }
  // Nothing to repair: a `submitted` receipt whose association is already
  // `verified` means the trusted `_meta` path bound the identity at the
  // INITIAL write. Running the recovery anyway could only answer
  // `already_bound`, which the hook renders as a routine `status=degraded`
  // line on EVERY successful submission — drowning the genuinely actionable
  // degraded signals (and the `blocked_by_consent` nextAction). This is the
  // normal WorkBuddy happy path, not a fallback case at all.
  // `submit_unconfirmed` is deliberately NOT skipped: its write outcome is
  // unknown, so the read-back-confirmed recovery still applies.
  if (validated.receipt.status === 'submitted' && validated.receipt.sessionAssociation.status === 'verified') {
    return { status: 'not_applicable' };
  }
  const outcome = await recoverTaskIdentityFromReceipt({
    workspaceDir: normalizedWorkspace,
    hostKind: 'workbuddy',
    receipt: validated.receipt,
    // No submissionTurnId: the WorkBuddy host provides no proven turn id.
    // An absent turn never negates the session binding (SPEC §G2); a target
    // turn pinned to an unproven id would wedge the task's evidence wait.
    identity: { sessionId, toolCallId },
    authorization: { minimalMetadataGranted: input.minimalMetadataGranted },
    targetTurnTextAvailable: (hostSessionId, targetTurnId) =>
      workbuddyTargetTurnTextAvailable(normalizedWorkspace, hostSessionId, targetTurnId),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { status: 'attempted', outcome };
}

/**
 * One bounded stderr diagnostic line for the hook (ids and codes only —
 * never receipt content, prompts or tool input/output).
 */
export function painReceiptFallbackDiagnostic(result: PainReceiptFallbackResult): string | null {
  if (result.status === 'not_applicable') return null;
  const { outcome } = result;
  switch (outcome.status) {
    case 'recovered':
      return `pain_receipt_recovered:taskId=${outcome.taskId}:state=${outcome.disposition.state}`;
    case 'already_bound':
      return `pain_receipt_idempotent:taskId=${outcome.taskId}`;
    case 'rejected':
      return `pain_receipt_rejected:${outcome.reasonCode}${outcome.detail !== undefined ? `:detail=${Array.from(outcome.detail).slice(0, 80).join('')}` : ''}${outcome.taskId !== undefined ? `:taskId=${outcome.taskId}` : ''}`;
  }
}
