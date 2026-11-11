/**
 * B3 — the OpenClaw gate resolves tool semantics through the workspace
 * declarations instead of the compiled-in static list.
 *
 * `hooks/gate.ts` classifies every dispatched tool through
 * `resolveOpenClawHookToolSemantics`. Before B3 that classification came from
 * `OPENCLAW_TOOL_SEMANTICS` alone, so a workspace declaration (the file
 * replay, evidence and the Console already read) could disagree with
 * production on the same event.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveHostToolDeclaration } from '@principles/host-runtime';
import { resolveOpenClawHookToolSemantics } from '../../src/hooks/hook-tool-semantics.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-openclaw-hook-semantics-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('resolveOpenClawHookToolSemantics', () => {
  it('uses the persisted OpenClaw declaration (hook == replay)', () => {
    expect(saveHostToolDeclaration(ws, {
      version: 1 as const,
      hostKind: 'openclaw',
      mappings: [{ rawToolName: 'exec', canonicalKind: 'write' as const }],
      declaredAt: '2026-11-11T00:00:00.000Z',
    }).ok).toBe(true);

    // Static OpenClaw says execute; the declaration says write and wins.
    expect(resolveOpenClawHookToolSemantics(ws, {}).resolve('exec')).toBe('write');
  });

  it('falls back to the static declaration when the workspace declares nothing', () => {
    const registry = resolveOpenClawHookToolSemantics(ws, {});
    expect(registry.resolve('exec')).toBe('execute');
    expect(registry.resolve('apply_patch')).toBe('write');
  });

  it('degrades to the static declaration with an observable warning when the declaration is malformed', () => {
    const dir = path.join(ws, '.pd', 'host-tool-semantics');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'openclaw.json'), 'not json', 'utf8');

    const warnings: string[] = [];
    const registry = resolveOpenClawHookToolSemantics(ws, { warn: (line: string) => warnings.push(line) });

    expect(registry.resolve('exec')).toBe('execute');
    expect(warnings.join('\n')).toContain('host_tool_declaration_invalid');
  });
});
