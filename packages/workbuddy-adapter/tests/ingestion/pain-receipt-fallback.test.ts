/**
 * PRI-1275 (B2) — WorkBuddy PostToolUse structured-receipt fallback.
 *
 * Mirrors the Codex adapter slice (PRI-1274) against the WorkBuddy envelope:
 * the MCP tool name gate is the exact `mcp__<server>__<tool>` parse, the
 * tool_response is the CallToolResult CONTENT BLOCK ARRAY (probe-verified on
 * the REAL installed engine, CodeBuddy Code 2.165.0, 2026-11-24 — never
 * assumed from Codex's `{content:[…]}` object), identity comes from the EVENT
 * (session/call ids only, never model parameters — `generation_id` is NOT
 * mapped to a submission/target turn), and the hand-off into the Core CAS
 * recovery carries hostKind 'workbuddy' with server gate `pd-recall` only.
 *
 * The Core barrel is mocked as a spy-through (importOriginal + delegation):
 * the REAL validate/recovery still runs against a REAL unbound task created
 * by the REAL submit capability, while the spy asserts the exact normalized
 * contract crossing the adapter → Core boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeStateManager } from '@principles/core/runtime';
import { deriveSubmitTaskId, submitPainCapability } from '@principles/core/runtime/pain-submit-capability';

const { recoverSpy, validateSpy } = vi.hoisted(() => ({
  recoverSpy: vi.fn(),
  validateSpy: vi.fn(),
}));
vi.mock('@principles/core/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/core/runtime')>();
  recoverSpy.mockImplementation((options: Parameters<typeof actual.recoverTaskIdentityFromReceipt>[0]) =>
    actual.recoverTaskIdentityFromReceipt(options));
  validateSpy.mockImplementation(
    (value: Parameters<typeof actual.validatePainSubmitReceipt>[0], options: Parameters<typeof actual.validatePainSubmitReceipt>[1]) =>
      actual.validatePainSubmitReceipt(value, options),
  );
  return { ...actual, recoverTaskIdentityFromReceipt: recoverSpy, validatePainSubmitReceipt: validateSpy };
});

import {
  attemptPainReceiptFallback,
  painReceiptFallbackDiagnostic,
  workbuddyTargetTurnTextAvailable,
} from '../../src/ingestion/pain-receipt-fallback.js';
import {
  PAIN_SUBMIT_MCP_SERVER_IDS,
  isPainSubmitWorkbuddyToolName,
  parseWorkbuddyMcpToolName,
} from '../../src/codec/input-decoder.js';

/** REAL engine naming (Devin SEC finding): the real WorkBuddy/CodeBuddy
 * engine preserves the hyphen — MCP tools register as
 * `mcp__pd-recall__pd_submit_pain` verbatim, with NO identifier
 * sanitization. A literal `pd_recall` server on this host is a DIFFERENT
 * third-party server and must stay NOT_APPLICABLE (attack surface). */
const REAL_TOOL_NAME = 'mcp__pd-recall__pd_submit_pain';

/** Identity shape of the REAL captured PostToolUse payload (probe 2026-11-24):
 * session_id + the engine per-call uuid call_id. The event's `generation_id`
 * is deliberately NOT part of the identity — its equivalence to a PD
 * submission turn is unproven (review round: Devin BUG + CodeRabbit CR-4),
 * so the input type physically omits it. */
const EVENT_IDENTITY = {
  sessionId: '01a20d41-fc4f-71ec-ab89-7d83a970215a',
  toolCallId: '01a20d41-fdfd-758f-ab69-4df2fe1fe263',
} as const;

const dirs: string[] = [];
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-workbuddy-receipt-'));
  dirs.push(root);
  return root;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** Create the original unbound task through the REAL Core capability — the
 * exact row shape the WorkBuddy MCP server persists when the request carried
 * no trusted `_meta` (`host_session_claim_empty`, the PRI-1275 designated
 * fallback territory). `agent_instruction` anchor: no independently admissible
 * Owner statement, so the recovered task WAITs for its target turn's text. */
