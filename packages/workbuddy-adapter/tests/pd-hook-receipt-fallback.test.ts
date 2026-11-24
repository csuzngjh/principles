/**
 * PRI-1275 (B2) — PostToolUse structured-receipt fallback through the REAL
 * WorkBuddy hook entry (local convention: the built dist process spawned with
 * a fake home, helpers/hook-runner.ts).
 *
 * Drives the entry with the REAL captured PostToolUse MCP payload shape
 * (content-block ARRAY tool_response, `mcp__pd_recall__pd_submit_pain` name,
 * engine per-call uuid ids) against a REAL governance workspace holding a
 * REAL unbound task created by the REAL submit capability, and asserts the
 * SAME task comes back bound — no Console, no manual ids, no resubmission.
 * The fallback must be independent of workbuddy_conversation_ingestion
 * (stays at its default OFF in every fixture here; the path reads no
 * transcript and persists ids only). Fail-open belt: an unexpected recovery
 * throw degrades to one bounded stderr line and never changes the hook
 * result (P02: PostToolUse has nothing blockable — always exit 0).
 *
 * The Core barrel is mocked as a spy-through (importOriginal + delegation)
 * so the in-process fail-open case can force ONE recovery throw at the
 * adapter→Core seam; spawned children are untouched by vitest mocks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeStateManager } from '@principles/core/runtime';
import { deriveSubmitTaskId, submitPainCapability } from '@principles/core/runtime/pain-submit-capability';

const { recoverSpy } = vi.hoisted(() => ({
  recoverSpy: vi.fn(),
}));
vi.mock('@principles/core/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/core/runtime')>();
  recoverSpy.mockImplementation((options: Parameters<typeof actual.recoverTaskIdentityFromReceipt>[0]) =>
    actual.recoverTaskIdentityFromReceipt(options));
  return { ...actual, recoverTaskIdentityFromReceipt: recoverSpy };
});

import { processWorkbuddyHookInvocation } from '../src/pd-hook.js';
import { runEntry } from './helpers/hook-runner.js';
import {
  cleanupTempDirs,
  fixturePayload,
  makeGovernance,
  makeHome,
  makeProjectDir,
  makeTrajectory,
} from './helpers/workbench.js';

afterEach(() => { cleanupTempDirs(); });

/** The REAL captured PostToolUse identity (PRI-1275 probe, engine 2.165.0). */
const SESSION_ID = '01a20d41-fc4f-71ec-ab89-7d83a970215a';
const TURN_ID = '01a20d41fbb377cfa975b1b725b6238e';
const CALL_ID = '01a20d41-fdfd-758f-ab69-4df2fe1fe263';
const REAL_TOOL_NAME = 'mcp__pd_recall__pd_submit_pain';

/** A governance workspace with WorkBuddy enabled, the receipt fallback's
 * `host_identity_minimal_metadata` authorization ON, and the trajectory
 * schema the shared PostToolUse evidence path writes into. */
function governanceHome(): { home: string; governance: string } {
  const home = makeHome();
  const governance = makeGovernance(home, { workbuddyFlag: true });
  enableMinimalMetadataFlag(governance);
  makeTrajectory(governance);
  return { home, governance };
}

function enableMinimalMetadataFlag(governance: string): void {
  const configPath = path.join(governance, '.pd', 'config.yaml');
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('fixture config is not a JSON object');
  const featuresRaw: unknown = Object.getOwnPropertyDescriptor(parsed, 'features')?.value;
  if (typeof featuresRaw !== 'object' || featuresRaw === null || Array.isArray(featuresRaw)) throw new Error('fixture config has no features map');
  const flagRaw: unknown = Object.getOwnPropertyDescriptor(featuresRaw, 'host_identity_minimal_metadata')?.value;
  if (typeof flagRaw !== 'object' || flagRaw === null || Array.isArray(flagRaw)) throw new Error('default config lacks the host_identity_minimal_metadata flag');
  const features: object = { ...featuresRaw, host_identity_minimal_metadata: { ...flagRaw, enabled: true } };
  const config: object = { ...parsed, features };
  fs.writeFileSync(configPath, JSON.stringify(config));
}

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

/** The REAL WorkBuddy MCP envelope: tool_response IS the content block array. */
function arrayEnvelopeReceipt(painId: string, workspaceDir: string): unknown {
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
    }),
  }];
}

/** The REAL captured fixture payload, pointed at test reality: project cwd,
 * stable probe-like identity ids, the MCP tool name and the array response. */
