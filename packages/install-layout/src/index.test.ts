import { describe, expect, it } from 'vitest';
import { getInstallLayoutPaths, getConsoleServerEntry, parseInstallManifest, resolveInstallLayout } from './index.js';

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
});
