/**
 * PRI-1274 (B1) — T1 acceptance through the REAL server process.
 *
 * Drives the BUILT `dist/index.js` through the official SDK client's
 * StdioClientTransport (a real child process over real stdio pipes, real
 * startup workspace binding, real SQLite state.db) exactly like the
 * process-stdio suite. The Codex host attaches `_meta.threadId` WITHOUT a
 * turn id and the target turn text has never entered PD's trajectory: the
 * ORIGINAL Pain/Task write must already carry the bound session
 * (`sessionIdHint` + `painIngress.verifiedHostSession`), proving the
 * prebind main path end-to-end without Console, manual ids or PostToolUse.
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

describe('B1/T1 process acceptance — prebind through the real dist server', () => {
  let workspaceDir: string;
  let logDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    expect(fs.existsSync(DIST_ENTRY)).toBe(true);
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-b1-t1-ws-'));
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-b1-t1-logs-'));
    // The one-time Workspace minimal identity-metadata authorization.
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = true;
    config.features.host_identity_minimal_metadata.enabled = true;
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_ENTRY],
      env: {
        PD_MCP_WORKSPACE_DIR: workspaceDir,
        PD_MCP_HOST: 'codex',
        PD_MCP_LOG_DIR: logDir,
      },
      stderr: 'pipe',
    });
    const stderrStream = transport.stderr as Readable | undefined;
    stderrStream?.setEncoding('utf8');
    stderrStream?.on('data', () => {
      // Drain: stderr content is asserted via the state db, not here.
    });
    client = new Client({ name: 'pd-b1-t1-acceptance', version: '0.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('binds the session at the initial write from threadId-only _meta (no turn id, no collected target text)', async () => {
    const result = await client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...SUBMIT_ARGS },
      _meta: { threadId: 'b1-t1-rollout-0001' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const [block] = result.content;
    if (block === undefined || block.type !== 'text') throw new Error('expected single text content block');
    const receipt = JSON.parse(block.text) as {
      status: string; painId: string | null; taskId: string | null;
      sessionAssociation?: { status: string; sessionId?: string };
      error?: { code: string; message: string } | null;
    };
    expect(receipt.status, JSON.stringify(receipt.error)).toBe('submitted');
    expect(receipt.sessionAssociation).toEqual({ status: 'verified', sessionId: 'b1-t1-rollout-0001' });
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
      expect(diagnostic.sessionIdHint).toBe('b1-t1-rollout-0001');
      const painIngress = diagnostic.painIngress as Record<string, unknown>;
      expect(painIngress.verifiedHostSession).toEqual({ status: 'verified', sessionId: 'b1-t1-rollout-0001' });
      expect(diagnostic.evidence).toEqual([]);
    } finally {
      await manager.close();
    }
  });

  it('a follow-up submission WITHOUT _meta stays legally unbound with the explicit cause (T2 precondition)', async () => {
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
    expect(receipt.sessionAssociation).toEqual({ status: 'unverified', detail: 'codex_host_metadata_missing' });
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
