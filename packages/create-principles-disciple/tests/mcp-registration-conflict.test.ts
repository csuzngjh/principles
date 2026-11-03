/**
 * Gate 4 (PRI-1071) — three-host MCP same-name registration conflict gate
 * (SPEC-PD-MCP-GATE4-001 §7.5/§11.3).
 *
 * Rules pinned here, for Codex / OpenClaw / WorkBuddy:
 *   A. same name + PD launcher → recognized as PD's own (idempotent, no dup);
 *   B. same name + another server → STOP, report, leave the file untouched;
 *   C. different names → coexist, no false positive;
 *   D. malformed / unattributable config → STOP fail-closed, never overwrite.
 *
 * The installer cases assert BYTE-IDENTICAL host config (sha256) after a
 * refusal — a conflict must never be written first and "rolled back" later.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => state.home };
});

import {
  checkMcpRegistrationConflict,
  classifyOpenClawConfigObject,
  resolveMcpRegistrationConfigPath,
} from '../src/installers/mcp-registration-conflict.js';
import { OpenClawHostInstaller } from '../src/installers/openclaw-host-installer.js';
import { WorkBuddyHostInstaller, WORKBUDDY_PLUGIN_NAME, WORKBUDDY_MARKETPLACE_NAME } from '../src/installers/workbuddy-host-installer.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const PD_SETUP = path.join(REPO_ROOT, 'plugins', 'principles-disciple', 'scripts', 'pd-setup.cjs');

let home: string;

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mcp-conflict-'));
  state.home = home;
});

afterEach(() => {
  state.home = '';
  fs.rmSync(home, { recursive: true, force: true });
});

// ─── Pure classifier (all three host config shapes) ─────────────────────────

describe('checkMcpRegistrationConflict — Codex config.toml', () => {
  function writeCodex(config: string): string {
    const dir = path.join(home, '.codex');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, config);
    return file;
  }

  it('absent when no mcp_servers table exists', () => {
    writeCodex('[features]\nhooks = true\n');
    const result = checkMcpRegistrationConflict('codex', { homeDir: home });
    expect(result).toMatchObject({ ok: true, state: 'absent' });
  });

  it('other names coexist (no false positive)', () => {
    writeCodex('[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@context7/mcp"]\n');
    const result = checkMcpRegistrationConflict('codex', { homeDir: home });
    expect(result).toMatchObject({ ok: true, state: 'other_servers_only' });
  });

  it('same name pointing at PD launcher is PD-owned (idempotent)', () => {
    writeCodex('[mcp_servers.pd-recall]\ncommand = "node"\nargs = ["C:\\\\pd\\\\plugins\\\\principles-disciple\\\\mcp\\\\launcher.cjs"]\n');
    const result = checkMcpRegistrationConflict('codex', { homeDir: home });
    expect(result).toMatchObject({ ok: true, state: 'pd_owned' });
  });

  it('same name pointing at ANOTHER server is a conflict', () => {
    const file = writeCodex('[mcp_servers.pd-recall]\ncommand = "npx"\nargs = ["-y", "some-other-mcp"]\n');
    const before = sha256(file);
    const result = checkMcpRegistrationConflict('codex', { homeDir: home });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.kind).toBe('conflict');
    expect(result.reason).toContain('mcp_same_name_conflict');
    expect(sha256(file)).toBe(before);
  });

  it('an inline mcp_servers table is unverifiable (never treated as free)', () => {
    writeCodex('mcp_servers = { "other" = { command = "node" } }\n');
    const result = checkMcpRegistrationConflict('codex', { homeDir: home });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.kind).toBe('unverifiable');
  });

  it('a same-name entry without command/args is unattributable', () => {
    writeCodex('[mcp_servers.pd-recall]\nstartup_timeout_sec = 20\n');
    const result = checkMcpRegistrationConflict('codex', { homeDir: home });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.kind).toBe('unverifiable');
  });
});

describe('checkMcpRegistrationConflict — OpenClaw openclaw.json', () => {
  function writeOpenClaw(record: unknown): string {
    const dir = path.join(home, '.openclaw');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'openclaw.json');
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    return file;
  }

  it('absent / other names / PD-owned / conflict / unverifiable', () => {
    writeOpenClaw({ plugins: {} });
    expect(checkMcpRegistrationConflict('openclaw', { homeDir: home })).toMatchObject({ ok: true, state: 'absent' });

    writeOpenClaw({ mcp: { servers: { comfyui: { command: 'node', args: ['comfyui-mcp'] } } } });
    expect(checkMcpRegistrationConflict('openclaw', { homeDir: home })).toMatchObject({ ok: true, state: 'other_servers_only' });

    writeOpenClaw({ mcp: { servers: { 'pd-recall': { command: 'node', args: ['./mcp/launcher.cjs'] } } } });
    expect(checkMcpRegistrationConflict('openclaw', { homeDir: home })).toMatchObject({ ok: true, state: 'pd_owned' });

    const conflictFile = writeOpenClaw({ mcp: { servers: { 'pd-recall': { command: 'python', args: ['other_mcp.py'] } } } });
    const before = sha256(conflictFile);
    const conflict = checkMcpRegistrationConflict('openclaw', { homeDir: home });
    expect(conflict.ok).toBe(false);
    expect(sha256(conflictFile)).toBe(before);

    writeOpenClaw({ mcp: { servers: { 'pd-recall': {} } } });
    const unattributable = checkMcpRegistrationConflict('openclaw', { homeDir: home });
    expect(unattributable.ok).toBe(false);
    if (unattributable.ok) throw new Error('expected refusal');
    expect(unattributable.kind).toBe('unverifiable');
  });
});

describe('checkMcpRegistrationConflict — WorkBuddy mcp.json', () => {
  it('resolves <config>/mcp.json and classifies all four outcomes', () => {
    const configDir = path.join(home, '.workbuddy');
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'pd-recall': { type: 'stdio', command: 'node', args: ['${CODEBUDDY_PLUGIN_ROOT}/mcp/launcher.cjs'] } } }, null, 2));
    expect(resolveMcpRegistrationConfigPath('workbuddy', { homeDir: home, workbuddyConfigDir: configDir })).toBe(file);
    expect(checkMcpRegistrationConflict('workbuddy', { homeDir: home, workbuddyConfigDir: configDir })).toMatchObject({ ok: true, state: 'pd_owned' });

    fs.writeFileSync(file, JSON.stringify({ mcpServers: { lighthouse: { type: 'streamableHttp', url: 'https://example/mcp' } } }, null, 2));
    expect(checkMcpRegistrationConflict('workbuddy', { homeDir: home, workbuddyConfigDir: configDir })).toMatchObject({ ok: true, state: 'other_servers_only' });

    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'pd-recall': { type: 'streamableHttp', url: 'https://evil.example/mcp' } } }, null, 2));
    const before = sha256(file);
    const conflict = checkMcpRegistrationConflict('workbuddy', { homeDir: home, workbuddyConfigDir: configDir });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error('expected refusal');
    expect(conflict.kind).toBe('conflict');
    expect(sha256(file)).toBe(before);

    fs.writeFileSync(file, '{ not json');
    const malformedBefore = sha256(file);
    const malformed = checkMcpRegistrationConflict('workbuddy', { homeDir: home, workbuddyConfigDir: configDir });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error('expected refusal');
    expect(malformed.kind).toBe('unverifiable');
    expect(sha256(file)).toBe(malformedBefore);
  });
});

// ─── Installer wiring: refusal must precede EVERY write ─────────────────────

describe('OpenClawHostInstaller conflict gate', () => {
  it('stops before writing openclaw.json and leaves it byte-identical', async () => {
    const configDir = path.join(home, '.openclaw');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({
      mcp: { servers: { 'pd-recall': { command: 'python', args: ['other_mcp.py'] } } },
    }, null, 2));
    const before = sha256(configPath);
    const mtimeBefore = fs.statSync(configPath).mtimeMs;

    const result = await new OpenClawHostInstaller().install({
      workspaceDir: path.join(home, 'ws'),
      pluginDir: path.join(home, 'pkg'),
      language: 'en',
      mode: 'smart',
    });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('mcp_same_name_conflict');
    expect(sha256(configPath)).toBe(before);
    expect(fs.statSync(configPath).mtimeMs).toBe(mtimeBefore);
    console.log('[gate4-evidence]', JSON.stringify({
      host: 'openclaw', configPath, installerReason: result.reason,
      sha256Before: before, sha256After: sha256(configPath),
      mtimeUnchanged: fs.statSync(configPath).mtimeMs === mtimeBefore,
    }));
  });

  it('allows different names and preserves them', async () => {
    const configDir = path.join(home, '.openclaw');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({
      mcp: { servers: { comfyui: { command: 'node', args: ['comfyui-mcp'] } } },
    }, null, 2));

    const result = await new OpenClawHostInstaller().install({
      workspaceDir: path.join(home, 'ws'),
      pluginDir: path.join(home, 'pkg'),
      language: 'en',
      mode: 'smart',
    });
    expect(result.success).toBe(true);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(written.mcp.servers.comfyui).toBeDefined();
  });

  it('classifyOpenClawConfigObject is the same pure rule used by pd health', () => {
    expect(classifyOpenClawConfigObject({}, '/x/openclaw.json')).toMatchObject({ ok: true, state: 'absent' });
    expect(classifyOpenClawConfigObject({ mcp: { servers: { 'pd-recall': { command: 'python' } } } }, '/x/openclaw.json').ok).toBe(false);
  });
});

describe('WorkBuddyHostInstaller conflict gate', () => {
  function writePayload(): string {
    const payloadRoot = fs.mkdtempSync(path.join(home, 'payload-'));
    const plug = path.join(payloadRoot, 'workbuddy-adapter', 'plugin');
    fs.cpSync(path.join(REPO_ROOT, 'packages', 'workbuddy-adapter', 'plugin', 'skills'), path.join(plug, 'skills'), { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, 'packages', 'workbuddy-adapter', 'plugin', 'mcp'), path.join(plug, 'mcp'), { recursive: true });
    fs.mkdirSync(path.join(plug, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'packages', 'workbuddy-adapter', 'plugin', 'scripts', 'pd-control.cjs'), path.join(plug, 'scripts', 'pd-control.cjs'));
    fs.writeFileSync(path.join(plug, 'scripts', 'wrapper.cjs'), '// wrapper\n');
    fs.mkdirSync(path.join(plug, '.codebuddy-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plug, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ name: WORKBUDDY_PLUGIN_NAME, version: '0.3.0' }, null, 2));
    fs.mkdirSync(path.join(plug, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(plug, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node wrapper.cjs' }] }] } }, null, 2));
    return payloadRoot;
  }

  it('stops before marketplace/cache/registration writes on a same-name conflict', async () => {
    const configDir = path.join(home, '.workbuddy');
    fs.mkdirSync(configDir, { recursive: true });
    const mcpPath = path.join(configDir, 'mcp.json');
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'pd-recall': { type: 'streamableHttp', url: 'https://evil.example/mcp' } } }, null, 2));
    const before = sha256(mcpPath);

    const installer = new WorkBuddyHostInstaller({ homeDir: () => home, enginePath: () => undefined });
    const result = await installer.install({
      workspaceDir: path.join(home, 'ws'),
      pluginDir: writePayload(),
      language: 'en',
      mode: 'smart',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('mcp_same_name_conflict');
    expect(sha256(mcpPath)).toBe(before);
    expect(fs.existsSync(path.join(home, '.pd', 'workbuddy-marketplace'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'cache', WORKBUDDY_MARKETPLACE_NAME))).toBe(false);
    console.log('[gate4-evidence]', JSON.stringify({
      host: 'workbuddy', configPath: mcpPath, installerReason: result.reason,
      sha256Before: before, sha256After: sha256(mcpPath),
      marketplaceCreated: false, settingsCreated: false, cacheCreated: false,
    }));
  });

  it('allows different names and leaves the user MCP file untouched', async () => {
    const configDir = path.join(home, '.workbuddy');
    fs.mkdirSync(configDir, { recursive: true });
    const mcpPath = path.join(configDir, 'mcp.json');
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { lighthouse: { type: 'streamableHttp', url: 'https://example/mcp' } } }, null, 2));
    const before = sha256(mcpPath);

    const installer = new WorkBuddyHostInstaller({ homeDir: () => home, enginePath: () => undefined });
    const result = await installer.install({
      workspaceDir: path.join(home, 'ws'),
      pluginDir: writePayload(),
      language: 'en',
      mode: 'smart',
    });

    expect(result.success).toBe(true);
    expect(sha256(mcpPath)).toBe(before);
  });
});

describe('Codex $pd-control setup conflict gate (real script)', () => {
  it('refuses before plugin-data/runtime creation and keeps config.toml byte-identical', () => {
    const codexHome = path.join(home, '.codex');
    const configPath = path.join(codexHome, 'config.toml');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(configPath, '[mcp_servers.pd-recall]\ncommand = "npx"\nargs = ["-y", "other-mcp"]\n');
    const before = sha256(configPath);

    const pluginRoot = path.join(codexHome, 'plugins', 'cache', 'test-market', 'principles-disciple', '0.1.0');
    fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: WORKBUDDY_PLUGIN_NAME }));

    const run = spawnSync(process.execPath, [PD_SETUP, '--plugin-root', pluginRoot, '--skip-init', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 60000,
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('mcp_same_name_conflict');
    expect(sha256(configPath)).toBe(before);
    expect(fs.existsSync(path.join(codexHome, 'plugins', 'data'))).toBe(false);
    console.log('[gate4-evidence]', JSON.stringify({
      host: 'codex', configPath, exitStatus: run.status, stderr: run.stderr.trim(),
      sha256Before: before, sha256After: sha256(configPath), pluginDataCreated: false,
    }));
  });
});
