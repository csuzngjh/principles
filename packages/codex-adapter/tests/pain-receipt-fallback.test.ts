/**
 * PRI-1274 (B1) — PostToolUse structured-receipt fallback (adapter slice).
 *
 * The Codex envelope decode (single text content block, JSON in
 * `content[0].text`, never structuredContent), the strict hand-off into the
 * Core CAS recovery, and the authorization boundary — exercised against a
 * REAL unbound task created by the REAL submit capability.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeStateManager } from '@principles/core/runtime';
import { deriveSubmitTaskId, submitPainCapability } from '@principles/core/runtime/pain-submit-capability';
import {
  attemptPainReceiptFallback,
  painReceiptFallbackDiagnostic,
  PAIN_SUBMIT_TOOL_NAME,
} from '../src/ingestion/pain-receipt-fallback.js';

const dirs: string[] = [];
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-receipt-'));
  dirs.push(root);
  return root;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** Create the original unbound task through the REAL Core capability — the
 * exact row shape the MCP server persists when the request had no `_meta`. */
async function persistUnboundPain(workspaceDir: string, painId: string): Promise<string> {
  const taskId = deriveSubmitTaskId(painId);
  const receipt = await submitPainCapability(
    {
      workspaceDir,
      stateDir: path.join(workspaceDir, '.state'),
      painId,
      taskId,
      hostKind: 'codex',
    },
    {
      reason: 'Anchor: owner expectation. Observed: behavior. Deviation: mismatch.',
      anchorType: 'owner_expectation',
      anchorRef: 'Owner statement in this conversation',
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
        warnings: [],
        error: null,
        nextAction: null,
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

describe('attemptPainReceiptFallback — envelope decode and recovery', () => {
  it('recovers the original unbound task from a real Codex PostToolUse envelope (T2)', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000021_aa000021';
    const taskId = await persistUnboundPain(ws, painId);

    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: PAIN_SUBMIT_TOOL_NAME,
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
      });
      expect((diagnostic.recovery).receiptRef.toolCallId).toBe(EVENT_IDENTITY.toolCallId);
    } finally {
      await mgr.close();
    }
  });

  it('a plain-string tool_response (e.g. Bash output shape) is never treated as a receipt', async () => {
    const ws = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: PAIN_SUBMIT_TOOL_NAME,
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
      toolName: PAIN_SUBMIT_TOOL_NAME,
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

  it('a non-text first content block is rejected', async () => {
    const ws = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: PAIN_SUBMIT_TOOL_NAME,
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

  it('other tool names are not applicable (exact-name matching only)', async () => {
    const ws = workspace();
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: 'pd_submit_pain_v2',
      toolResponse: envelopeReceipt('mcp_x', ws),
      identity: { ...EVENT_IDENTITY },
      minimalMetadataGranted: true,
    });
    expect(result).toEqual({ status: 'not_applicable' });
  });

  it('authorization off records blocked_by_consent on the original task (ids never persisted)', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000022_bb000022';
    const taskId = await persistUnboundPain(ws, painId);
    const result = await attemptPainReceiptFallback({
      workspaceDir: ws,
      toolName: PAIN_SUBMIT_TOOL_NAME,
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
      const diagnostic = JSON.parse(task?.diagnosticJson ?? '{}');
      expect(diagnostic.sessionIdHint).toBeNull();
      expect((diagnostic.recovery).state).toBe('blocked_by_consent');
    } finally {
      await mgr.close();
    }
  });

  it('the same physical event replayed through the hook is idempotent', async () => {
    const ws = workspace();
    const painId = 'mcp_1700000000023_cc000023';
    await persistUnboundPain(ws, painId);
    const base = {
      workspaceDir: ws,
      toolName: PAIN_SUBMIT_TOOL_NAME,
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
});

describe('painReceiptFallbackDiagnostic — bounded stderr lines', () => {
  it('surfaces ids and codes only', () => {
    expect(painReceiptFallbackDiagnostic({ status: 'not_applicable' })).toBeNull();
    expect(painReceiptFallbackDiagnostic({
      status: 'attempted',
      outcome: { status: 'recovered', painId: 'p1', taskId: 't1', disposition: { state: 'waiting_for_target_evidence', reasonCode: 'receipt_recovered', attemptCount: 1, lastCheckedAt: 'x', schemaVersion: 1 } },
    })).toBe('pain_receipt_recovered:taskId=t1:state=waiting_for_target_evidence');
    expect(painReceiptFallbackDiagnostic({
      status: 'attempted', outcome: { status: 'rejected', reasonCode: 'blocked_by_consent', painId: 'p1', taskId: 't1' },
    })).toBe('pain_receipt_rejected:blocked_by_consent:taskId=t1');
  });
});
