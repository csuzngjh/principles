/**
 * Host Tool Declaration Store tests — PRI-634-F R2 (review P1-2)
 *
 * Durable workspace provenance: hosts persist their gate-reachable tool
 * declaration; host-neutral consumers load it. Round-trip + untrusted-input
 * handling (the file is re-read as unknown, never trusted).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  saveHostToolDeclaration,
  loadHostToolDeclaration,
  HOST_TOOL_DECLARATION_FILENAME,
} from '../src/host-tool-declaration.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-decl-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('saveHostToolDeclaration / loadHostToolDeclaration', () => {
  it('round-trips a host declaration through <ws>/.pd/host-tool-semantics.json', () => {
    const saved = saveHostToolDeclaration(ws, {
      version: 1,
      hostKind: 'openclaw',
      mappings: [
        { rawToolName: 'shell', canonicalKind: 'execute' },
        { rawToolName: 'write_file', canonicalKind: 'write' },
      ],
      declaredAt: '2026-09-04T00:00:00.000Z',
    });
    expect(saved.ok).toBe(true);
    expect(existsSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_FILENAME))).toBe(true);

    const loaded = loadHostToolDeclaration(ws);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.declaration.hostKind).toBe('openclaw');
    expect(loaded.declaration.mappings).toHaveLength(2);
    expect(loaded.declaration.mappings[0]?.rawToolName).toBe('shell');
  });

  it('missing file → typed host_tool_declaration_missing with nextAction (rc-9)', () => {
    const loaded = loadHostToolDeclaration(ws);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('host_tool_declaration_missing');
    expect(loaded.nextAction).toContain('host');
  });

  it('malformed JSON → host_tool_declaration_invalid (untrusted input, fail loud)', () => {
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    writeFileSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_FILENAME), '{oops', 'utf8');
    const loaded = loadHostToolDeclaration(ws);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('host_tool_declaration_invalid');
  });

  it('invalid mappings (bad canonicalKind) → host_tool_declaration_invalid', () => {
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    writeFileSync(
      path.join(ws, '.pd', HOST_TOOL_DECLARATION_FILENAME),
      JSON.stringify({ version: 1, hostKind: 'x', mappings: [{ rawToolName: 'a', canonicalKind: 'cron' }], declaredAt: 't' }),
      'utf8',
    );
    const loaded = loadHostToolDeclaration(ws);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('host_tool_declaration_invalid');
    expect(loaded.nextAction).toContain('mappings invalid');
  });

  it('wrong version → host_tool_declaration_invalid (no silent shape guessing)', () => {
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    writeFileSync(
      path.join(ws, '.pd', HOST_TOOL_DECLARATION_FILENAME),
      JSON.stringify({ version: 99, hostKind: 'x', mappings: [], declaredAt: 't' }),
      'utf8',
    );
    const loaded = loadHostToolDeclaration(ws);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('host_tool_declaration_invalid');
  });
});
