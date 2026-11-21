/**
 * PRI-1274 (B1) — Codex PostToolUse structured-receipt fallback.
 *
 * When a `pd_submit_pain` MCP request carried no trusted host `_meta`, the
 * original Pain/Task was legally persisted unbound. Codex's formal
 * PostToolUse completion event then carries PD's own structured receipt in
 * `tool_response` — the MCP envelope is a SINGLE text content block with the
 * JSON in `content[0].text` (never `structuredContent`; the adapter owns
 * this host envelope shape and must not extrapolate it to other hosts).
 * Together with the event's own host-authoritative identity
 * (`session_id` / `turn_id` / `tool_use_id` — never model parameters), this
 * module restores the SAME original task's submission identity through the
 * Core CAS recovery.
 *
 * P1-1 (review round 2): Codex reports MCP tools under the server
 * namespace — the gate is an exact parse of `mcp__<server>__<tool>` against
 * the PD server (`pd-recall`, sanitized `pd_recall`) + `pd_submit_pain`
 * (see codec/input-decoder.ts for the format evidence). A bare
 * `pd_submit_pain` or an identically-named tool on another MCP server never
 * enters this path.
 *
 * Authorization: the Workspace-level `host_identity_minimal_metadata` quiet
 * flag — deliberately INDEPENDENT of `codex_conversation_ingestion` (full
 * conversation ingestion may stay off; this path reads no transcript and
 * persists ids only).
 *
 * No recovery is EVER attempted from free text, ordinary EventLog
 * `tool_call` rows, or look-alike strings (SPEC TD §1.3).
 */
import * as path from 'node:path';
import { listGovernanceObservations } from '@principles/host-runtime';
import { isSentinelSessionId } from '@principles/core/runtime';
import {
  recoverTaskIdentityFromReceipt,
  validatePainSubmitReceipt,
  type PainReceiptRecoveryOutcome,
} from '@principles/core/runtime';
import { isPainSubmitPostToolUseToolName } from '../codec/input-decoder.js';

/** The MCP tool id this fallback processes (the server gate lives in the
 * codec parser — exact match on both namespace segments, never a pattern). */
export const PAIN_SUBMIT_TOOL_NAME = 'pd_submit_pain' as const;

export type PainReceiptFallbackResult =
  | { readonly status: 'not_applicable' }
  | { readonly status: 'attempted'; readonly outcome: PainReceiptRecoveryOutcome };

/** MCP CallToolResult content block shape (single text block contract).
 * P2 review round: more than one content block is AMBIGUOUS — two text
 * blocks could each carry a different task's receipt, so the whole envelope
 * is rejected instead of quietly trusting the first block. */
function extractReceiptText(toolResponse: unknown): { ok: true; text: string } | { ok: false; reasonCode: string } {
  if (typeof toolResponse !== 'object' || toolResponse === null || Array.isArray(toolResponse)) {
    return { ok: false, reasonCode: 'receipt_envelope_not_an_object' };
  }
  if (!Object.hasOwn(toolResponse, 'content')) {
    return { ok: false, reasonCode: 'receipt_envelope_content_missing' };
  }
  const { content } = toolResponse as { content: unknown };
  if (!Array.isArray(content) || content.length === 0) {
    return { ok: false, reasonCode: 'receipt_envelope_content_missing' };
  }
  if (content.length > 1) {
    return { ok: false, reasonCode: 'receipt_envelope_ambiguous_content' };
  }
  const [first] = content;
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    return { ok: false, reasonCode: 'receipt_envelope_block_invalid' };
  }
  if (!Object.hasOwn(first, 'type') || !Object.hasOwn(first, 'text')) {
    return { ok: false, reasonCode: 'receipt_envelope_not_text_block' };
  }
  const { type, text } = first as { type: unknown; text: unknown };
  if (type !== 'text' || typeof text !== 'string') {
    return { ok: false, reasonCode: 'receipt_envelope_not_text_block' };
  }
  return { ok: true, text };
}

