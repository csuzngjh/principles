/**
 * PRI-1276 (B2) — OpenClaw `after_tool_call` structured-receipt fallback.
 *
 * When a `pd_submit_pain` MCP request carried no trusted host `_meta`, the
 * original Pain/Task was legally persisted unbound (`host_session_claim_empty`
 * — the non-Codex designated fallback territory, PRI-1275 whitelist). The
 * OpenClaw formal `after_tool_call` completion event then carries PD's own
 * structured receipt plus host-authoritative identity (`sessionId` in the
 * hook context, `toolCallId` from the real execution record — never model
 * parameters), and this module restores the SAME original task's submission
 * identity through the Core CAS recovery.
 *
 * The event envelope is OpenClaw's OWN, probe-verified on the REAL isolated
 * gateway 2026-11-25 (audit `PRI1276_OPENCLAW_HOST_IDENTITY_AUDIT_20261125.md`
 * §2.5, probe record `.tmp/pri1276/probe/after-tool-call.jsonl`) — deliberately
 * NOT the Codex single-object envelope and NOT the WorkBuddy content-block
 * array: the agent tool result is
 * `{content:[{type:'text',text:<receipt JSON>}],details:{mcpServer,mcpTool}}`
 * — the receipt JSON itself sits in ONE text block (SINGLE-encoded; the
 * dist-derived double-encoded CallToolResult reading remains an accepted
 * legacy variant, see `extractOpenclawReceipt`).
 * `details.mcpServer` is the host's own server attribution and cross-checks
 * the tool-name gate; a disagreement is contradictory evidence, not a hint.
 *
 * P1-1 (mirrored from PRI-1274/1275): the gate is EXACT equality against the
 * one materialized tool name `pd-recall__pd_submit_pain` (dist naming:
 * `{safeServerName}__{sanitizedTool}`, hyphen preserved, NO `mcp__` prefix —
 * agent-bundle-mcp-names-*.mjs `buildSafeToolName`). A bare `pd_submit_pain`,
 * a `mcp__`-prefixed foreign-engine spelling, or an identically-named tool on
 * any other server never enters this path. If a future third-party server
 * collision renames the materialized tool (dist appends `-2`), the exact
 * equality stops matching — the submission stays unbound (fail closed), and
 * the namespaced `_meta` producer (upstream OpenClaw patch, audit §5) remains
 * the designed main path.
 *
 * Target-turn association: OpenClaw's runId is NOT itself a turn id.
 * The before_prompt_build hook records the exact PD-owned user-turn identity
 * under the same host runId; after_tool_call joins that tuple in bounded
 * process memory. Missing/expired correlation is fail-closed for tasks that
 * require target evidence — the original task remains unbound.
 *
 * Authorization: the Workspace-level `host_identity_minimal_metadata` quiet
 * flag — deliberately INDEPENDENT of conversation ingestion consent (this
 * path reads no transcript for identity; ids only). Per-event config re-read
 * (the caller's job) makes a revocation effective on the next event without
 * a gateway restart.
 *
 * No recovery is EVER attempted from free text, ordinary tool_call rows,
 * gateway private memory, session stores or look-alike strings (SPEC TD §1.3).
 */
import * as path from 'node:path';
import { createConsentLedgerSourceMaterialAuthorization, readSourceMaterialAuthorization, listGovernanceConversationTextsForHostTurn, loadPdConfigForPlugin } from '@principles/host-runtime';
import { computeFeatureFlagsFromConfig, isSentinelSessionId } from '@principles/core/runtime';
import type { TargetTurnEvidenceRead } from '@principles/core/runtime';
import {
  recoverTaskIdentityFromReceipt,
  validatePainSubmitReceipt,
  type PainReceiptRecoveryOutcome,
} from '@principles/core/runtime';
import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from '../openclaw-sdk.js';
import { resolveOpenclawRunTurnCorrelation } from './openclaw-run-turn-correlation.js';

/** The exact materialized tool name this fallback processes (audit §2.5).
 * Exact equality — no substring, no regex, no second spelling. */
export const OPENCLAW_PAIN_SUBMIT_TOOL_NAME = 'pd-recall__pd_submit_pain' as const;

/** The MCP server id the PD plugin manifest declares (`openclaw.plugin.json`
 * `mcpServers["pd-recall"]`) and the host's own result attribution must agree
 * with. */
export const OPENCLAW_PAIN_SUBMIT_SERVER_ID = 'pd-recall' as const;

