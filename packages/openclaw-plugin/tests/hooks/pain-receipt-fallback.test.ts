/**
 * PRI-1276 (B2) — OpenClaw `after_tool_call` structured-receipt fallback.
 *
 * Mirrors the WorkBuddy slice (PRI-1275) against OpenClaw's OWN envelope,
 * probe-derived from the installed 2026.11.5 dist (audit
 * `PRI1276_OPENCLAW_HOST_IDENTITY_AUDIT_20261125.md` §2.4/§2.5 — never
 * assumed from Codex's single-object envelope or the WorkBuddy content-block
 * array):
 *   - the tool name gate is EXACT equality on `pd-recall__pd_submit_pain`
 *     (dist naming `{safeServer}__{tool}`, hyphen kept, NO `mcp__` prefix);
 *   - the event `result` is the agent tool result
 *     `{content:[{type:'text',text:<JSON of legacy CallToolResult>}],
 *      details:{mcpServer,...}}` — the receipt is DOUBLE-ENCODED;
 *   - identity = context `sessionId` + event `toolCallId`; the event runId
 *     joins only to the exact persisted user-turn identity captured by the
 *     same prompt run (never using runId as a turn id);
 *   - hand-off into the Core CAS recovery carries hostKind 'openclaw'.
 *
 * The Core barrel is mocked as a spy-through (importOriginal + delegation):
 * the REAL validate/recovery still runs against a REAL unbound task created
 * by the REAL submit capability, while the spy asserts the exact normalized
 * contract crossing the plugin → Core boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeStateManager, getDefaultPdConfig } from '@principles/core/runtime';
import { recordConversationIngestionConsent } from '@principles/host-runtime';
import {
  buildReconciledSubmitReceipt,
  buildUnconfirmedSubmitReceipt,
  deriveSubmitTaskId,
  submitPainCapability,
} from '@principles/core/runtime/pain-submit-capability';

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

import { captureOpenclawUserTurnForTargetEvidence } from '../../src/hooks/openclaw-target-turn-capture.js';
import { clearOpenclawRunTurnCorrelationsForTest, rememberOpenclawRunTurnCorrelation } from '../../src/hooks/openclaw-run-turn-correlation.js';
import {
  OPENCLAW_PAIN_SUBMIT_SERVER_ID,
  attemptPainReceiptFallback,
  extractOpenclawReceipt,
  isPainSubmitOpenclawToolName,
  openclawTargetTurnTextAvailable,
  painReceiptFallbackDiagnostic,
  runAfterToolCallReceiptFallback,
} from '../../src/hooks/pain-receipt-fallback.js';

/** Identity shape of the REAL after_tool_call emission (installed 2026.11.5
 * dist, embedded-agent-subscribe): context `sessionId` + execution-record
 * `toolCallId`. No native submission-turn field; the local exact-turn join
 * is supplied separately by the same-run correlation map. */
const EVENT_IDENTITY = {
  sessionId: '0c1a2d3e-4f50-4a11-bcde-ac1234567890',
  toolCallId: 'call_01a20d41fdfd758fab694df2fe1fe263',
} as const;

