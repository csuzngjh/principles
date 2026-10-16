import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  getInstallLayoutPaths,
  getConsoleServerEntry,
  getWorkbuddyWorkspaceDir,
  installManifestHostsForPersist,
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
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: [123] })).toEqual({
      error: 'install_manifest_malformed: hosts must be an array of host name strings',
    });
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: [] }).error).toContain('hosts');
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: 'codex' }).error).toContain('hosts');
  });

  it('re-reads its own output idempotently (all-unknown-hosts round trip)', () => {
    const first = parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: ['gamma'] });
    expect(first.error).toBeUndefined();
    const second = parseInstallManifest(first.manifest);
    expect(second.error).toBeUndefined();
    expect(second.manifest).toEqual(first.manifest);
    expect(second.warnings).toEqual(first.warnings);
  });

  // ── Forward compatibility (2026-10-16 incident) ─────────────────────────────
  // A manifest written by a NEWER installer must never read as "broken" in an
  // OLDER reader: the pre-WorkBuddy parser rejected the 3-host production
  // manifest as install_manifest_malformed, which resolveInstallLayout turned
  // into a legacy/missing fallback and the Companion surfaced as
  // "未找到已安装的 PD / console_runtime_not_installed" on a healthy install.

  it('accepts the production 3-host manifest (openclaw + codex + workbuddy) without warnings', () => {
    const { manifest, warnings, error } = parseInstallManifest({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['openclaw', 'codex', 'workbuddy'],
      workspaces: ['C:/Users/alice/.codex/pd-workspace', 'C:/Users/alice/.workbuddy/pd-workspace'],
    });
    expect(error).toBeUndefined();
    expect(warnings).toBeUndefined();
    expect(manifest?.hosts).toEqual(['openclaw', 'codex', 'workbuddy']);
    expect(manifest?.unknownHosts).toBeUndefined();
  });

  it('tolerates an unknown future 4th host as a structured warning — never "malformed"', () => {
    const { manifest, warnings, error } = parseInstallManifest({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['codex', 'openclaw', 'workbuddy', 'gamma'],
      workspaces: ['C:/ws'],
    });
    expect(error).toBeUndefined();
    expect(manifest?.hosts).toEqual(['codex', 'openclaw', 'workbuddy']);
    expect(manifest?.unknownHosts).toEqual(['gamma']);
    expect(warnings).toEqual([{ code: 'install_manifest_unknown_host', host: 'gamma' }]);
  });

  it('resolves an unknown-host manifest to canonical when the runtime exists — no legacy fallback (A6)', () => {
    const result = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest: { layoutVersion: 1, mode: 'canonical', hosts: ['codex', 'gamma'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: true,
    });
    expect(result.mode).toBe('canonical');
    expect(result.manifest?.unknownHosts).toEqual(['gamma']);
    expect(result.warnings).toEqual([{ code: 'install_manifest_unknown_host', host: 'gamma' }]);
  });

  it('tolerates a manifest whose hosts are ALL unknown to this reader', () => {
    const { manifest, warnings } = parseInstallManifest({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['gamma', 'delta'],
    });
    expect(manifest?.hosts).toEqual([]);
    expect(manifest?.unknownHosts).toEqual(['gamma', 'delta']);
    expect(warnings).toHaveLength(2);
    // Still a real canonical install for resolveInstallLayout.
    const resolved = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest,
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(resolved.mode).toBe('canonical');
  });

  it('installManifestHostsForPersist reunites known and unknown hosts for writers — no registration loss (A5)', () => {
    const { manifest } = parseInstallManifest({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['workbuddy', 'codex', 'gamma'],
    });
    expect(installManifestHostsForPersist(manifest)).toEqual(['workbuddy', 'codex', 'gamma']);
    expect(installManifestHostsForPersist(undefined)).toEqual([]);
  });

  it('still fails closed on an incompatible layoutVersion — compatibility never covers version drift (A2)', () => {
    expect(parseInstallManifest({ layoutVersion: 2, mode: 'canonical', hosts: ['codex'] })).toEqual({
      error: 'install_manifest_unsupported_version: 2',
    });
    expect(parseInstallManifest({ layoutVersion: '1', mode: 'canonical', hosts: ['codex'] })).toEqual({
      error: 'install_manifest_unsupported_version: 1',
    });
  });

  it('accepts workbuddy as an install host and exposes its runtime adapter dir', () => {
    const paths = getInstallLayoutPaths('C:/Users/alice');
    const result = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest: { layoutVersion: 1, mode: 'canonical', hosts: ['workbuddy'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(result.mode).toBe('canonical');
    expect(result.manifest?.hosts).toEqual(['workbuddy']);
    expect(paths.workbuddyAdapterDir).toBe(path.join(paths.runtimeDir, 'workbuddy-adapter'));
  });

  it('freezes the WorkBuddy governance workspace under the WorkBuddy config root (OD-07)', () => {
    const dir = getWorkbuddyWorkspaceDir('C:/Users/alice');
    expect(dir).toBe(path.join(path.resolve('C:/Users/alice'), '.workbuddy', 'pd-workspace'));
    // Never collides with Codex or OpenClaw state roots.
    expect(dir).not.toContain('.pd');
    expect(dir).not.toContain('.openclaw');
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
