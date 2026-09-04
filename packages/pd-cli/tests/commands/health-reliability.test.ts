/**
 * PRI-662 — reliability readiness section of `pd health`, against REAL
 * declaration files on disk (no fs mock, no host-runtime mock): the upgrade
 * validation surface must observe exactly what the production paths observe.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveHostToolDeclaration } from '@principles/host-runtime';
import { handleHealth } from '../../src/commands/health.js';

const dirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-health-reliability-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

describe('pd health reliability section (real declaration files)', () => {
  it('fresh workspace (no declaration): explicit degraded + host_tool_declaration_missing, informational only', async () => {
    const workspaceDir = makeWorkspace();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleHealth({ workspace: workspaceDir, json: true });
      const parsed = JSON.parse(logSpy.mock.calls[0][0]) as {
        reliability: { registry: { status: string }; resolver: string; replay: string; reason?: string; nextAction?: string };
      };
      expect(parsed.reliability.registry.status).toBe('degraded');
      expect(parsed.reliability.resolver).toBe('not_ready');
      expect(parsed.reliability.replay).toBe('not_ready');
      expect(parsed.reliability.reason).toBe('host_tool_declaration_missing');
      expect(parsed.reliability.nextAction ?? '').not.toBe('');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('declared workspace: registry ok with per-host counts, resolver/replay ready', async () => {
    const workspaceDir = makeWorkspace();
    saveHostToolDeclaration(workspaceDir, {
      version: 1,
      hostKind: 'openclaw',
      mappings: [
        { rawToolName: 'Write', canonicalKind: 'write' },
        { rawToolName: 'Edit', canonicalKind: 'write' },
        { rawToolName: 'Bash', canonicalKind: 'execute' },
      ],
      declaredAt: new Date().toISOString(),
    });
    saveHostToolDeclaration(workspaceDir, {
      version: 1,
      hostKind: 'codex',
      mappings: [{ rawToolName: 'shell', canonicalKind: 'execute' }],
      declaredAt: new Date().toISOString(),
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleHealth({ workspace: workspaceDir, json: false });
      const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(allOutput).toContain('reliability.registry.status: ok');
      expect(allOutput).toContain('reliability.registry.hosts: codex+openclaw');
      expect(allOutput).toContain('reliability.registry.declaredTools: 4');
      expect(allOutput).toContain('reliability.resolver: ready');
      expect(allOutput).toContain('reliability.replay: ready');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('malformed declaration: explicit invalid reason with a repair action', async () => {
    const workspaceDir = makeWorkspace();
    const dir = path.join(workspaceDir, '.pd', 'host-tool-semantics');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'openclaw.json'), '{broken', 'utf-8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleHealth({ workspace: workspaceDir, json: true });
      const parsed = JSON.parse(logSpy.mock.calls[0][0]) as {
        reliability: { registry: { status: string }; reason?: string; nextAction?: string };
      };
      expect(parsed.reliability.registry.status).toBe('degraded');
      expect(parsed.reliability.reason).toContain('host_tool_declaration_invalid');
      expect(parsed.reliability.nextAction ?? '').not.toBe('');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
