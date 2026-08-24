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
    expect(resolved?.mode).toBe('canonical');
    expect(resolved?.root).toContain(path.join('.pd', 'runtime'));
    expect(resolved?.pluginRoot).toContain(path.join('.pd', 'runtime', 'plugin'));
  });

  it('keeps legacy OpenClaw installs discoverable', () => {
    const resolved = resolveInstalledRuntime({
      homeDir: 'C:\\Users\\alice',
      manifest: undefined,
      canonicalRuntimeExists: false,
      legacyExtensionExists: true,
    });
    expect(resolved?.mode).toBe('legacy');
    expect(resolved?.root).toContain(path.join('.openclaw', 'extensions'));
    expect(resolved?.pluginRoot).toBe(resolved?.root);
  });
});

describe('resolveSystemNodeCommand', () => {
  it('is always the literal node command — never env-controlled (security)', () => {
    expect(resolveSystemNodeCommand()).toBe('node');
  });
});

describe('buildConsoleOpenArgs', () => {
  it('uses --json --no-browser --no-auth with no workspace', () => {
    expect(buildConsoleOpenArgs()).toEqual(['console', 'open', '--json', '--no-browser', '--no-auth']);
  });

  it('appends --workspace when provided', () => {
    const args = buildConsoleOpenArgs({ workspaceDir: 'D:\\ws' });
    expect(args).toEqual(['console', 'open', '--json', '--no-browser', '--no-auth', '--workspace', 'D:\\ws']);
  });

  it('omits --workspace for empty string', () => {
    expect(buildConsoleOpenArgs({ workspaceDir: '' })).not.toContain('--workspace');
  });
});
