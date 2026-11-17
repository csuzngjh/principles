/**
 * `pd mcp probe` — active liveness probe tests.
 *
 * Real-filesystem fixtures under an exclusive mkdtemp HOME (same recipe as
 * health-mcp.test.ts), with the "installed server entry" replaced by a REAL
 * spawnable minimal MCP server so the handshake client is exercised end to
 * end: happy path, timeout, early exit, contract violation, static refusal.
 *
 * cli-7: the registration block also parses the REAL program tree
 * (buildPdProgram), not a hand-copied command definition.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMcpProbe, handleMcpProbe } from '../../src/commands/mcp-probe.js';
import { assessMcpHealth } from '../../src/commands/health-mcp.js';

const SCHEMA = 'pd.mcp-binding.v1';
const originalExitCode = process.exitCode;

// ─── fixture helpers (mirror health-mcp.test.ts) ─────────────────────────────

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * A real, spawnable minimal MCP stdio server. Modes:
 *  - 'ok'      — full handshake, exposes the contract tool (+ submit tool).
 *  - 'silent'  — stays alive, never answers (probe must time out).
 *  - 'exit'    — exits immediately with code 3 after writing stderr.
 *  - 'wrong'   — handshakes, but tools/list omits the contract tool.
 */
function writeFixtureServer(serverEntry: string, mode: 'ok' | 'silent' | 'exit' | 'wrong'): void {
  fs.mkdirSync(path.dirname(serverEntry), { recursive: true });
  const body = `
const mode = ${JSON.stringify(mode)};
if (mode === 'exit') {
  process.stderr.write('fixture startup failure\\n');
  process.exit(3);
}
if (mode === 'silent') {
  setInterval(() => {}, 1000);
} else {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });
  if (!process.env.PD_MCP_WORKSPACE_DIR) {
    process.stderr.write('workspace binding missing\\n');
    process.exit(1);
  }
  const host = process.env.PD_MCP_HOST;
  if (host !== undefined && host !== 'openclaw') {
    process.stderr.write('unexpected host marker: ' + host + '\\n');
  }
  rl.on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === 1 && msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'pd-mcp-server-fixture', version: '0.1.0' },
      } }) + '\\n');
    } else if (msg.id === 2 && msg.method === 'tools/list') {
      const tools = mode === 'wrong'
        ? [{ name: 'some_other_tool' }]
        : [{ name: 'pd_recall_principle_pains' }, { name: 'pd_submit_pain' }];
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } }) + '\\n');
    }
  });
  rl.on('close', () => process.exit(0));
}
`;
  fs.writeFileSync(serverEntry, body);
}

interface ProbeFixture {
  home: string;
  workspace: string;
  serverEntry: string;
  bindingPath: string;
}

/**
 * A static-HEALTHY openclaw layout: extension payload + registered host
 * config + canonical runtime entry + agreeing binding. `serverMode` decides
 * what the "installed server" actually does when spawned.
 */
function makeFixture(home: string, serverMode: 'ok' | 'silent' | 'exit' | 'wrong'): ProbeFixture {
  const payloadRoot = path.join(home, '.openclaw', 'extensions', 'principles-disciple');
  const runtimeDir = path.join(home, '.pd', 'runtime');
  const serverEntry = path.join(runtimeDir, 'pd-mcp-server', 'dist', 'index.js');
  const workspace = path.join(home, 'ws');
  fs.mkdirSync(workspace, { recursive: true });

  writeJson(path.join(payloadRoot, 'openclaw.plugin.json'), {
    id: 'principles-disciple',
    mcpServers: { 'pd-recall': { transport: 'stdio', command: 'node', args: ['./mcp/launcher.cjs'] } },
  });
  const launcher = path.join(payloadRoot, 'mcp', 'launcher.cjs');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "// pd-mcp-launcher.v1\nconst bindingSchema = 'pd.mcp-binding.v1';\n");
  writeJson(path.join(home, '.openclaw', 'openclaw.json'), {
    mcp: { servers: { 'pd-recall': { command: 'node', args: [launcher] } } },
  });
  writeJson(path.join(runtimeDir, 'pd-mcp-server', 'package.json'), {
    name: '@principles/pd-mcp-server',
    version: '0.1.0',
  });
  writeFixtureServer(serverEntry, serverMode);

  const bindingPath = path.join(payloadRoot, 'mcp-binding.json');
  writeJson(bindingPath, {
    schemaVersion: SCHEMA,
    host: 'openclaw',
    workspaceDir: workspace,
    runtimeDir,
    serverEntry,
    versions: { mcpServer: '0.1.0' },
  });
  return { home, workspace, serverEntry, bindingPath };
}

