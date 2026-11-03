/**
 * Workspace binding tests — SPEC-PD-MCP-GATE4-001 §3.5 (Gate 4-A freeze).
 *
 * Pins: the binding env is the ONLY source of the business workspaceDir; every
 * malformed binding fails closed with a reason + next action; there is no
 * cwd/HOME fallback; the optional host marker must be a known PD host.
 *
 * All fixtures are created with mkdtempSync (exclusive, collision-free) and
 * removed in finally — no Date.now()-derived paths (CodeQL js/insecure-temporary-file).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkspaceBinding, WORKSPACE_DIR_ENV, HOST_ENV } from '../workspace.js';

function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('resolveWorkspaceBinding (§3.5 fail-closed)', () => {
  it('accepts an existing absolute directory and resolves it', () => {
    withTempDir('pd-mcp-ws-', (dir) => {
      const res = resolveWorkspaceBinding({ [WORKSPACE_DIR_ENV]: dir });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.binding.workspaceDir).toBe(path.resolve(dir));
        expect(res.binding.host).toBeNull();
      }
    });
  });

  it('accepts a known host marker', () => {
    withTempDir('pd-mcp-ws-', (dir) => {
      const res = resolveWorkspaceBinding({ [WORKSPACE_DIR_ENV]: dir, [HOST_ENV]: 'codex' });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.binding.host).toBe('codex');
    });
  });

  it('rejects an unknown host marker (fail-closed, not ignored)', () => {
    withTempDir('pd-mcp-ws-', (dir) => {
      const res = resolveWorkspaceBinding({ [WORKSPACE_DIR_ENV]: dir, [HOST_ENV]: 'evil-host' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.envVar).toBe(HOST_ENV);
        expect(res.nextAction.length).toBeGreaterThan(0);
      }
    });
  });

  it.each([
    ['missing env', {}],
    ['empty string', { [WORKSPACE_DIR_ENV]: '' }],
    ['non-string', { [WORKSPACE_DIR_ENV]: 42 }],
    ['relative path', { [WORKSPACE_DIR_ENV]: 'relative/ws' }],
  ])('rejects: %s', (_name, env) => {
    const res = resolveWorkspaceBinding(env);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.envVar).toBe(WORKSPACE_DIR_ENV);
      expect(res.reason.length).toBeGreaterThan(0);
      expect(res.nextAction.length).toBeGreaterThan(0);
    }
  });

  it('rejects a nonexistent path without echoing it', () => {
    // A child of a fresh mkdtemp dir is guaranteed nonexistent and unique; the
    // failure reason must not leak the value (asserted below).
    withTempDir('pd-mcp-missing-', (dir) => {
      const missing = path.join(dir, 'pd-mcp-definitely-missing-inside');
      const res = resolveWorkspaceBinding({ [WORKSPACE_DIR_ENV]: missing });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.envVar).toBe(WORKSPACE_DIR_ENV);
        expect(res.reason).not.toMatch(/pd-mcp-definitely-missing-inside/);
      }
    });
  });

  it('rejects a file (not a directory) as the binding', () => {
    withTempDir('pd-mcp-file-', (dir) => {
      const file = path.join(dir, 'workspace.txt');
      fs.writeFileSync(file, 'x');
      const res = resolveWorkspaceBinding({ [WORKSPACE_DIR_ENV]: file });
      expect(res.ok).toBe(false);
    });
  });
});
