/**
 * Workspace binding tests — SPEC-PD-MCP-GATE4-001 §3.5 (Gate 4-A freeze).
 *
 * Pins: the binding env is the ONLY source of the business workspaceDir; every
 * malformed binding fails closed with a reason + next action; there is no
 * cwd/HOME fallback; the optional host marker must be a known PD host.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkspaceBinding, WORKSPACE_DIR_ENV, HOST_ENV } from '../workspace.js';

describe('resolveWorkspaceBinding (§3.5 fail-closed)', () => {
  it('accepts an existing absolute directory and resolves it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mcp-ws-'));
    const res = resolveWorkspaceBinding({ [WORKSPACE_DIR_ENV]: dir });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.binding.workspaceDir).toBe(path.resolve(dir));
      expect(res.binding.host).toBeNull();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a known host marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mcp-ws-'));
    const res = resolveWorkspaceBinding({ [WORKSPACE_DIR_ENV]: dir, [HOST_ENV]: 'codex' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.binding.host).toBe('codex');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an unknown host marker (fail-closed, not ignored)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mcp-ws-'));
    const res = resolveWorkspaceBinding({ [WORKSPACE_DIR_ENV]: dir, [HOST_ENV]: 'evil-host' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.envVar).toBe(HOST_ENV);
      expect(res.nextAction.length).toBeGreaterThan(0);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['missing env', {}],
    ['empty string', { [WORKSPACE_DIR_ENV]: '' }],
    ['non-string', { [WORKSPACE_DIR_ENV]: 42 }],
    ['relative path', { [WORKSPACE_DIR_ENV]: 'relative/ws' }],
    ['nonexistent path', { [WORKSPACE_DIR_ENV]: path.join(os.tmpdir(), 'pd-mcp-definitely-missing-' + Date.now()) }],
  ])('rejects: %s', (_name, env) => {
    const res = resolveWorkspaceBinding(env);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.envVar).toBe(WORKSPACE_DIR_ENV);
      expect(res.reason.length).toBeGreaterThan(0);
      expect(res.nextAction.length).toBeGreaterThan(0);
      // The failure reason never echoes the value (no path leak).
      expect(res.reason).not.toMatch(/pd-mcp-definitely-missing/);
    }
  });

  it('rejects a file (not a directory) as the binding', () => {
    const file = path.join(os.tmpdir(), `pd-mcp-file-${Date.now()}.txt`);
    fs.writeFileSync(file, 'x');
    const res = resolveWorkspaceBinding({ [WORKSPACE_DIR_ENV]: file });
    expect(res.ok).toBe(false);
    fs.rmSync(file, { force: true });
  });
});