/** Unified host-id format check (P2): trimmed, 1..200 chars, never a
 * sentinel spelling — the same rule the trusted `_meta` path applies. */
function isUsableEventId(value: string | undefined, opts: { readonly allowEmpty: boolean }): boolean {
  if (value === undefined) return true;
  const id = value.trim();
  if (opts.allowEmpty && id.length === 0) return true;
  return id.length > 0 && id.length <= 200 && !isSentinelSessionId(id);
}

export interface PainReceiptFallbackInput {
  readonly workspaceDir: string;
  /** Raw host event `tool_name` — gated by the codec MCP namespace parser
   * before anything else happens (P1-1). */
  readonly toolName: string;
  /** Raw `tool_response` from the PostToolUse payload. */
  readonly toolResponse: unknown;
  /** Host-authoritative identity from the event itself. */
  readonly identity: {
    readonly sessionId: string;
    readonly turnId?: string;
    readonly toolCallId: string;
  };
  /** Caller-resolved `host_identity_minimal_metadata` flag verdict. */
  readonly minimalMetadataGranted: boolean;
  readonly now?: () => Date;
}

/**
 * P1-3: does the authorized governance store already hold readable text for
 * the EXACT (session, turn)? Shared by the receipt fallback (disposition
 * choice) and the workspace worker's waiting-task reconcile (the flip) —
 * the diagnosis itself re-reads the turn through the same store.
 * Unreadable ⇒ missing.
 */
export function codexTargetTurnTextAvailable(workspaceDir: string, sessionId: string, turnId: string): boolean {
  try {
    const result = listGovernanceObservations({
      workspaceDir,
      hostKind: 'codex',
      rolloutIdentity: sessionId,
      hostTurnId: turnId,
      limit: 8,
    });
    if (!result.ok) return false;
    return result.observations.some((row) =>
      (row.kind === 'user_turn' || row.kind === 'assistant_turn')
      && (row.retentionClass === 'operational' || row.retentionClass === 'promoted')
      && typeof row.visibleText === 'string'
      && row.visibleText.trim() !== '');
  } catch {
    return false;
  }
}

/**
 * Attempt the receipt fallback for one PostToolUse event. Never throws —
 * every failure is a structured result the hook surfaces as one bounded
 * diagnostic (rc-9); the hook result itself is unaffected (fail-open belt).
 */
export async function attemptPainReceiptFallback(input: PainReceiptFallbackInput): Promise<PainReceiptFallbackResult> {
  // P1-1: exact namespace gate first — only the PD MCP server's
  // `pd_submit_pain` completion may enter the recovery path.
  if (!isPainSubmitPostToolUseToolName(input.toolName)) {
    return { status: 'not_applicable' };
  }
  // P2: unified format + sentinel validation on the event identity fields.
  if (!isUsableEventId(input.identity.sessionId, { allowEmpty: false })
    || !isUsableEventId(input.identity.toolCallId, { allowEmpty: false })
    || !isUsableEventId(input.identity.turnId, { allowEmpty: true })) {
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: 'event_identity_invalid' } };
  }
  if (input.identity.sessionId.trim().length === 0 || input.identity.toolCallId.trim().length === 0) {
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
  const turnId = input.identity.turnId !== undefined && input.identity.turnId.trim().length > 0
    ? input.identity.turnId
    : undefined;
  const outcome = await recoverTaskIdentityFromReceipt({
    workspaceDir: normalizedWorkspace,
    hostKind: 'codex',
    receipt: validated.receipt,
    identity: {
      sessionId: input.identity.sessionId,
      ...(turnId === undefined ? {} : { submissionTurnId: turnId }),
      toolCallId: input.identity.toolCallId,
    },
    authorization: { minimalMetadataGranted: input.minimalMetadataGranted },
    targetTurnTextAvailable: (sessionId, targetTurnId) =>
      codexTargetTurnTextAvailable(normalizedWorkspace, sessionId, targetTurnId),
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
