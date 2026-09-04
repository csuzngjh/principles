/**
 * Workspace Tool Semantics Resolution tests — PRI-634-F R2 (review P1-2)
 *
 * The CLI must resolve the host registry from DURABLE workspace provenance
 * and refuse (never guess, never silently skip) when unavailable.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWorkspaceToolSemantics } from '../../src/services/workspace-tool-semantics.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-wts-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function writeDeclaration(payload: unknown, hostKind = 'openclaw'): void {
  // R3: per-host partition — <ws>/.pd/host-tool-semantics/<hostKind>.json
  mkdirSync(path.join(ws, '.pd', 'host-tool-semantics'), { recursive: true });
  writeFileSync(path.join(ws, '.pd', 'host-tool-semantics', `${hostKind}.json`), JSON.stringify(payload), 'utf8');
}

describe('resolveWorkspaceToolSemantics', () => {
  it('resolves a valid persisted host declaration into a host-layered registry', () => {
    writeDeclaration({
      version: 1,
      hostKind: 'openclaw',
      mappings: [
        { rawToolName: 'shell', canonicalKind: 'execute' },
        { rawToolName: 'write_file', canonicalKind: 'write' },
      ],
      declaredAt: '2026-09-04T00:00:00.000Z',
    });
    const result = resolveWorkspaceToolSemantics(ws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostKind).toBe('openclaw');
    expect(result.registry.hasHostTool('shell')).toBe(true);
    // Core baseline names still classify, but are NOT host-declared here.
    expect(result.registry.hasHostTool('execute_command')).toBe(false);
    expect(result.registry.hasHostTool('read_file')).toBe(false);
  });

  it('missing declaration → structured failure with actionable nextAction (no guessing)', () => {
    const result = resolveWorkspaceToolSemantics(ws);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('host_tool_declaration_missing');
    expect(result.nextAction).toContain('host');
  });

  it('malformed declaration → host_tool_declaration_invalid, never baseline fallback', () => {
    writeDeclaration({ version: 1, hostKind: 'x', mappings: [{ rawToolName: 'bad', canonicalKind: 'nope' }], declaredAt: 't' });
    const result = resolveWorkspaceToolSemantics(ws);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('host_tool_declaration_invalid');
    expect(result.reason).toContain('openclaw');
  });

  it('not JSON at all → host_tool_declaration_invalid (per-host file)', () => {
    mkdirSync(path.join(ws, '.pd', 'host-tool-semantics'), { recursive: true });
    writeFileSync(path.join(ws, '.pd', 'host-tool-semantics', 'openclaw.json'), '{not json', 'utf8');
    const result = resolveWorkspaceToolSemantics(ws);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('host_tool_declaration_invalid (openclaw: not valid JSON)');
  });
});
