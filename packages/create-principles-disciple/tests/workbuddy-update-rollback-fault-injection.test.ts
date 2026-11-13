/**
 * Gate 4 (PRI-1071) — WorkBuddy UPDATE-FAILURE ROLLBACK with REAL fault
 * injection (SPEC-PD-MCP-GATE4-001 §11.3/§11.4 "更新失败 → 恢复上一版本",
 * "成功覆盖故障注入").
 *
 * Scenario (real temp filesystem, real installer, real launcher process):
 *   1. install payload 0.3.0 → real cache + mcp-binding.json + host JSONs;
 *   2. re-run with a CHANGED same-version payload → the installer backs up the
 *      live cache, swaps in the verified new one, then commits settings.json /
 *      installed_plugins.json;
 *   3. FAULT: installed_plugins.json is made read-only, so the registry commit
 *      fails exactly AFTER the cache swap;
 *   4. assert the installer rolls back: old cache restored byte-for-byte, old
 *      binding retained, settings.json/installed_plugins.json byte-identical,
 *      staging removed;
 *   5. START THE REAL LAUNCHER from the restored cache and prove initialize +
 *      tools/list + a read-only tools/call still serve the OLD workspace.
 *
 * No mock replaces the copy/swap/rollback/launcher/MCP path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WorkBuddyHostInstaller,
  WORKBUDDY_MARKETPLACE_NAME,
  WORKBUDDY_PLUGIN_NAME,
} from '../src/installers/workbuddy-host-installer.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const WORKTREE_TMP = path.join(REPO_ROOT, '.tmp');
const MCP_DIST = path.join(REPO_ROOT, 'packages', 'pd-mcp-server', 'dist');
const MCP_PACKAGE_JSON = path.join(REPO_ROOT, 'packages', 'pd-mcp-server', 'package.json');
// OG-4 (Owner-authorized 2026-11-13, decision card r6) enables the write tool on
// all three hosts. The restored cache runs THIS build's pd-mcp-server bytes
// (MCP_DIST), so the inventory is both tools — the assertion's job is to prove
// the restored launcher serves the real server, not to pin a recall-only era.
const RECALL_TOOL_NAME = 'pd_recall_principle_pains';
const SUBMIT_TOOL_NAME = 'pd_submit_pain';
const TOOL_NAME = RECALL_TOOL_NAME;
const P_OLD = 'principle-in-old-workspace';
const P_OTHER = 'principle-not-in-old-workspace';
const VERSION = '0.3.0';

let home: string;
let configDir: string;
let payloadRoot: string;
let installer: WorkBuddyHostInstaller;
let previousConfigEnv: string | undefined;

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Stable manifest of every file under a directory (path → sha256). */
function digestTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, relative: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(relative, entry.name);
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out[rel] = sha256File(abs);
    }
  };
  walk(root, '');
  return out;
}

function writePluginSkeleton(pluginDir: string): void {
  fs.cpSync(path.join(PACKAGE_ROOT, '..', 'workbuddy-adapter', 'plugin', 'skills'), path.join(pluginDir, 'skills'), { recursive: true });
  fs.cpSync(path.join(PACKAGE_ROOT, '..', 'workbuddy-adapter', 'plugin', 'mcp'), path.join(pluginDir, 'mcp'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(PACKAGE_ROOT, '..', 'workbuddy-adapter', 'plugin', 'scripts', 'pd-control.cjs'), path.join(pluginDir, 'scripts', 'pd-control.cjs'));
  fs.writeFileSync(path.join(pluginDir, 'scripts', 'wrapper.cjs'), '// wrapper v1\n');
  fs.mkdirSync(path.join(pluginDir, '.codebuddy-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, '.codebuddy-plugin', 'plugin.json'),
    JSON.stringify({ name: WORKBUDDY_PLUGIN_NAME, version: VERSION, description: 'rollback-lab' }, null, 2),
  );
  const hook = (eventArg: string) => ({
    matcher: '*',
    hooks: [{ type: 'command', command: `node "\${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" ${eventArg}`, timeout: 30 }],
  });
  fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { PreToolUse: [hook('pretooluse')], PostToolUse: [hook('posttooluse')], UserPromptSubmit: [hook('userpromptsubmit')], SessionStart: [hook('sessionstart')] } }, null, 2),
  );
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

function cacheVersionDir(): string {
  return path.join(configDir, 'plugins', 'cache', WORKBUDDY_MARKETPLACE_NAME, WORKBUDDY_PLUGIN_NAME, VERSION);
}

