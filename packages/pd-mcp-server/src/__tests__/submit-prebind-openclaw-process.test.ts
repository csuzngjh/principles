/**
 * PRI-1276 (B2) — acceptance for the OpenClaw host through the REAL server
 * process (same harness as the Codex/WorkBuddy prebind suites).
 *
 * Drives the BUILT `dist/index.js` through the official SDK client's
 * StdioClientTransport. The OpenClaw producer shape is the namespaced
 * `_meta["pd.host-context.v1"]` contract (Core `resolveHostSubmissionContext`
 * 'openclaw' branch — PRI-1274 consumer, PRI-1276 producer contract). On the
 * installed OpenClaw 2026.11.5 runtime the materializer does not yet inject
 * `_meta` (audit §2.2 — the upstream producer patch card), so these cases
 * prove the SERVER side is ready the moment a producer exists, and that the
 * no-`_meta` reality legally persists the unbound task the plugin's
 * `after_tool_call` receipt fallback repairs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultPdConfig, RuntimeStateManager } from '@principles/core/runtime';
import { deriveSubmitTaskId } from '@principles/core/runtime/pain-submit-capability';
import { SUBMIT_TOOL_NAME } from '../server.js';

const DIST_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');

const SUBMIT_ARGS = {
  reason: 'Anchor: Owner asked to keep the runbook current. Observed: the runbook drifted. Deviation: the update was skipped.',
  anchorType: 'owner_expectation',
  anchorRef: 'Owner request earlier in this conversation',
  painType: 'user_frustration',
} as const;

/** The namespaced producer contract a patched OpenClaw materializer would
 * inject (audit §5): host runtime `sessionId` required; `toolCallId` from the
 * execution context when available; NO submissionTurnId (OpenClaw exposes no
 * proven one). An unrelated host field rides along to prove the merge keeps
 * every `_meta` field. */
const OPENCLAW_PRODUCER_META = {
  'pd.host-context.v1': {
    sessionId: 'oc-process-session-0001',
    toolCallId: 'call_probe_0001',
  },
  progressToken: 1,
} as const;

