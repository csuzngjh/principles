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

  it('buildMcpBinding carries the schema, host, workspace and entry verbatim', () => {
    const binding = buildMcpBinding('C:\\ws', 'C:\\pd\\server.js');
    expect(binding.schemaVersion).toBe(MCP_BINDING_SCHEMA);
    expect(binding.host).toBe(MCP_BINDING_HOST);
    expect(binding.workspaceDir).toBe('C:\\ws');
    expect(binding.serverEntry).toBe('C:\\pd\\server.js');
  });
});
