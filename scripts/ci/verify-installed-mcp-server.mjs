#!/usr/bin/env node
// Real installed-runtime verification for @principles/pd-mcp-server (PRI-1071
// P1-4E/P1-5). CI runs this AFTER an isolated install of the PR-built
// tarballs: it proves the INSTALLED bytes resolve their dependencies inside
// the runtime directory (never the monorepo source tree) and serve the MCP
// protocol over a real stdio child process.
//
// Usage: node scripts/ci/verify-installed-mcp-server.mjs --runtime-dir <dir> [--workspace <dir>]
//
// Stdout is one machine-readable JSON object. Exit 0 = PASS.

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// OG-4 (Owner-authorized 2026-11-13, decision card r6) turned the write tool on
// for all three hosts, so the installed server MUST expose both. A recall-only
// inventory here means the installed bytes predate OG-4 (or degraded to
// recall-only because the workspace config failed to load), and silently
// shipping that would deliver a server whose advertised capability is missing.
const RECALL_TOOL_NAME = 'pd_recall_principle_pains';
const SUBMIT_TOOL_NAME = 'pd_submit_pain';
const EXPECTED_TOOL_NAMES = [RECALL_TOOL_NAME, SUBMIT_TOOL_NAME];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime-dir') args.runtimeDir = argv[++i];
    else if (arg === '--workspace') args.workspace = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/ci/verify-installed-mcp-server.mjs --runtime-dir <dir> [--workspace <dir>]');
      process.exit(0);
    } else {
      fail('unknown_argument:' + arg, { nextAction: 'supported: --runtime-dir <dir> [--workspace <dir>]' });
    }
  }
  if (!args.runtimeDir) fail('missing_runtime_dir', { nextAction: 'pass --runtime-dir <isolated install root>' });
  return args;
}

function fail(reason, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, reason, ...extra }) + '\n');
  process.exit(1);
}

function assertInsideRuntime(runtimeReal, candidatePath, label) {
  const real = fs.realpathSync(candidatePath);
  if (real !== runtimeReal && !real.startsWith(runtimeReal + path.sep)) {
    fail('dependency_escaped_runtime', { label, resolved: real, runtime: runtimeReal });
  }
  return real;
}

async function main() {
  const args = parseArgs(process.argv);
  const runtimeDir = path.resolve(args.runtimeDir);
  const runtimeReal = fs.realpathSync(runtimeDir);

  const serverManifestPath = path.join(runtimeDir, 'node_modules', '@principles', 'pd-mcp-server', 'package.json');
  if (!fs.existsSync(serverManifestPath)) fail('mcp_server_not_installed', { serverManifestPath });
  const serverManifest = JSON.parse(fs.readFileSync(serverManifestPath, 'utf8'));
  const serverEntry = path.join(path.dirname(serverManifestPath), 'dist', 'index.js');
  if (!fs.existsSync(serverEntry)) fail('server_entry_missing', { serverEntry });

  const requireFromInstalled = createRequire(serverManifestPath);
  let coreManifestPath;
  let coreManifest;
  try {
    coreManifestPath = requireFromInstalled.resolve('@principles/core/package.json');
    coreManifest = JSON.parse(fs.readFileSync(coreManifestPath, 'utf8'));
  } catch (error) {
    fail('core_dependency_unresolved', { message: String(error && error.message).slice(0, 200) });
  }
  const coreReal = assertInsideRuntime(runtimeReal, coreManifestPath, '@principles/core');

  let sdkEntry;
  try {
    sdkEntry = requireFromInstalled.resolve('@modelcontextprotocol/server');
  } catch (error) {
    fail('mcp_sdk_unresolved', { message: String(error && error.message).slice(0, 200) });
  }
  const sdkReal = assertInsideRuntime(runtimeReal, sdkEntry, '@modelcontextprotocol/server');

  const createdWorkspace = !args.workspace;
  const workspaceDir = createdWorkspace
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'pd-installed-mcp-ws-'))
    : path.resolve(args.workspace);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, PD_MCP_WORKSPACE_DIR: workspaceDir, PD_MCP_HOST: 'codex' },
    stderr: 'pipe',
  });
  let stderrText = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', (chunk) => { stderrText += chunk; });

  let serverVersion;
  let tools;
  let envelopeStatus;
  const client = new Client({ name: 'pd-installed-verify', version: '0.0.0' });
  try {
    await client.connect(transport);
    serverVersion = client.getServerVersion();
    tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOL_NAMES)) {
      fail('unexpected_tool_list', { toolNames, expected: EXPECTED_TOOL_NAMES });
    }

    const before = fs.readdirSync(workspaceDir);
    const result = await client.callTool({ name: RECALL_TOOL_NAME, arguments: { principleId: 'installed-verify' } });
    if (result.isError) fail('tool_call_returned_is_error', { content: result.content });
    const [block] = result.content ?? [];
    if (!block || block.type !== 'text') fail('tool_call_missing_text_block', { blockType: block?.type ?? null });
    const envelope = JSON.parse(block.text);
    envelopeStatus = envelope.status;
    if (!['ok', 'unavailable', 'not_found'].includes(envelopeStatus)) {
      fail('unexpected_envelope_status', { envelopeStatus });
    }
    const after = fs.readdirSync(workspaceDir);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail('read_only_tool_mutated_workspace', { before, after });
    }
    await client.close();
  } catch (error) {
    fail('installed_server_exchange_failed', { message: String(error && error.message).slice(0, 300) });
  }

  if (stderrText.includes(workspaceDir)) fail('stderr_leaked_workspace_path');
  for (const line of stderrText.trim().split('\n')) {
    if (line.length === 0) continue;
    try {
      JSON.parse(line);
    } catch {
      fail('stderr_not_sanitized_json', { line: line.slice(0, 120) });
    }
  }

  if (createdWorkspace) fs.rmSync(workspaceDir, { recursive: true, force: true });

  process.stdout.write(JSON.stringify({
    ok: true,
    runtimeDir,
    server: { name: serverVersion?.name ?? null, version: serverVersion?.version ?? null },
    packageVersion: serverManifest.version,
    dependencies: {
      core: { version: coreManifest.version, physical: coreReal },
      mcpSdk: { physical: sdkReal },
    },
    toolNames: tools.tools.map((tool) => tool.name),
    envelopeStatus,
    stderrLines: stderrText.trim().split('\n').filter((line) => line.length > 0).length,
  }) + '\n');
  process.exit(0);
}

main().catch((error) => fail('unhandled_error', { message: String(error && error.message).slice(0, 300) }));
