/**
 * Cross-version install manifest compatibility (2026-10-16, Fix A+B
 * regression matrix). The regression sample is a read-only copy of the real
 * production install.json (see fixtures/install-manifest/README.md) — the
 * exact shape that bricked Companion 0.1.2.
 *
 * Covered here: the task-book matrix rows that need the REAL manifest shape
 * end-to-end (3-host load, unknown 4th host, incompatible version, corrupt
 * fields, canonical preference). Registry lifecycle rows live in
 * workspace-workers-manifest-failure.test.ts.
 *
 * Windows-gated BY CONTRACT, not by convenience: the fixture carries real
 * Windows workspace paths and the parser validates workspace absoluteness
 * with the host's path semantics — a Windows production manifest is only
 * meaningful on Windows (the Companion itself is Windows-only). The OS-neutral
 * contract rows run everywhere via bundled-parser-compat.test.ts.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getInstallLayoutPaths, parseInstallManifest, resolveInstallLayout } from '@principles/install-layout';
import { resolveInstalledRuntime } from '../../src/lib/locate.js';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/install-manifest/production-copy-20261016.json', import.meta.url));

function loadProductionFixture(): unknown {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
}

describe.skipIf(process.platform !== 'win32')('production 3-host manifest loads through the whole Companion resolution path', () => {
  it('parses with zero warnings and every host recognized', () => {
    const { manifest, warnings, error } = parseInstallManifest(loadProductionFixture());
    expect(error).toBeUndefined();
    expect(warnings).toBeUndefined();
    expect(manifest?.hosts).toEqual(['openclaw', 'codex', 'workbuddy']);
    expect(manifest?.unknownHosts).toBeUndefined();
    expect(manifest?.workspaces?.length).toBe(11);
  });

  it('resolves canonical (never the legacy fallback) with the real runtime present', () => {
    const fixture = loadProductionFixture();
    const paths = getInstallLayoutPaths('C:\\Users\\alice');
    const layout = resolveInstallLayout({
      homeDir: 'C:\\Users\\alice',
      manifest: fixture,
      canonicalRuntimeExists: true,
      legacyExtensionExists: true, // the incident machine HAD the legacy dir
    });
    expect(layout.mode).toBe('canonical');
    expect(layout.paths.runtimeDir).toBe(paths.runtimeDir);
    const runtime = resolveInstalledRuntime({
      homeDir: 'C:\\Users\\alice',
      manifest: fixture,
      canonicalRuntimeExists: true,
      legacyExtensionExists: true,
    });
    expect(runtime?.runtime?.mode).toBe('canonical');
    expect(runtime?.runtime?.root).toContain('.pd');
    expect(runtime?.missing).toBeUndefined();
  });

  it('yields non-empty codex and workbuddy workspace sets per host (worker discovery)', () => {
    const { manifest } = parseInstallManifest(loadProductionFixture());
    const workspaces = manifest?.workspaces ?? [];
    const codexSet = workspaces.filter((w) => !w.replaceAll('\\', '/').includes('.workbuddy/pd-workspace'));
    const workbuddySet = workspaces.filter((w) => w.replaceAll('\\', '/').includes('.workbuddy/pd-workspace'));
    expect(codexSet.length).toBe(10);
    expect(workbuddySet).toEqual(['C:\\Users\\Administrator\\.workbuddy\\pd-workspace']);
  });
});

describe.skipIf(process.platform !== 'win32')('the same manifest shape stays forward- and backward-safe', () => {
  it('an unknown 4th host on the production shape warns instead of failing', () => {
    const fixture = loadProductionFixture() as Record<string, unknown>;
    const { manifest, warnings, error } = parseInstallManifest({
      ...fixture,
      hosts: [...(fixture.hosts as string[]), 'gamma'],
    });
    expect(error).toBeUndefined();
    expect(manifest?.hosts).toEqual(['openclaw', 'codex', 'workbuddy']);
    expect(manifest?.unknownHosts).toEqual(['gamma']);
    expect(warnings).toEqual([{ code: 'install_manifest_unknown_host', host: 'gamma' }]);
    // And it still resolves canonical, with the legacy dir present.
    const layout = resolveInstallLayout({
      homeDir: 'C:\\Users\\alice',
      manifest,
      canonicalRuntimeExists: true,
      legacyExtensionExists: true,
    });
    expect(layout.mode).toBe('canonical');
  });

  it('an incompatible layoutVersion is still rejected loudly on the production shape', () => {
    const fixture = loadProductionFixture() as Record<string, unknown>;
    const { manifest, error } = parseInstallManifest({ ...fixture, layoutVersion: 2 });
    expect(manifest).toBeUndefined();
    expect(error).toBe('install_manifest_unsupported_version: 2');
    const resolved = resolveInstalledRuntime({
      homeDir: 'C:\\Users\\alice',
      manifest: { ...fixture, layoutVersion: 2 },
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(resolved?.runtime).toBeUndefined();
    expect(resolved?.missing?.reason).toBe('install_manifest_unsupported_version: 2');
  });

  it('a corrupt workspaces field on the production shape is rejected, not read as zero workspaces', () => {
    const fixture = loadProductionFixture() as Record<string, unknown>;
    const { manifest, error } = parseInstallManifest({ ...fixture, workspaces: ['relative/path'] });
    expect(manifest).toBeUndefined();
    expect(error).toContain('workspaces');
  });
});
