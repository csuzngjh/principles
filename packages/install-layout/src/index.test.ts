import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  getInstallLayoutPaths,
  getConsoleServerEntry,
  parseInstallManifest,
  resolveInstallLayout,
  mergeInstallManifestWorkspaces,
} from './index.js';

describe('install layout', () => {
  it('resolves a canonical Codex-only install without OpenClaw', () => {
    const paths = getInstallLayoutPaths('C:/Users/alice');
    const result = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest: { layoutVersion: 1, mode: 'canonical', hosts: ['codex'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(result.mode).toBe('canonical');
    expect(result.manifest?.hosts).toEqual(['codex']);
    expect(paths.openClawExtensionDir).toContain('.openclaw');
    expect(paths.pluginDir).toContain('plugin');
    expect(paths.installLayoutDir).toContain('install-layout');
    expect(getConsoleServerEntry(result.paths, 'canonical')).toContain('.pd');
  });

  it('falls back to legacy only when the old extension exists', () => {
    const result = resolveInstallLayout({
      homeDir: '/home/alice',
      manifest: undefined,
      canonicalRuntimeExists: false,
      legacyExtensionExists: true,
    });
    expect(result.mode).toBe('legacy');
    expect(result.nextAction).toContain('migrate');
  });

  it('rejects malformed manifests instead of silently treating them as canonical', () => {
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: ['wat'] })).toEqual({
      error: 'install_manifest_malformed: hosts must contain codex and/or openclaw',
    });
  });

  it('accepts a manifest without workspaces (pre-PRI-624 manifests stay valid)', () => {
    const { manifest, error } = parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'] });
    expect(error).toBeUndefined();
    expect(manifest?.workspaces).toEqual([]);
  });

  it('parses workspaces as canonical absolute paths, deduped in insertion order', () => {
    const { manifest, error } = parseInstallManifest({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['codex'],
      workspaces: ['D:/Code/ws-a', 'D:\\Code\\ws-a', 'C:/work/ws b'],
    });
    expect(error).toBeUndefined();
    expect(manifest?.workspaces?.length).toBe(2);
    expect(manifest?.workspaces?.[0]).toBe(path.resolve('D:/Code/ws-a'));
    expect(manifest?.workspaces).toContain(path.resolve('C:/work/ws b'));
  });

  it('rejects malformed workspace entries loudly', () => {
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: [''] })).toEqual({
      error: 'install_manifest_malformed: workspaces must be non-empty absolute paths',
    });
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: ['ws-a'] })).toEqual({
      error: 'install_manifest_malformed: workspaces must be non-empty absolute paths',
    });
  });

  it('merges a workspace into an existing manifest without duplicates', () => {
    const merged = mergeInstallManifestWorkspaces(
      { layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: ['D:/Code/ws-a'] },
      'D:\\Code\\ws-a',
    );
    expect(merged.length).toBe(1);
    expect(merged[0]).toBe(path.resolve('D:/Code/ws-a'));
  });

  it('merge accepts unknown current manifests and starts a fresh list', () => {
    const merged = mergeInstallManifestWorkspaces(undefined, 'D:/Code/ws-b');
    expect(merged).toEqual([path.resolve('D:/Code/ws-b')]);
  });
});