async function persistUnboundPain(workspaceDir: string, painId: string): Promise<string> {
  const taskId = deriveSubmitTaskId(painId);
  const receipt = await submitPainCapability(
    {
      workspaceDir,
      stateDir: path.join(workspaceDir, '.state'),
      painId,
      taskId,
      hostKind: 'workbuddy',
      verifyHostSession: () => ({ status: 'unverified', detail: 'host_session_claim_empty' }),
    },
    {
      reason: 'Anchor: agent instruction. Observed: behavior. Deviation: mismatch.',
      anchorType: 'agent_instruction',
      anchorRef: 'AGENTS.md#safety',
      painType: 'user_frustration',
    },
  );
  if (receipt.status !== 'submitted') throw new Error(`fixture submit failed: ${JSON.stringify(receipt.error)}`);
  return taskId;
}

/** The REAL WorkBuddy MCP envelope: tool_response IS the content block array
 * (`[{type:'text',text:'<receipt json>'}]`), not a `{content:[…]}` wrapper. */
function arrayEnvelopeReceipt(painId: string, workspaceDir: string, overrides: Record<string, unknown> = {}): unknown {
  return [{
    type: 'text',
    text: JSON.stringify({
      schemaVersion: 'pd.pain-submit-receipt.v1',
      capability: 'pd_submit_pain',
      status: 'submitted',
      painId,
      taskId: deriveSubmitTaskId(painId),
      workspaceDir,
      diagnosis: { status: 'pending' },
      anchor: { type: 'owner_expectation', ref: 'Owner statement in this conversation' },
      provenance: 'agent_reported_owner_approved',
      warnings: ['host_session_unverified:host_session_claim_empty'],
      error: null,
      nextAction: null,
      sessionAssociation: { status: 'unverified', detail: 'host_session_claim_empty' },
      ...overrides,
    }),
  }];
}

describe('P1-1 — exact MCP namespace gate (real WorkBuddy naming)', () => {
  it('parses real namespaced names into server + tool ids', () => {
    expect(parseWorkbuddyMcpToolName('mcp__pd-recall__pd_submit_pain')).toEqual({ serverId: 'pd-recall', toolId: 'pd_submit_pain' });
    expect(parseWorkbuddyMcpToolName('mcp__pd_recall__pd_submit_pain')).toEqual({ serverId: 'pd_recall', toolId: 'pd_submit_pain' });
    expect(parseWorkbuddyMcpToolName('mcp__pdprobe__echo_meta')).toEqual({ serverId: 'pdprobe', toolId: 'echo_meta' });
    expect(parseWorkbuddyMcpToolName('pd_submit_pain')).toBeNull();
    expect(parseWorkbuddyMcpToolName('mcp__onlyonesegment')).toBeNull();
    expect(parseWorkbuddyMcpToolName('mcp____pd_submit_pain')).toBeNull();
  });

  it('accepts ONLY the real hyphenated PD server id + pd_submit_pain (Devin SEC: no sanitization)', () => {
    expect(PAIN_SUBMIT_MCP_SERVER_IDS.has('pd-recall')).toBe(true);
    expect(PAIN_SUBMIT_MCP_SERVER_IDS.has('pd_recall')).toBe(false);
    expect(isPainSubmitWorkbuddyToolName('mcp__pd-recall__pd_submit_pain')).toBe(true);
  });

  it('isolates every other server and tool — equality on BOTH segments, never a substring', () => {
    // The sanitized-looking spelling is the NEW negative control: the real
    // engine never sanitizes, so a literal `pd_recall` server is third-party.
    expect(isPainSubmitWorkbuddyToolName('mcp__pd_recall__pd_submit_pain')).toBe(false);
    expect(isPainSubmitWorkbuddyToolName('mcp__other__pd_submit_pain')).toBe(false);
    expect(isPainSubmitWorkbuddyToolName('mcp__pd_recall_clone__pd_submit_pain')).toBe(false);
    expect(isPainSubmitWorkbuddyToolName('mcp__pd-recall__pd_recall_principle_pains')).toBe(false);
    expect(isPainSubmitWorkbuddyToolName('pd_submit_pain')).toBe(false);
    expect(isPainSubmitWorkbuddyToolName('pd-recall__pd_submit_pain')).toBe(false);
    expect(isPainSubmitWorkbuddyToolName('xmcp__pd-recall__pd_submit_pain')).toBe(false);
    expect(isPainSubmitWorkbuddyToolName('mcp__pd-recall__pd_submit_pain_extra')).toBe(false);
  });

  it('attemptPainReceiptFallback is not_applicable for non-PD tools (incl. pd_recall) and enters for pd-recall', async () => {
    const ws = workspace();
    const notJson = [{ type: 'text', text: '{not json' }];
    for (const toolName of ['mcp__pd_recall__pd_submit_pain', 'pd_submit_pain', 'pd_submit_pain_v2', 'mcp__other__pd_submit_pain', 'mcp__pd-recall__pd_recall_principle_pains', 'Bash']) {
      const result = await attemptPainReceiptFallback({
        workspaceDir: ws,
        toolName,
        toolResponse: notJson,
        identity: { ...EVENT_IDENTITY },
        minimalMetadataGranted: true,
      });
      expect(result).toEqual({ status: 'not_applicable' });
    }
    // The gate LET this in: the envelope is decoded (and rejected on its own
    // merits) instead of the tool name refusing the attempt outright.
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: 'mcp__pd-recall__pd_submit_pain',
      toolResponse: notJson,
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('receipt_text_not_json');
  });
});

