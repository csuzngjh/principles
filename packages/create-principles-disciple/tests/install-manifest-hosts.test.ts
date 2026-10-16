import { describe, expect, it } from 'vitest';
import { mergeInstallManifestHosts } from '../src/installer.js';

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