const dirs: string[] = [];
function workspace(config?: { minimalMetadata: boolean }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-openclaw-receipt-'));
  if (config !== undefined) {
    const pdConfig = getDefaultPdConfig();
    pdConfig.features.host_identity_minimal_metadata.enabled = config.minimalMetadata;
    fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(pdConfig));
  }
  dirs.push(root);
  return root;
}
afterEach(() => {
  clearOpenclawRunTurnCorrelationsForTest();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The original unbound task the REAL capability persists when the request
 * carried no trusted `_meta` and no claim (`host_session_claim_empty` — the
 * designated OpenClaw fallback territory). `agent_instruction` anchor: no
 * independently admissible Owner statement. */
async function persistUnboundPain(workspaceDir: string, painId: string): Promise<string> {
  const taskId = deriveSubmitTaskId(painId);
  const receipt = await submitPainCapability(
    {
      workspaceDir,
      stateDir: path.join(workspaceDir, '.state'),
      painId,
      taskId,
      hostKind: 'openclaw',
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

async function readDiagnostic(workspaceDir: string, taskId: string): Promise<Record<string, unknown>> {
  const manager = new RuntimeStateManager({ workspaceDir });
  await manager.initialize();
  try {
    const task = await manager.getTask(taskId);
    if (task === null) throw new Error('fixture task missing');
    return JSON.parse(task.diagnosticJson ?? '{}') as Record<string, unknown>;
  } finally {
    await manager.close();
  }
}

/** The REAL installed envelope (probe 2026-11-25, isolated gateway):
 * `{content:[{type:'text',text:<receipt JSON>}],details:{mcpServer:'pd-recall',mcpTool}}`
 * — SINGLE-encoded. */
function openclawEnvelope(callResult: unknown, details: Record<string, unknown> = { mcpServer: 'pd-recall', mcpTool: 'pd_submit_pain' }): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(callResult, null, 2) }],
    details,
  };
}

function receiptJson(painId: string, workspaceDir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'pd.pain-submit-receipt.v1',
    capability: 'pd_submit_pain',
    status: 'submitted',
    painId,
    taskId: deriveSubmitTaskId(painId),
    workspaceDir,
    diagnosis: { status: 'pending' },
    anchor: { type: 'owner_expectation', ref: 'Owner statement in this conversation' },
    provenance: 'agent_reported_owner_approved',
    warnings: [],
    error: null,
    nextAction: null,
    sessionAssociation: { status: 'unverified', detail: 'host_session_claim_empty' },
    ...overrides,
  };
}

/** The full REAL envelope for one submitted receipt. */
function envelopeForReceipt(painId: string, workspaceDir: string, overrides: Record<string, unknown> = {}): unknown {
  return openclawEnvelope(receiptJson(painId, workspaceDir, overrides));
}

/** The dist-derived LEGACY double-encoded variant: the legacy CallToolResult
 * wraps the receipt in its own content blocks inside the layer-1 text. */
function legacyDoubleEncodedEnvelope(receiptText: string): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text', text: receiptText }], isError: false }) }],
    details: { mcpServer: 'pd-recall', mcpTool: 'pd_submit_pain' },
  };
}

describe('P1-1 — exact tool-name gate (real OpenClaw materialized naming)', () => {
  it('accepts ONLY the exact materialized PD name — no mcp__ prefix, hyphen preserved', () => {
    expect(OPENCLAW_PAIN_SUBMIT_SERVER_ID).toBe('pd-recall');
    expect(isPainSubmitOpenclawToolName('pd-recall__pd_submit_pain')).toBe(true);
  });

  it('isolates every other spelling — equality, never substring/regex', () => {
    // The WorkBuddy/Codex foreign-engine spelling is NOT this host's name.
    expect(isPainSubmitOpenclawToolName('mcp__pd-recall__pd_submit_pain')).toBe(false);
    // A sanitized-looking server id is a DIFFERENT third-party server.
    expect(isPainSubmitOpenclawToolName('pd_recall__pd_submit_pain')).toBe(false);
    expect(isPainSubmitOpenclawToolName('other__pd_submit_pain')).toBe(false);
    expect(isPainSubmitOpenclawToolName('pd-recall__pd_recall_principle_pains')).toBe(false);
    // A collision-suffix rename (dist appends `-2`) stops matching → fail
    // closed, the designed direction.
    expect(isPainSubmitOpenclawToolName('pd-recall-2__pd_submit_pain')).toBe(false);
    expect(isPainSubmitOpenclawToolName('pd-recall__pd_submit_pain_extra')).toBe(false);
    expect(isPainSubmitOpenclawToolName('pd_submit_pain')).toBe(false);
    expect(isPainSubmitOpenclawToolName('Bash')).toBe(false);
    expect(isPainSubmitOpenclawToolName('pain')).toBe(false);
  });

  it('attemptPainReceiptFallback is not_applicable for every non-PD tool', async () => {
    const ws = workspace();
    for (const toolName of ['pd_recall__pd_submit_pain', 'mcp__pd-recall__pd_submit_pain', 'other__pd_submit_pain', 'pd-recall__other_tool', 'Bash', 'pain']) {
      const result = await attemptPainReceiptFallback({
        workspaceDir: ws,
        toolName,
        toolResult: openclawEnvelope({ content: [{ type: 'text', text: '{not json' }], isError: false }),
        identity: { ...EVENT_IDENTITY },
        minimalMetadataGranted: true,
      });
      expect(result).toEqual({ status: 'not_applicable' });
    }
  });
});

