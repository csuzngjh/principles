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
 * Authorization: the Workspace-level `host_identity_minimal_metadata` quiet
 * flag — deliberately INDEPENDENT of `codex_conversation_ingestion` (full
 * conversation ingestion may stay off; this path reads no transcript and
 * persists ids only).
 *
 * No recovery is EVER attempted from free text, ordinary EventLog
 * `tool_call` rows, or look-alike strings (SPEC TD §1.3).
 */
import * as path from 'node:path';
import {
  recoverTaskIdentityFromReceipt,
  validatePainSubmitReceipt,
  type PainReceiptRecoveryOutcome,
} from '@principles/core/runtime';

/** The one tool this fallback processes (exact match — never a pattern). */
export const PAIN_SUBMIT_TOOL_NAME = 'pd_submit_pain' as const;

export type PainReceiptFallbackResult =
  | { readonly status: 'not_applicable' }
  | { readonly status: 'attempted'; readonly outcome: PainReceiptRecoveryOutcome };

/** MCP CallToolResult content block shape (single text block contract). */
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

export interface PainReceiptFallbackInput {
  readonly workspaceDir: string;
  /** Exact host event tool name — the caller compares before invoking. */
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
 * Attempt the receipt fallback for one PostToolUse event. Never throws —
 * every failure is a structured result the hook surfaces as one bounded
 * diagnostic (rc-9); the hook result itself is unaffected (fail-open belt).
 */
export async function attemptPainReceiptFallback(input: PainReceiptFallbackInput): Promise<PainReceiptFallbackResult> {
  if (input.toolName !== PAIN_SUBMIT_TOOL_NAME) {
    return { status: 'not_applicable' };
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
  const validated = validatePainSubmitReceipt(parsed, { workspaceDir: input.workspaceDir });
  if (!validated.ok) {
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: validated.reasonCode } };
  }
  // Host-layer workspace equality: the receipt names the workspace the MCP
  // server was bound to; a lexically-different spelling of the SAME directory
  // is fine, a different directory never is (cross-workspace receipts are
  // exactly the isolation breach this rejects).
  if (path.resolve(validated.receipt.workspaceDir) !== path.resolve(input.workspaceDir)) {
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: 'receipt_workspace_mismatch' } };
  }
  const outcome = await recoverTaskIdentityFromReceipt({
    workspaceDir: input.workspaceDir,
    hostKind: 'codex',
    receipt: validated.receipt,
    identity: {
      sessionId: input.identity.sessionId,
      ...(input.identity.turnId === undefined || input.identity.turnId.trim().length === 0
        ? {}
        : { submissionTurnId: input.identity.turnId }),
      toolCallId: input.identity.toolCallId,
    },
    authorization: { minimalMetadataGranted: input.minimalMetadataGranted },
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
  const {outcome} = result;
  switch (outcome.status) {
    case 'recovered':
      return `pain_receipt_recovered:taskId=${outcome.taskId}:state=${outcome.disposition.state}`;
    case 'already_bound':
      return `pain_receipt_idempotent:taskId=${outcome.taskId}`;
    case 'rejected':
      return `pain_receipt_rejected:${outcome.reasonCode}${outcome.taskId !== undefined ? `:taskId=${outcome.taskId}` : ''}`;
  }
}
