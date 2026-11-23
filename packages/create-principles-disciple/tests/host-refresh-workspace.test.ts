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
import { resolveExistingHostWorkspaceForRefresh, resolveProvisioningTargets } from '../src/installer.js';

const dirs: string[] = [];
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousWorkbuddy: string | undefined;
let previousExperimentRoot: string | undefined;

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
  delete process.env.PD_EXPERIMENT_ROOT;
  delete process.env.WORKBUDDY_CONFIG_DIR;
  const home = tempHome();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  const restore = (key: 'HOME' | 'USERPROFILE' | 'WORKBUDDY_CONFIG_DIR' | 'PD_EXPERIMENT_ROOT', value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('HOME', previousHome);
  restore('USERPROFILE', previousUserProfile);
  restore('WORKBUDDY_CONFIG_DIR', previousWorkbuddy);
  restore('PD_EXPERIMENT_ROOT', previousExperimentRoot);
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

  it('openclaw: a missing/unreadable declaration is a SKIP, never a rebind', () => {
    const result = resolveExistingHostWorkspaceForRefresh('openclaw');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('unreadable');
      expect(result.nextAction).toContain('--host openclaw');
    }
  });

  it('codex: returns the workspace recorded in mcp-binding.json', () => {
    const home = process.env.HOME as string;
    const bound = path.join(home, 'real-codex-ws');
    mkdirSync(bound, { recursive: true });
    const versionDir = path.join(home, '.codex', 'plugins', 'data', 'principles-disciple-principles', 'runtime', '1.0.0');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(path.join(versionDir, 'mcp-binding.json'), JSON.stringify({ host: 'codex', workspaceDir: bound }), 'utf8');
    expect(resolveExistingHostWorkspaceForRefresh('codex')).toMatchObject({
      ok: true,
      workspaceDir: bound,
      source: 'codex_mcp_binding',
    });
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