describe('envelope — OpenClaw SINGLE-encoded MCP result (probe 2026-11-25, audit §2.5 r2)', () => {
  it('parses the REAL single-encoded envelope straight to the receipt object', () => {
    const extracted = extractOpenclawReceipt(envelopeForReceipt('mcp_x', 'D:/w'));
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect((extracted.receipt as Record<string, unknown>).schemaVersion).toBe('pd.pain-submit-receipt.v1');
  });

  it('accepts the dist-derived double-encoded variant as legacy tolerance', () => {
    const extracted = extractOpenclawReceipt(legacyDoubleEncodedEnvelope(JSON.stringify(receiptJson('mcp_y', 'D:/w'))));
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect((extracted.receipt as Record<string, unknown>).schemaVersion).toBe('pd.pain-submit-receipt.v1');
  });

  it('rejects a foreign server attribution in details.mcpServer', () => {
    const extracted = extractOpenclawReceipt(
      openclawEnvelope(receiptJson('mcp_x', 'D:/w'), { mcpServer: 'evil-clone', mcpTool: 'pd_submit_pain' }),
    );
    expect(extracted).toEqual({ ok: false, reasonCode: 'receipt_envelope_foreign_server' });
  });

  it('rejects missing / non-object / non-array results and ambiguous blocks', () => {
    expect(extractOpenclawReceipt(undefined)).toEqual({ ok: false, reasonCode: 'receipt_envelope_result_missing' });
    expect(extractOpenclawReceipt('text')).toEqual({ ok: false, reasonCode: 'receipt_envelope_result_missing' });
    expect(extractOpenclawReceipt({ details: { mcpServer: 'pd-recall' } })).toEqual({ ok: false, reasonCode: 'receipt_envelope_content_missing' });
    expect(extractOpenclawReceipt({ content: 'nope' })).toEqual({ ok: false, reasonCode: 'receipt_envelope_content_missing' });
    expect(extractOpenclawReceipt({ content: [] })).toEqual({ ok: false, reasonCode: 'receipt_envelope_content_missing' });
    expect(extractOpenclawReceipt({ content: [{ type: 'text' }] })).toEqual({ ok: false, reasonCode: 'receipt_envelope_content_missing' });
    // More than one text block could each carry a different task's receipt —
    // ambiguous, never first-wins.
    expect(extractOpenclawReceipt({
      content: [
        { type: 'text', text: JSON.stringify(receiptJson('mcp_a', 'D:/w')) },
        { type: 'text', text: JSON.stringify(receiptJson('mcp_b', 'D:/w')) },
      ],
    })).toEqual({ ok: false, reasonCode: 'receipt_envelope_ambiguous_content' });
    // Layer-1 text that is not JSON (plain-text degradation) or not an object.
    expect(extractOpenclawReceipt(openclawEnvelope('just text')))
      .toEqual({ ok: false, reasonCode: 'receipt_envelope_not_call_result' });
    // A foreign SINGLE-encoded object parses fine at the envelope layer —
    // Core receipt validation rejects it on its own merits later.
    expect(extractOpenclawReceipt(openclawEnvelope({ broken: 7 }))).toMatchObject({ ok: true });
    expect(extractOpenclawReceipt({ content: [{ type: 'text', text: '{broken' }] }))
      .toEqual({ ok: false, reasonCode: 'receipt_envelope_not_call_result' });
    // A legacy CallToolResult whose inner text is broken is rejected too.
    expect(extractOpenclawReceipt(legacyDoubleEncodedEnvelope('{broken')))
      .toEqual({ ok: false, reasonCode: 'receipt_envelope_not_call_result' });
  });

  it('a dispatch-error result (non-block element) is a structured rejection, never a crash', () => {
    expect(extractOpenclawReceipt({ content: [{ type: 'text', text: 'ok' }, 42] }))
      .toEqual({ ok: false, reasonCode: 'receipt_envelope_block_invalid' });
  });
});