function installCtx(): Parameters<WorkBuddyHostInstaller['install']>[0] {
  return { workspaceDir: path.join(home, 'some-project'), pluginDir: payloadRoot, language: 'en', mode: 'smart' };
}

describe('WorkBuddy update-failure rollback (real fault injection)', () => {
  beforeAll(() => {
    if (!fs.existsSync(path.join(MCP_DIST, 'index.js'))) {
      throw new Error(`built pd-mcp-server dist is missing: ${MCP_DIST}`);
    }
    fs.mkdirSync(WORKTREE_TMP, { recursive: true });
    home = fs.mkdtempSync(path.join(WORKTREE_TMP, 'wb-rollback-'));
    configDir = path.join(home, '.workbuddy');
    fs.mkdirSync(configDir, { recursive: true });
    previousConfigEnv = process.env.WORKBUDDY_CONFIG_DIR;
    process.env.WORKBUDDY_CONFIG_DIR = configDir;

    // Bundled installer payload (engine unreachable → real direct-write path).
    payloadRoot = fs.mkdtempSync(path.join(WORKTREE_TMP, 'wb-rollback-payload-'));
    const adapterRoot = path.join(payloadRoot, 'workbuddy-adapter');
    writePluginSkeleton(path.join(adapterRoot, 'plugin'));
    fs.mkdirSync(path.join(adapterRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(adapterRoot, 'dist', 'index.js'), '// adapter dist placeholder\n');
    fs.writeFileSync(path.join(adapterRoot, 'package.json'), JSON.stringify({ name: '@principles/workbuddy-adapter', version: '0.1.0' }, null, 2));

    // REAL installed MCP server component (unbundled dist resolves through the
    // repo's node_modules because this lab lives under <repo>/.tmp).
    const serverDir = path.join(home, '.pd', 'runtime', 'pd-mcp-server');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.cpSync(MCP_DIST, path.join(serverDir, 'dist'), { recursive: true });
    fs.copyFileSync(MCP_PACKAGE_JSON, path.join(serverDir, 'package.json'));

    installer = new WorkBuddyHostInstaller({ homeDir: () => home, enginePath: () => undefined });
  });

  afterAll(() => {
    if (previousConfigEnv === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
    else process.env.WORKBUDDY_CONFIG_DIR = previousConfigEnv;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(payloadRoot, { recursive: true, force: true });
  });

  it('restores the previous plugin version when the registration commit fails after the cache swap', async () => {
    // 1. Install the OLD version.
    const first = await installer.install(installCtx());
    expect(first.success).toBe(true);
    expect(fs.existsSync(cacheVersionDir())).toBe(true);

    // 2. Seed the OLD governance workspace with evidence its launcher serves.
    seedLedger(path.join(home, '.workbuddy', 'pd-workspace'), P_OLD);

    const settingsPath = path.join(configDir, 'settings.json');
    const registryPath = path.join(configDir, 'plugins', 'installed_plugins.json');
    const oldCacheDigest = digestTree(cacheVersionDir());
    const oldBindingSha = sha256File(path.join(cacheVersionDir(), 'mcp-binding.json'));
    const oldSettingsSha = sha256File(settingsPath);
    const oldRegistrySha = sha256File(registryPath);

    // 3. Publish a CHANGED same-version payload, then inject the fault: the
    //    registry commit must fail AFTER the cache swap.
    //    Cross-platform real OS failure, no mock seam:
    //      - Windows: a read-only target file makes the atomic rename fail;
    //      - POSIX: rename over a read-only file is legal, so the registry's
    //        PARENT dir is made non-writable — the backup/temp step inside it
    //        fails. The cache staging/swap lives in a deeper directory, so the
    //        cache replacement still happens first.
    fs.writeFileSync(path.join(payloadRoot, 'workbuddy-adapter', 'plugin', 'scripts', 'wrapper.cjs'), '// wrapper v2 (changed payload)\n');
    const pluginsDir = path.dirname(registryPath);
    fs.chmodSync(registryPath, 0o444);
    fs.chmodSync(pluginsDir, 0o555);

    const second = await installer.install(installCtx());
    expect(second.success).toBe(false);
    expect(second.reason).toContain('workbuddy_registration_commit_failed');
    // Only a fully successful rollback may claim restoration.
    expect(second.reason).toContain('Previous cache and registration state restored');

    // 4. Old cache restored byte-for-byte (the changed wrapper must be gone).
    expect(digestTree(cacheVersionDir())).toEqual(oldCacheDigest);
    expect(fs.readFileSync(path.join(cacheVersionDir(), 'scripts', 'wrapper.cjs'), 'utf8')).toBe('// wrapper v1\n');
    expect(sha256File(path.join(cacheVersionDir(), 'mcp-binding.json'))).toBe(oldBindingSha);

    // 5. Host JSON files byte-identical to the pre-update state.
    expect(sha256File(settingsPath)).toBe(oldSettingsSha);
    expect(sha256File(registryPath)).toBe(oldRegistrySha);

    // 6. Staging removed; the cache backup was consumed by the restore.
    const cacheParent = path.dirname(cacheVersionDir());
    const leftovers = fs.readdirSync(cacheParent).filter((name) => name.startsWith('.pd-staging-') || name.startsWith('.pd-backup-'));
    expect(leftovers).toEqual([]);

    // 7. Restore permissions before launching/cleanup.
    fs.chmodSync(pluginsDir, 0o755);
    fs.chmodSync(registryPath, 0o644);

    // 8. REAL launcher from the restored cache: initialize, tools/list and a
    //    read-only tools/call on the OLD workspace.
    let stderr = '';
    const childEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnv[name] = value;
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(cacheVersionDir(), 'mcp', 'launcher.cjs')],
      cwd: cacheVersionDir(),
      env: childEnv,
      stderr: 'pipe',
    });
    const stream = transport.stderr as Readable | undefined;
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => { stderr += chunk; });
    const client = new Client({ name: 'pd-wb-rollback-probe', version: '0.0.0' });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([RECALL_TOOL_NAME, SUBMIT_TOOL_NAME]);
      expect(tools.tools.find((tool) => tool.name === RECALL_TOOL_NAME)?.annotations?.readOnlyHint).toBe(true);

      const ownResult = await client.callTool({ name: TOOL_NAME, arguments: { principleId: P_OLD } });
      expect(ownResult.isError).toBeFalsy();
      const [ownBlock] = ownResult.content;
      if (ownBlock === undefined || ownBlock.type !== 'text') throw new Error('expected text block');
      const ownEnvelope = JSON.parse(ownBlock.text) as { status: string; error: { code: string } | null };
      // Old ledger resolved → query stops at the absent trajectory source.
      expect(ownEnvelope.status).toBe('unavailable');
      expect(ownEnvelope.error?.code).toBe('source_missing');

      const foreignResult = await client.callTool({ name: TOOL_NAME, arguments: { principleId: P_OTHER } });
      expect(foreignResult.isError).toBeFalsy();
      const [foreignBlock] = foreignResult.content;
      if (foreignBlock === undefined || foreignBlock.type !== 'text') throw new Error('expected text block');
      const foreignEnvelope = JSON.parse(foreignBlock.text) as { status: string; error: { code: string } | null };
      expect(foreignEnvelope.status).toBe('not_found');

      const startup = stderr.split('\n').filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { event?: string; workspaceFingerprint?: string })
        .find((entry) => entry.event === 'startup');
      const expected = createHash('sha256').update(path.resolve(path.join(home, '.workbuddy', 'pd-workspace'))).digest('hex').slice(0, 16);
      expect(startup?.workspaceFingerprint).toBe(expected);

      console.log('[gate4-evidence]', JSON.stringify({
        injectedFault: 'registry file read-only (Windows) + registry parent dir non-writable (POSIX) → registry commit fails after cache swap',
        installerReason: second.reason,
        cacheDigestBefore: oldCacheDigest,
        cacheDigestAfter: digestTree(cacheVersionDir()),
        settingsShaBefore: oldSettingsSha,
        settingsShaAfter: sha256File(settingsPath),
        registryShaBefore: oldRegistrySha,
        registryShaAfter: sha256File(registryPath),
        bindingShaBefore: oldBindingSha,
        bindingShaAfter: sha256File(path.join(cacheVersionDir(), 'mcp-binding.json')),
        stagingOrBackupLeftovers: leftovers,
        mcpInitialize: true,
        toolsList: tools.tools.map((tool) => tool.name),
        toolCallOwnWorkspace: ownEnvelope,
        toolCallForeignWorkspace: foreignEnvelope,
        serverWorkspaceFingerprint: startup?.workspaceFingerprint,
        expectedWorkspaceFingerprint: expected,
      }));
    } finally {
      await client.close();
    }
  }, 60000);
});
