/**
 * OD-07 / P06 governance workspace resolution tests: one explicit user-level
 * governance directory (install-layout SSoT), shared across projects, never
 * auto-created, never silently switched when broken.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveWorkbuddyWorkspace } from '../src/workspace-resolution.js';
import { getInstallLayoutPaths, getWorkbuddyWorkspaceDir } from '@principles/install-layout';
import { assertInsideSandbox, cleanupTempDirs, sandboxEnv, trackTempDir } from './helpers/workbench.js';

function tempHome(): string {
  return trackTempDir(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-res-'))));
}

/**
 * Isolated env for sandbox resolution (2026-11-24 remediation): ambient host
 * overrides (WORKBUDDY_CONFIG_DIR injected by a WorkBuddy-launched shell, etc.)
 * are stripped so a test can never resolve the REAL user config root by
 * accident. Tests that exercise an override pass it EXPLICITLY as the subject
 * under test.
 */
function isolatedEnv(home: string, extra?: Record<string, string>): Readonly<Record<string, string | undefined>> {
  return sandboxEnv(home, extra);
}

function writeConfig(home: string): string {
  // Explicit sandbox configDirOverride: the fixture lands inside `home` even
  // when the ambient environment carries WORKBUDDY_CONFIG_DIR.
  const governance = getWorkbuddyWorkspaceDir(home, path.join(home, '.workbuddy'), isolatedEnv(home));
  assertInsideSandbox(governance, '(writeConfig)');
  fs.mkdirSync(path.join(governance, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(governance, '.pd', 'config.yaml'), 'features: {}');
  return governance;
}

// ─── Out-of-sandbox write guard ────────────────────────────────────────────
// The real host config roots a leaked override could point at: every
// real-home `.workbuddy` plus any ambient WORKBUDDY_/CODEBUDDY_CONFIG_DIR the
// process inherited. Snapshot at module load (before ANY test env pinning)
// and re-check in afterAll — a write outside the temp dirs turns the suite
// red instead of silently corrupting the real workspace.
function guardTargets(): string[] {
  const roots = new Set<string>();
  for (const home of [os.homedir(), process.env.HOME, process.env.USERPROFILE]) {
    if (typeof home === 'string' && home.trim().length > 0) {
      roots.add(path.join(path.resolve(home), '.workbuddy'));
    }
  }
  for (const key of ['WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR']) {
    const value = process.env[key]?.trim();
    if (value !== undefined && value.length > 0) roots.add(path.resolve(value));
  }
  return [...roots].sort();
}

function describeGuardPath(target: string): string {
  let contentFailure: string | undefined;
  try {
    const bytes = fs.readFileSync(target);
    const stat = fs.statSync(target);
    return `file:${bytes.length}:${Math.trunc(stat.mtimeMs)}:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EACCES') {
      return code === 'ENOENT' ? 'absent' : `unreadable:${code}`;
    }
    contentFailure = code;
  }
  try {
    // Recursive listing so a fixture nested below the root is still caught.
    const names = fs.readdirSync(target, { recursive: true }).map(String).sort();
    const digest = createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 16);
    return `dir:${names.length}:${digest}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? contentFailure ?? 'unknown';
    return `unreadable:${code}`;
  }
}

const guardBefore = new Map<string, string>();
beforeAll(() => {
  for (const target of guardTargets()) guardBefore.set(target, describeGuardPath(target));
});
afterAll(() => {
  cleanupTempDirs();
  const violations: string[] = [];
  for (const [target, before] of guardBefore) {
    const after = describeGuardPath(target);
    if (after !== before) violations.push(`  ${target}\n    before: ${before}\n    after:  ${after}`);
  }
  if (violations.length > 0) {
    throw new Error(
      'Workspace-resolution tests wrote outside their temp dirs — a host config root changed:\n' + violations.join('\n'),
    );
  }
});

describe('resolveWorkbuddyWorkspace', () => {
  it('resolves the install-layout governance dir and reports ok when the config exists', () => {
    const home = tempHome();
    const governance = writeConfig(home);
    const resolution = resolveWorkbuddyWorkspace(home, isolatedEnv(home));
    expect(resolution).toEqual({ status: 'ok', workspaceDir: governance });
  });

  it('matches the install-layout SSoT exactly (workspace dir AND runtime adapter dir conventions)', () => {
    const home = 'D:\\fake-home';
    expect(getWorkbuddyWorkspaceDir(home, undefined, isolatedEnv(home))).toBe(path.join(path.resolve(home), '.workbuddy', 'pd-workspace'));
    expect(getInstallLayoutPaths(home, isolatedEnv(home)).workbuddyAdapterDir).toBe(path.join(path.resolve(home), '.pd', 'runtime', 'workbuddy-adapter'));
    expect(resolveWorkbuddyWorkspace(home, isolatedEnv(home)).workspaceDir).toBe(getWorkbuddyWorkspaceDir(home, undefined, isolatedEnv(home)));
  });

  it('uses the same explicit host config override for the WorkBuddy governance workspace', () => {
    const home = tempHome();
    const configDir = path.join(home, 'workbuddy-config');
    fs.mkdirSync(configDir);
    const governance = getWorkbuddyWorkspaceDir(home, configDir, isolatedEnv(home));
    assertInsideSandbox(governance, '(explicit override)');
    fs.mkdirSync(path.join(governance, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(governance, '.pd', 'config.yaml'), 'features: {}');
    const resolution = resolveWorkbuddyWorkspace(home, isolatedEnv(home, { WORKBUDDY_CONFIG_DIR: configDir }));
    expect(resolution).toEqual({ status: 'ok', workspaceDir: governance });
  });

  it('derives the WorkBuddy governance workspace from PD_EXPERIMENT_ROOT', () => {
    const home = tempHome();
    const experimentRoot = tempHome();
    const resolution = resolveWorkbuddyWorkspace(home, isolatedEnv(home, { PD_EXPERIMENT_ROOT: experimentRoot }));
    expect(resolution.status).toBe('uninitialized');
    expect(resolution.workspaceDir).toBe(path.join(experimentRoot, '.workbuddy', 'pd-workspace'));
  });

  it('refuses an inherited production WorkBuddy config root in experiment mode', () => {
    const home = tempHome();
    const experimentRoot = tempHome();
    const productionConfig = tempHome();
    const resolution = resolveWorkbuddyWorkspace(home, isolatedEnv(home, {
      PD_EXPERIMENT_ROOT: experimentRoot,
      WORKBUDDY_CONFIG_DIR: productionConfig,
    }));
    expect(resolution.status).toBe('degraded');
    if (resolution.status !== 'degraded') throw new Error('unreachable');
    expect(resolution.reason).toBe('pd_home_resolution_failed');
    expect(resolution.workspaceDir).toBe('');
    expect(resolution.nextAction).toContain('WORKBUDDY_CONFIG_DIR');
  });

  it('uninitialized home: actionable reason, no directory auto-created (P06)', () => {
    const home = tempHome();
    const resolution = resolveWorkbuddyWorkspace(home, isolatedEnv(home));
    expect(resolution.status).toBe('uninitialized');
    if (resolution.status !== 'uninitialized') throw new Error('unreachable');
    expect(resolution.reason).toBe('workbuddy_workspace_not_initialized');
    expect(resolution.nextAction).toContain('setup');
    expect(resolution.nextAction).toContain(resolution.workspaceDir);
    // Resolution is read-only: the governance dir must NOT appear.
    expect(fs.existsSync(getWorkbuddyWorkspaceDir(home, undefined, isolatedEnv(home)))).toBe(false);
  });

  it('config path occupied by a non-file: DEGRADED, never uninitialized, never a fallback', () => {
    const home = tempHome();
    const governance = getWorkbuddyWorkspaceDir(home, path.join(home, '.workbuddy'), isolatedEnv(home));
    assertInsideSandbox(governance, '(non-file config)');
    fs.mkdirSync(path.join(governance, '.pd', 'config.yaml'), { recursive: true }); // a DIRECTORY
    const resolution = resolveWorkbuddyWorkspace(home, isolatedEnv(home));
    expect(resolution.status).toBe('degraded');
    if (resolution.status !== 'degraded') throw new Error('unreachable');
    expect(resolution.reason).toBe('workbuddy_workspace_config_invalid');
    expect(resolution.nextAction).toContain('Repair');
    // No alternative workspace is ever offered (P06: no silent switch).
    expect(resolution.workspaceDir).toBe(governance);
  });

  it('A/B projects: the resolution is project-independent — one shared governance dir (OD-07)', () => {
    const home = 'D:\\wb-home-ab';
    const env = isolatedEnv(home);
    const a = resolveWorkbuddyWorkspace(home, env);
    const b = resolveWorkbuddyWorkspace(home, env);
    expect(a).toEqual(b);
    expect(a.workspaceDir).toBe(path.join(path.resolve(home), '.workbuddy', 'pd-workspace'));
  });

  // ── Malicious ambient env regression (2026-11-24 remediation) ──────────

  it('ignores a poisoned ambient WORKBUDDY_CONFIG_DIR when resolving with an isolated env', () => {
    const home = tempHome();
    const decoy = tempHome();
    const previous = process.env.WORKBUDDY_CONFIG_DIR;
    process.env.WORKBUDDY_CONFIG_DIR = path.join(decoy, '.workbuddy');
    try {
      // The ambient var is exactly what a WorkBuddy-launched shell injects;
      // the isolated env must make it inert for resolution AND for writes.
      const governance = writeConfig(home);
      const resolution = resolveWorkbuddyWorkspace(home, isolatedEnv(home));
      expect(resolution).toEqual({ status: 'ok', workspaceDir: governance });
      assertInsideSandbox(governance, '(ambient WORKBUDDY_CONFIG_DIR)');
      expect(fs.readdirSync(decoy)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
      else process.env.WORKBUDDY_CONFIG_DIR = previous;
    }
  });

  it('resolves under the explicit home even when HOME and USERPROFILE disagree', () => {
    const home = tempHome();
    const otherAuthority = tempHome();
    const governance = writeConfig(home);
    const env = isolatedEnv(home, { USERPROFILE: otherAuthority });
    const resolution = resolveWorkbuddyWorkspace(home, env);
    expect(resolution.status).toBe('ok');
    expect(resolution.workspaceDir).toBe(governance);
    // The mismatched authority must not become a second workspace root.
    expect(fs.existsSync(path.join(otherAuthority, '.workbuddy'))).toBe(false);
  });

  it('accepts a config dir that is a link into a real directory inside the home', () => {
    const home = tempHome();
    const realConfig = path.join(home, 'wb-config-real');
    fs.mkdirSync(realConfig, { recursive: true });
    fs.symlinkSync(realConfig, path.join(home, '.workbuddy'), process.platform === 'win32' ? 'junction' : 'dir');
    const governance = path.join(realConfig, 'pd-workspace');
    fs.mkdirSync(path.join(governance, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(governance, '.pd', 'config.yaml'), 'features: {}');
    const resolution = resolveWorkbuddyWorkspace(home, isolatedEnv(home));
    expect(resolution.status).toBe('ok');
    // All writes happened inside the sandbox; the link is sandbox-internal.
    assertInsideSandbox(governance, '(linked config dir)');
  });

  it('unreadable config: DEGRADED, never silently re-initialized', () => {
    if (process.platform === 'win32') return; // chmod has no POSIX effect there
    const home = tempHome();
    const governance = writeConfig(home);
    // statSync(config.yaml) must EACCES: lock the directory, not the file
    // (stat on a chmod-0 file still succeeds).
    fs.chmodSync(path.join(governance, '.pd'), 0o000);
    try {
      const resolution = resolveWorkbuddyWorkspace(home, isolatedEnv(home));
      expect(resolution.status).toBe('degraded');
      if (resolution.status !== 'degraded') throw new Error('unreachable');
      expect(resolution.reason).toBe('workbuddy_workspace_config_unreadable');
      expect(resolution.workspaceDir).toBe(governance); // no silent switch
    } finally {
      fs.chmodSync(path.join(governance, '.pd'), 0o755);
    }
  });
});
