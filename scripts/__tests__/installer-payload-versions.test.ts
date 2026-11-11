// Regression contract for the installer payload component versions.
//
// Context (release 1.150.1 / cohort 8851a3be8 / tag v3.2.1): the npm
// installer bundle stamped `pd-cli` from the movable registry `latest`
// (2.1.0) while the cohort committed 2.2.0, because the preserve-source env
// var was exported in a step that never ran the bundle. These tests pin the
// two halves of the fix:
//   1. a bundle never moves a component BACKWARDS, even with preserve off;
//   2. a packed installer whose payload disagrees with the cohort fails
//      closed instead of publishing a mixed-version release.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INSTALLER_PAYLOAD_COMPONENTS,
  compareStrictVersions,
  readCommittedComponentVersions,
  resolveBundledComponentVersion,
  verifyInstallerPayloadVersions,
} from '../release/lib/installer-payload-versions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

function payloadReaderFrom(versionsByPath: Record<string, string | null>) {
  return (payloadPath: string): string => {
    const version = versionsByPath[payloadPath];
    if (version === null || version === undefined) {
      const error = new Error(`ENOENT: no such file or directory, open 'package/${payloadPath}'`);
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    }
    return JSON.stringify({ name: payloadPath, version });
  };
}

describe('resolveBundledComponentVersion — bundles never downgrade', () => {
  it('preserve mode keeps the source version regardless of registry latest', () => {
    const result = resolveBundledComponentVersion({
      label: 'pd-cli',
      sourceVersion: '2.2.0',
      registryVersion: '2.1.0',
      preserveSourceVersions: true,
    });
    expect(result).toEqual({ version: '2.2.0', refusedDowngrade: false });
  });

  it('default mode refuses to stamp an OLDER registry version (the 1.150.1 defect)', () => {
    const result = resolveBundledComponentVersion({
      label: 'pd-cli',
      sourceVersion: '2.2.0',
      registryVersion: '2.1.0',
      preserveSourceVersions: false,
    });
    expect(result).toEqual({ version: '2.2.0', refusedDowngrade: true });
  });

  it('default mode still moves forward to a newer registry version', () => {
    const result = resolveBundledComponentVersion({
      label: 'plugin',
      sourceVersion: '3.2.0',
      registryVersion: '3.2.1',
      preserveSourceVersions: false,
    });
    expect(result).toEqual({ version: '3.2.1', refusedDowngrade: false });
  });

  it('an unreadable registry version keeps the source version', () => {
    const result = resolveBundledComponentVersion({
      label: 'core',
      sourceVersion: '7.3.2',
      registryVersion: null,
      preserveSourceVersions: false,
    });
    expect(result).toEqual({ version: '7.3.2', refusedDowngrade: false });
  });

  it('refuses to guess when the versions cannot be ordered', () => {
    expect(() =>
      resolveBundledComponentVersion({
        label: 'plugin',
        sourceVersion: '3.2.1-rc.1',
        registryVersion: '3.2.0',
        preserveSourceVersions: false,
      }),
    ).toThrow(/cannot order/i);
  });

  it('orders strict x.y.z versions', () => {
    expect(compareStrictVersions('2.2.0', '2.1.0')).toBe(1);
    expect(compareStrictVersions('2.1.0', '2.2.0')).toBe(-1);
    expect(compareStrictVersions('2.2.0', '2.2.0')).toBe(0);
    expect(compareStrictVersions('2.2.0-beta.1', '2.2.0')).toBeNull();
  });
});

describe('verifyInstallerPayloadVersions — packed installer must match the cohort', () => {
  const committed = readCommittedComponentVersions({ repoRoot: REPO_ROOT, cohort: HEAD });
  const exactPayload = () =>
    Object.fromEntries(committed.map((component) => [component.payloadPath, component.version]));

  it('covers every runtime component the installer ships', () => {
    expect(INSTALLER_PAYLOAD_COMPONENTS.map((component) => component.label)).toEqual([
      'pd-cli',
      'core',
      'host-runtime',
      'codex-adapter',
      'plugin',
    ]);
    expect(committed.map((component) => component.payloadPath)).toEqual([
      'pd-cli/package.json',
      'core/package.json',
      'host-runtime/package.json',
      'codex-adapter/package.json',
      'plugin/package.json',
    ]);
  });

  it('PASSES when the payload keeps the committed versions even though the registry latest is older', () => {
    const result = verifyInstallerPayloadVersions({
      committed,
      readPayloadManifest: payloadReaderFrom(exactPayload()),
    });
    expect(result.components).toHaveLength(committed.length);
    // The registry's older `latest` is irrelevant to the assertion: the
    // payload was built from the cohort tree, so it must carry these values.
    for (const component of result.components) {
      expect(component.version).toBe(committed.find((c) => c.label === component.label)?.version);
    }
  });

  it('FAILS when a component version differs from the cohort (the 2.1.0 payload)', () => {
    const versions = exactPayload();
    const pdCli = committed.find((component) => component.label === 'pd-cli')!;
    const [major, minor] = pdCli.version.split('.');
    versions['pd-cli/package.json'] = `${major}.${Math.max(0, Number(minor) - 1)}.0`;

    expect(() =>
      verifyInstallerPayloadVersions({ committed, readPayloadManifest: payloadReaderFrom(versions) }),
    ).toThrow(
      new RegExp(
        `pd-cli \\(pd-cli/package\\.json\\): expected ${pdCli.version.replace(/\./g, '\\.')}, got ${versions['pd-cli/package.json'].replace(/\./g, '\\.')}`,
      ),
    );
  });

  it('FAILS closed when a required component manifest is missing (no silent skip)', () => {
    const versions = exactPayload();
    versions['core/package.json'] = null;
    expect(() =>
      verifyInstallerPayloadVersions({ committed, readPayloadManifest: payloadReaderFrom(versions) }),
    ).toThrow(/core \(core\/package\.json\): expected .* got <missing>/);
  });

  it('refuses a moving ref as the version authority', () => {
    expect(() => readCommittedComponentVersions({ repoRoot: REPO_ROOT, cohort: 'HEAD' })).toThrow(/40-char git sha/);
  });
});
