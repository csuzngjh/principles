/**
 * Host Tool Semantic Resolver tests — PRI-634-F R3 (SPEC P1-1/P1-2)
 *
 * The ONE deep module every entry point uses: load (all per-host
 * declarations) → merge (union; order-independent) → validate (fail loud) →
 * resolve (merged ToolSemanticRegistry with host-layer existence semantics).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveHostToolDeclaration } from '../src/host-tool-declaration.js';
import { resolveWorkspaceHostToolSemantics } from '../src/host-tool-semantic-resolver.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-resolver-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const OPENCLAW = {
  version: 1 as const,
  hostKind: 'openclaw',
  mappings: [
    { rawToolName: 'shell', canonicalKind: 'execute' as const },
    { rawToolName: 'cmd', canonicalKind: 'execute' as const },
    { rawToolName: 'write_file', canonicalKind: 'write' as const },
  ],
  declaredAt: '2026-09-04T00:00:00.000Z',
};

const CODEX = {
  version: 1 as const,
  hostKind: 'codex',
  mappings: [
    { rawToolName: 'Bash', canonicalKind: 'execute' as const },
    { rawToolName: 'apply_patch', canonicalKind: 'write' as const },
  ],
  declaredAt: '2026-09-04T00:00:00.000Z',
};

describe('resolveWorkspaceHostToolSemantics', () => {
  it('merges multiple hosts: every co-installed host surface is dispatchable', () => {
    saveHostToolDeclaration(ws, OPENCLAW);
    saveHostToolDeclaration(ws, CODEX);
    const r = resolveWorkspaceHostToolSemantics(ws);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hostKinds.sort()).toEqual(['codex', 'openclaw']);
    // OpenClaw surface
    expect(r.registry.hasHostTool('shell')).toBe(true);
    expect(r.registry.hasHostTool('cmd')).toBe(true);
    // Codex surface
    expect(r.registry.hasHostTool('Bash')).toBe(true);
    expect(r.registry.hasHostTool('apply_patch')).toBe(true);
    // Baseline generic names never become existence evidence (ERR-114)
    expect(r.registry.hasHostTool('execute_command')).toBe(false);
    expect(r.registry.hasHostTool('read_file')).toBe(false);
  });

  it('SPEC Test 3: order independence — openclaw→codex equals codex→openclaw', () => {
    saveHostToolDeclaration(ws, OPENCLAW);
    saveHostToolDeclaration(ws, CODEX);
    const a = resolveWorkspaceHostToolSemantics(ws);
    rmSync(path.join(ws, '.pd', 'host-tool-semantics'), { recursive: true, force: true });
    saveHostToolDeclaration(ws, CODEX);
    saveHostToolDeclaration(ws, OPENCLAW);
    const b = resolveWorkspaceHostToolSemantics(ws);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.hostKinds).toEqual(b.hostKinds);
    const snapshot = (r: typeof a) =>
      ['shell', 'cmd', 'write_file', 'Bash', 'apply_patch'].map((n) => [n, r.registry.hasHostTool(n), r.registry.resolve(n)]);
    expect(snapshot(b)).toEqual(snapshot(a));
  });

  it('single-host workspace resolves exactly that host (no guessing)', () => {
    saveHostToolDeclaration(ws, CODEX);
    const r = resolveWorkspaceHostToolSemantics(ws);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hostKinds).toEqual(['codex']);
    expect(r.registry.hasHostTool('Bash')).toBe(true);
    // OpenClaw names are NOT dispatchable on a Codex-only workspace
    expect(r.registry.hasHostTool('shell')).toBe(false);
  });

  it('missing declarations → structured refusal with nextAction (no baseline fallback, ERR-114)', () => {
    const r = resolveWorkspaceHostToolSemantics(ws);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('host_tool_declaration_missing');
  });

  it('conflicting canonicalKind for one raw name across hosts fails loud (no startup-order winner)', () => {
    saveHostToolDeclaration(ws, OPENCLAW);
    saveHostToolDeclaration(ws, {
      version: 1 as const,
      hostKind: 'codex',
      mappings: [{ rawToolName: 'shell', canonicalKind: 'write' as const }],
      declaredAt: '2026-09-04T00:00:00.000Z',
    });
    const r = resolveWorkspaceHostToolSemantics(ws);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("conflicting canonicalKind for 'shell'");
    // Directory listing is sorted → codex (alphabetical) loads first; the
    // conflict direction is therefore deterministic regardless of save order.
    expect(r.reason).toContain('write vs execute');
  });
});
