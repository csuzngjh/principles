/**
 * OpenClaw home-wide MCP binding: the plugin's workspace declaration.
 *
 * The real host strips PD_WORKSPACE_DIR / OPENCLAW_WORKSPACE / HOME from the
 * MCP child it spawns, so `~/.openclaw/principles-disciple.json` is the only
 * workspace signal the launcher can re-derive at launch time. These tests
 * drive the REAL writer the installer calls against a REAL filesystem in a
 * fake HOME and pin the contract the caller asked for:
 *   - first install writes the declaration (workspace + state + channels);
 *   - re-installing the same workspace is byte-identical (idempotent);
 *   - an existing declaration for a DIFFERENT workspace is never overwritten
 *     and fails with an operator-readable reason;
 *   - malformed / unreadable declarations are never overwritten either;
 *   - non-OpenClaw installs are not this writer's callers (installer gates it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertOpenClawWorkspaceDeclarationCompatible,
  ensureOpenClawWorkspaceDeclaration,
  inspectOpenClawWorkspaceDeclaration,
} from '../src/installer.js';

const TMP = fs.realpathSync(os.tmpdir());
const CONFIG_RELATIVE = path.join('.openclaw', 'principles-disciple.json');

describe('OpenClaw PD workspace declaration (install-time MCP locate)', () => {
  let sandbox: string;
  let workspaceA: string;
  let workspaceB: string;
  let configPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    sandbox = fs.mkdtempSync(path.join(TMP, 'pd-ws-decl-'));
    workspaceA = path.resolve(sandbox, 'workspace-a');
    workspaceB = path.resolve(sandbox, 'workspace-b');
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });
    // Both getHomeDir() (HOME) and os.homedir() (USERPROFILE on win32) must
    // agree on the sandbox as "~".
    process.env.HOME = sandbox;
    process.env.USERPROFILE = sandbox;
    configPath = path.join(sandbox, CONFIG_RELATIVE);
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('writes the declaration on first install and is byte-identical on re-install', async () => {
    const first = await ensureOpenClawWorkspaceDeclaration(workspaceA, ['mvp-core']);
    expect(first.action).toBe('created');
    expect(fs.existsSync(configPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(written.workspace).toBe(workspaceA);
    expect(written.state).toBe(path.join(workspaceA, '.state'));
    expect(written.channels).toEqual(['mvp-core']);
    expect(typeof written.installedAt).toBe('string');
    expect(written.mvpFirst).toBe(true);

    const before = fs.readFileSync(configPath, 'utf8');
    const second = await ensureOpenClawWorkspaceDeclaration(workspaceA, ['mvp-core']);
    expect(second.action).toBe('unchanged');
    // No rewrite: not just "same values" — the exact bytes (including
    // installedAt) must be untouched so a re-install is idempotent.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('leaves a compatible declaration (different spelling) untouched, preserving Owner edits', async () => {
    // Same directory, different spelling: trailing separator always, plus
    // different case on Windows (which is case-insensitive for paths).
    const spelling = process.platform === 'win32'
      ? path.join(sandbox, 'WORKSPACE-A') + path.sep
      : workspaceA + path.sep;
    const seeded = {
      workspace: spelling,
      features: ['owner-edit'],
      installedAt: '2020-01-01T00:00:00.000Z',
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(seeded, null, 2), 'utf8');
    const before = fs.readFileSync(configPath, 'utf8');

    const inspection = inspectOpenClawWorkspaceDeclaration(path.join(sandbox, 'workspace-a'));
    expect(inspection.state).toBe('compatible');

    const result = await ensureOpenClawWorkspaceDeclaration(workspaceA, ['mvp-core']);
    expect(result.action).toBe('unchanged');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('never overwrites a declaration that points at a DIFFERENT workspace', async () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ workspace: workspaceB }, null, 2), 'utf8');
    const before = fs.readFileSync(configPath, 'utf8');

    const inspection = inspectOpenClawWorkspaceDeclaration(workspaceA);
    expect(inspection.state).toBe('conflict');
    expect(inspection.declaredWorkspace).toBe(workspaceB);

    await expect(ensureOpenClawWorkspaceDeclaration(workspaceA, ['mvp-core']))
      .rejects.toThrow(/DIFFERENT workspace/);
    await expect(ensureOpenClawWorkspaceDeclaration(workspaceA, ['mvp-core']))
      .rejects.toThrow(new RegExp(`Declared:  ${JSON.stringify(workspaceB).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('refuses the read-only preflight for a different workspace (install fails before mutation)', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ workspace: workspaceB }), 'utf8');
    expect(() => assertOpenClawWorkspaceDeclarationCompatible(workspaceA)).toThrow(/DIFFERENT workspace/);
    // Same workspace passes; absence passes.
    expect(() => assertOpenClawWorkspaceDeclarationCompatible(workspaceB)).not.toThrow();
    fs.rmSync(configPath, { force: true });
    expect(() => assertOpenClawWorkspaceDeclarationCompatible(workspaceA)).not.toThrow();
  });

  it('refuses malformed JSON without overwriting it', async () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ not json', 'utf8');
    const before = fs.readFileSync(configPath, 'utf8');

    expect(inspectOpenClawWorkspaceDeclaration(workspaceA).state).toBe('invalid');
    await expect(ensureOpenClawWorkspaceDeclaration(workspaceA, ['mvp-core']))
      .rejects.toThrow(/not valid JSON/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('refuses a declaration without a usable absolute workspace pointer', async () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    for (const seeded of [{ channels: [] }, { workspace: '' }, { workspace: 'relative/workspace' }]) {
      fs.writeFileSync(configPath, JSON.stringify(seeded), 'utf8');
      const inspection = inspectOpenClawWorkspaceDeclaration(workspaceA);
      expect(inspection.state).toBe('invalid');
      await expect(ensureOpenClawWorkspaceDeclaration(workspaceA, ['mvp-core']))
        .rejects.toThrow(/cannot be verified/);
    }
    expect(fs.readFileSync(configPath, 'utf8')).toBe(JSON.stringify({ workspace: 'relative/workspace' }));
  });

  it('refuses an unreadable declaration path without overwriting it', async () => {
    // A directory at the config path makes readFileSync fail deterministically.
    fs.mkdirSync(configPath, { recursive: true });
    const inspection = inspectOpenClawWorkspaceDeclaration(workspaceA);
    expect(inspection.state).toBe('unreadable');
    await expect(ensureOpenClawWorkspaceDeclaration(workspaceA, ['mvp-core']))
      .rejects.toThrow(/cannot be verified/);
    expect(fs.statSync(configPath).isDirectory()).toBe(true);
  });
});
