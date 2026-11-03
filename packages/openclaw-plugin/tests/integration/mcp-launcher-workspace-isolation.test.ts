/**
 * Gate 4 (PRI-1071) — REAL launcher/process evidence for OpenClaw multi-agent
 * workspace isolation.
 *
 * Two isolated plugin payloads (Agent X / Agent Y) each carry their own
 * `mcp-binding.json` pointing at a different governance workspace. Each
 * launcher is spawned as a REAL child process (official MCP stdio client)
 * with a NEUTRAL cwd that belongs to neither workspace, so:
 *   - the server's startup log fingerprint must equal the bound workspace
 *     (process-level evidence of WHICH workspace this process serves);
 *   - a recall for a principle that exists only in the OTHER workspace must
 *     return not_found, never that workspace's data (no cross-workspace leak).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const WORKTREE_TMP = path.join(REPO_ROOT, '.tmp');
const MCP_DIST = path.join(REPO_ROOT, 'packages', 'pd-mcp-server', 'dist');
const MCP_PACKAGE_JSON = path.join(REPO_ROOT, 'packages', 'pd-mcp-server', 'package.json');
const LAUNCHER = path.join(PACKAGE_ROOT, 'mcp', 'launcher.cjs');
const TOOL_NAME = 'pd_recall_principle_pains';
const P_X = 'principle-only-in-workspace-x';
const P_Y = 'principle-only-in-workspace-y';

let tempRoot: string;

function fingerprint(workspaceDir: string): string {
  return createHash('sha256').update(path.resolve(workspaceDir)).digest('hex').slice(0, 16);
}

function seedLedger(workspaceDir: string, principleId: string): void {
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'principle_training_state.json'),
    JSON.stringify({
      _tree: {
        principles: {
          [principleId]: {
            id: principleId,
            version: 1,
            text: `ledger principle ${principleId}`,
            triggerPattern: 'when in doubt',
            action: 'verify first',
            status: 'active',
            derivedFromPainIds: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    }, null, 2),
  );
}

function makePayload(name: string, workspaceDir: string): string {
  const payloadRoot = path.join(tempRoot, name);
  fs.mkdirSync(path.join(payloadRoot, 'mcp'), { recursive: true });
  fs.copyFileSync(LAUNCHER, path.join(payloadRoot, 'mcp', 'launcher.cjs'));
  fs.writeFileSync(path.join(payloadRoot, 'openclaw.plugin.json'), JSON.stringify({ id: 'principles-disciple', name: 'Principles Disciple' }));

  const runtimeDir = path.join(tempRoot, 'runtime');
  const serverDir = path.join(runtimeDir, 'pd-mcp-server');
  if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir, { recursive: true });
    fs.cpSync(MCP_DIST, path.join(serverDir, 'dist'), { recursive: true });
    fs.copyFileSync(MCP_PACKAGE_JSON, path.join(serverDir, 'package.json'));
  }
  const serverEntry = path.join(serverDir, 'dist', 'index.js');
  const version = (JSON.parse(fs.readFileSync(MCP_PACKAGE_JSON, 'utf8')) as { version: string }).version;
  fs.writeFileSync(
    path.join(payloadRoot, 'mcp-binding.json'),
    JSON.stringify({
      schemaVersion: 'pd.mcp-binding.v1',
      host: 'openclaw',
      workspaceDir,
      runtimeDir,
      serverEntry,
      versions: { mcpServer: version },
    }, null, 2),
  );
  return payloadRoot;
}

interface Connected {
  client: Client;
  stderrText(): string;
}

async function connectLauncher(payloadRoot: string): Promise<Connected> {
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(payloadRoot, 'mcp', 'launcher.cjs')],
    cwd: path.join(tempRoot, 'neutral-cwd'),
    env: { ...process.env },
    stderr: 'pipe',
  });
  const stream = transport.stderr as Readable | undefined;
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => { stderr += chunk; });
  const client = new Client({ name: 'pd-isolation-probe', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderrText: () => stderr };
}

async function recall(client: Client, principleId: string): Promise<{ status: string; errorCode: string | null; returned: number; identityStatus: string | null }> {
  const result = await client.callTool({ name: TOOL_NAME, arguments: { principleId } });
  expect(result.isError).toBeFalsy();
  const [block] = result.content;
  if (block === undefined || block.type !== 'text') throw new Error('expected text block');
  const envelope = JSON.parse(block.text) as {
    status: string;
    error: { code: string } | null;
    data: { principle: { identityStatus: string }; summary: { returned: number } } | null;
  };
  return {
    status: envelope.status,
    errorCode: envelope.error?.code ?? null,
    returned: envelope.data?.summary.returned ?? -1,
    identityStatus: envelope.data?.principle.identityStatus ?? null,
  };
}

describe('OpenClaw multi-workspace MCP isolation (real launcher process)', () => {
  beforeAll(() => {
    if (!fs.existsSync(path.join(MCP_DIST, 'index.js'))) {
      throw new Error(`built pd-mcp-server dist is missing: ${MCP_DIST}`);
    }
    fs.mkdirSync(WORKTREE_TMP, { recursive: true });
    tempRoot = fs.mkdtempSync(path.join(WORKTREE_TMP, 'oc-mcp-isolation-'));
    fs.mkdirSync(path.join(tempRoot, 'neutral-cwd'), { recursive: true });
    seedLedger(path.join(tempRoot, 'workspace-x'), P_X);
    seedLedger(path.join(tempRoot, 'workspace-y'), P_Y);
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('Agent X process serves workspace X only (fingerprint + data), never workspace Y', async () => {
    const payloadX = makePayload('agent-x', path.join(tempRoot, 'workspace-x'));
    const connected = await connectLauncher(payloadX);
    try {
      const startup = connected.stderrText()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { event?: string; workspaceFingerprint?: string })
        .find((entry) => entry.event === 'startup');
      expect(startup?.workspaceFingerprint).toBe(fingerprint(path.join(tempRoot, 'workspace-x')));
      expect(startup?.workspaceFingerprint).not.toBe(fingerprint(path.join(tempRoot, 'workspace-y')));

      // OWN principle: the ledger resolves it, then the (absent) trajectory
      // source stops the query — proof the server read workspace X's ledger.
      const own = await recall(connected.client, P_X);
      expect(own.status).toBe('unavailable');
      expect(own.errorCode).toBe('source_missing');

      const foreign = await recall(connected.client, P_Y);
      expect(foreign.status).toBe('not_found');
      expect(foreign.errorCode).toBe('principle_not_found');
      expect(foreign.returned).toBe(0);

      console.log('[gate4-evidence]', JSON.stringify({
        host: 'openclaw', agent: 'X', launcherCwd: path.join(tempRoot, 'neutral-cwd'),
        bindingWorkspace: path.join(tempRoot, 'workspace-x'),
        serverWsFingerprint: startup?.workspaceFingerprint,
        workspaceXFingerprint: fingerprint(path.join(tempRoot, 'workspace-x')),
        workspaceYFingerprint: fingerprint(path.join(tempRoot, 'workspace-y')),
        ownPrincipleCall: own, foreignPrincipleCallInX: foreign,
      }));
    } finally {
      await connected.client.close();
    }
  }, 30000);

  it('Agent Y process serves workspace Y only, never workspace X', async () => {
    const payloadY = makePayload('agent-y', path.join(tempRoot, 'workspace-y'));
    const connected = await connectLauncher(payloadY);
    try {
      const startup = connected.stderrText()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { event?: string; workspaceFingerprint?: string })
        .find((entry) => entry.event === 'startup');
      expect(startup?.workspaceFingerprint).toBe(fingerprint(path.join(tempRoot, 'workspace-y')));

      const own = await recall(connected.client, P_Y);
      expect(own.status).toBe('unavailable');
      expect(own.errorCode).toBe('source_missing');
      const foreign = await recall(connected.client, P_X);
      expect(foreign.status).toBe('not_found');
      expect(foreign.returned).toBe(0);
    } finally {
      await connected.client.close();
    }
  }, 30000);

  it('a payload without a binding fails closed before any MCP traffic', async () => {
    const payload = makePayload('agent-no-binding', path.join(tempRoot, 'workspace-x'));
    fs.rmSync(path.join(payload, 'mcp-binding.json'));
    await expect(connectLauncher(payload)).rejects.toThrow();
  }, 20000);
});
