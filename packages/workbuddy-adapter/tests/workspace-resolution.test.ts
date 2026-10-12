/**
 * OD-07 / P06 governance workspace resolution tests: one explicit user-level
 * governance directory (install-layout SSoT), shared across projects, never
 * auto-created, never silently switched when broken.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkbuddyWorkspace } from '../src/workspace-resolution.js';
import { getInstallLayoutPaths, getWorkbuddyWorkspaceDir } from '@principles/install-layout';

function tempHome(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-res-')));
}

function writeConfig(home: string): string {
  const governance = getWorkbuddyWorkspaceDir(home);
  fs.mkdirSync(path.join(governance, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(governance, '.pd', 'config.yaml'), 'features: {}');
  return governance;
}

describe('resolveWorkbuddyWorkspace', () => {
  it('resolves the install-layout governance dir and reports ok when the config exists', () => {
    const home = tempHome();
    try {
      const governance = writeConfig(home);
      const resolution = resolveWorkbuddyWorkspace(home);
      expect(resolution).toEqual({ status: 'ok', workspaceDir: governance });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('matches the install-layout SSoT exactly (workspace dir AND runtime adapter dir conventions)', () => {
    const home = 'D:\\fake-home';
    expect(getWorkbuddyWorkspaceDir(home)).toBe(path.join(home, '.workbuddy', 'pd-workspace'));
    expect(getInstallLayoutPaths(home).workbuddyAdapterDir).toBe(path.join(home, '.pd', 'runtime', 'workbuddy-adapter'));
    expect(resolveWorkbuddyWorkspace(home).workspaceDir).toBe(getWorkbuddyWorkspaceDir(home));
  });

  it('uninitialized home: actionable reason, no directory auto-created (P06)', () => {
    const home = tempHome();
    try {
      const resolution = resolveWorkbuddyWorkspace(home);
      expect(resolution.status).toBe('uninitialized');
      if (resolution.status !== 'uninitialized') throw new Error('unreachable');
      expect(resolution.reason).toBe('workbuddy_workspace_not_initialized');
      expect(resolution.nextAction).toContain('setup');
      expect(resolution.nextAction).toContain(resolution.workspaceDir);
      // Resolution is read-only: the governance dir must NOT appear.
      expect(fs.existsSync(getWorkbuddyWorkspaceDir(home))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('config path occupied by a non-file: DEGRADED, never uninitialized, never a fallback', () => {
    const home = tempHome();
    try {
      const governance = getWorkbuddyWorkspaceDir(home);
      fs.mkdirSync(path.join(governance, '.pd', 'config.yaml'), { recursive: true }); // a DIRECTORY
      const resolution = resolveWorkbuddyWorkspace(home);
      expect(resolution.status).toBe('degraded');
      if (resolution.status !== 'degraded') throw new Error('unreachable');
      expect(resolution.reason).toBe('workbuddy_workspace_config_invalid');
      expect(resolution.nextAction).toContain('Repair');
      // No alternative workspace is ever offered (P06: no silent switch).
      expect(resolution.workspaceDir).toBe(governance);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('A/B projects: the resolution is project-independent — one shared governance dir (OD-07)', () => {
    const home = 'D:\\wb-home-ab';
    const a = resolveWorkbuddyWorkspace(home);
    const b = resolveWorkbuddyWorkspace(home);
    expect(a).toEqual(b);
    expect(a.workspaceDir).toBe(path.join(home, '.workbuddy', 'pd-workspace'));
  });
});