describe('attemptPainReceiptFallback — identity normalization and missing fields', () => {
  it('missing sessionId or toolCallId is a structured rejection (no bind, no crash)', async () => {
    const ws = workspace();
    for (const identity of [
      { sessionId: undefined, toolCallId: EVENT_IDENTITY.toolCallId },
      { sessionId: EVENT_IDENTITY.sessionId, toolCallId: undefined },
    ]) {
      const result = await attemptPainReceiptFallback({
        workspaceDir: ws,
        toolName: 'pd-recall__pd_submit_pain',
        toolResult: envelopeForReceipt('mcp_x', ws),
        identity,
        minimalMetadataGranted: true,
      });
      expect(result.status).toBe('attempted');
      if (result.status !== 'attempted') return;
      expect(result.outcome).toMatchObject({ status: 'rejected', reasonCode: 'event_identity_missing' });
    }
  });

  it('sentinel or non-string identity values are invalid, never a bind', async () => {
    const ws = workspace();
    for (const identity of [
      { sessionId: 'cli', toolCallId: EVENT_IDENTITY.toolCallId },
      { sessionId: 'unknown', toolCallId: EVENT_IDENTITY.toolCallId },
      { sessionId: 42, toolCallId: EVENT_IDENTITY.toolCallId },
      { sessionId: EVENT_IDENTITY.sessionId, toolCallId: 'cli' },
    ]) {
      const result = await attemptPainReceiptFallback({
        workspaceDir: ws,
        toolName: 'pd-recall__pd_submit_pain',
        toolResult: envelopeForReceipt('mcp_x', ws),
        identity: identity as { sessionId: string; toolCallId: string },
        minimalMetadataGranted: true,
      });
      expect(result.status).toBe('attempted');
      if (result.status !== 'attempted') return;
      expect(result.outcome).toMatchObject({ status: 'rejected', reasonCode: 'event_identity_invalid' });
    }
  });

  it('non-JSON receipt text is a structured rejection (no recovery from free text)', async () => {
    const ws = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: 'pd-recall__pd_submit_pain',
      toolResult: openclawEnvelope({ note: 'Pain submitted successfully.' }),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    // A foreign single-encoded object is not a receipt — Core validation
    // rejects it on its own merits (unknown surface).
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status === 'rejected') {
      expect(result.outcome.reasonCode).toMatch(/^receipt_/);
    }
  });
});

describe('runAfterToolCallReceiptFallback — exact same-run target-turn association', () => {
  it('recovers the original task against the exact rowid captured by before_prompt_build', async () => {
    const ws = workspace({ minimalMetadata: true });
    const painId = 'mcp_1764000000030_cc000030';
    const taskId = await persistUnboundPain(ws, painId);
    const sessionId = EVENT_IDENTITY.sessionId;
    const runId = 'openclaw-run-exact-target-30';
    const targetTurnId = 'user-turn-row:77';
    const consent = recordConversationIngestionConsent(ws, 'openclaw', {
      decision: 'granted',
      decidedVia: 'owner_directive',
      disclosureVersion: 'test-v1',
      evidenceRef: 'pri-1296-same-run-target',
    });
    expect(consent.ok).toBe(true);
    captureOpenclawUserTurnForTargetEvidence({
      workspaceDir: ws,
      sessionId,
      hostTurnId: undefined,
      fallbackHostTurnId: targetTurnId,
      text: 'the exact embedded owner message',
    });
    expect(rememberOpenclawRunTurnCorrelation({
      workspaceDir: ws,
      sessionId,
      runId,
      targetTurnId,
      message: 'the exact embedded owner message',
    })).toBe(true);

    const result = await runAfterToolCallReceiptFallback({
      workspaceDir: ws,
      event: {
        toolName: 'pd-recall__pd_submit_pain',
        runId,
        toolCallId: EVENT_IDENTITY.toolCallId,
        result: envelopeForReceipt(painId, ws),
      },
      ctx: { sessionId },
    });
    expect(result.line).toBe(`pain_receipt_recovered:taskId=${taskId}:state=ready_for_diagnosis`);
    expect(recoverSpy).toHaveBeenCalledWith(expect.objectContaining({
      identity: {
        sessionId,
        toolCallId: EVENT_IDENTITY.toolCallId,
        targetTurnId,
      },
      requireTargetTurnIdentity: true,
    }));

    const diagnostic = await readDiagnostic(ws, taskId);
    const verified = ((diagnostic.painIngress as Record<string, unknown>).verifiedHostSession) as Record<string, unknown>;
    expect(verified.targetTurnId).toBe(targetTurnId);
    expect(verified.submissionTurnId).toBeUndefined();
    expect(diagnostic.evidence).toEqual([{
      sourceRef: `governance_observation:openclaw|${sessionId}|${targetTurnId}|user`,
      note: 'the exact embedded owner message',
    }]);
    expect(diagnostic.recovery).toMatchObject({ state: 'ready_for_diagnosis', reasonCode: 'target_evidence_arrived' });
  });

  it('keeps a task unbound when the after_tool_call run has no same-run turn mapping', async () => {
    const ws = workspace({ minimalMetadata: true });
    const painId = 'mcp_1764000000031_cc000031';
    const taskId = await persistUnboundPain(ws, painId);
    const result = await runAfterToolCallReceiptFallback({
      workspaceDir: ws,
      event: {
        toolName: 'pd-recall__pd_submit_pain',
        runId: 'openclaw-run-without-capture',
        toolCallId: EVENT_IDENTITY.toolCallId,
        result: envelopeForReceipt(painId, ws),
      },
      ctx: { sessionId: EVENT_IDENTITY.sessionId },
    });
    expect(result.line).toBe(`pain_receipt_rejected:target_turn_identity_unavailable:stage=after_tool_call:unbound=true:taskId=${taskId}`);
    const diagnostic = await readDiagnostic(ws, taskId);
    expect(diagnostic.sessionIdHint).toBeNull();
    expect((diagnostic.recovery as Record<string, unknown> | undefined)?.state).not.toBe('ready_for_diagnosis');
  });
});