describe('attemptPainReceiptFallback — array envelope decode and recovery', () => {
  it('recovers the original unbound task from a real-fixture-shaped array envelope (hostKind workbuddy crosses into Core)', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000121_ab000121';
    const taskId = await persistUnboundPain(ws, painId);

    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: arrayEnvelopeReceipt(painId, ws),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('recovered');
    if (result.outcome.status !== 'recovered') return;
    expect(result.outcome.taskId).toBe(taskId);
    expect(result.outcome.painId).toBe(painId);
    // No submission/target turn exists (generation_id is not mapped), so the
    // recovery is not pinned to an unproven evidence wait.
    expect(result.outcome.disposition.state).toBe('ready_for_diagnosis');

    // Spy-through: the adapter→Core hand-off carries the WORKBUDDY host kind
    // and the NORMALIZED event identity (same values the envelope decode used).
    const recoverArg: unknown = recoverSpy.mock.calls.at(-1)?.[0];
    expect(recoverArg).toMatchObject({
      workspaceDir: path.resolve(ws),
      hostKind: 'workbuddy',
      identity: {
        sessionId: EVENT_IDENTITY.sessionId,
        toolCallId: EVENT_IDENTITY.toolCallId,
      },
      authorization: { minimalMetadataGranted: true },
    });
    const validateArg: unknown = validateSpy.mock.calls.at(-1);
    expect(validateArg).toMatchObject([{ painId }, { workspaceDir: path.resolve(ws) }]);

    const mgr = new RuntimeStateManager({ workspaceDir: ws });
    await mgr.initialize();
    try {
      const task = await mgr.getTask(taskId);
      if (task === null) throw new Error('task missing');
      expect(task.inputRef).toBe(painId);
      const diagnostic = JSON.parse(task.diagnosticJson);
      expect(diagnostic.sessionIdHint).toBe(EVENT_IDENTITY.sessionId);
      // EXACT equality: no submissionTurnId / targetTurnId may appear — the
      // WorkBuddy event provides no proven turn id (review round).
      expect(diagnostic.painIngress.verifiedHostSession).toEqual({
        status: 'verified',
        sessionId: EVENT_IDENTITY.sessionId,
      });
      expect(diagnostic.recovery.receiptRef.toolCallId).toBe(EVENT_IDENTITY.toolCallId);
    } finally {
      await mgr.close();
    }
  });

  it('generation_id is NOT mapped to a submission/target turn (unproven equivalence): the Core identity is session + call only', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000122_ac000122';
    const taskId = await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: arrayEnvelopeReceipt(painId, ws),
      identity: { sessionId: EVENT_IDENTITY.sessionId, toolCallId: EVENT_IDENTITY.toolCallId },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('recovered');
    if (result.outcome.status !== 'recovered') return;
    expect(result.outcome.taskId).toBe(taskId);
    const recoverArg: unknown = recoverSpy.mock.calls.at(-1)?.[0];
    expect(recoverArg).toMatchObject({ hostKind: 'workbuddy', identity: { sessionId: EVENT_IDENTITY.sessionId, toolCallId: EVENT_IDENTITY.toolCallId } });
    // The Core call must not receive a submission turn — not even undefined
    // spelled differently: the identity object carries exactly two ids.
    expect(recoverArg).not.toMatchObject({ identity: { submissionTurnId: expect.anything() } });
    expect(recoverArg).not.toMatchObject({ identity: { targetTurnId: expect.anything() } });
  });

  it('P2: a multi-text-block envelope is ambiguous and rejected, not first-block-trusted', async () => {
    const ws = workspace();
    const envelope = [
      { type: 'text', text: JSON.stringify({ schemaVersion: 'pd.pain-submit-receipt.v1', painId: 'mcp_a' }) },
      { type: 'text', text: '{"maybe":"another task receipt"}' },
    ];
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: envelope,
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('receipt_envelope_ambiguous_content');
  });

  it('an envelope with ZERO text blocks is content_missing (no block to trust)', async () => {
    const ws = workspace();
    for (const toolResponse of [[], [{ type: 'image', data: 'x' }]]) {
      const result = await attemptPainReceiptFallback({
        workspaceDir: ws,
        toolName: REAL_TOOL_NAME,
        toolResponse,
        identity: { ...EVENT_IDENTITY },
        minimalMetadataGranted: true,
      });
      expect(result.status).toBe('attempted');
      if (result.status !== 'attempted') return;
      expect(result.outcome.status).toBe('rejected');
      if (result.outcome.status !== 'rejected') return;
      expect(result.outcome.reasonCode).toBe('receipt_envelope_content_missing');
    }
  });

  it('a NON-ARRAY tool_response is not a receipt envelope (WorkBuddy MCP tools always arrive as arrays)', async () => {
    const ws = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: '    Directory: D:\\ws\r\nMode   Name\r\n----   ----',
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('receipt_envelope_not_content_array');
  });

  it('a non-record content block makes the whole envelope block_invalid (rc-4: elements are validated)', async () => {
    const ws = workspace();
    for (const block of [42, [{ type: 'text', text: 'nested' }]]) {
      const result = await attemptPainReceiptFallback({
        workspaceDir: ws,
        toolName: REAL_TOOL_NAME,
        toolResponse: [{ type: 'text', text: '{}' }, block],
        identity: { ...EVENT_IDENTITY },
        minimalMetadataGranted: true,
      });
      expect(result.status).toBe('attempted');
      if (result.status !== 'attempted') return;
      expect(result.outcome.status).toBe('rejected');
      if (result.outcome.status !== 'rejected') return;
      expect(result.outcome.reasonCode).toBe('receipt_envelope_block_invalid');
    }
  });

  it('a non-JSON text block is not a receipt — no recovery from free text', async () => {
    const ws = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: [{ type: 'text', text: "Submission status is 'submitted'; taskId is 'diagnosis_x'." }],
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('receipt_text_not_json');
  });
});

