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
import { SUBMIT_TOOL_NAME, TOOL_NAME } from '../server.js';

const DIST_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');
let logDir = '';

interface Connected {
  client: Client;
  transport: StdioClientTransport;
  stderrText(): string;
}

async function connectServer(bindingEnv: Record<string, string>): Promise<Connected> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    env: { ...bindingEnv, PD_MCP_LOG_DIR: logDir },
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
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mcp-proc-logs-'));
  });

  function newLogFiles(before: ReadonlySet<string>): string[] {
    return fs.readdirSync(logDir).filter((name) => /^mcp-.*\.jsonl$/.test(name) && !before.has(name));
  }

  function latestLog(before: ReadonlySet<string>): { file: string; lines: Record<string, unknown>[] } {
    const files = newLogFiles(before)
      .map((name) => {
        const fullPath = path.join(logDir, name);
        return { name, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    const newest = files[files.length - 1];
    if (newest === undefined) throw new Error('no MCP log file was written');
    const lines = fs.readFileSync(newest.fullPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { file: newest.fullPath, lines };
  }

  it('full round-trip through the REAL capability: initialize → tools/list → tools/call → clean shutdown', async () => {
    const { client, transport, stderrText } = await connectServer({ PD_MCP_WORKSPACE_DIR: workspaceDir, PD_MCP_HOST: 'codex' });

    const serverVersion = client.getServerVersion();
    expect(serverVersion?.name).toBe('pd-mcp-server');

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([TOOL_NAME, SUBMIT_TOOL_NAME]);
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

  it('OG-4: all three hosts expose both tools; a missing host stays recall-only', async () => {
    for (const host of ['codex', 'openclaw', 'workbuddy'] as const) {
      const connected = await connectServer({ PD_MCP_WORKSPACE_DIR: workspaceDir, PD_MCP_HOST: host });
      const tools = await connected.client.listTools();
      expect(tools.tools.map((tool) => tool.name), `${host} tools`).toEqual([TOOL_NAME, SUBMIT_TOOL_NAME]);
      const submit = tools.tools.find((tool) => tool.name === SUBMIT_TOOL_NAME);
      expect(submit?.annotations?.readOnlyHint).toBe(false);
      expect(submit?.annotations?.destructiveHint).toBe(false);
      await connected.client.close();
    }

    const unbound = await connectServer({ PD_MCP_WORKSPACE_DIR: workspaceDir });
    const unboundTools = await unbound.client.listTools();
    expect(unboundTools.tools.map((tool) => tool.name)).toEqual([TOOL_NAME]);
    await unbound.client.close();
  }, 90000);

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
    const code = await main({ PD_MCP_WORKSPACE_DIR: '', PD_MCP_LOG_DIR: logDir });
    expect(code).toBe(1);
    const codeMissing = await main({ PD_MCP_LOG_DIR: logDir });
    expect(codeMissing).toBe(1);
    const codeRelative = await main({ PD_MCP_WORKSPACE_DIR: 'relative/path', PD_MCP_LOG_DIR: logDir });
    expect(codeRelative).toBe(1);
  });

  it('durable JSONL records the real initialize → tools/list → tool_call → shutdown order', async () => {
    const before = new Set(fs.readdirSync(logDir));
    const { client } = await connectServer({ PD_MCP_WORKSPACE_DIR: workspaceDir, PD_MCP_HOST: 'codex' });
    await client.listTools();
    const result = await client.callTool({ name: TOOL_NAME, arguments: { principleId: 'some-principle' } });
    expect(result.isError).toBeFalsy();
    await client.close();

    const { lines } = latestLog(before);
    const events = lines.map((line) => `${String(line.event)}:${String(line.phase ?? '')}`);
    expect(events).toEqual([
      'startup:',
      'initialize:request',
      'initialize:response',
      'tools_list:request',
      'tools_list:response',
      'tool_call:',
      'shutdown:',
    ]);
    const startup = lines[0] as Record<string, unknown>;
    expect(startup.host).toBe('codex');
    expect(typeof startup.workspaceFingerprint).toBe('string');
    const initializeResponse = lines[2] as Record<string, unknown>;
    expect(initializeResponse.ok).toBe(true);
    const toolCall = lines[5] as Record<string, unknown>;
    expect(toolCall.toolName).toBe(TOOL_NAME);
    expect(typeof toolCall.durationMs).toBe('number');
    expect(typeof toolCall.responseBytes).toBe('number');
    expect(toolCall.truncated).toBe(false);
    const seqs = lines.map((line) => Number(line.seq));
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    for (const line of lines) {
      expect(String(line.ts)).toMatch(/[+-]\d{2}:\d{2}$/);
      expect(line.tzOffsetMinutes).toBeTypeOf('number');
      expect(JSON.stringify(line)).not.toContain(workspaceDir);
    }
  }, 30000);

  it('startup_failure is persisted when the process exits before initialize', async () => {
    const before = new Set(fs.readdirSync(logDir));
    await expect(connectServer({ PD_MCP_WORKSPACE_DIR: '' })).rejects.toThrow();
    const { lines } = latestLog(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe('startup_failure');
    expect(lines[0]?.stage).toBe('server');
    expect(lines[0]?.reasonCode).toBe('workspace_env_missing');
  }, 20000);
});