describe('attemptPainReceiptFallback — REAL recovery against the REAL task store', () => {
  it('recovers the SAME original task (CAS), folds the replay, and keeps exactly one task', async () => {
    const ws = workspace();
    const painId = 'mcp_1764000000001_aa000001';
    const taskId = await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: 'pd-recall__pd_submit_pain',
      toolResult: envelopeForReceipt(painId, ws),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted' || result.outcome.status !== 'recovered') {
      throw new Error(`expected recovered, got ${JSON.stringify(result)}`);
    }
    expect(result.outcome.taskId).toBe(taskId);
    // The Core boundary contract: hostKind openclaw, ids normalized, no turn.
    expect(recoverSpy).toHaveBeenCalledWith(expect.objectContaining({
      workspaceDir: path.resolve(ws),
      hostKind: 'openclaw',
      identity: { sessionId: EVENT_IDENTITY.sessionId, toolCallId: EVENT_IDENTITY.toolCallId },
    }));

    const diagnostic = await readDiagnostic(ws, taskId);
    expect(diagnostic.sessionIdHint).toBe(EVENT_IDENTITY.sessionId);
    const painIngress = diagnostic.painIngress as Record<string, unknown>;
    expect((painIngress.verifiedHostSession as Record<string, unknown>).sessionId).toBe(EVENT_IDENTITY.sessionId);
    expect((diagnostic.recovery as Record<string, unknown>).state).toBe('ready_for_diagnosis');

    // Same physical call replayed → idempotent, no second write.
    const replay = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: 'pd-recall__pd_submit_pain',
      toolResult: envelopeForReceipt(painId, ws),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(replay.status).toBe('attempted');
    if (replay.status !== 'attempted') return;
    expect(replay.outcome).toMatchObject({ status: 'already_bound', taskId });
  });

  it('recovers through the server\'s actual reconciled timeout receipt (association verdict retained)', async () => {
    const ws = workspace();
    const painId = 'mcp_1764000000010_aa000010';
    const taskId = await persistUnboundPain(ws, painId);
    const timeoutReceipt = buildReconciledSubmitReceipt({
      painId,
      taskId,
      workspaceDir: ws,
      sessionAssociation: { status: 'unverified', detail: 'host_session_claim_empty' },
    });
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: 'pd-recall__pd_submit_pain',
      toolResult: openclawEnvelope(timeoutReceipt),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome).toMatchObject({ status: 'recovered', taskId });
  });

  it('a timeout receipt WITHOUT sessionAssociation still fails closed instead of becoming recoverable', async () => {
    const ws = workspace();
    const painId = 'mcp_1764000000014_aa000014';
    const taskId = await persistUnboundPain(ws, painId);
    const legacyTimeoutReceipt = buildReconciledSubmitReceipt({ painId, taskId, workspaceDir: ws });
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: 'pd-recall__pd_submit_pain',
      toolResult: openclawEnvelope(legacyTimeoutReceipt),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome).toMatchObject({ status: 'rejected', reasonCode: 'session_association_not_recoverable' });
    const diagnostic = await readDiagnostic(ws, taskId);
    expect(diagnostic.sessionIdHint).toBeNull();
  });

  it('the server\'s actual submit_unconfirmed timeout receipt still requires the exact read-back', async () => {
    const ws = workspace();
    // Initialize the real store with an unrelated task so the negative case is
    // an exact-ID miss, not a missing database.
    await persistUnboundPain(ws, 'mcp_1764000000011_aa000011');
    const missingPainId = 'mcp_1764000000012_aa000012';
    const missingReceipt = buildUnconfirmedSubmitReceipt({
      painId: missingPainId,
      taskId: deriveSubmitTaskId(missingPainId),
      workspaceDir: ws,
      message: 'timeout before the write outcome was known',
      sessionAssociation: { status: 'unverified', detail: 'host_session_claim_empty' },
    });
    const missing = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: 'pd-recall__pd_submit_pain',
      toolResult: openclawEnvelope(missingReceipt),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(missing.status).toBe('attempted');
    if (missing.status !== 'attempted') return;
    expect(missing.outcome).toMatchObject({ status: 'rejected', reasonCode: 'submit_unconfirmed_task_not_found' });

    const painId = 'mcp_1764000000013_aa000013';
    const taskId = await persistUnboundPain(ws, painId);
    const timeoutReceipt = buildUnconfirmedSubmitReceipt({
      painId,
      taskId,
      workspaceDir: ws,
      message: 'timeout before the write outcome was known',
      sessionAssociation: { status: 'unverified', detail: 'host_session_claim_empty' },
    });
    const recovered = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: 'pd-recall__pd_submit_pain',
      toolResult: openclawEnvelope(timeoutReceipt),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(recovered.status).toBe('attempted');
    if (recovered.status !== 'attempted') return;
    expect(recovered.outcome).toMatchObject({ status: 'recovered', taskId });
  });

  it('a different toolCallId on the same task is ambiguous and never overwrites', async () => {
    const ws = workspace();
    const painId = 'mcp_1764000000002_bb000002';
    await persistUnboundPain(ws, painId);
    const first = await attemptPainReceiptFallback({
      workspaceDir: ws, toolName: 'pd-recall__pd_submit_pain',
      toolResult: envelopeForReceipt(painId, ws),
      identity: { ...EVENT_IDENTITY }, minimalMetadataGranted: true,
    });
    expect(first.status).toBe('attempted');
    if (first.status !== 'attempted' || first.outcome.status !== 'recovered') throw new Error('fixture first recovery failed');
    const second = await attemptPainReceiptFallback({
      workspaceDir: ws, toolName: 'pd-recall__pd_submit_pain',
      toolResult: envelopeForReceipt(painId, ws),
      identity: { sessionId: EVENT_IDENTITY.sessionId, toolCallId: 'call_different_physical' },
      minimalMetadataGranted: true,
    });
    expect(second.status).toBe('attempted');
    if (second.status !== 'attempted') return;
    expect(second.outcome).toMatchObject({ status: 'rejected', reasonCode: 'ambiguous_receipt' });
  });

  it('a receipt whose workspace differs is rejected (never cross-workspace)', async () => {
    const ws = workspace();
    const otherWs = workspace();
    const painId = 'mcp_1764000000003_cc000003';
    await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws, toolName: 'pd-recall__pd_submit_pain',
      // The envelope claims a DIFFERENT workspace.
      toolResult: envelopeForReceipt(painId, path.resolve(otherWs)),
      identity: { ...EVENT_IDENTITY }, minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome).toMatchObject({ status: 'rejected', reasonCode: 'receipt_workspace_mismatch' });
  });

  it('invalid receipt surfaces (schema/capability/status/mapping) are structured rejections', async () => {
    const ws = workspace();
    const painId = 'mcp_1764000000004_dd000004';
    await persistUnboundPain(ws, painId);
    const cases: Record<string, Record<string, unknown>> = {
      schema: { schemaVersion: 'pd.pain-submit-receipt.v0' },
      capability: { capability: 'pd_submit_other_tool' },
      refused: { status: 'refused' },
      mapping: { taskId: deriveSubmitTaskId('mcp_other_pain') },
      association: { sessionAssociation: { status: 'unverified', detail: 'host_context_conflict' } },
    };
    for (const [label, overrides] of Object.entries(cases)) {
      const result = await attemptPainReceiptFallback({
        workspaceDir: ws, toolName: 'pd-recall__pd_submit_pain',
        toolResult: envelopeForReceipt(painId, ws, overrides),
        identity: { ...EVENT_IDENTITY }, minimalMetadataGranted: true,
      });
      expect(result.status, label).toBe('attempted');
      if (result.status !== 'attempted') return;
      if (label === 'association') {
        // The P1-2 security gate: a fail-closed main-path refusal is NEVER
        // overturned by the completion event.
        expect(result.outcome).toMatchObject({ status: 'rejected', reasonCode: 'session_association_not_recoverable' });
      } else {
        expect(result.outcome.status, label).toBe('rejected');
        if (result.outcome.status === 'rejected') {
          expect(result.outcome.reasonCode, label).toMatch(/^receipt_/);
        }
      }
    }
  });

  it('authorization OFF: no identity write, blocked_by_consent disposition persisted (rc-9)', async () => {
    const ws = workspace();
    const painId = 'mcp_1764000000005_ee000005';
    const taskId = await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws, toolName: 'pd-recall__pd_submit_pain',
      toolResult: envelopeForReceipt(painId, ws),
      identity: { ...EVENT_IDENTITY }, minimalMetadataGranted: false,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome).toMatchObject({ status: 'rejected', reasonCode: 'blocked_by_consent' });
    const diagnostic = await readDiagnostic(ws, taskId);
    // No identity fields — but the WHY is persisted and observable.
    expect(diagnostic.sessionIdHint).toBeNull();
    expect(Object.hasOwn(diagnostic, 'recovery')).toBe(true);
    expect((diagnostic.recovery as Record<string, unknown>).state).toBe('blocked_by_consent');
  });
});

