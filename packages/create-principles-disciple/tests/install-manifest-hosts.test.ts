import { describe, expect, it } from 'vitest';
import { mergeInstallManifestHosts } from '../src/installer.js';

describe('mergeInstallManifestHosts', () => {
  it('preserves OpenClaw ownership when Codex is attached later', () => {
    expect(mergeInstallManifestHosts(
      { layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] },
      'codex',
    )).toEqual(['openclaw', 'codex']);
  });

  it('fails loud instead of erasing host ownership from a malformed manifest', () => {
    expect(() => mergeInstallManifestHosts(
      { layoutVersion: 1, mode: 'canonical', hosts: ['openclaw', 'unknown'] },
      'codex',
    )).toThrow('install_manifest_malformed');
  });
});
