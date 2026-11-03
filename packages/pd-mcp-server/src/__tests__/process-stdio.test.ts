/**
 * Real-process stdio tests — SPEC-PD-MCP-GATE4-001 §5.3/§5.5/§11.4.
 *
 * Drives the BUILT `dist/index.js` through the official SDK client's
 * StdioClientTransport — a real child process over real stdio pipes (the
 * spawn lives inside the SDK, keeping this package's own code
 * process-spawn-free). Pins: a full initialize → tools/list → tools/call →
 * shutdown round-trip through the REAL Gate 3 capability against a real
 * (empty) workspace; stdout stays pure MCP protocol (any stray banner would
 * break the SDK parser — successful operation IS the purity assertion);
 * stderr logging is sanitized JSON without the workspace path; fail-closed
 * startup (missing binding) refuses to connect; and the normal-shutdown
 * cycle repeats cleanly 10 times (§11.4 门槛: ≥10).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../index.js';
import { TOOL_NAME } from '../server.js';

const DIST_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');

interface Connected {
  client: Client;
  transport: StdioClientTransport;
  stderrText(): string;
}

async function connectServer(bindingEnv: Record<string, string>): Promise<Connected> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    env: bindingEnv,
    stderr: 'pipe',
  });
  let stderr = '';
  const stderrStream = transport.stderr as Readable | undefined;
  stderrStream?.setEncoding('utf8');
  stderrStream?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const client = new Client({ name: 'pd-process-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    stderrText: () => stderr,
  };
}

describe('process stdio contract (real dist/index.js child process)', () => {
  let workspaceDir: string;

  beforeAll(() => {
    expect(fs.existsSync(DIST_ENTRY)).toBe(true);
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mcp-proc-ws-'));
  });

  it('full round-trip through the REAL capability: initialize → tools/list → tools/call → clean shutdown', async () => {
    const { client, transport, stderrText } = await connectServer({ PD_MCP_WORKSPACE_DIR: workspaceDir, PD_MCP_HOST: 'codex' });

    const serverVersion = client.getServerVersion();
    expect(serverVersion?.name).toBe('pd-mcp-server');

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([TOOL_NAME]);
    const [toolEntry] = tools.tools;
    expect(toolEntry?.annotations?.readOnlyHint).toBe(true);

    // Real capability over an EMPTY workspace: sources missing → unavailable
    // with a stable code — read-only, no writes to the workspace.
    const before = fs.readdirSync(workspaceDir);
    const result = await client.callTool({ name: TOOL_NAME, arguments: { principleId: 'some-principle' } });
    expect(result.isError).toBeFalsy();
    const [block] = result.content;
    if (block === undefined || block.type !== 'text') throw new Error('expected text block');
    const envelope = JSON.parse(block.text) as { status: string; error: { code: string } | null };
    expect(['unavailable', 'not_found']).toContain(envelope.status);
    expect(fs.readdirSync(workspaceDir)).toEqual(before);

    // stdout purity is proven by the SDK parser completing every exchange
    // above; assert the transport stayed alive end-to-end.
    expect(transport.pid).toBeGreaterThan(0);

    await client.close();
    const errText = stderrText();
    expect(errText).not.toContain(workspaceDir);
    for (const line of errText.trim().split('\n')) {
      if (line.length === 0) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 30000);

  it('normal shutdown repeats cleanly 10 times (§11.4: ≥10)', async () => {
    for (let i = 0; i < 10; i++) {
      const { client } = await connectServer({ PD_MCP_WORKSPACE_DIR: workspaceDir });
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);
      await client.close();
    }
  }, 120000);

  it('fail-closed: empty binding env → connection refused (server exits before initialize)', async () => {
    await expect(connectServer({ PD_MCP_WORKSPACE_DIR: '' })).rejects.toThrow();
  }, 20000);

  it('main() fail-closed returns exit code 1 before touching stdio (in-process)', async () => {
    const code = await main({ PD_MCP_WORKSPACE_DIR: '' });
    expect(code).toBe(1);
    const codeMissing = await main({});
    expect(codeMissing).toBe(1);
    const codeRelative = await main({ PD_MCP_WORKSPACE_DIR: 'relative/path' });
    expect(codeRelative).toBe(1);
  });
});
