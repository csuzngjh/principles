/**
 * PRI-1275 (B2) — T1/T2 acceptance for the WorkBuddy host through the REAL
 * server process (same harness as the Codex prebind suite).
 *
 * Drives the BUILT `dist/index.js` through the official SDK client's
 * StdioClientTransport. The WorkBuddy producer shape is the probe-verified
 * real-engine `_meta`: `baggage` carrying `codebuddy.session_id` (the
 * installed CodeBuddy Code 2.165.0 injects it on every tools/call) plus the
 * SDK's own progressToken — proving the merge keeps every field and the
 * prebind happens at the INITIAL write.
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
  reason: 'Anchor: Owner asked to re-run the verification step. Observed: the change shipped unverified. Deviation: the requested verification was skipped.',
  anchorType: 'owner_expectation',
  anchorRef: 'Owner request earlier in this conversation',
  painType: 'user_frustration',
} as const;

/** The probe-verified real-engine `_meta` (modelId/traceparent/baggage/
 * progressToken). The SDK merges its progressToken with these fields. */
const REAL_ENGINE_META = {
  modelId: 'wb-probe-mock',
  traceparent: '00-9e20b85b83d30b39ab39f7951ac95e0a-ff9a59749cfc6662-01',
  baggage: 'codebuddy.session_id=b1-wb-session-0001,codebuddy.conversation_request_id=01a20d41fbb377cfa975b1b725b6238e',
} as const;

describe('B2/T1 process acceptance — WorkBuddy prebind through the real dist server', () => {
  // Same fresh-clone stability rule as the Codex suite: no dist → skip with
  // a loud marker (the merge gate always builds first).
  const suite = fs.existsSync(DIST_ENTRY) ? describe : describe.skip;

  suite('B2/T1 process acceptance — WorkBuddy prebind through the real dist server', () => {
  let workspaceDir: string;
  let logDir: string;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  beforeAll(async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-b2-t1-ws-'));
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-b2-t1-logs-'));
    // The one-time Workspace minimal identity-metadata authorization.
    const config = getDefaultPdConfig();
    config.features['host.workbuddy'].enabled = true;
    config.features.host_identity_minimal_metadata.enabled = true;
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_ENTRY],
      env: {
        PD_MCP_WORKSPACE_DIR: workspaceDir,
        PD_MCP_HOST: 'workbuddy',
        PD_MCP_LOG_DIR: logDir,
      },
      stderr: 'pipe',
    });
    const stderrStream = transport.stderr as Readable | undefined;
    stderrStream?.setEncoding('utf8');
    stderrStream?.on('data', () => {
      // Drain: stderr content is asserted via the state db, not here.
    });
    client = new Client({ name: 'pd-b2-t1-acceptance', version: '0.0.0' });
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

  it('binds the session at the initial write from the real-engine baggage _meta (no turn id)', async () => {
    if (client === undefined) throw new Error('client not connected');
    const result = await client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...SUBMIT_ARGS },
      _meta: { ...REAL_ENGINE_META },
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
    expect(receipt.sessionAssociation).toEqual({
      status: 'verified',
      sessionId: 'b1-wb-session-0001',
    });
    if (receipt.painId === null || receipt.taskId === null) throw new Error('receipt identity missing');

    // Read back the ORIGINAL task from the real state.db: the session was
    // bound at the INITIAL write (nothing else touched the task).
    const manager = new RuntimeStateManager({ workspaceDir });
    await manager.initialize();
    try {
      const task = await manager.getTask(receipt.taskId);
      expect(task).not.toBeNull();
      if (task === null) return;
      expect(task.taskId).toBe(deriveSubmitTaskId(receipt.painId));
      expect(task.inputRef).toBe(receipt.painId);
      const diagnostic = JSON.parse(task.diagnosticJson ?? '{}') as Record<string, unknown>;
      expect(diagnostic.sessionIdHint).toBe('b1-wb-session-0001');
      const painIngress = diagnostic.painIngress as Record<string, unknown>;
      expect(painIngress.verifiedHostSession).toEqual({ status: 'verified', sessionId: 'b1-wb-session-0001' });
    } finally {
      await manager.close();
    }
  });

  it('a follow-up submission WITHOUT _meta stays legally unbound with the WorkBuddy cause (T2 precondition)', async () => {
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
    // claim cause — the designated WorkBuddy receipt-fallback territory.
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

  it('a namespaced producer _meta binding with a CONFLICTING model claim fails closed (T4)', async () => {
    if (client === undefined) throw new Error('client not connected');
    const result = await client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: {
        ...SUBMIT_ARGS,
        anchorRef: 'A third Owner request in this conversation',
        hostSession: { sessionId: 'bogus-model-claimed-session' },
      },
      _meta: { ...REAL_ENGINE_META },
    });
    const [block] = result.content;
    if (block === undefined || block.type !== 'text') throw new Error('expected single text content block');
    const receipt = JSON.parse(block.text) as {
      status: string; taskId: string | null;
      sessionAssociation?: { status: string; detail?: string };
    };
    expect(receipt.status).toBe('submitted');
    // The trusted baggage session and the model claim disagree → fail closed,
    // never bind from either side (SPEC §G2 conflict rule).
    expect(receipt.sessionAssociation).toEqual({ status: 'unverified', detail: 'host_context_conflict' });
  });

  it('REVOKING the minimal identity authorization stops binding on the NEXT submission, no restart (Stage 3 / Devin)', async () => {
    if (client === undefined) throw new Error('client not connected');
    // Flip the Workspace authorization OFF behind the RUNNING server.
    const config = getDefaultPdConfig();
    config.features['host.workbuddy'].enabled = true;
    config.features.host_identity_minimal_metadata.enabled = false;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    const result = await client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...SUBMIT_ARGS, anchorRef: 'A fourth Owner request in this conversation' },
      _meta: { ...REAL_ENGINE_META },
    });
    const [block] = result.content;
    if (block === undefined || block.type !== 'text') throw new Error('expected single text content block');
    const receipt = JSON.parse(block.text) as {
      status: string; taskId: string | null;
      sessionAssociation?: { status: string; detail?: string };
    };
    expect(receipt.status).toBe('submitted');
    // The per-request authorization re-read sees the revocation: the trusted
    // engine identity is NOT persisted (fail closed, no server restart).
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
