/**
 * The bundled-parser compatibility matrix, run against the WORKSPACE SOURCE
 * (scripts/bundled-parser-compat.mjs runs the same matrix against the parser
 * extracted from the built app.asar in the release gate). Keeping both sides
 * on one module means the artifact gate can never drift from the contract
 * the repository tests enforce.
 */
import { describe, expect, it } from 'vitest';
import { assertInstallManifestCompat, PRODUCTION_SHAPED_MANIFEST } from '../../scripts/bundled-parser-compat.mjs';
import {
  installManifestHostsForPersist,
  parseInstallManifest,
  resolveInstallLayout,
} from '@principles/install-layout';

describe('bundled-parser compatibility matrix against workspace source', () => {
  it('passes the full matrix (same gate the packaged app.asar must pass)', () => {
    const rows = assertInstallManifestCompat({ parseInstallManifest, resolveInstallLayout, installManifestHostsForPersist });
    expect(rows).toHaveLength(6);
    expect(rows[0]).toContain('openclaw,codex,workbuddy');
  });

  it('fails loudly against a parser that predates the workbuddy contract (the 0.1.2 defect shape)', async () => {
    // Simulate the shipped 0.1.0 parser: only two hosts known, unknown = malformed.
    const INSTALL_HOSTS = ['codex', 'openclaw'];
    const oldParser = (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: 'install_manifest_malformed: expected an object' };
      if (!Array.isArray(value.hosts) || !value.hosts.every((h) => INSTALL_HOSTS.includes(h))) {
        return { error: 'install_manifest_malformed: hosts must contain codex and/or openclaw' };
      }
      return { manifest: { ...value, hosts: [...value.hosts] } };
    };
    const oldLayout = { parseInstallManifest: oldParser, resolveInstallLayout, installManifestHostsForPersist };
    expect(() => assertInstallManifestCompat(oldLayout)).toThrow(/3-host manifest|too old/);
    // Sanity: the simulated old parser really does reject the production shape.
    expect(oldParser(PRODUCTION_SHAPED_MANIFEST).manifest).toBeUndefined();
  });
});