describe('runAfterToolCallReceiptFallback — hook entry (flags from the CURRENT config)', () => {
  it('routes a non-PD tool to not_applicable without touching the config', async () => {
    const ws = workspace({ minimalMetadata: true });
    const result = await runAfterToolCallReceiptFallback({
      event: { toolName: 'Bash', result: {} },
      ctx: { sessionId: EVENT_IDENTITY.sessionId },
      workspaceDir: ws,
    });
    expect(result).toEqual({ line: null, notApplicableReason: 'tool_not_pd_submit_pain' });
  });

  it('authorized workspace: one bounded recovered/idempotent line, ids only', async () => {
    const ws = workspace({ minimalMetadata: true });
    const painId = 'mcp_1764000000006_ff000006';
    await persistUnboundPain(ws, painId);
    const first = await runAfterToolCallReceiptFallback({
      event: {
        toolName: 'pd-recall__pd_submit_pain',
        toolCallId: EVENT_IDENTITY.toolCallId,
        result: envelopeForReceipt(painId, ws),
      },
      ctx: { sessionId: EVENT_IDENTITY.sessionId, toolCallId: 'ctx-fallback-id' },
      workspaceDir: ws,
    });
    expect(first.line).toBe(`pain_receipt_recovered:taskId=${deriveSubmitTaskId(painId)}:state=ready_for_diagnosis`);
    const second = await runAfterToolCallReceiptFallback({
      event: {
        toolName: 'pd-recall__pd_submit_pain',
        toolCallId: EVENT_IDENTITY.toolCallId,
        result: envelopeForReceipt(painId, ws),
      },
      ctx: { sessionId: EVENT_IDENTITY.sessionId },
      workspaceDir: ws,
    });
    expect(second.line).toBe(`pain_receipt_idempotent:taskId=${deriveSubmitTaskId(painId)}`);
  });

  it('revoking the authorization takes effect on the NEXT event without a restart', async () => {
    const ws = workspace({ minimalMetadata: true });
    const painId = 'mcp_1764000000007_aa000007';
    await persistUnboundPain(ws, painId);
    const before = await runAfterToolCallReceiptFallback({
      event: { toolName: 'pd-recall__pd_submit_pain', toolCallId: EVENT_IDENTITY.toolCallId, result: envelopeForReceipt(painId, ws) },
      ctx: { sessionId: EVENT_IDENTITY.sessionId },
      workspaceDir: ws,
    });
    expect(before.line).toContain('pain_receipt_recovered');
    // Workspace admin flips the flag OFF behind the running gateway.
    const pdConfig = getDefaultPdConfig();
    pdConfig.features.host_identity_minimal_metadata.enabled = false;
    fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), JSON.stringify(pdConfig));
    const otherPain = 'mcp_1764000000008_bb000008';
    await persistUnboundPain(ws, otherPain);
    const after = await runAfterToolCallReceiptFallback({
      event: { toolName: 'pd-recall__pd_submit_pain', toolCallId: 'call_after_revocation', result: envelopeForReceipt(otherPain, ws) },
      ctx: { sessionId: EVENT_IDENTITY.sessionId },
      workspaceDir: ws,
    });
    expect(after.line).toContain('pain_receipt_rejected:blocked_by_consent');
    expect(after.line).toContain('unbound=true');
  });

  it('a malformed workspace config fails the identity path closed (no grant)', async () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), 'features: [broken');
    const painId = 'mcp_1764000000009_cc000009';
    await persistUnboundPain(ws, painId);
    const result = await runAfterToolCallReceiptFallback({
      event: { toolName: 'pd-recall__pd_submit_pain', toolCallId: EVENT_IDENTITY.toolCallId, result: envelopeForReceipt(painId, ws) },
      ctx: { sessionId: EVENT_IDENTITY.sessionId },
      workspaceDir: ws,
    });
    expect(result.line).toContain('blocked_by_consent');
  });
});

