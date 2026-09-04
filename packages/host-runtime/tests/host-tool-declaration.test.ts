
/**
 * Host Tool Declaration Store tests — PRI-634-F R3 (SPEC P1-2)
 *
 * Per-host file layout: OpenClaw and Codex persist SEPARATE declaration
 * files so a shared workspace never hits last-writer-wins. Order
 * independence is a hard acceptance criterion (SPEC Test 2/3).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  saveHostToolDeclaration,
  loadHostToolDeclarations,
  HOST_TOOL_DECLARATION_DIRNAME,
} from '../src/host-tool-declaration.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-decl-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const OPENCLAW = {
  version: 1 as const,
  hostKind: 'openclaw',
  mappings: [
    { rawToolName: 'shell', canonicalKind: 'execute' as const },
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

describe('saveHostToolDeclaration / loadHostToolDeclarations (per-host partition)', () => {
  it('round-trips one host declaration into <ws>/.pd/host-tool-semantics/<hostKind>.json', () => {
    expect(saveHostToolDeclaration(ws, OPENCLAW).ok).toBe(true);
    expect(existsSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME, 'openclaw.json'))).toBe(true);

    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.declarations).toHaveLength(1);
    expect(loaded.declarations[0]?.hostKind).toBe('openclaw');
    expect(loaded.declarations[0]?.mappings).toHaveLength(2);
  });

  it('SPEC Test 2 (multi-host isolation) + Test 3 (order independence): both declarations survive either startup order', () => {
    // Order 1: openclaw then codex
    saveHostToolDeclaration(ws, OPENCLAW);
    saveHostToolDeclaration(ws, CODEX);
    const afterOpenclawFirst = loadHostToolDeclarations(ws);
    rmSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME), { recursive: true, force: true });

    // Order 2: codex then openclaw
    saveHostToolDeclaration(ws, CODEX);
    saveHostToolDeclaration(ws, OPENCLAW);
    const afterCodexFirst = loadHostToolDeclarations(ws);

    expect(afterOpenclawFirst.ok).toBe(true);
    expect(afterCodexFirst.ok).toBe(true);
    if (!afterOpenclawFirst.ok || !afterCodexFirst.ok) return;
    const kinds = (r: typeof afterOpenclawFirst & { ok: true }) =>
      r.declarations.map((d) => d.hostKind).sort();
    expect(kinds(afterOpenclawFirst)).toEqual(['codex', 'openclaw']);
    expect(kinds(afterCodexFirst)).toEqual(['codex', 'openclaw']);
    // Identical per-host mappings regardless of order
    const byHost = (r: typeof afterOpenclawFirst & { ok: true }) =>
      Object.fromEntries(r.declarations.map((d) => [d.hostKind, d.mappings]));
    expect(byHost(afterOpenclawFirst)).toEqual(byHost(afterCodexFirst));
  });

  it('same host re-declaring replaces only ITS file (isolation, no cross-host clobber)', () => {
    saveHostToolDeclaration(ws, OPENCLAW);
    saveHostToolDeclaration(ws, CODEX);
    const refreshed = { ...OPENCLAW, declaredAt: '2026-09-04T12:00:00.000Z' };
    saveHostToolDeclaration(ws, refreshed);

    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.declarations.map((d) => d.hostKind).sort()).toEqual(['codex', 'openclaw']);
    expect(loaded.declarations.find((d) => d.hostKind === 'openclaw')?.declaredAt).toBe('2026-09-04T12:00:00.000Z');
    expect(loaded.declarations.find((d) => d.hostKind === 'codex')?.declaredAt).toBe('2026-09-04T00:00:00.000Z');
  });

  it('missing declarations → typed host_tool_declaration_missing with nextAction (rc-9)', () => {
    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('host_tool_declaration_missing');
    expect(loaded.nextAction).toContain('host');
  });

  it('malformed JSON → host_tool_declaration_invalid naming the hostKind (untrusted input, fail loud)', () => {
    mkdirSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME), { recursive: true });
    writeFileSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME, 'codex.json'), '{oops', 'utf8');
    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('host_tool_declaration_invalid (codex: not valid JSON)');
  });

  it('invalid mappings (bad canonicalKind) → host_tool_declaration_invalid naming the hostKind', () => {
    mkdirSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME), { recursive: true });
    writeFileSync(
      path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME, 'codex.json'),
      JSON.stringify({ version: 1, hostKind: 'codex', mappings: [{ rawToolName: 'a', canonicalKind: 'cron' }], declaredAt: 't' }),
      'utf8',
    );
    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toContain('codex');
    expect(loaded.reason).toContain('mappings invalid');
  });

  it('hostKind must match the filename-safe pattern (rc: it doubles as a path segment)', () => {
    const bad = saveHostToolDeclaration(ws, { ...OPENCLAW, hostKind: '../evil' });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('hostKind');
  });
})