/** Exact gate: only the PD MCP server's materialized `pd_submit_pain`
 * completion may enter the recovery path. */
export function isPainSubmitOpenclawToolName(toolName: string): boolean {
  return toolName === OPENCLAW_PAIN_SUBMIT_TOOL_NAME;
}

export type PainReceiptFallbackResult =
  | { readonly status: 'not_applicable' }
  | { readonly status: 'attempted'; readonly outcome: PainReceiptRecoveryOutcome };

/**
 * Walk the OpenClaw agent tool result to the parsed receipt object. The
 * REAL installed envelope (probe-verified 2026-11-25 on the isolated
 * gateway, `.tmp/pri1276/probe/after-tool-call.jsonl`) is SINGLE-encoded:
 * `result.content[0].text` IS the `pd.pain-submit-receipt.v1` JSON directly
 * and `result.details` carries `{mcpServer:'pd-recall', mcpTool}`. The
 * dist-derived double-encoded shape (CallToolResult JSON inside the text,
 * audit §2.5 first reading) is kept as an accepted variant: a layer-1
 * object that carries an ARRAY `content` property is unwrapped one more
 * layer. Every deviation is a structured rejection — the event envelope is
 * untrusted runtime data (rc-1..rc-5) and more than one text block at
 * either layer is ambiguous (two blocks could each carry a different
 * task's receipt).
 */
export function extractOpenclawReceipt(
  result: unknown,
): { ok: true; receipt: unknown } | { ok: false; reasonCode: string } {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    // Dispatch errors and void results carry no receipt at all.
    return { ok: false, reasonCode: 'receipt_envelope_result_missing' };
  }
  const record = result as Record<string, unknown>;
  // The host's own server attribution, when present, must name the PD server.
  // `details` itself is optional defensive tolerance; a PRESENT mcpServer is
  // authoritative evidence and a foreign value is contradictory, not ignorable.
  const details = Object.hasOwn(record, 'details') ? record.details : undefined;
  if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
    const detailsRecord = details as Record<string, unknown>;
    if (Object.hasOwn(detailsRecord, 'mcpServer') && detailsRecord.mcpServer !== OPENCLAW_PAIN_SUBMIT_SERVER_ID) {
      return { ok: false, reasonCode: 'receipt_envelope_foreign_server' };
    }
  }
  const outerText = readSingleTextBlock(record.content);
  if (!outerText.ok) return outerText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(outerText.text);
  } catch {
    // Layer-1 text that is not JSON at all (plain-text degradation).
    return { ok: false, reasonCode: 'receipt_envelope_not_call_result' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reasonCode: 'receipt_envelope_not_call_result' };
  }
  const parsedRecord = parsed as Record<string, unknown>;
  if (Object.hasOwn(parsedRecord, 'content') && Array.isArray(parsedRecord.content)) {
    // Legacy double-encoded variant: the legacy CallToolResult wraps the
    // receipt in its own content blocks.
    const innerText = readSingleTextBlock(parsedRecord.content);
    if (!innerText.ok) return innerText;
    let receipt: unknown;
    try {
      receipt = JSON.parse(innerText.text);
    } catch {
      return { ok: false, reasonCode: 'receipt_envelope_not_call_result' };
    }
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
      return { ok: false, reasonCode: 'receipt_envelope_not_call_result' };
    }
    return { ok: true, receipt };
  }
  // Real installed shape: the receipt JSON itself.
  return { ok: true, receipt: parsed };
}

/** Exactly one `{type:'text',text:string}` block out of an MCP content array;
 * absent / non-array / zero / multiple are distinct structured rejections. */
