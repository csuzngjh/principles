/**
 * PRI-1278 Phase 5 review — refreshing an already-installed host must reuse
 * the workspace that host is BOUND to. A plain `--yes` upgrade (no --host)
 * previously passed this run's neutral `~/pd-workspace` into the Codex plugin
 * rebuild / OpenClaw declaration rewrite and moved the host off its real
 * workspace.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readHostWorkspaceBinding,
  resolveExistingHostWorkspaceForRefresh,
  resolveProvisioningTargets,
  resolveResumeProvisioningHost,
} from '../src/installer.js';

const dirs: string[] = [];
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousWorkbuddy: string | undefined;
let previousExperimentRoot: string | undefined;
let previousPdWorkspaceDir: string | undefined;
let previousOpenClawWorkspace: string | undefined;

function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-host-refresh-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousWorkbuddy = process.env.WORKBUDDY_CONFIG_DIR;
  previousExperimentRoot = process.env.PD_EXPERIMENT_ROOT;
  previousPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;
  previousOpenClawWorkspace = process.env.OPENCLAW_WORKSPACE;
  delete process.env.PD_EXPERIMENT_ROOT;
  delete process.env.PD_WORKSPACE_DIR;
  delete process.env.OPENCLAW_WORKSPACE;
  delete process.env.WORKBUDDY_CONFIG_DIR;
  const home = tempHome();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  const restore = (key: 'HOME' | 'USERPROFILE' | 'WORKBUDDY_CONFIG_DIR' | 'PD_EXPERIMENT_ROOT' | 'PD_WORKSPACE_DIR' | 'OPENCLAW_WORKSPACE', value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('HOME', previousHome);
  restore('USERPROFILE', previousUserProfile);
  restore('WORKBUDDY_CONFIG_DIR', previousWorkbuddy);
  restore('PD_EXPERIMENT_ROOT', previousExperimentRoot);
  restore('PD_WORKSPACE_DIR', previousPdWorkspaceDir);
  restore('OPENCLAW_WORKSPACE', previousOpenClawWorkspace);
});

describe('resolveExistingHostWorkspaceForRefresh', () => {
  it('openclaw: returns the declared workspace, not this run\'s target', () => {
    const home = process.env.HOME as string;
    const declared = path.join(home, 'real-openclaw-ws');
    mkdirSync(declared, { recursive: true });
    mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    writeFileSync(path.join(home, '.openclaw', 'principles-disciple.json'), JSON.stringify({ workspace: declared }), 'utf8');
    expect(resolveExistingHostWorkspaceForRefresh('openclaw')).toMatchObject({
      ok: true,
      workspaceDir: declared,
      source: 'openclaw_declaration',
    });
  });

  it('openclaw: a missing declaration is a verified SKIP, never a rebind', () => {
    const result = resolveExistingHostWorkspaceForRefresh('openclaw');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('absent');
      expect(result.nextAction).toContain('--host openclaw');
    }
  });

  it('codex: reads the DURABLE binding at the plugin data root', () => {
    const home = process.env.HOME as string;
    const bound = path.join(home, 'real-codex-ws');
    mkdirSync(bound, { recursive: true });
    const dataRoot = path.join(home, '.codex', 'plugins', 'data', 'principles-disciple-principles');
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, 'mcp-binding.json'), JSON.stringify({ host: 'codex', workspaceDir: bound }), 'utf8');
    expect(resolveExistingHostWorkspaceForRefresh('codex')).toMatchObject({
      ok: true,
      workspaceDir: bound,
      source: 'codex_mcp_binding',
    });
  });

  it('codex: falls back to the payload-local legacy mirror', () => {
    const home = process.env.HOME as string;
    const bound = path.join(home, 'legacy-codex-ws');
    mkdirSync(bound, { recursive: true });
    const versionDir = path.join(home, '.codex', 'plugins', 'cache', 'principles', 'principles-disciple', '1.2.3');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(path.join(versionDir, 'mcp-binding.json'), JSON.stringify({ host: 'codex', workspaceDir: bound }), 'utf8');
    expect(resolveExistingHostWorkspaceForRefresh('codex')).toMatchObject({
      ok: true,
      workspaceDir: bound,
      source: 'codex_mcp_binding',
    });
  });

  it('codex: a runtime/ subdirectory is NOT a binding location', () => {
    const home = process.env.HOME as string;
    const bound = path.join(home, 'runtime-ws');
    mkdirSync(bound, { recursive: true });
    const runtimeDir = path.join(home, '.codex', 'plugins', 'data', 'principles-disciple-principles', 'runtime', '1.0.0');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(path.join(runtimeDir, 'mcp-binding.json'), JSON.stringify({ host: 'codex', workspaceDir: bound }), 'utf8');
    const result = resolveExistingHostWorkspaceForRefresh('codex');
    expect(result.ok).toBe(false);
  });

  it('codex: an unreadable/malformed binding is UNVERIFIABLE (never a rebind)', () => {
    const home = process.env.HOME as string;
    const dataRoot = path.join(home, '.codex', 'plugins', 'data', 'principles-disciple-principles');
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, 'mcp-binding.json'), '{not json', 'utf8');
    expect(readHostWorkspaceBinding('codex').state).toBe('unverifiable');
  });

  it('codex: no readable binding is a SKIP with an explicit re-run instruction', () => {
    const result = resolveExistingHostWorkspaceForRefresh('codex');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.nextAction).toContain('--host codex');
  });

  it('workbuddy: always its own governance workspace', () => {
    const home = process.env.HOME as string;
    expect(resolveExistingHostWorkspaceForRefresh('workbuddy')).toMatchObject({
      ok: true,
      workspaceDir: path.join(home, '.workbuddy', 'pd-workspace'),
      source: 'workbuddy_governance_dir',
    });
  });
});

describe('resolveResumeProvisioningHost — the binding that exists NOW', () => {
  it('probes OpenClaw when the recorded declaration binds this workspace', () => {
    const home = process.env.HOME as string;
    const ws = path.join(home, 'resume-openclaw-ws');
    mkdirSync(ws, { recursive: true });
    mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    writeFileSync(path.join(home, '.openclaw', 'principles-disciple.json'), JSON.stringify({ workspace: ws }), 'utf8');
    expect(resolveResumeProvisioningHost('none', ws)).toEqual({ ok: true, host: 'openclaw' });
  });

  it('honours PD_WORKSPACE_DIR and OPENCLAW_WORKSPACE ahead of declaration files', () => {
    const home = process.env.HOME as string;
    const envWs = path.join(home, 'env-declared-ws');
    const fileWs = path.join(home, 'file-declared-ws');
    mkdirSync(envWs, { recursive: true });
    mkdirSync(fileWs, { recursive: true });
    mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    writeFileSync(path.join(home, '.openclaw', 'principles-disciple.json'), JSON.stringify({ workspace: fileWs }), 'utf8');
    process.env.PD_WORKSPACE_DIR = envWs;
    expect(resolveResumeProvisioningHost('none', envWs)).toEqual({ ok: true, host: 'openclaw' });
    delete process.env.PD_WORKSPACE_DIR;
    process.env.OPENCLAW_WORKSPACE = envWs;
    expect(resolveResumeProvisioningHost('none', envWs)).toEqual({ ok: true, host: 'openclaw' });
  });

  it('honours primary-declaration precedence when a stale secondary names another workspace', () => {
    const home = process.env.HOME as string;
    const primaryWs = path.join(home, 'resume-primary-ws');
    const staleWs = path.join(home, 'resume-stale-secondary-ws');
    mkdirSync(primaryWs, { recursive: true });
    mkdirSync(staleWs, { recursive: true });
    mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    mkdirSync(path.join(home, '.principles'), { recursive: true });
    writeFileSync(path.join(home, '.openclaw', 'principles-disciple.json'), JSON.stringify({ workspace: primaryWs }), 'utf8');
    writeFileSync(path.join(home, '.principles', 'principles-disciple.json'), JSON.stringify({ workspace: staleWs }), 'utf8');
    expect(resolveResumeProvisioningHost('none', primaryWs)).toEqual({ ok: true, host: 'openclaw' });
  });

  it('does not treat an orphaned OpenClaw payload binding as active workspace evidence', () => {
    const home = process.env.HOME as string;
    const ws = path.join(home, 'orphaned-payload-ws');
    mkdirSync(ws, { recursive: true });
    const extensionDir = path.join(home, '.openclaw', 'extensions', 'principles-disciple');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(path.join(extensionDir, 'mcp-binding.json'), JSON.stringify({ host: 'openclaw', workspaceDir: ws }), 'utf8');
    const result = resolveResumeProvisioningHost('none', ws);
    expect(result.ok).toBe(false);
  });

  it('follows the actual Codex binding even when the pending record named OpenClaw', () => {
    const home = process.env.HOME as string;
    const ws = path.join(home, 'resume-codex-ws');
    mkdirSync(ws, { recursive: true });
    const dataRoot = path.join(home, '.codex', 'plugins', 'data', 'principles-disciple-principles');
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, 'mcp-binding.json'), JSON.stringify({ host: 'codex', workspaceDir: ws }), 'utf8');
    expect(resolveResumeProvisioningHost('openclaw', ws)).toEqual({ ok: true, host: 'codex' });
  });

  it('returns none only for a none marker; a concrete pending host remains fail-closed', () => {
    const home = process.env.HOME as string;
    const ws = path.join(home, 'resume-unbound-ws');
    mkdirSync(ws, { recursive: true });
    const result = resolveResumeProvisioningHost('openclaw', ws);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.nextAction).toContain('not proof that the recorded consumer is absent');
    expect(resolveResumeProvisioningHost('none', ws)).toEqual({ ok: true, host: 'none' });
  });

  it('refuses when a binding exists but cannot be verified and nothing else is bound', () => {
    const home = process.env.HOME as string;
    const ws = path.join(home, 'resume-broken-ws');
    mkdirSync(ws, { recursive: true });
    const dataRoot = path.join(home, '.codex', 'plugins', 'data', 'principles-disciple-principles');
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, 'mcp-binding.json'), '{broken', 'utf8');
    const result = resolveResumeProvisioningHost('none', ws);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.nextAction).toContain('Repair');
  });
});

describe('resolveProvisioningTargets — the ACTUAL bound workspaces', () => {
  const project = path.resolve('/tmp/project-ws');
  const codexRedirect = path.resolve('/tmp/codex-ws');

  it('Service-Host-only provisions the requested workspace', () => {
    expect(resolveProvisioningTargets({ host: 'none', workspaceDir: project }))
      .toEqual([{ host: 'none', workspaceDir: project }]);
  });

  it('Codex provisions its materialized/redirected directory, not the project dir', () => {
    expect(resolveProvisioningTargets({ host: 'codex', workspaceDir: project, codexWorkspaceDir: codexRedirect }))
      .toEqual([{ host: 'codex', workspaceDir: codexRedirect }]);
  });

  it('WorkBuddy provisions the governance workspace, not the project dir', () => {
    const home = process.env.HOME as string;
    expect(resolveProvisioningTargets({ host: 'workbuddy', workspaceDir: project }))
      .toEqual([{ host: 'workbuddy', workspaceDir: path.join(home, '.workbuddy', 'pd-workspace') }]);
  });

  it('all provisions both real bindings and dedupes identical paths', () => {
    expect(resolveProvisioningTargets({ host: 'all', workspaceDir: project, codexWorkspaceDir: codexRedirect }))
      .toEqual([
        { host: 'openclaw', workspaceDir: project },
        { host: 'codex', workspaceDir: codexRedirect },
      ]);
    expect(resolveProvisioningTargets({ host: 'all', workspaceDir: project, codexWorkspaceDir: project }))
      .toEqual([{ host: 'openclaw', workspaceDir: project }]);
  });
});
