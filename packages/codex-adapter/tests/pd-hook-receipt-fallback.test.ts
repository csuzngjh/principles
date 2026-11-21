/**
 * PRI-1274 (B1) — PostToolUse receipt fallback through the REAL hook entry.
 *
 * Drives `processHookInvocation` with a genuine Codex PostToolUse payload
 * (real decoder, real workspace resolution, real dispatch) against a REAL
 * unbound task created by the REAL submit capability, and asserts the SAME
 * task comes back bound — no Console, no manual ids, no resubmission (T2).
 * The fallback must be independent of codex_conversation_ingestion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDefaultPdConfig, RuntimeStateManager } from '@principles/core/runtime';
import { deriveSubmitTaskId, submitPainCapability } from '@principles/core/runtime/pain-submit-capability';
import { processHookInvocation } from '../src/pd-hook.js';

const dirs: string[] = [];
function workspace(minimalMetadata: boolean): { root: string; env: Record<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-hook-b1-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  if (minimalMetadata) config.features['host_identity_minimal_metadata'].enabled = true;
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  // Isolate CODEX_HOME so the hook's user-workspace-first resolution cannot
  // adopt THIS machine's real ~/.codex/pd-workspace instead of the fixture.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-hook-b1-home-'));
  dirs.push(codexHome);
  return { root, env: { CODEX_HOME: codexHome } };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function persistUnboundPain(workspaceDir: string, painId: string): Promise<string> {
  const taskId = deriveSubmitTaskId(painId);
  const receipt = await submitPainCapability(
    { workspaceDir, stateDir: path.join(workspaceDir, '.state'), painId, taskId, hostKind: 'codex' },
    {
      // agent_instruction: no independently admissible Owner statement, so
      // the recovered task WAITs for its target turn's text (r2 default path).
      reason: 'Anchor: agent instruction. Observed: behavior. Deviation: mismatch.',
      anchorType: 'agent_instruction',
      anchorRef: 'AGENTS.md#safety',
      painType: 'user_frustration',
    },
  );
  if (receipt.status !== 'submitted') throw new Error(`fixture submit failed: ${JSON.stringify(receipt.error)}`);
  return taskId;
}

function postToolUsePayload(root: string, toolResponse: unknown, toolName = 'mcp__pd_recall__pd_submit_pain'): string {
  return JSON.stringify({
    session_id: '0b21621e-0000-4000-8000-000000000041',
    turn_id: '0b21621e-0000-4000-8000-000000000042',
    transcript_path: null,
    cwd: root,
    hook_event_name: 'PostToolUse',
    model: 'gpt-5.6',
    permission_mode: 'default',
    tool_name: toolName,
    tool_input: { reason: 'submitted via MCP without _meta' },
    tool_response: toolResponse,
    tool_use_id: 'toolu-b1-integration-1',
  });
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

async function readTask(workspaceDir: string, taskId: string) {
  const mgr = new RuntimeStateManager({ workspaceDir });
  await mgr.initialize();
  try {
    return await mgr.getTask(taskId);
  } finally {
    await mgr.close();
  }
}

describe('pd-hook PostToolUse receipt fallback (B1/T2 through the real entry)', () => {
  it('recovers the same original task without Console, manual ids or resubmission', async () => {
    const { root, env } = workspace(true);
    const painId = 'mcp_1700000000031_dd000031';
    const taskId = await persistUnboundPain(root, painId);

    // Pre-condition: the original task is legally unbound (the exact
    // failure B1 exists to repair — SourceTraceLocator would report
    // missing_session_hint from here).
    const before = await readTask(root, taskId);
    expect(JSON.parse(before?.diagnosticJson ?? '{}').sessionIdHint).toBeNull();

    const result = await processHookInvocation(postToolUsePayload(root, envelopeReceipt(painId, root)), env, root);

    // The hook stays fail-open: the host decision is a normal observe result.
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('pain_receipt_recovered:taskId='))).toBe(true);

    const after = await readTask(root, taskId);
    if (after === null) throw new Error('task missing after hook');
    // 原 painId/taskId 不变。
    expect(after.taskId).toBe(taskId);
    expect(after.inputRef).toBe(painId);
    const diagnostic = JSON.parse(after.diagnosticJson);
    expect(diagnostic.sessionIdHint).toBe('0b21621e-0000-4000-8000-000000000041');
    expect(diagnostic.painIngress.verifiedHostSession).toEqual({
      status: 'verified',
      sessionId: '0b21621e-0000-4000-8000-000000000041',
      submissionTurnId: '0b21621e-0000-4000-8000-000000000042',
      targetTurnId: '0b21621e-0000-4000-8000-000000000042',
    });
    expect(diagnostic.recovery.state).toBe('waiting_for_target_evidence');
    expect(diagnostic.recovery.reasonCode).toBe('target_turn_text_pending');
  });

  it('runs with conversation ingestion OFF (independent authorization) and reads no transcript', async () => {
    const { root, env } = workspace(true);
    // codex_conversation_ingestion stays at its default OFF in this fixture;
    // transcript_path is null so a transcript read would be impossible anyway.
    const painId = 'mcp_1700000000032_ee000032';
    const taskId = await persistUnboundPain(root, painId);
    const result = await processHookInvocation(postToolUsePayload(root, envelopeReceipt(painId, root)), env, root);
    expect(result.exitCode).toBe(0);
    const after = await readTask(root, taskId);
    expect(JSON.parse(after?.diagnosticJson ?? '{}').sessionIdHint).toBe('0b21621e-0000-4000-8000-000000000041');
  });

  it('authorization off records blocked_by_consent and leaves the task unbound', async () => {
    const { root, env } = workspace(false);
    const painId = 'mcp_1700000000033_ff000033';
    const taskId = await persistUnboundPain(root, painId);
    const result = await processHookInvocation(postToolUsePayload(root, envelopeReceipt(painId, root)), env, root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('pain_receipt_rejected:blocked_by_consent'))).toBe(true);
    const after = await readTask(root, taskId);
    const diagnostic = JSON.parse(after?.diagnosticJson ?? '{}');
    expect(diagnostic.sessionIdHint).toBeNull();
    expect(diagnostic.recovery.state).toBe('blocked_by_consent');
  });

  it('an unrelated tool completion never triggers receipt processing', async () => {
    const { root, env } = workspace(true);
    const result = await processHookInvocation(
      postToolUsePayload(root, { content: [{ type: 'text', text: 'ok' }] }, 'Bash'),
      env, root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('pain_receipt'))).toBe(false);
  });

  it('P1-1: a BARE pd_submit_pain tool name never triggers the fallback (real names are namespaced)', async () => {
    const { root, env } = workspace(true);
    const painId = 'mcp_1700000000036_7c000036';
    await persistUnboundPain(root, painId);
    const result = await processHookInvocation(
      postToolUsePayload(root, envelopeReceipt(painId, root), 'pd_submit_pain'),
      env, root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('pain_receipt'))).toBe(false);
    const after = await readTask(root, deriveSubmitTaskId(painId));
    expect(JSON.parse(after?.diagnosticJson ?? '{}').sessionIdHint).toBeNull();
  });

  it('P1-1: a same-named tool on a FOREIGN MCP server never triggers the fallback', async () => {
    const { root, env } = workspace(true);
    const painId = 'mcp_1700000000037_6d000037';
    await persistUnboundPain(root, painId);
    const result = await processHookInvocation(
      postToolUsePayload(root, envelopeReceipt(painId, root), 'mcp__evil_mirror__pd_submit_pain'),
      env, root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('pain_receipt'))).toBe(false);
    const after = await readTask(root, deriveSubmitTaskId(painId));
    expect(JSON.parse(after?.diagnosticJson ?? '{}').sessionIdHint).toBeNull();
  });

  it('P1-5(B): a refusal states it is NOT retried automatically — no next-cycle promise', async () => {
    const { root, env } = workspace(true);
    const painId = 'mcp_1700000000038_5e000038';
    await persistUnboundPain(root, painId);
    const result = await processHookInvocation(
      postToolUsePayload(root, envelopeReceipt(painId, root, { sessionAssociation: { status: 'unverified', detail: 'host_context_conflict' } })),
      env, root,
    );
    expect(result.exitCode).toBe(0);
    const refusal = result.stderr.find((line) => line.includes('pain_receipt_rejected:session_association_not_recoverable'));
    expect(refusal).toBeDefined();
    expect(refusal).toContain('not retried automatically');
    // The stale promise wording is gone.
    expect(result.stderr.some((line) => line.includes('re-evaluates recovery on the next cycle'))).toBe(false);
    const after = await readTask(root, deriveSubmitTaskId(painId));
    const diagnostic = JSON.parse(after?.diagnosticJson ?? '{}');
    expect(diagnostic.sessionIdHint).toBeNull();
    expect(Object.hasOwn(diagnostic, 'recovery')).toBe(false);
  });

  it('a corrupted envelope degrades to one bounded diagnostic and no task mutation', async () => {
    const { root, env } = workspace(true);
    const painId = 'mcp_1700000000034_9a000034';
    const taskId = await persistUnboundPain(root, painId);
    const result = await processHookInvocation(
      postToolUsePayload(root, { content: [{ type: 'text', text: '{not json' }] }),
      env, root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('pain_receipt_rejected:receipt_text_not_json'))).toBe(true);
    const after = await readTask(root, taskId);
    expect(JSON.parse(after?.diagnosticJson ?? '{}').sessionIdHint).toBeNull();
  });

  it('replaying the same event folds idempotently (same tool_use_id)', async () => {
    const { root, env } = workspace(true);
    const painId = 'mcp_1700000000035_8b000035';
    const taskId = await persistUnboundPain(root, painId);
    const payload = postToolUsePayload(root, envelopeReceipt(painId, root));
    const first = await processHookInvocation(payload, env, root);
    const second = await processHookInvocation(payload, env, root);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.stderr.some((line) => line.includes('pain_receipt_idempotent:taskId='))).toBe(true);
    const after = await readTask(root, taskId);
    const diagnostic = JSON.parse(after?.diagnosticJson ?? '{}');
    expect((diagnostic.recovery).attemptCount).toBe(1);
  });
});
