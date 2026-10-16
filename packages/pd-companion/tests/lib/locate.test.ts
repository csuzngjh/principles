import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  buildConsoleOpenArgs,
  resolveExtensionDir,
  resolveInstalledRuntime,
  resolvePdCliEntry,
  resolvePluginPackageJson,
  resolveSystemNodeCommand,
} from '../../src/lib/locate.js';

describe('resolveExtensionDir', () => {
  it('returns <home>/.openclaw/extensions/principles-disciple', () => {
    const dir = resolveExtensionDir('C:\\Users\\alice');
    expect(dir).toContain('.openclaw');
    expect(dir).toContain('extensions');
    expect(dir).toContain('principles-disciple');
  });

  it('returns undefined for empty or whitespace home', () => {
    expect(resolveExtensionDir(undefined)).toBeUndefined();
    expect(resolveExtensionDir('')).toBeUndefined();
    expect(resolveExtensionDir('   ')).toBeUndefined();
  });
});

describe('resolvePdCliEntry / resolvePluginPackageJson', () => {
  it('points at pd-cli/dist/index.js and extension package.json', () => {
    expect(resolvePdCliEntry('/ext')).toBe(path.join('/ext', 'pd-cli', 'dist', 'index.js'));
    expect(resolvePluginPackageJson('/ext')).toBe(path.join('/ext', 'package.json'));
  });
});

describe('resolveInstalledRuntime', () => {
  it('prefers the canonical runtime for a Codex-only install', () => {
    const resolved = resolveInstalledRuntime({
      homeDir: 'C:\\Users\\alice',
      manifest: { layoutVersion: 1, mode: 'canonical', hosts: ['codex'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(resolved?.runtime.mode).toBe('canonical');
    expect(resolved?.runtime.root).toContain(path.join('.pd', 'runtime'));
    expect(resolved?.runtime.pluginRoot).toContain(path.join('.pd', 'runtime', 'plugin'));
    expect(resolved?.missing).toBeUndefined();
  });

  it('keeps legacy OpenClaw installs discoverable', () => {
    const resolved = resolveInstalledRuntime({
      homeDir: 'C:\\Users\\alice',
      manifest: undefined,
      canonicalRuntimeExists: false,
      legacyExtensionExists: true,
    });
    expect(resolved?.runtime.mode).toBe('legacy');
    expect(resolved?.runtime.root).toContain(path.join('.openclaw', 'extensions'));
    expect(resolved?.runtime.pluginRoot).toBe(resolved?.runtime.root);
    expect(typeof resolved?.runtime.fallbackReason).toBe('string');
  });

  // 2026-10-16: distinct failure causes must stay distinct (rc-9). The old
  // collapsed shape (undefined for every missing mode) is exactly what turned
  // "manifest this reader cannot understand" into the wrong "PD not installed"
  // message for the Owner.

  it('reports an incompatible layoutVersion as its own cause on a machine without the legacy dir', () => {
    const resolved = resolveInstalledRuntime({
      homeDir: 'C:\\Users\\alice',
      manifest: { layoutVersion: 2, mode: 'canonical', hosts: ['codex'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(resolved?.runtime).toBeUndefined();
    expect(resolved?.missing?.reason).toBe('install_manifest_unsupported_version: 2');
    expect(resolved?.missing?.nextAction).toContain('companion-v');
    expect(resolved?.missing?.nextAction).not.toContain('create-principles-disciple');
  });

  it('carries the incompatible-version reason through the legacy fallback when there is no canonical runtime to protect', () => {
    const resolved = resolveInstalledRuntime({
      homeDir: 'C:\\Users\\alice',
      manifest: { layoutVersion: 2, mode: 'canonical', hosts: ['codex'] },
      canonicalRuntimeExists: false,
      legacyExtensionExists: true,
    });
    // Canonical dir ABSENT: nothing to bypass, the legacy discovery stays.
    expect(resolved?.runtime?.mode).toBe('legacy');
    expect(resolved?.runtime?.fallbackReason).toBe('install_manifest_unsupported_version: 2');
  });

  // RF-01 end-to-end chain (the incident machine shape — canonical runtime
  // EXISTED): the resolution must refuse, and the refusal must land the Owner
  // on the update-the-Companion page — never on a launched legacy CLI.
  it('RF-01: refusal → install_manifest_incompatible degraded page with the Companion update entry', async () => {
    const resolved = resolveInstalledRuntime({
      homeDir: 'C:\\Users\\alice',
      manifest: { layoutVersion: 2, mode: 'canonical', hosts: ['codex'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: true,
    });
    // main.ts: extDir stays undefined → startSupervision returns before any
    // spawn; the reason flows to the supervisor unmapped-from-blanket.
    expect(resolved?.runtime).toBeUndefined();
    expect(resolved?.missing?.reason).toBe('install_manifest_unsupported_version: 2');
    const { mapLaunchFailureReason } = await import('../../src/lib/supervisor.js');
    const { describeDegraded } = await import('../../src/lib/degraded.js');
    expect(mapLaunchFailureReason(resolved!.missing!.reason)).toBe('install_manifest_incompatible');
    const page = describeDegraded('install_manifest_incompatible', resolved!.missing!.reason, resolved!.missing!.nextAction);
    expect(resolved!.missing!.nextAction).toContain('companion-v');
    expect(page.nextAction).toContain('companion-v');
    expect(page.nextAction).not.toContain('create-principles-disciple');
  });

  it('reports structural manifest damage as its own missing cause', () => {
    const resolved = resolveInstalledRuntime({
      homeDir: 'C:\\Users\\alice',
      manifest: { layoutVersion: 1, mode: 'weird', hosts: ['codex'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(resolved?.runtime).toBeUndefined();
    expect(resolved?.missing?.reason).toContain('install_manifest_malformed');
  });

  it('surfaces forward-compatibility warnings for unknown hosts on a healthy canonical install', () => {
    const resolved = resolveInstalledRuntime({
      homeDir: 'C:\\Users\\alice',
      manifest: { layoutVersion: 1, mode: 'canonical', hosts: ['codex', 'gamma'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(resolved?.runtime.mode).toBe('canonical');
    expect(resolved?.warnings).toEqual([{ code: 'install_manifest_unknown_host', host: 'gamma' }]);
  });
});

describe('resolveSystemNodeCommand', () => {
  it('is always the literal node command — never env-controlled (security)', () => {
    expect(resolveSystemNodeCommand()).toBe('node');
  });
});

describe('buildConsoleOpenArgs', () => {
  it('uses loopback no-auth mode when no token is configured', () => {
    expect(buildConsoleOpenArgs()).toEqual(['console', 'open', '--json', '--no-browser', '--no-auth']);
  });

  it('relies on inherited environment authentication without exposing a token in argv', () => {
    const args = buildConsoleOpenArgs({ workspaceDir: 'D:\\ws', tokenConfigured: true });
    expect(args).toEqual(['console', 'open', '--json', '--no-browser', '--workspace', 'D:\\ws']);
    expect(args).not.toContain('--no-auth');
    expect(args).not.toContain('--token');
  });

  it('appends --workspace when provided', () => {
    const args = buildConsoleOpenArgs({ workspaceDir: 'D:\\ws' });
    expect(args).toEqual(['console', 'open', '--json', '--no-browser', '--no-auth', '--workspace', 'D:\\ws']);
  });

  it('omits --workspace for empty string', () => {
    expect(buildConsoleOpenArgs({ workspaceDir: '' })).not.toContain('--workspace');
  });
});
