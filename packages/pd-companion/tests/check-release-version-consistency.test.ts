/**
 * RF-03 (review 2026-10-16): the release version consistency guard. A
 * companion-vX.Y.Z tag must never produce an installer whose embedded
 * version disagrees with the tag or the repository package.json. The pure
 * core is exercised directly; the asar read path through a real archive
 * built with @electron/asar (the same library electron-builder uses).
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as asar from '@electron/asar';
import {
  checkVersionConsistency,
  locatePackagedAppAsar,
  readAsarAppVersion,
} from '../scripts/check-release-version-consistency.mjs';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-version-guard-'));

afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), 60_000);

async function buildAsar(fixtureName: string, embeddedVersion: string): Promise<string> {
  const appDir = path.resolve(root, fixtureName);
  if (appDir === root || !appDir.startsWith(root + path.sep)) {
    throw new Error(`fixture name escapes the test root: ${fixtureName}`);
  }
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: '@principles/pd-companion', version: embeddedVersion, main: 'dist/main/main.js' }),
  );
  const archive = path.join(root, `${fixtureName}.asar`);
  await asar.createPackage(appDir, archive);
  return archive;
}

describe('checkVersionConsistency (pure core)', () => {
  it('positive: agreeing repo/artifact/tag versions verify and report the version', () => {
    expect(checkVersionConsistency({ repoVersion: '0.1.3', artifactVersion: '0.1.3', expectedTagVersion: '0.1.3' }))
      .toEqual({ version: '0.1.3' });
    // No tag (workflow_dispatch): repo ↔ artifact agreement still enforced.
    expect(checkVersionConsistency({ repoVersion: '0.1.2', artifactVersion: '0.1.2' })).toEqual({ version: '0.1.2' });
  });

  it('negative: a tag cut on a commit whose package.json still says the old version fails loudly', () => {
    expect(() => checkVersionConsistency({ repoVersion: '0.1.2', artifactVersion: '0.1.2', expectedTagVersion: '0.1.3' }))
      .toThrow(/tag companion-v0\.1\.3.*release-prep/);
  });

  it('negative: an artifact built from a different source tree fails on repo ↔ asar disagreement', () => {
    expect(() => checkVersionConsistency({ repoVersion: '0.1.3', artifactVersion: '0.1.2', expectedTagVersion: '0.1.3' }))
      .toThrow(/rebuild before releasing/);
  });

  it('negative: malformed version strings fail loudly (semver shape enforced)', () => {
    expect(() => checkVersionConsistency({ repoVersion: 'not-a-version', artifactVersion: '0.1.2' })).toThrow(/repoVersion/);
    expect(() => checkVersionConsistency({ repoVersion: '0.1.2', artifactVersion: '0.1.2', expectedTagVersion: 'v0..1' }))
      .toThrow(/companion-vX\.Y\.Z/);
  });
});

describe('readAsarAppVersion / locatePackagedAppAsar (real archive)', () => {
  it('reads the embedded version from a real app.asar', async () => {
    const archive = await buildAsar('good', '9.9.9');
    expect(readAsarAppVersion(archive)).toBe('9.9.9');
    expect(checkVersionConsistency({ repoVersion: '9.9.9', artifactVersion: readAsarAppVersion(archive) }).version).toBe('9.9.9');
  });

  it('fails loud when the embedded package.json has no version', async () => {
    const appDir = path.join(root, 'no-version');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: '@principles/pd-companion' }));
    const archive = path.join(root, 'no-version.asar');
    await asar.createPackage(appDir, archive);
    expect(() => readAsarAppVersion(archive)).toThrow(/without a non-empty "version"/);
  });

  it('locatePackagedAppAsar refuses a release dir without a build', () => {
    expect(() => locatePackagedAppAsar(path.join(root, 'empty-release'))).toThrow(/npm run dist/);
  });
});

describe('Windows release workflow tag extraction', () => {
  it('R2-01: the tag step explicitly uses Bash for parameter expansion on windows-latest', () => {
    const workflow = fs.readFileSync(path.resolve(import.meta.dirname, '../../../.github/workflows/companion-release.yml'), 'utf8');
    const tagStep = workflow.split('- name: Verify release version consistency')[1]?.split('\n      - name:')[0];
    expect(tagStep).toBeDefined();
    expect(tagStep).toContain('shell: bash');
    expect(tagStep).toContain('--expect-tag');
    expect(workflow).toContain('runs-on: windows-latest');
  });
});
