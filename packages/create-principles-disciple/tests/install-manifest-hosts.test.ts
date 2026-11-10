import { describe, expect, it } from 'vitest';
import { mergeInstallManifestHosts, planUpgradeHosts, resolveHostRefreshTargets } from '../src/installer.js';

describe('mergeInstallManifestHosts', () => {
  it('preserves OpenClaw ownership when Codex is attached later', () => {
    expect(mergeInstallManifestHosts(
      { layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] },
      'codex',
    )).toEqual(['openclaw', 'codex']);
  });

  // Forward compatibility (2026-10-16): a manifest written by a NEWER
  // installer may carry a host this reader does not know. Re-running the
  // installer on such a machine previously threw install_manifest_malformed
  // and refused to install/update at all — the write-side twin of the old
  // Companion brick. The unknown registration must survive the merge instead.
  it('carries unknown host registrations forward when a known host is attached', () => {
    expect(mergeInstallManifestHosts(
      { layoutVersion: 1, mode: 'canonical', hosts: ['openclaw', 'gamma'] },
      'codex',
    )).toEqual(['openclaw', 'gamma', 'codex']);
  });

  it('still fails loud instead of erasing host ownership from a structurally broken manifest', () => {
    expect(() => mergeInstallManifestHosts(
      { layoutVersion: 2, mode: 'canonical', hosts: ['openclaw'] },
      'codex',
    )).toThrow('install_manifest_unsupported_version');
    expect(() => mergeInstallManifestHosts(
      { layoutVersion: 1, mode: 'canonical', hosts: [42] },
      'codex',
    )).toThrow('install_manifest_malformed');
  });
});

/**
 * The shared runtime (~/.pd/runtime) is replaced by every install/update, so a
 * host the manifest already records must be refreshed even when the run targets
 * a different host — its mcp-binding.json pins the MCP server version.
 */
describe('resolveHostRefreshTargets', () => {
  it('refreshes a previously installed WorkBuddy host when the run targets OpenClaw', () => {
    expect(resolveHostRefreshTargets(['openclaw', 'workbuddy'], 'openclaw')).toEqual(['workbuddy']);
  });

  it("keeps WorkBuddy opt-in: 'all' refreshes it only because the manifest already records it", () => {
    expect(resolveHostRefreshTargets(['openclaw', 'codex'], 'all')).toEqual([]);
    expect(resolveHostRefreshTargets(['openclaw', 'codex', 'workbuddy'], 'all')).toEqual(['workbuddy']);
  });

  it('never refreshes the host this run already installs, and ignores unknown registrations', () => {
    expect(resolveHostRefreshTargets(['workbuddy', 'gamma'], 'workbuddy')).toEqual([]);
    expect(resolveHostRefreshTargets(['openclaw', 'gamma'], 'workbuddy')).toEqual(['openclaw']);
  });
});

describe('planUpgradeHosts (update chain 2026-11-11)', () => {
  it('covers a host installed outside the manifest instead of silently leaving it on the old release', () => {
    // BEFORE: `--host openclaw` refreshed only the manifest hosts → a Codex
    // plugin added by hand stayed stale while the upgrade reported success.
    const plan = planUpgradeHosts('openclaw', [], [
      { hostId: 'codex', evidence: '/home/u/.codex/plugins/cache/principles/principles-disciple/0.3.19' },
    ]);
    expect(plan.refreshTargets).toEqual(['codex']);
    expect(plan.newlyCovered.map((host) => host.hostId)).toEqual(['codex']);
  });

  it('covers every detected host on one upgrade, without repeating the requested one', () => {
    const plan = planUpgradeHosts('openclaw', ['openclaw', 'codex', 'workbuddy'], [
      { hostId: 'codex', evidence: 'codex cache' },
      { hostId: 'workbuddy', evidence: 'workbuddy registry' },
    ]);
    expect(plan.refreshTargets).toEqual(['codex', 'workbuddy']);
    expect(plan.newlyCovered).toEqual([]);
  });
});