describe('attemptPainReceiptFallback — event identity normalization', () => {
  function attempt(identity: unknown, toolResponse: unknown): Promise<ReturnType<typeof attemptPainReceiptFallback>> {
    const ws = workspace();
    return attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse,
      // The public parameter type cannot express an ABSENT required id (that
      // state exists only for non-typed callers) — the deliberately malformed
      // identity is built through JSON.parse (JSON.stringify drops undefined
      // fields) instead of an `as` cast; the runtime branch under test is the
      // same one a JS caller hits.
      identity: JSON.parse(JSON.stringify(identity)),
      minimalMetadataGranted: true,
    });
  }

  it('a MISSING session or toolCall id is rejected as event_identity_missing (rc-3)', async () => {
    for (const identity of [
      { toolCallId: EVENT_IDENTITY.toolCallId },
      { sessionId: EVENT_IDENTITY.sessionId },
    ]) {
      const result = await attempt(identity, arrayEnvelopeReceipt('mcp_x', workspace()));
      expect(result.status).toBe('attempted');
      if (result.status !== 'attempted') return;
      expect(result.outcome.status).toBe('rejected');
      if (result.outcome.status !== 'rejected') return;
      expect(result.outcome.reasonCode).toBe('event_identity_missing');
    }
  });

  it('MALFORMED ids (sentinel spelling, oversize) are rejected as event_identity_invalid', async () => {
    for (const identity of [
      { ...EVENT_IDENTITY, sessionId: 'cli' },
      { ...EVENT_IDENTITY, sessionId: 'w'.repeat(201) },
      { ...EVENT_IDENTITY, toolCallId: 'unknown' },
      { ...EVENT_IDENTITY, toolCallId: 'x'.repeat(201) },
    ]) {
      const result = await attempt(identity, arrayEnvelopeReceipt('mcp_x', workspace()));
      expect(result.status).toBe('attempted');
      if (result.status !== 'attempted') return;
      expect(result.outcome.status).toBe('rejected');
      if (result.outcome.status !== 'rejected') return;
      expect(result.outcome.reasonCode).toBe('event_identity_invalid');
    }
  });

  it('padded ids are TRIMMED before recovery (one identity spelling reaches Core)', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000123_ad000123';
    const taskId = await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: arrayEnvelopeReceipt(painId, ws),
      identity: {
        sessionId: ` ${EVENT_IDENTITY.sessionId} `,
        toolCallId: ` ${EVENT_IDENTITY.toolCallId} `,
      },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('recovered');
    if (result.outcome.status !== 'recovered') return;
    expect(result.outcome.taskId).toBe(taskId);
    const recoverArg: unknown = recoverSpy.mock.calls.at(-1)?.[0];
    expect(recoverArg).toMatchObject({ identity: { sessionId: EVENT_IDENTITY.sessionId, toolCallId: EVENT_IDENTITY.toolCallId } });
  });
});

