/**
 * MCP binding writer tests (Gate 4, PRI-1071) — SPEC §3.5.
 *
 * Pins: binding written beside the payload from the RESOLVED workspace;
 * idempotent (no rewrite when unchanged, rewrite when the workspace or entry
 * changed); serverEntry is the canonical installed component path; a missing
 * component degrades honestly; a write failure is a structured outcome, never
 * a throw (G4-07).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildMcpBinding,
  canonicalMcpServerEntry,
  ensureMcpBinding,
  invalidateMcpBinding,
  MCP_BINDING_HOST,
  MCP_BINDING_SCHEMA,
} from '../../src/core/mcp-binding.js';

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fabricate a minimal installed server component (package.json + dist). */
function fabricateServer(homeDir: string, version = '0.1.0'): string {
  const entry = canonicalMcpServerEntry(homeDir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// fabricated entry\n');
  fs.writeFileSync(path.join(path.dirname(entry), '..', 'package.json'), JSON.stringify({ name: '@principles/pd-mcp-server', version }));
  return entry;
}

describe('ensureMcpBinding — experiment isolation (P0)', () => {
  it('writes runtime + server entry inside PD_EXPERIMENT_ROOT, never the production home', () => {
    const experimentRoot = tempRoot('pd-oc-exp-root-');
    const extRoot = tempRoot('pd-oc-exp-ext-');
    const productionHome = tempRoot('pd-oc-prod-home-');
    const entry = fabricateServer(experimentRoot, '9.9.9');
    const ws = path.join(experimentRoot, 'workspace-20261113');
    fs.mkdirSync(ws, { recursive: true });

    const outcome = ensureMcpBinding(ws, extRoot, productionHome, { experimentRoot });
    expect(outcome.ok).toBe(true);
    const binding = JSON.parse(fs.readFileSync(path.join(extRoot, 'mcp-binding.json'), 'utf8'));
    expect(binding.workspaceDir).toBe(ws);
    expect(binding.runtimeDir).toBe(path.join(experimentRoot, '.pd', 'runtime'));
    expect(binding.serverEntry).toBe(entry);
    expect(binding.versions.mcpServer).toBe('9.9.9');
    expect(binding.serverEntry.startsWith(productionHome)).toBe(false);
    for (const dir of [experimentRoot, extRoot, productionHome]) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to bind a workspace outside the experiment root and writes nothing', () => {
    const experimentRoot = tempRoot('pd-oc-exp-root-');
    const extRoot = tempRoot('pd-oc-exp-ext-');
    const productionHome = tempRoot('pd-oc-prod-home-');
    const productionWorkspace = path.join(productionHome, 'workspace');
    fs.mkdirSync(productionWorkspace, { recursive: true });
    fabricateServer(experimentRoot);

    const outcome = ensureMcpBinding(productionWorkspace, extRoot, productionHome, { experimentRoot });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('workspace_outside_experiment_root');
    expect(fs.existsSync(path.join(extRoot, 'mcp-binding.json'))).toBe(false);
    for (const dir of [experimentRoot, extRoot, productionHome]) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses when the experiment runtime component is missing instead of falling back to production', () => {
    const experimentRoot = tempRoot('pd-oc-exp-root-');
    const extRoot = tempRoot('pd-oc-exp-ext-');
    const productionHome = tempRoot('pd-oc-prod-home-');
    fabricateServer(productionHome); // production has the component; the experiment does not
    const ws = path.join(experimentRoot, 'workspace-20261113');
    fs.mkdirSync(ws, { recursive: true });

    const outcome = ensureMcpBinding(ws, extRoot, productionHome, { experimentRoot });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('mcp_server_component_missing');
    expect(outcome.serverEntry?.startsWith(experimentRoot)).toBe(true);
    expect(fs.existsSync(path.join(extRoot, 'mcp-binding.json'))).toBe(false);
    for (const dir of [experimentRoot, extRoot, productionHome]) fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ensureMcpBinding (Gate 4)', () => {
  it('writes the binding beside the payload from the resolved workspace', () => {
    const home = tempRoot('pd-oc-bind-home-');
    const extRoot = tempRoot('pd-oc-bind-ext-');
    const entry = fabricateServer(home);
    const ws = path.join(home, 'workspace');
    fs.mkdirSync(ws, { recursive: true });

    const outcome = ensureMcpBinding(ws, extRoot, home);
    expect(outcome.ok).toBe(true);
    expect(outcome.written).toBe(true);
    const binding = JSON.parse(fs.readFileSync(path.join(extRoot, 'mcp-binding.json'), 'utf8'));
    expect(binding.schemaVersion).toBe(MCP_BINDING_SCHEMA);
    expect(binding.host).toBe(MCP_BINDING_HOST);
    expect(binding.workspaceDir).toBe(ws);
    expect(binding.runtimeDir).toBe(path.join(home, '.pd', 'runtime'));
    expect(binding.serverEntry).toBe(entry);
    expect(binding.versions.mcpServer).toBe('0.1.0');
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  it('is idempotent: no rewrite when unchanged, rewrite when the workspace changed', () => {
    const home = tempRoot('pd-oc-bind-home-');
    const extRoot = tempRoot('pd-oc-bind-ext-');
    fabricateServer(home);
    const wsA = path.join(home, 'ws-a');
    const wsB = path.join(home, 'ws-b');
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });

    const first = ensureMcpBinding(wsA, extRoot, home);
    expect(first.written).toBe(true);
    const bindingPath = path.join(extRoot, 'mcp-binding.json');
    const before = fs.readFileSync(bindingPath, 'utf8');

    const second = ensureMcpBinding(wsA, extRoot, home);
    expect(second.ok).toBe(true);
    expect(second.written).toBe(false);
    expect(fs.readFileSync(bindingPath, 'utf8')).toBe(before);

    const third = ensureMcpBinding(wsB, extRoot, home);
    expect(third.written).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingPath, 'utf8')).workspaceDir).toBe(wsB);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  it('degrades honestly when the server component is missing (no throw, no write)', () => {
    const home = tempRoot('pd-oc-bind-home-');
    const extRoot = tempRoot('pd-oc-bind-ext-');
    const ws = path.join(home, 'ws');
    fs.mkdirSync(ws, { recursive: true });

    const outcome = ensureMcpBinding(ws, extRoot, home);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('mcp_server_component_missing');
    expect(fs.existsSync(path.join(extRoot, 'mcp-binding.json'))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  it('never throws on an unwritable extension root (structured failure, G4-07)', () => {
    const home = tempRoot('pd-oc-bind-home-');
    fabricateServer(home);
    const ws = path.join(home, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    // A path INSIDE a regular file cannot be created — writeFileSync fails.
    const blocker = path.join(home, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const extRoot = path.join(blocker, 'ext');

    const outcome = ensureMcpBinding(ws, extRoot, home);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/^write_failed:/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('buildMcpBinding carries the schema, host, workspace, runtime and entry verbatim', () => {
    const binding = buildMcpBinding('C:\\ws', 'C:\\pd\\runtime', 'C:\\pd\\runtime\\pd-mcp-server\\dist\\index.js');
    expect(binding.schemaVersion).toBe(MCP_BINDING_SCHEMA);
    expect(binding.host).toBe(MCP_BINDING_HOST);
    expect(binding.workspaceDir).toBe('C:\\ws');
    expect(binding.runtimeDir).toBe('C:\\pd\\runtime');
    expect(binding.serverEntry).toBe('C:\\pd\\runtime\\pd-mcp-server\\dist\\index.js');
  });

  it('rewrites when only the installed server version changed', () => {
    const home = tempRoot('pd-oc-bind-home-');
    const extRoot = tempRoot('pd-oc-bind-ext-');
    fabricateServer(home, '0.1.0');
    const ws = path.join(home, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    expect(ensureMcpBinding(ws, extRoot, home).written).toBe(true);

    fabricateServer(home, '0.2.0');
    const rebound = ensureMcpBinding(ws, extRoot, home);
    expect(rebound.written).toBe(true);
    const binding = JSON.parse(fs.readFileSync(path.join(extRoot, 'mcp-binding.json'), 'utf8'));
    expect(binding.versions.mcpServer).toBe('0.2.0');
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(extRoot, { recursive: true, force: true });
  });
});

describe('invalidateMcpBinding (§3.5 fail-closed)', () => {
  it('removes a stale binding and is a no-op when it is already absent', () => {
    const extRoot = tempRoot('pd-oc-invalidate-');
    expect(invalidateMcpBinding(extRoot)).toEqual({ ok: true, removed: false });

    fs.writeFileSync(path.join(extRoot, 'mcp-binding.json'), '{"host":"openclaw"}');
    expect(invalidateMcpBinding(extRoot)).toEqual({ ok: true, removed: true });
    expect(fs.existsSync(path.join(extRoot, 'mcp-binding.json'))).toBe(false);
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  it('reports a structured failure instead of throwing when removal fails', () => {
    const extRoot = tempRoot('pd-oc-invalidate-');
    // A non-empty DIRECTORY at the binding path cannot be removed by the
    // non-recursive force delete, which is exactly the "cannot clean up" case.
    fs.mkdirSync(path.join(extRoot, 'mcp-binding.json'));
    fs.writeFileSync(path.join(extRoot, 'mcp-binding.json', 'keep.txt'), 'x');

    const outcome = invalidateMcpBinding(extRoot);
    expect(outcome.ok).toBe(false);
    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toMatch(/^remove_failed:/);
    fs.rmSync(extRoot, { recursive: true, force: true });
  });
});
