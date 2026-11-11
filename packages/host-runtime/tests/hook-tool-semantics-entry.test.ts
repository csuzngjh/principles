/**
 * B3 — the hook-facing tool semantics entry point.
 *
 * The realtime hook and replay must classify the same raw tool name the same
 * way. Replay already reads the durable workspace declarations through
 * `resolveWorkspaceHostToolSemantics`; before B3 the hook ignored them and
 * classified from the host's static declaration only, so a workspace
 * declaration that disagreed (or named a tool the static list does not know)
 * made production and replay disagree on the same event.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolSemanticMappingV1 } from '@principles/core/runtime';
import { saveHostToolDeclaration } from '../src/host-tool-declaration.js';
import { resolveHostToolSemanticsForHook, resolveWorkspaceHostToolSemantics } from '../src/host-tool-semantic-resolver.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-hook-semantics-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

// Deliberately coarser than the persisted declaration below: this is the
// host's compiled-in surface, the fallback when no declaration exists.
const STATIC: readonly ToolSemanticMappingV1[] = Object.freeze([
  { rawToolName: 'exec', canonicalKind: 'execute' },
  { rawToolName: 'write', canonicalKind: 'write' },
  { rawToolName: 'apply_patch', canonicalKind: 'write' },
]);

const OPENCLAW_DECLARATION = {
  version: 1 as const,
  hostKind: 'openclaw',
  mappings: [
    // Workspace says exec is a write surface; the static list says execute.
    { rawToolName: 'exec', canonicalKind: 'write' as const },
    // A name the static list does not carry at all.
    { rawToolName: 'shell', canonicalKind: 'execute' as const },
  ],
  declaredAt: '2026-11-11T00:00:00.000Z',
};

describe('resolveHostToolSemanticsForHook', () => {
  it('falls back to the host static declaration when the workspace declares nothing', () => {
    const r = resolveHostToolSemanticsForHook({
      workspaceDir: ws,
      hostKind: 'openclaw',
      staticMappings: STATIC,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe('host-static');
    expect(r.registry.resolve('exec')).toBe('execute');
    expect(r.registry.hasHostTool('exec')).toBe(true);
  });

  it('B3: reads the workspace declaration so production and replay classify identically', () => {
    expect(saveHostToolDeclaration(ws, OPENCLAW_DECLARATION).ok).toBe(true);

    const hook = resolveHostToolSemanticsForHook({
      workspaceDir: ws,
      hostKind: 'openclaw',
      staticMappings: STATIC,
    });
    const replay = resolveWorkspaceHostToolSemantics(ws);
    expect(hook.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!hook.ok || !replay.ok) return;

    expect(hook.source).toBe('workspace-declaration');
    for (const name of ['exec', 'shell']) {
      expect(hook.registry.resolve(name), `hook '${name}'`).toBe(replay.registry.resolve(name));
    }
    // The declaration is authoritative: it overrides the static kind ...
    expect(hook.registry.resolve('exec')).toBe('write');
    // ... and names only the declaration carries stay dispatchable.
    expect(hook.registry.resolve('shell')).toBe('execute');
    expect(hook.registry.hasHostTool('shell')).toBe(true);
  });

  it('a stale declaration cannot amputate the host static surface', () => {
    expect(saveHostToolDeclaration(ws, {
      version: 1 as const,
      hostKind: 'openclaw',
      mappings: [{ rawToolName: 'exec', canonicalKind: 'execute' as const }],
      declaredAt: '2026-11-11T00:00:00.000Z',
    }).ok).toBe(true);

    const r = resolveHostToolSemanticsForHook({
      workspaceDir: ws,
      hostKind: 'openclaw',
      staticMappings: STATIC,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Declared name resolves from the declaration ...
    expect(r.registry.resolve('exec')).toBe('execute');
    // ... and names added to the host since the file was written still work.
    expect(r.registry.resolve('apply_patch')).toBe('write');
    expect(r.registry.hasHostTool('apply_patch')).toBe(true);
  });

  it('a malformed declaration fails loud instead of silently returning the static registry', () => {
    const dir = path.join(ws, '.pd', 'host-tool-semantics');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'openclaw.json'), '{"version":1,"hostKind":"openclaw"', 'utf8');

    const r = resolveHostToolSemanticsForHook({
      workspaceDir: ws,
      hostKind: 'openclaw',
      staticMappings: STATIC,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('host_tool_declaration_invalid');
    expect(r.nextAction.length).toBeGreaterThan(0);
  });

  it('keeps the cross-host conflict refusal (no startup-order winner)', () => {
    expect(saveHostToolDeclaration(ws, OPENCLAW_DECLARATION).ok).toBe(true);
    expect(saveHostToolDeclaration(ws, {
      version: 1 as const,
      hostKind: 'codex',
      mappings: [{ rawToolName: 'exec', canonicalKind: 'execute' as const }],
      declaredAt: '2026-11-11T00:00:00.000Z',
    }).ok).toBe(true);

    const r = resolveHostToolSemanticsForHook({
      workspaceDir: ws,
      hostKind: 'openclaw',
      staticMappings: STATIC,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("conflicting canonicalKind for 'exec'");
  });

  it('an invalid static declaration fails loud', () => {
    const r = resolveHostToolSemanticsForHook({
      workspaceDir: ws,
      hostKind: 'openclaw',
      staticMappings: [
        { rawToolName: 'exec', canonicalKind: 'execute' },
        { rawToolName: 'exec', canonicalKind: 'write' },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('host_tool_semantics_static_invalid');
  });
});