describe('attemptPainReceiptFallback — workspace spelling normalization', () => {
  it('a receipt workspace spelled with a trailing separator + "." resolves to the SAME workspace', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000124_ae000124';
    await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: arrayEnvelopeReceipt(painId, `${ws}${path.sep}.`),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('recovered');
  });

  it('a genuinely DIFFERENT workspace receipt is still rejected after normalization', async () => {
    const ws = workspace();
    const other = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: arrayEnvelopeReceipt('mcp_x', other),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('receipt_workspace_mismatch');
  });
});

describe('attemptPainReceiptFallback — the prebound happy path is NOT a fallback case', () => {
  it('a `submitted` receipt that is already `verified` short-circuits to not_applicable (no store read, no degraded line)', async () => {
    // The trusted `_meta` path bound this identity at the initial write, so
    // there is nothing to repair. Before the short-circuit the recovery was
    // still entered and answered `already_bound`, which the hook renders as
    // `status=degraded reason=pain_receipt_idempotent:…` on EVERY successful
    // submission — routine noise over the actionable degraded signals.
    const ws = workspace();
    const painId = 'mcp_1700000000127_c1000127';
    await persistUnboundPain(ws, painId);
    recoverSpy.mockClear();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: arrayEnvelopeReceipt(painId, ws, {
        sessionAssociation: { status: 'verified', sessionId: EVENT_IDENTITY.sessionId },
      }),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result).toEqual({ status: 'not_applicable' });
    // No diagnostic at all — `painReceiptFallbackDiagnostic` is silent for
    // not_applicable, so the hook emits zero receipt lines for this event.
    expect(painReceiptFallbackDiagnostic(result)).toBeNull();
    expect(recoverSpy).not.toHaveBeenCalled();
  });

  it('`submit_unconfirmed` is NOT short-circuited — its write outcome is unknown, the read-back recovery still runs', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000128_c2000128';
    const taskId = await persistUnboundPain(ws, painId);
    recoverSpy.mockClear();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: arrayEnvelopeReceipt(painId, ws, {
        status: 'submit_unconfirmed',
        sessionAssociation: { status: 'verified', sessionId: EVENT_IDENTITY.sessionId },
      }),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    // The original task exists (read-back confirmed) and the receipt says
    // verified, so the recovery binds it — never a silent skip.
    expect(result.outcome.status).toBe('recovered');
    if (result.outcome.status !== 'recovered') return;
    expect(result.outcome.taskId).toBe(taskId);
  });
});