function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mcp-probe-'));
  // `return await` is load-bearing: a bare `return fn(home)` would run the
  // finally-cleanup the moment the promise is RETURNED (before it resolves),
  // deleting the fixture home out from under the spawned server child.
  return (async () => {
    try {
      return await fn(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })();
}

// ─── probe behavior ──────────────────────────────────────────────────────────

describe('pd mcp probe — happy path', () => {
  it('completes the handshake and verifies the contract tool', async () => {
    await withHome(async (home) => {
      const fixture = makeFixture(home, 'ok');
      const sanity = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(sanity.status).toBe('HEALTHY');
      expect(fs.existsSync(fixture.serverEntry), 'fixture entry exists before probe').toBe(true);

      const result = await runMcpProbe({
        workspace: fixture.workspace,
        host: 'openclaw',
        homeDir: home,
        timeoutMs: 15_000,
      });
      expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
      expect(result.phase).toBe('shutdown');
      expect(result.tools).toContain('pd_recall_principle_pains');
      expect(result.expectedToolPresent).toBe(true);
      expect(result.submitToolPresent).toBe(true);
      expect(result.protocolVersion).toBe('2025-03-26');
      expect(result.serverInfo).toEqual({ name: 'pd-mcp-server-fixture', version: '0.1.0' });
      expect(result.reason).toBeUndefined();
      expect(result.durationMs).toBeGreaterThan(0);
      // PRI-1247: the receipt names the workspace the binding actually serves.
      expect(result.workspace).toBe(fixture.workspace);
      expect(result.requestedWorkspace).toBe(fixture.workspace);
      expect(result.boundWorkspace).toBe(fixture.workspace);
      expect(result.workspaceMatchesRequest).toBe(true);
    });
  });

  it('selects the host from the serving binding when --host is omitted', async () => {
    await withHome(async (home) => {
      const fixture = makeFixture(home, 'ok');
      const result = await runMcpProbe({ workspace: fixture.workspace, homeDir: home, timeoutMs: 15_000 });
      expect(result.host).toBe('openclaw');
      expect(result.ok).toBe(true);
    });
  });
});

describe('pd mcp probe — failure modes', () => {
  it('refuses an explicit probe target the binding does not serve (PRI-1247 cross-host misbinding)', async () => {
    await withHome(async (home) => {
      const fixture = makeFixture(home, 'ok');
      const requested = path.join(home, 'requested-ws');
      fs.mkdirSync(requested, { recursive: true });

      const result = await runMcpProbe({
        workspace: requested,
        host: 'openclaw',
        homeDir: home,
        timeoutMs: 15_000,
      });
      expect(result.ok).toBe(false);
      expect(result.phase).toBe('static');
      expect(result.workspace).toBe(fixture.workspace);
      expect(result.requestedWorkspace).toBe(path.resolve(requested));
      expect(result.boundWorkspace).toBe(fixture.workspace);
      expect(result.workspaceMatchesRequest).toBe(false);
      expect(result.reason).toContain('workspace_mismatch');
      expect(result.nextAction).toContain('Re-run the PD host setup');
    });
  });

  it('refuses without spawning when the static install layer is not verified (cli-5)', async () => {
    await withHome(async (home) => {
      // Empty home: nothing installed.
      const workspace = path.join(home, 'ws');
      fs.mkdirSync(workspace, { recursive: true });
      const result = await runMcpProbe({ workspace, host: 'openclaw', homeDir: home, timeoutMs: 2_000 });
      expect(result.ok).toBe(false);
      expect(result.phase).toBe('static');
      expect(result.reason).toBeTruthy();
      expect(result.nextAction).toBeTruthy();
      expect(result.tools).toEqual([]);
    });
  });

  it('fails with a timeout reason when the server never answers (bounded probe)', async () => {
    await withHome(async (home) => {
      const fixture = makeFixture(home, 'silent');
      const result = await runMcpProbe({ workspace: fixture.workspace, host: 'openclaw', homeDir: home, timeoutMs: 1_500 });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('timed out');
      expect(result.nextAction).toBeTruthy();
    });
  }, 20_000);

  it('fails when the server exits before the handshake and captures the stderr tail', async () => {
    await withHome(async (home) => {
      const fixture = makeFixture(home, 'exit');
      const result = await runMcpProbe({ workspace: fixture.workspace, host: 'openclaw', homeDir: home, timeoutMs: 10_000 });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(3);
      expect(result.reason).toContain('exited early');
      expect(result.stderrTail).toContain('fixture startup failure');
    });
  });

  it('fails when tools/list omits the contract tool (contract violation)', async () => {
    await withHome(async (home) => {
      const fixture = makeFixture(home, 'wrong');
      const result = await runMcpProbe({ workspace: fixture.workspace, host: 'openclaw', homeDir: home, timeoutMs: 15_000 });
      expect(result.ok).toBe(false);
      expect(result.phase).toBe('validate');
      expect(result.reason).toContain('pd_recall_principle_pains');
      expect(result.nextAction).toBeTruthy();
    });
  });

  it('clamps an out-of-domain timeout into the supported range (ERR-191)', async () => {
    await withHome(async (home) => {
      const fixture = makeFixture(home, 'silent');
      // 1ms would be clamped UP to the 1000ms floor: the probe still runs a
      // real bounded handshake attempt rather than failing on an API range.
      const result = await runMcpProbe({ workspace: fixture.workspace, host: 'openclaw', homeDir: home, timeoutMs: 1 });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('timed out after 1000ms');
    });
  }, 20_000);
});

describe('pd mcp probe — handler contract (cli-1/cli-2/cli-6)', () => {
  beforeEach(() => {
    process.exitCode = originalExitCode;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('emits exactly one parseable JSON document and sets exitCode 1 on failure', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await withHome(async (home) => {
        const workspace = path.join(home, 'ws');
        fs.mkdirSync(workspace, { recursive: true });
        await handleMcpProbe({ workspace, host: 'openclaw', homeDir: home, json: true, timeoutMs: 2_000 });
        expect(logSpy).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as { ok: boolean; reason?: string; nextAction?: string };
        expect(payload.ok).toBe(false);
        expect(payload.reason).toBeTruthy();
        expect(payload.nextAction).toBeTruthy();
        expect(process.exitCode).toBe(1);
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('leaves exitCode untouched on success (ERR-181: no stray process.exit)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await withHome(async (home) => {
        const fixture = makeFixture(home, 'ok');
        await handleMcpProbe({ workspace: fixture.workspace, host: 'openclaw', homeDir: home, json: true, timeoutMs: 15_000 });
        expect(process.exitCode).toBe(originalExitCode);
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ─── cli-7: real registration wiring ─────────────────────────────────────────

describe('cli-7: pd mcp probe registration (real program tree)', () => {
  it('registers under the mcp subtree with the documented options', async () => {
    const { buildPdProgram } = await import('../../src/program.js');
    const program = buildPdProgram();
    const mcpCmd = program.commands.find((cmd) => cmd.name() === 'mcp');
    expect(mcpCmd).toBeDefined();
    const probeCmd = mcpCmd?.commands.find((cmd) => cmd.name() === 'probe');
    expect(probeCmd).toBeDefined();
    const longFlags = probeCmd?.options.map((option) => option.long).filter((flag): flag is string => flag !== undefined) ?? [];
    expect(longFlags).toContain('--workspace');
    expect(longFlags).toContain('--host');
    expect(longFlags).toContain('--timeout-ms');
    expect(longFlags).toContain('--json');
    expect(probeCmd?.description()).toContain('initialize');
  });

  it('rejects an unknown --host with one JSON doc + exitCode 1 (no spawn)', async () => {
    const { buildPdProgram } = await import('../../src/program.js');
    const program = buildPdProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await program.parseAsync(['node', 'pd', 'mcp', 'probe', '--host', 'bogus', '--json']);
      expect(process.exitCode).toBe(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as { ok: boolean; reason: string };
      expect(payload.ok).toBe(false);
      expect(payload.reason).toBe('invalid_host');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it('rejects a non-numeric --timeout-ms instead of silently using the default (rc-9)', async () => {
    const { buildPdProgram } = await import('../../src/program.js');
    const program = buildPdProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // commander's parseInt coercion turns 'abc' into NaN — the registration
      // must surface that as a structured rejection, not fall back silently.
      // (--host is passed valid because buildPdProgram() returns the module
      // singleton: a previous parse's opts persist, so tests must not depend
      // on unspecified options being undefined.)
      await program.parseAsync(['node', 'pd', 'mcp', 'probe', '--host', 'openclaw', '--timeout-ms', 'abc', '--json']);
      expect(process.exitCode).toBe(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as { ok: boolean; reason: string };
      expect(payload.ok).toBe(false);
      expect(payload.reason).toBe('invalid_timeout_ms');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });
});
