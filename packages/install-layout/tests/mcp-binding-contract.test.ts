/**
 * MCP binding contract — the single declaration the installer, `pd health` and
 * the launcher parity test all rely on.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  buildMcpBindingFixture,
  getCanonicalMcpServerEntry,
  MCP_BINDING_FIXTURES,
  MCP_BINDING_HOSTS,
  MCP_BINDING_LAUNCHER_ONLY_REASONS,
  MCP_BINDING_SCHEMA_VERSION,
  MCP_BINDING_SHAPE_CODES,
  validateMcpBinding,
} from '../src/mcp-binding-contract.js';

const RUNTIME = path.resolve('/pd/runtime');
const WORKSPACE = path.resolve('/pd/workspace');
const ELSEWHERE = path.resolve('/pd/elsewhere.js');

function context(host: (typeof MCP_BINDING_HOSTS)[number]) {
  return {host, runtimeDir: RUNTIME, workspaceDir: WORKSPACE, foreignServerEntry: ELSEWHERE, versions: {mcpServer: '0.1.0'}};
}

describe('getCanonicalMcpServerEntry', () => {
  it('uses the npm dependency layout for codex and the component layout for the shared runtime hosts', () => {
    expect(getCanonicalMcpServerEntry('codex', RUNTIME)).toBe(
      path.join(RUNTIME, 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'),
    );
    expect(getCanonicalMcpServerEntry('openclaw', RUNTIME)).toBe(
      path.join(RUNTIME, 'pd-mcp-server', 'dist', 'index.js'),
    );
    expect(getCanonicalMcpServerEntry('workbuddy', RUNTIME)).toBe(
      path.join(RUNTIME, 'pd-mcp-server', 'dist', 'index.js'),
    );
  });
});

describe('validateMcpBinding — shared fixture table', () => {
  for (const host of MCP_BINDING_HOSTS) {
    for (const fixture of MCP_BINDING_FIXTURES) {
      it(`${host} / ${fixture.id}`, () => {
        const verdict = validateMcpBinding(buildMcpBindingFixture(fixture.id, context(host)), host);
        if (fixture.expectedReasonPrefix === null) {
          expect(verdict.ok).toBe(true);
          return;
        }
        expect(verdict.ok).toBe(false);
        if (verdict.ok) return;
        expect(verdict.reason.startsWith(fixture.expectedReasonPrefix)).toBe(true);
        expect(verdict.nextAction.length).toBeGreaterThan(20);
      });
    }
  }

  it('accepts the exact schema version the writers emit', () => {
    const verdict = validateMcpBinding(buildMcpBindingFixture('valid', context('codex')), 'codex');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.binding.schemaVersion).toBe(MCP_BINDING_SCHEMA_VERSION);
  });
});

describe('reason vocabulary', () => {
  it('keeps the shape and launcher-only vocabularies disjoint', () => {
    const shape = new Set<string>(MCP_BINDING_SHAPE_CODES);
    expect(MCP_BINDING_LAUNCHER_ONLY_REASONS.filter((entry) => shape.has(entry.code))).toEqual([]);
  });

  it('justifies every launcher-only exemption', () => {
    for (const entry of MCP_BINDING_LAUNCHER_ONLY_REASONS) {
      expect(entry.why.length, entry.code).toBeGreaterThan(20);
    }
  });
});
