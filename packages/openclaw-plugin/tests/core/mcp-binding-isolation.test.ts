/**
 * Gate 4 (PRI-1071) — OpenClaw multi-workspace binding isolation.
 *
 * The MCP launcher reads ONE host-wide `mcp-binding.json`. OpenClaw may run
 * several agents with different `ctx.workspaceDir`s, so the binding may only
 * record an EXPLICITLY DECLARED PD workspace. These tests pin the startup
 * decision (no `main`/cwd/HOME inference, fail-closed invalidation) against
 * real temp directories and a fabricated installed MCP component.
 *
 * The companion integration test (`mcp-launcher-workspace-isolation.test.ts`)
 * proves the REAL launcher/server process reads the matching workspace.
 */
import { describe, expect, it } from 'vitest';
// Importing src/index runs the module-level conversation-access auto-fix; the
// isolate helper redirects os.homedir() to a temp dir so no real host config
// is touched. Must be imported BEFORE src/index.
import { isolatePdCanonicalConfig } from '../utils/isolate-pd-canonical.js';
isolatePdCanonicalConfig();
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncMcpBindingFromExplicitWorkspace } from '../../src/index.js';
import { invalidateMcpBinding, canonicalMcpServerEntry } from '../../src/core/mcp-binding.js';
import { resolveExplicitPdWorkspaceDir } from '../../src/utils/workspace-resolver.js';

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fabricateServer(homeDir: string, version = '0.1.0'): string {
  const entry = canonicalMcpServerEntry(homeDir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// fabricated entry\n');
  fs.writeFileSync(path.join(path.dirname(entry), '..', 'package.json'), JSON.stringify({ name: '@principles/pd-mcp-server', version }));
  return entry;
}

function bindingPath(extRoot: string): string {
  return path.join(extRoot, 'mcp-binding.json');
}

describe('syncMcpBindingFromExplicitWorkspace (§3.5 fail-closed, multi-agent)', () => {
  it('does NOT infer the implicit main-agent workspace: no explicit declaration → previous binding removed', () => {
    const home = tempRoot('pd-oc-iso-home-');
    const extRoot = tempRoot('pd-oc-iso-ext-');
    fabricateServer(home);
    const implicitMainWorkspace = path.join(home, 'agents', 'main');
    fs.mkdirSync(implicitMainWorkspace, { recursive: true });

    // Simulate a binding written by an earlier build that resolved `main`.
    fs.writeFileSync(bindingPath(extRoot), JSON.stringify({ schemaVersion: 'pd.mcp-binding.v1', host: 'openclaw', workspaceDir: implicitMainWorkspace }));

    const result = syncMcpBindingFromExplicitWorkspace({
      extensionRoot: extRoot,
      homeDir: home,
      resolver: () => null,
    });

    expect(result.status).toBe('invalidated');
    expect(result.reason).toBe('pd_workspace_not_explicit');
    expect(fs.existsSync(bindingPath(extRoot))).toBe(false);
    expect(result.nextAction).toContain('PD_WORKSPACE_DIR');
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  it('binds ONLY the owner-declared workspace and is idempotent', () => {
    const home = tempRoot('pd-oc-iso-home-');
    const extRoot = tempRoot('pd-oc-iso-ext-');
    fabricateServer(home);
    const declared = path.join(home, 'ws-declared');
    fs.mkdirSync(declared, { recursive: true });

    const first = syncMcpBindingFromExplicitWorkspace({
      extensionRoot: extRoot,
      homeDir: home,
      resolver: () => ({ workspaceDir: declared, source: 'pd_env' }),
    });
    expect(first.status).toBe('written');
    expect(first.source).toBe('pd_env');
    const binding = JSON.parse(fs.readFileSync(bindingPath(extRoot), 'utf8'));
    expect(binding.workspaceDir).toBe(declared);

    const second = syncMcpBindingFromExplicitWorkspace({
      extensionRoot: extRoot,
      homeDir: home,
      resolver: () => ({ workspaceDir: declared, source: 'pd_env' }),
    });
    expect(second.status).toBe('unchanged');
    expect(JSON.parse(fs.readFileSync(bindingPath(extRoot), 'utf8')).workspaceDir).toBe(declared);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  it('invalidates a stale binding when the declared workspace fails validation', () => {
    const home = tempRoot('pd-oc-iso-home-');
    const extRoot = tempRoot('pd-oc-iso-ext-');
    fabricateServer(home);
    fs.writeFileSync(bindingPath(extRoot), JSON.stringify({ host: 'openclaw', workspaceDir: path.join(home, 'old') }));

    const result = syncMcpBindingFromExplicitWorkspace({
      extensionRoot: extRoot,
      homeDir: home,
      // A drive/filesystem root is not a governance workspace.
      resolver: () => ({ workspaceDir: path.parse(home).root, source: 'pd_config' }),
    });

    expect(result.status).toBe('invalidated');
    expect(result.reason).toBe('pd_workspace_declaration_invalid');
    expect(fs.existsSync(bindingPath(extRoot))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  it('fails closed with a structured reason when the installed MCP component is missing', () => {
    const home = tempRoot('pd-oc-iso-home-');
    const extRoot = tempRoot('pd-oc-iso-ext-');
    const ws = path.join(home, 'ws');
    fs.mkdirSync(ws, { recursive: true });

    const result = syncMcpBindingFromExplicitWorkspace({
      extensionRoot: extRoot,
      homeDir: home,
      resolver: () => ({ workspaceDir: ws, source: 'pd_env' }),
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('mcp_server_component_missing');
    expect(fs.existsSync(bindingPath(extRoot))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  it('resolveExplicitPdWorkspaceDir reads PD_WORKSPACE_DIR and never falls back to the host default', () => {
    const workspaceDir = tempRoot('pd-oc-explicit-ws-');
    const previous = process.env.PD_WORKSPACE_DIR;
    try {
      process.env.PD_WORKSPACE_DIR = workspaceDir;
      const resolved = resolveExplicitPdWorkspaceDir();
      expect(resolved).toMatchObject({ workspaceDir: path.resolve(workspaceDir), source: 'pd_env' });
    } finally {
      if (previous === undefined) delete process.env.PD_WORKSPACE_DIR;
      else process.env.PD_WORKSPACE_DIR = previous;
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('invalidateMcpBinding is idempotent for the no-explicit path', () => {
    const extRoot = tempRoot('pd-oc-iso-ext-');
    expect(invalidateMcpBinding(extRoot)).toEqual({ ok: true, removed: false });
    fs.rmSync(extRoot, { recursive: true, force: true });
  });
});