function postToolUsePayload(projectDir: string, toolResponse: unknown, toolName = REAL_TOOL_NAME): string {
  const payload = fixturePayload('post-tool-use-mcp-echo.json', {
    cwd: projectDir,
    session_id: SESSION_ID,
    generation_id: TURN_ID,
    call_id: CALL_ID,
    tool_use_id: CALL_ID,
    tool_name: toolName,
    tool_response: toolResponse,
  });
  return JSON.stringify(payload);
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

function receiptLines(stderr: string): string[] {
  return stderr.split(/\r?\n/).filter((line) => line.includes('pain_receipt'));
}

describe('pd-hook PostToolUse receipt fallback (B2 through the real spawned entry)', () => {
  it('recovers the same original task without Console, manual ids or resubmission', async () => {
    const { home, governance } = governanceHome();
    const painId = 'mcp_1700000000131_dd000131';
    const taskId = await persistUnboundPain(governance, painId);

    // Pre-condition: the original task is legally unbound (the exact failure
    // B2 exists to repair — the request had no trusted `_meta`).
    const before = await readTask(governance, taskId);
    expect(JSON.parse(before?.diagnosticJson ?? '{}').sessionIdHint).toBeNull();

    const project = makeProjectDir(home, 'receipt');
    const result = runEntry(home, postToolUsePayload(project, arrayEnvelopeReceipt(painId, governance)), 'PostToolUse');

    // Fail-open channel: EMPTY stdout (P04) + exit 0 + exactly one bounded
    // receipt diagnostic on stderr.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const lines = receiptLines(result.stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('pain_receipt_recovered:taskId=');

    const after = await readTask(governance, taskId);
    if (after === null) throw new Error('task missing after hook');
    expect(after.taskId).toBe(taskId);
    expect(after.inputRef).toBe(painId);
    const diagnostic = JSON.parse(after.diagnosticJson);
    expect(diagnostic.sessionIdHint).toBe(SESSION_ID);
    expect(diagnostic.painIngress.verifiedHostSession).toEqual({
      status: 'verified',
      sessionId: SESSION_ID,
      submissionTurnId: TURN_ID,
      targetTurnId: TURN_ID,
    });
    expect(diagnostic.recovery.state).toBe('waiting_for_target_evidence');
    expect(diagnostic.recovery.receiptRef.toolCallId).toBe(CALL_ID);
  });

  it('runs with conversation ingestion OFF (independent authorization), no transcript read', async () => {
    // makeGovernance leaves workbuddy_conversation_ingestion at its default
    // OFF; transcript_path points at the probe lab and is never opened.
    const { home, governance } = governanceHome();
    const painId = 'mcp_1700000000132_ee000132';
    const taskId = await persistUnboundPain(governance, painId);
    const project = makeProjectDir(home, 'ingest-off');
    const result = runEntry(home, postToolUsePayload(project, arrayEnvelopeReceipt(painId, governance)), 'PostToolUse');
    expect(result.status).toBe(0);
    const after = await readTask(governance, taskId);
    expect(JSON.parse(after?.diagnosticJson ?? '{}').sessionIdHint).toBe(SESSION_ID);
  });

  it('replaying the same event folds idempotently (same call_id)', async () => {
    const { home, governance } = governanceHome();
    const painId = 'mcp_1700000000133_ff000133';
    await persistUnboundPain(governance, painId);
    const project = makeProjectDir(home, 'replay');
    const payload = postToolUsePayload(project, arrayEnvelopeReceipt(painId, governance));
    const first = runEntry(home, payload, 'PostToolUse');
    const second = runEntry(home, payload, 'PostToolUse');
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe('');
    expect(receiptLines(second.stderr).some((line) => line.includes('pain_receipt_idempotent:taskId='))).toBe(true);
  });

  it('P1-1: a same-named tool on a FOREIGN MCP server never triggers the fallback', async () => {
    const { home, governance } = governanceHome();
    const painId = 'mcp_1700000000134_9a000134';
    const taskId = await persistUnboundPain(governance, painId);
    const project = makeProjectDir(home, 'foreign');
    const result = runEntry(home, postToolUsePayload(project, arrayEnvelopeReceipt(painId, governance), 'mcp__evil_mirror__pd_submit_pain'), 'PostToolUse');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(receiptLines(result.stderr)).toHaveLength(0);
    const after = await readTask(governance, taskId);
    expect(JSON.parse(after?.diagnosticJson ?? '{}').sessionIdHint).toBeNull();
  });
});

describe('pd-hook receipt fallback fail-open belt (in-process, forced recovery throw)', () => {
  it('a recovery that THROWS degrades to one bounded fallback-failed line, exit 0, stdout untouched', async () => {
    const { home, governance } = governanceHome();
    const painId = 'mcp_1700000000135_a0000135';
    const taskId = await persistUnboundPain(governance, painId);
    const project = makeProjectDir(home, 'fail-open');

    const previousConfigDir = process.env.WORKBUDDY_CONFIG_DIR;
    process.env.WORKBUDDY_CONFIG_DIR = path.join(home, '.workbuddy');
    try {
      // ONE forced throw at the adapter→Core seam; mockImplementationOnce
      // reverts to the delegating implementation afterwards by itself.
      recoverSpy.mockImplementationOnce(async () => { throw new Error('simulated store crash'); });
      const result = await processWorkbuddyHookInvocation(
        postToolUsePayload(project, arrayEnvelopeReceipt(painId, governance)),
        'PostToolUse',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBeNull();
      const lines = result.stderr.filter((line) => line.includes('pain_receipt'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('pain_receipt_fallback_failed');
      expect(lines[0]).toContain('simulated store crash');
    } finally {
      if (previousConfigDir === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
      else process.env.WORKBUDDY_CONFIG_DIR = previousConfigDir;
    }
    // The forced throw aborted before any write — the task stays unbound.
    const after = await readTask(governance, taskId);
    expect(JSON.parse(after?.diagnosticJson ?? '{}').sessionIdHint).toBeNull();
  });
});