function readSingleTextBlock(content: unknown): { ok: true; text: string } | { ok: false; reasonCode: string } {
  if (!Array.isArray(content)) return { ok: false, reasonCode: 'receipt_envelope_content_missing' };
  const textBlocks: string[] = [];
  for (const block of content) {
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
 * The structured target-turn evidence read for the OpenClaw host boundary —
 * the exact contract PRI-1273 froze: the consent ledger FIRST (a denial
 * returns blocked_by_consent BEFORE any store query), then the EXACT
 * (rollout identity, host turn id) — never a session scan, never the
 * submission turn, never a recent-turn fallback.
 */
export function readOpenclawTargetTurnEvidence(workspaceDir: string, sessionId: string, turnId: string): TargetTurnEvidenceRead {
  const authorization = readSourceMaterialAuthorization({ workspaceDir, hostKind: 'openclaw' });
  if (authorization.status === 'blocked') {
    return { status: 'blocked_by_consent', reason: authorization.reason };
  }
  try {
    const result = listGovernanceConversationTextsForHostTurn({
      workspaceDir,
      hostKind: 'openclaw',
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

/** Does the authorized governance store already hold readable text for the
 * EXACT (session, turn)? Same contract as the WorkBuddy host boundary. */
export function openclawTargetTurnTextAvailable(workspaceDir: string, sessionId: string, turnId: string): boolean {
  return readOpenclawTargetTurnEvidence(workspaceDir, sessionId, turnId).status === 'available';
}

export interface PainReceiptFallbackInput {
  readonly workspaceDir: string;
  /** Raw host event `toolName` — exact-equality gated before anything else
   * happens (P1-1). */
  readonly toolName: string;
  /** The formal event's `result` (double-encoded MCP envelope). */
  readonly toolResult: unknown;
  /** Host-authoritative identity plus an optional exact turn identity
   * resolved by the same-process (workspace, session, runId) correlation. */
  readonly identity: {
    readonly sessionId: string | undefined;
    readonly toolCallId: string | undefined;
    readonly submissionTurnId?: string;
  };
  /** OpenClaw's production after_tool_call path sets this to prevent a
   * session-only READY fallback when target evidence is required. */
  readonly requireTargetTurnIdentity?: boolean;
  /** Caller-resolved `host_identity_minimal_metadata` flag verdict. */
  readonly minimalMetadataGranted: boolean;
  readonly now?: () => Date;
}

/** Host id normalization: `null` malformed, `undefined` absent; only the
 * normalized value may cross into Core (same rule as the `_meta` reader). */
function normalizeEventId(value: unknown, opts: { readonly allowEmpty: boolean }): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (opts.allowEmpty && id.length === 0) return undefined;
  return id.length > 0 && id.length <= 200 && !isSentinelSessionId(id) ? id : null;
}

/**
 * Attempt the receipt fallback for one `after_tool_call` event. Never
 * throws — every failure is a structured result the hook surfaces as one
 * bounded diagnostic (rc-9); the hook result itself is unaffected
 * (fail-open belt: recovery cannot change what the tool already did).
 */
export async function attemptPainReceiptFallback(input: PainReceiptFallbackInput): Promise<PainReceiptFallbackResult> {
  // P1-1: exact tool-name gate first.
  if (!isPainSubmitOpenclawToolName(input.toolName)) {
    return { status: 'not_applicable' };
  }
  // P2: validate AND normalize at the host boundary — a trimmed copy that
  // validates while the raw value forwards would create a second identity
  // spelling in Core/SQLite.
  const sessionId = normalizeEventId(input.identity.sessionId, { allowEmpty: false });
  const toolCallId = normalizeEventId(input.identity.toolCallId, { allowEmpty: false });
  const submissionTurnId = normalizeEventId(input.identity.submissionTurnId, { allowEmpty: false });
  if (sessionId === null || toolCallId === null || submissionTurnId === null) {
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: 'event_identity_invalid' } };
  }
  if (sessionId === undefined || toolCallId === undefined) {
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: 'event_identity_missing' } };
  }
  const envelope = extractOpenclawReceipt(input.toolResult);
  if (!envelope.ok) {
    return { status: 'attempted', outcome: { status: 'rejected', reasonCode: envelope.reasonCode } };
  }
  let parsed: unknown = envelope.receipt;
  // P2: normalize the workspace spellings BEFORE validation — the same
  // directory written differently is the same workspace; a genuinely
  // different directory is still rejected by the validated exact comparison.
  // Platform path knowledge stays in the adapter (Core stays path-free).
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
  // INITIAL write — running the recovery could only answer `already_bound`,
  // which would turn into a degraded line on EVERY successfully prebound
  // submission and drown the actionable signals (same rule as PRI-1275).
  // `submit_unconfirmed` is deliberately NOT skipped: its write outcome is
  // unknown, so the read-back-confirmed recovery still applies.
  if (validated.receipt.status === 'submitted' && validated.receipt.sessionAssociation.status === 'verified') {
    return { status: 'not_applicable' };
  }
  const outcome = await recoverTaskIdentityFromReceipt({
    workspaceDir: normalizedWorkspace,
    hostKind: 'openclaw',
    receipt: validated.receipt,
    identity: {
      sessionId,
      toolCallId,
      ...(submissionTurnId !== undefined ? { submissionTurnId } : {}),
    },
    authorization: { minimalMetadataGranted: input.minimalMetadataGranted },
    requireTargetTurnIdentity: input.requireTargetTurnIdentity === true,
    readTargetTurnEvidence: (hostSessionId, targetTurnId) =>
      readOpenclawTargetTurnEvidence(normalizedWorkspace, hostSessionId, targetTurnId),
    sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(normalizedWorkspace),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { status: 'attempted', outcome };
}

/**
 * One bounded stderr/logger diagnostic line for the hook (ids and codes
 * only — never receipt content, prompts or tool input/output). The
 * `stage` segment keeps the degraded state observable per the host contract.
 * `unbound=true` is emitted only when the shared recovery pass actually read
 * the task and proved it unbound; conflict, parse and store failures leave
 * the binding state unknown and therefore omit the field.
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
      // CodeRabbit round: NEVER echo `outcome.detail` here — Core fills it on
      // `recovery_store_error` with a raw exception message that may embed a
      // workspace path or newlines; the ids-only line contract admits codes
      // and ids only.
      return `pain_receipt_rejected:${outcome.reasonCode}:stage=after_tool_call${outcome.taskUnbound === true ? ':unbound=true' : ''}${outcome.taskId !== undefined ? `:taskId=${outcome.taskId}` : ''}`;
  }
}

/**
 * Hook entry: one `after_tool_call` event in, a bounded diagnostic line (or
 * null) plus the gate verdict out. Resolves the
 * `host_identity_minimal_metadata` verdict from the CURRENT workspace config
 * (per-event re-read — a Workspace-side revocation stops binding on the next
 * event without a gateway restart; a malformed config fails closed for the
 * identity path) and aggregates the host-authoritative identity from the
 * EVENT and its hook context (`sessionId` on the context, `toolCallId` on
 * the event — both real host fields, audit §2.4). Never throws; the caller
 * logs the returned line.
 */
export async function runAfterToolCallReceiptFallback(input: {
  readonly event: PluginHookAfterToolCallEvent;
  readonly ctx: PluginHookToolContext;
  readonly workspaceDir: string;
}): Promise<{ readonly line: string | null; readonly notApplicableReason?: 'tool_not_pd_submit_pain' }> {
  if (!isPainSubmitOpenclawToolName(input.event.toolName)) {
    return { line: null, notApplicableReason: 'tool_not_pd_submit_pain' };
  }
  const config = loadPdConfigForPlugin(input.workspaceDir);
  let minimalMetadataGranted = false;
  if (config.ok) {
    minimalMetadataGranted = computeFeatureFlagsFromConfig(config.effective).flags.host_identity_minimal_metadata?.enabled === true;
  }
  // Identity: the event's own toolCallId (real execution record) and the
  // context's sessionId (OpenClaw session authority). The context may also
  // carry the call id on older relays — read it ONLY as a fallback, never
  // from params (model-visible, untrusted).
  const eventToolCallId = Object.hasOwn(input.event, 'toolCallId') ? input.event.toolCallId : undefined;
  const ctxToolCallId = Object.hasOwn(input.ctx, 'toolCallId') ? (input.ctx as Record<string, unknown>).toolCallId : undefined;
  const toolCallId = typeof eventToolCallId === 'string' && eventToolCallId.length > 0
    ? eventToolCallId
    : typeof ctxToolCallId === 'string' && ctxToolCallId.length > 0
      ? ctxToolCallId
      : undefined;
  const submissionTurnId = resolveOpenclawRunTurnCorrelation({
    workspaceDir: input.workspaceDir,
    sessionId: input.ctx.sessionId,
    runId: input.event.runId,
  });
  const fallback = await attemptPainReceiptFallback({
    workspaceDir: input.workspaceDir,
    toolName: input.event.toolName,
    toolResult: input.event.result,
    identity: {
      sessionId: input.ctx.sessionId,
      toolCallId,
      ...(submissionTurnId !== undefined ? { submissionTurnId } : {}),
    },
    // Without the same-run turn join, a target-dependent OpenClaw task stays
    // unbound. Explicit requested targets, valid submitted evidence and
    // owner_expectation anchors retain their existing admission semantics.
    requireTargetTurnIdentity: true,
    minimalMetadataGranted,
  });
  return { line: painReceiptFallbackDiagnostic(fallback) };
}
