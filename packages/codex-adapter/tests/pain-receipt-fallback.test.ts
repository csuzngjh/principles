/**
 * PRI-1274 (B1) — PostToolUse structured-receipt fallback (adapter slice).
 *
 * The Codex envelope decode (single text content block, JSON in
 * `content[0].text`, never structuredContent), the strict hand-off into the
 * Core CAS recovery, and the authorization boundary — exercised against a
 * REAL unbound task created by the REAL submit capability.
 *
 * Review round 2 (P1-1): every positive case uses the REAL namespaced
 * PostToolUse tool name (`mcp__pd_recall__pd_submit_pain` — server
 * `pd-recall`, sanitized), never a bare `pd_submit_pain`; foreign servers
 * with an identically-named tool must stay isolated. P2: multi-block
 * envelopes are ambiguous, workspace spellings normalize before validation,
 * and event identity fields get the unified format/sentinel check.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeStateManager } from '@principles/core/runtime';
import { deriveSubmitTaskId, submitPainCapability } from '@principles/core/runtime/pain-submit-capability';
import {
  attemptPainReceiptFallback,
  codexTargetTurnTextAvailable,
  painReceiptFallbackDiagnostic,
} from '../src/ingestion/pain-receipt-fallback.js';
import {
  PAIN_SUBMIT_MCP_SERVER_IDS,
  isPainSubmitPostToolUseToolName,
  parseCodexMcpToolName,
} from '../src/codec/input-decoder.js';

/** The REAL PostToolUse tool name: server `pd-recall` sanitized to
 * `pd_recall` + tool `pd_submit_pain` (Gate 2 runtime capture + 0.171.0
 * binary template `mcp__{}__{}`). */
const REAL_TOOL_NAME = 'mcp__pd_recall__pd_submit_pain';

const dirs: string[] = [];
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-receipt-'));
  dirs.push(root);
  return root;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** Create the original unbound task through the REAL Core capability — the
 * exact row shape the MCP server persists when the request had no `_meta`.
 * `agent_instruction` anchor: this submission has no independently
 * admissible Owner statement, so the recovered task WAITs for its target
 * turn's text (the r2 default-path coverage). */
async function persistUnboundPain(workspaceDir: string, painId: string): Promise<string> {
  const taskId = deriveSubmitTaskId(painId);
  const receipt = await submitPainCapability(
    {
      workspaceDir,
      stateDir: path.join(workspaceDir, '.state'),
      painId,
      taskId,
      hostKind: 'codex',
      // The realistic unbound cause: the request carried no trusted _meta.
      verifyHostSession: () => ({ status: 'unverified', detail: 'codex_host_metadata_missing' }),
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

function envelopeReceipt(painId: string, workspaceDir: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    content: [{
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
        warnings: ['host_session_unverified:codex_host_metadata_missing'],
        error: null,
        nextAction: null,
        sessionAssociation: { status: 'unverified', detail: 'codex_host_metadata_missing' },
        ...overrides,
      }),
    }],
  };
}

const EVENT_IDENTITY = {
  sessionId: '0b21621e-0000-4000-8000-000000000001',
  turnId: '0b21621e-0000-4000-8000-000000000002',
  toolCallId: 'toolu-post-probe-1',
} as const;

describe('P1-1 — exact MCP namespace gate (real Codex naming)', () => {
  it('parses real namespaced names into server + tool ids', () => {
    expect(parseCodexMcpToolName('mcp__pd_recall__pd_submit_pain')).toEqual({ serverId: 'pd_recall', toolId: 'pd_submit_pain' });
    expect(parseCodexMcpToolName('mcp__memory__create_entities')).toEqual({ serverId: 'memory', toolId: 'create_entities' });
    expect(parseCodexMcpToolName('pd_submit_pain')).toBeNull();
    expect(parseCodexMcpToolName('mcp__onlyonesegment')).toBeNull();
    expect(parseCodexMcpToolName('mcp____leadingempty__pd_submit_pain')).toBeNull();
  });

  it('accepts exactly the PD server ids (configured and sanitized spellings) + pd_submit_pain', () => {
    expect(PAIN_SUBMIT_MCP_SERVER_IDS.has('pd-recall')).toBe(true);
    expect(PAIN_SUBMIT_MCP_SERVER_IDS.has('pd_recall')).toBe(true);
    expect(isPainSubmitPostToolUseToolName('mcp__pd_recall__pd_submit_pain')).toBe(true);
    expect(isPainSubmitPostToolUseToolName('mcp__pd-recall__pd_submit_pain')).toBe(true);
  });

  it('isolates every other server — including same-named tools (no substring matching)', () => {
    expect(isPainSubmitPostToolUseToolName('mcp__other_server__pd_submit_pain')).toBe(false);
    expect(isPainSubmitPostToolUseToolName('mcp__pd_recall_clone__pd_submit_pain')).toBe(false);
    expect(isPainSubmitPostToolUseToolName('mcp__pd_recall__pd_recall_principle_pains')).toBe(false);
    expect(isPainSubmitPostToolUseToolName('pd_submit_pain')).toBe(false);
    expect(isPainSubmitPostToolUseToolName('pd-recall__pd_submit_pain')).toBe(false);
    expect(isPainSubmitPostToolUseToolName('xmcp__pd_recall__pd_submit_pain')).toBe(false);
    expect(isPainSubmitPostToolUseToolName('mcp__pd_recall__pd_submit_pain_extra')).toBe(false);
  });
});