describe('attemptPainReceiptFallback — authorization and idempotency', () => {
  it('authorization off records blocked_by_consent on the original task (ids never persisted)', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000125_af000125';
    const taskId = await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: arrayEnvelopeReceipt(painId, ws),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: false,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('blocked_by_consent');

    const mgr = new RuntimeStateManager({ workspaceDir: ws });
    await mgr.initialize();
    try {
      const task = await mgr.getTask(taskId);
      const raw = task?.diagnosticJson ?? '{}';
      const diagnostic = JSON.parse(raw);
      expect(diagnostic.sessionIdHint).toBeNull();
      expect(diagnostic.recovery.state).toBe('blocked_by_consent');
      // With the authorization OFF, no identity metadata at all.
      expect(Object.hasOwn(diagnostic.recovery, 'receiptRef')).toBe(false);
      expect(raw).not.toContain(EVENT_IDENTITY.toolCallId);
      expect(raw).not.toContain(EVENT_IDENTITY.sessionId);
    } finally {
      await mgr.close();
    }
  });

  it('the same physical event replayed is idempotent (same toolCallId folds)', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000126_b0000126';
    await persistUnboundPain(ws, painId);
    const input = {
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: arrayEnvelopeReceipt(painId, ws),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    };
    const first = await attemptPainReceiptFallback(input);
    const second = await attemptPainReceiptFallback(input);
    expect(first.status).toBe('attempted');
    expect(second.status).toBe('attempted');
    if (first.status !== 'attempted' || second.status !== 'attempted') return;
    expect(first.outcome.status).toBe('recovered');
    expect(second.outcome.status).toBe('already_bound');
  });

  it('the target-text probe fails closed on an empty workspace (and never throws on degenerate ids)', () => {
    const ws = workspace();
    expect(workbuddyTargetTurnTextAvailable(ws, EVENT_IDENTITY.sessionId, 'turn-under-probe')).toBe(false);
    expect(workbuddyTargetTurnTextAvailable(ws, ' ', '')).toBe(false);
  });
});

describe('painReceiptFallbackDiagnostic — bounded stderr lines', () => {
  it('surfaces ids and codes only', () => {
    expect(painReceiptFallbackDiagnostic({ status: 'not_applicable' })).toBeNull();
    expect(painReceiptFallbackDiagnostic({
      status: 'attempted',
      outcome: { status: 'recovered', painId: 'p1', taskId: 't1', disposition: { state: 'waiting_for_target_evidence', reasonCode: 'target_turn_text_pending', attemptCount: 1, lastCheckedAt: 'x', schemaVersion: 1 } },
    })).toBe('pain_receipt_recovered:taskId=t1:state=waiting_for_target_evidence');
    expect(painReceiptFallbackDiagnostic({
      status: 'attempted', outcome: { status: 'already_bound', painId: 'p1', taskId: 't1' },
    })).toBe('pain_receipt_idempotent:taskId=t1');
    expect(painReceiptFallbackDiagnostic({
      status: 'attempted', outcome: { status: 'rejected', reasonCode: 'blocked_by_consent', painId: 'p1', taskId: 't1' },
    })).toBe('pain_receipt_rejected:blocked_by_consent:taskId=t1');
  });
});