describe('B2/T1 process acceptance — OpenClaw prebind through the real dist server', () => {
  // Same fresh-clone stability rule as the Codex/WorkBuddy suites: no dist →
  // skip with a loud marker (the merge gate always builds first).
  const suite = fs.existsSync(DIST_ENTRY) ? describe : describe.skip;

  suite('B2/T1 process acceptance — OpenClaw prebind through the real dist server', () => {
  let workspaceDir: string;
  let logDir: string;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  beforeAll(async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-b2-oc-ws-'));
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-b2-oc-logs-'));
    // The one-time Workspace minimal identity-metadata authorization.
    const config = getDefaultPdConfig();
    config.features.host_identity_minimal_metadata.enabled = true;
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_ENTRY],
      env: {
        PD_MCP_WORKSPACE_DIR: workspaceDir,
        PD_MCP_HOST: 'openclaw',
        PD_MCP_LOG_DIR: logDir,
      },
      stderr: 'pipe',
    });
    const stderrStream = transport.stderr as Readable | undefined;
    stderrStream?.setEncoding('utf8');
    stderrStream?.on('data', () => {
      // Drain: stderr content is asserted via the state db, not here.
    });
    client = new Client({ name: 'pd-b2-oc-acceptance', version: '0.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // The child may already be gone; the tmp dirs still get cleaned.
      }
    }
    if (workspaceDir !== undefined) fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (logDir !== undefined) fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('binds the session at the INITIAL write from the namespaced producer _meta (session + toolCallId, no turn)', async () => {
    if (client === undefined) throw new Error('client not connected');
    const result = await client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...SUBMIT_ARGS },
      _meta: { ...OPENCLAW_PRODUCER_META },
    });
    expect(result.isError).toBeFalsy();
    const [block] = result.content;
    if (block === undefined || block.type !== 'text') throw new Error('expected single text content block');
    const receipt = JSON.parse(block.text) as {
      status: string; painId: string | null; taskId: string | null;
      sessionAssociation?: { status: string; sessionId?: string; detail?: string };
      error?: { code: string; message: string } | null;
    };
    expect(receipt.status, JSON.stringify(receipt.error)).toBe('submitted');
    // Session bound, turn absent — an absent submissionTurnId never negates
    // the session binding (SPEC §G2).
    expect(receipt.sessionAssociation).toEqual({
      status: 'verified',
      sessionId: 'oc-process-session-0001',
    });
    if (receipt.painId === null || receipt.taskId === null) throw new Error('receipt identity missing');

    // Read back the ORIGINAL task from the real state.db: bound at the
    // INITIAL write (nothing else touched the task).
    const manager = new RuntimeStateManager({ workspaceDir });
    await manager.initialize();
    try {
      const task = await manager.getTask(receipt.taskId);
      expect(task).not.toBeNull();
      if (task === null) return;
      expect(task.taskId).toBe(deriveSubmitTaskId(receipt.painId));
      expect(task.inputRef).toBe(receipt.painId);
      const diagnostic = JSON.parse(task.diagnosticJson ?? '{}') as Record<string, unknown>;
      expect(diagnostic.sessionIdHint).toBe('oc-process-session-0001');
      const painIngress = diagnostic.painIngress as Record<string, unknown>;
      expect(painIngress.verifiedHostSession).toEqual({ status: 'verified', sessionId: 'oc-process-session-0001' });
    } finally {
      await manager.close();
    }
  });

  it('a follow-up submission WITHOUT _meta stays legally unbound with host_session_claim_empty (the receipt-fallback territory)', async () => {
    if (client === undefined) throw new Error('client not connected');
    const result = await client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...SUBMIT_ARGS, anchorRef: 'A different Owner request in this conversation' },
    });
    const [block] = result.content;
    if (block === undefined || block.type !== 'text') throw new Error('expected single text content block');
    const receipt = JSON.parse(block.text) as {
      status: string; taskId: string | null;
      sessionAssociation?: { status: string; detail?: string };
    };
    expect(receipt.status).toBe('submitted');
    // No claim on the arguments → the PRI-1260 legacy path yields the empty
    // claim cause — the designated OpenClaw receipt-fallback territory.
    expect(receipt.sessionAssociation).toEqual({ status: 'unverified', detail: 'host_session_claim_empty' });
    if (receipt.taskId === null) throw new Error('receipt identity missing');
    const manager = new RuntimeStateManager({ workspaceDir });
    await manager.initialize();
    try {
      const task = await manager.getTask(receipt.taskId);
      const diagnostic = JSON.parse(task?.diagnosticJson ?? '{}') as Record<string, unknown>;
      expect(diagnostic.sessionIdHint).toBeNull();
    } finally {
      await manager.close();
    }
  });

  it('a namespaced producer _meta with a CONFLICTING model claim fails closed (T4)', async () => {
    if (client === undefined) throw new Error('client not connected');
    const result = await client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: {
        ...SUBMIT_ARGS,
        anchorRef: 'A third Owner request in this conversation',
        hostSession: { sessionId: 'bogus-model-claimed-session' },
      },
      _meta: { ...OPENCLAW_PRODUCER_META },
    });
    const [block] = result.content;
    if (block === undefined || block.type !== 'text') throw new Error('expected single text content block');
    const receipt = JSON.parse(block.text) as {
      status: string; taskId: string | null;
      sessionAssociation?: { status: string; detail?: string };
    };
    expect(receipt.status).toBe('submitted');
    // The trusted host session and the model claim disagree → fail closed,
    // never bind from either side (SPEC §G2 conflict rule).
    expect(receipt.sessionAssociation).toEqual({ status: 'unverified', detail: 'host_context_conflict' });
  });

  it('malformed producer metadata (sentinel session) is invalid, never trusted (fail closed)', async () => {
    if (client === undefined) throw new Error('client not connected');
    const result = await client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...SUBMIT_ARGS, anchorRef: 'A fourth Owner request in this conversation' },
      _meta: { 'pd.host-context.v1': { sessionId: 'cli' } },
    });
    const [block] = result.content;
    if (block === undefined || block.type !== 'text') throw new Error('expected single text content block');
    const receipt = JSON.parse(block.text) as {
      status: string; taskId: string | null;
      sessionAssociation?: { status: string; detail?: string };
    };
    expect(receipt.status).toBe('submitted');
    expect(receipt.sessionAssociation).toEqual({
      status: 'unverified',
      detail: 'host_context_invalid:host_context_v1_missing_session',
    });
  });

  it('REVOKING the minimal identity authorization stops binding on the NEXT submission, no restart (Stage 3)', async () => {
    if (client === undefined) throw new Error('client not connected');
    // Flip the Workspace authorization OFF behind the RUNNING server.
    const config = getDefaultPdConfig();
    config.features.host_identity_minimal_metadata.enabled = false;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    const result = await client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...SUBMIT_ARGS, anchorRef: 'A fifth Owner request in this conversation' },
      _meta: { ...OPENCLAW_PRODUCER_META },
    });
    const [block] = result.content;
    if (block === undefined || block.type !== 'text') throw new Error('expected single text content block');
    const receipt = JSON.parse(block.text) as {
      status: string; taskId: string | null;
      sessionAssociation?: { status: string; detail?: string };
    };
    expect(receipt.status).toBe('submitted');
    // The per-request authorization re-read sees the revocation: the trusted
    // host identity is NOT persisted (fail closed, no server restart).
    expect(receipt.sessionAssociation).toEqual({ status: 'unverified', detail: 'blocked_by_consent' });
    if (receipt.taskId === null) throw new Error('receipt identity missing');
    const manager = new RuntimeStateManager({ workspaceDir });
    await manager.initialize();
    try {
      const task = await manager.getTask(receipt.taskId);
      const diagnostic = JSON.parse(task?.diagnosticJson ?? '{}') as Record<string, unknown>;
      expect(diagnostic.sessionIdHint).toBeNull();
    } finally {
      await manager.close();
    }
  });
  });
});