describe('attemptPainReceiptFallback — envelope decode and recovery', () => {
  it('recovers the original unbound task from a real namespaced Codex PostToolUse envelope (T2)', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000021_aa000021';
    const taskId = await persistUnboundPain(ws, painId);

    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: envelopeReceipt(painId, ws),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('recovered');
    if (result.outcome.status !== 'recovered') return;
    expect(result.outcome.taskId).toBe(taskId);
    expect(result.outcome.painId).toBe(painId);
    // P1-3: the event turn is the target turn; no target text in the store
    // yet, so the disposition waits for that exact turn.
    expect(result.outcome.disposition.state).toBe('waiting_for_target_evidence');

    const mgr = new RuntimeStateManager({ workspaceDir: ws });
    await mgr.initialize();
    try {
      const task = await mgr.getTask(taskId);
      if (task === null) throw new Error('task missing');
      expect(task.inputRef).toBe(painId);
      const diagnostic = JSON.parse(task.diagnosticJson);
      expect(diagnostic.sessionIdHint).toBe(EVENT_IDENTITY.sessionId);
      expect((diagnostic.painIngress).verifiedHostSession).toEqual({
        status: 'verified',
        sessionId: EVENT_IDENTITY.sessionId,
        submissionTurnId: EVENT_IDENTITY.turnId,
        targetTurnId: EVENT_IDENTITY.turnId,
      });
      expect((diagnostic.recovery).receiptRef.toolCallId).toBe(EVENT_IDENTITY.toolCallId);
    } finally {
      await mgr.close();
    }
  });

  it('T3: a receipt whose main path refused for host_context_conflict is never bound, even when otherwise valid', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000026_8c000026';
    await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: envelopeReceipt(painId, ws, { sessionAssociation: { status: 'unverified', detail: 'host_context_conflict' } }),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('session_association_not_recoverable');
    const mgr = new RuntimeStateManager({ workspaceDir: ws });
    await mgr.initialize();
    try {
      const task = await mgr.getTask(deriveSubmitTaskId(painId));
      const diagnostic = JSON.parse(task?.diagnosticJson ?? '{}');
      expect(diagnostic.sessionIdHint).toBeNull();
      expect(Object.hasOwn(diagnostic, 'recovery')).toBe(false);
    } finally {
      await mgr.close();
    }
  });

  it('T4: sentinel event identity fields are rejected (unified format check)', async () => {
    const ws = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: envelopeReceipt('mcp_x', ws),
      identity: { ...EVENT_IDENTITY, sessionId: 'cli' },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('event_identity_invalid');
  });

  it('T4: trims padded host event ids before real SQLite recovery', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000041_aa000041';
    const taskId = await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: envelopeReceipt(painId, ws),
      identity: {
        sessionId: ` ${EVENT_IDENTITY.sessionId} `,
        turnId: ` ${EVENT_IDENTITY.turnId} `,
        toolCallId: ` ${EVENT_IDENTITY.toolCallId} `,
      },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('recovered');
    if (result.outcome.status !== 'recovered') return;
    expect(result.outcome.taskId).toBe(taskId);

    const mgr = new RuntimeStateManager({ workspaceDir: ws });
    await mgr.initialize();
    try {
      const task = await mgr.getTask(taskId);
      if (task === null) throw new Error('task missing');
      const diagnostic = JSON.parse(task.diagnosticJson);
      expect(diagnostic.sessionIdHint).toBe(EVENT_IDENTITY.sessionId);
      expect(diagnostic.painIngress.verifiedHostSession).toEqual({
        status: 'verified',
        sessionId: EVENT_IDENTITY.sessionId,
        submissionTurnId: EVENT_IDENTITY.turnId,
        targetTurnId: EVENT_IDENTITY.turnId,
      });
      expect(diagnostic.recovery.receiptRef.toolCallId).toBe(EVENT_IDENTITY.toolCallId);
    } finally {
      await mgr.close();
    }
  });

  it('T4: a workspace spelled with a trailing "/." normalizes to the same workspace', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000027_9d000027';
    await persistUnboundPain(ws, painId);
    const spelled = `${ws}${path.sep}.`;
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: envelopeReceipt(painId, spelled),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('recovered');
  });

  it('T4: a genuinely different workspace receipt is still rejected after normalization', async () => {
    const ws = workspace();
    const other = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: envelopeReceipt('mcp_x', other),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('receipt_workspace_mismatch');
  });

  it('a plain-string tool_response (e.g. Bash output shape) is never treated as a receipt', async () => {
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
    expect(result.outcome.reasonCode).toBe('receipt_envelope_not_an_object');
  });

  it('the degraded untransportable statement form is rejected (no free-text recovery)', async () => {
    const ws = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: { content: [{ type: 'text', text: "Submission status is 'submitted'; taskId is 'diagnosis_x'. The full receipt exceeded the transport budget." }] },
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('receipt_text_not_json');
  });

  it('P2: a multi-block envelope is ambiguous and rejected, not first-block-trusted', async () => {
    const ws = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: {
        content: [
          { type: 'text', text: JSON.stringify(envelopeReceipt('mcp_a', ws) as Record<string, unknown> ? { schemaVersion: 'pd.pain-submit-receipt.v1' } : {}) },
          { type: 'text', text: '{"maybe":"another task receipt"}' },
        ],
      },
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('receipt_envelope_ambiguous_content');
  });

  it('a non-text first content block is rejected', async () => {
    const ws = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: { content: [{ type: 'image', data: 'x' }] },
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result.status).toBe('attempted');
    if (result.status !== 'attempted') return;
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.reasonCode).toBe('receipt_envelope_not_text_block');
  });

  it('other tool names are not applicable — including foreign servers and bare names (P1-1)', async () => {
    const ws = workspace();
    for (const toolName of ['pd_submit_pain', 'pd_submit_pain_v2', 'mcp__other__pd_submit_pain', 'mcp__pd_recall__pd_recall_principle_pains', 'Bash']) {
      const result = await attemptPainReceiptFallback({
        workspaceDir: ws,
        toolName,
        toolResponse: envelopeReceipt('mcp_x', ws),
        identity: { ...EVENT_IDENTITY },
        minimalMetadataGranted: true,
      });
      expect(result).toEqual({ status: 'not_applicable' });
    }
  });

  it('authorization off records blocked_by_consent on the original task (ids never persisted, T9)', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000022_bb000022';
    const taskId = await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: envelopeReceipt(painId, ws),
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
      expect((diagnostic.recovery).state).toBe('blocked_by_consent');
      // T9: with the authorization OFF, no identity metadata at all.
      expect(Object.hasOwn(diagnostic.recovery, 'receiptRef')).toBe(false);
      expect(raw).not.toContain(EVENT_IDENTITY.toolCallId);
      expect(raw).not.toContain(EVENT_IDENTITY.sessionId);
    } finally {
      await mgr.close();
    }
  });

  it('the same physical event replayed through the hook is idempotent (T7)', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000023_cc000023';
    await persistUnboundPain(ws, painId);
    const base = {
      workspaceDir: ws,
      toolName: REAL_TOOL_NAME,
      toolResponse: envelopeReceipt(painId, ws),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    };
    const first = await attemptPainReceiptFallback(base);
    const second = await attemptPainReceiptFallback(base);
    expect(first.status).toBe('attempted');
    expect(second.status).toBe('attempted');
    if (first.status !== 'attempted' || second.status !== 'attempted') return;
    expect(first.outcome.status).toBe('recovered');
    expect(second.outcome.status).toBe('already_bound');
  });

  it('the target-text probe reads the authorized store and fails closed when absent', async () => {
    const ws = workspace();
    expect(codexTargetTurnTextAvailable(ws, EVENT_IDENTITY.sessionId, EVENT_IDENTITY.turnId)).toBe(false);
    // Malformed inputs degrade to "missing", never throw.
    expect(codexTargetTurnTextAvailable(ws, ' ', '')).toBe(false);
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
      status: 'attempted', outcome: { status: 'rejected', reasonCode: 'blocked_by_consent', painId: 'p1', taskId: 't1' },
    })).toBe('pain_receipt_rejected:blocked_by_consent:taskId=t1');
  });
});