describe('diagnostics — bounded, ids and codes only', () => {
  it('not_applicable yields no line', () => {
    expect(painReceiptFallbackDiagnostic({ status: 'not_applicable' })).toBeNull();
  });

  it('unknown-state rejections carry the stage but NOT unbound=true — and never the raw detail (path-leak surface)', () => {
    const line = painReceiptFallbackDiagnostic({
      status: 'attempted',
      outcome: {
        status: 'rejected',
        reasonCode: 'recovery_store_error',
        // Core fills detail with a raw exception message that can embed an
        // absolute workspace path — the ids-only line must not echo it.
        detail: 'SqliteError: unable to open D:\\secret\\paths\\ws\\.pd\\state.db',
        painId: 'mcp_p',
        taskId: 'task_p',
      },
    });
    expect(line).toContain('pain_receipt_rejected:recovery_store_error');
    expect(line).toContain('stage=after_tool_call');
    expect(line).not.toContain('unbound=');
    expect(line).toContain('taskId=task_p');
    expect(line).not.toContain('detail=');
    expect(line).not.toContain('secret');
    expect(line).not.toContain('\n');
  });

  it('unbound=true appears only when the recovery outcome proves the task was unbound', () => {
    const line = painReceiptFallbackDiagnostic({
      status: 'attempted',
      outcome: {
        status: 'rejected',
        reasonCode: 'blocked_by_consent',
        painId: 'mcp_p',
        taskId: 'task_p',
        taskUnbound: true,
      },
    });
    expect(line).toBe('pain_receipt_rejected:blocked_by_consent:stage=after_tool_call:unbound=true:taskId=task_p');
  });

  it('target-turn probe reads the exact (session, turn) or nothing', () => {
    const ws = workspace();
    // No authorized observation exists for this pair — a structured no.
    expect(openclawTargetTurnTextAvailable(ws, 'oc-session-x', 'turn-x')).toBe(false);
  });
});
