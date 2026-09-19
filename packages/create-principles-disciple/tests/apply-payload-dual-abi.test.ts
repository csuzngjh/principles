/**
 * PRI-852: same-platform dual-ABI publication and consumption.
 *
 * Publish side — two runtimes on one platform are DISTINCT signed targets
 * (no duplicate-platform refusal, both bytes served).
 * Consume side — selectReleaseAsset picks the exact platform+arch+ABI match
 * for THIS runtime and refuses with `runtime_not_supported` when only other
 * ABIs exist.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildReleaseMetadata } from '../src/update/release-metadata.js';
import { buildReleasePublication } from '../src/update/release-metadata-publisher.js';
import { parseReleaseMetadata, type ReleaseMetadata } from '../src/update/release-metadata.js';
import { selectReleaseAsset, downloadReleaseAsset } from '../src/update/apply-payload.js';
import { createShadowFixture, disposeShadowFixtures, trackTempDir } from './helpers/shadow-release-fixture.js';

const farExpiry = '2030-01-01T00:00:00Z';
const sourceCommit = '1234567890abcdef1234567890abcdef12345678';

function makeAssets(nodeAbis: string[]): Array<{ platform: string; arch: string; nodeAbi: string; archiveSha256: string; archiveSizeBytes: number }> {
  return nodeAbis.map((nodeAbi, index) => ({
    platform: process.platform,
    arch: process.arch,
    nodeAbi,
    archiveSha256: `a${index}`.padEnd(64, '0'),
    archiveSizeBytes: 1024 + index,
  }));
}

function makeMetadata(nodeAbis: string[]) {
  return buildReleaseMetadata({
    productVersion: '2.0.0',
    sourceCommit,
    minBootstrapVersion: '1.0.0',
    publicationSequence: 3,
    expiresAt: farExpiry,
    assets: makeAssets(nodeAbis),
    dataSchemaForwardReadableFrom: '1.0.0',
  });
}

describe('same-platform dual-ABI assets', () => {
  it('publisher accepts two ABIs for one platform and emits two distinct targets', () => {
    const metadata = makeMetadata(['137', '147']);
    const keyPair = generateKeyPairSync('ed25519');
    const signingKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publication = buildReleasePublication({
      channel: 'stable',
      channelVersion: 1,
      publicationSequence: 3,
      expiresAt: farExpiry,
      minBootstrapVersion: '1.0.0',
      dataSchemaForwardReadableFrom: '1.0.0',
      productVersion: '2.0.0',
      sourceCommit,
      signingKeyPem,
      previousState: null,
      archives: [
        { platform: process.platform, arch: process.arch, nodeAbi: '137', bytes: Buffer.from('abi137-bytes') },
        { platform: process.platform, arch: process.arch, nodeAbi: '147', bytes: Buffer.from('abi147-bytes') },
      ],
    });
    const targetPaths = publication.files.map((f) => f.path).filter((p) => p.includes('release-asset-'));
    expect(targetPaths).toHaveLength(2);
    expect(targetPaths.some((p) => p.endsWith(`release-asset-${process.platform}-${process.arch}-abi137.tar.gz`))).toBe(true);
    expect(targetPaths.some((p) => p.endsWith(`release-asset-${process.platform}-${process.arch}-abi147.tar.gz`))).toBe(true);
    expect(publication.releaseMetadata.assets).toHaveLength(2);
  });

  it('consumer selects the exact platform+arch+ABI match for THIS runtime', () => {
    const metadata = makeMetadata(['137', process.versions.modules]);
    const asset = selectReleaseAsset(metadata);
    expect(asset.nodeAbi).toBe(process.versions.modules);
  });

  it('consumer refuses with runtime_not_supported when only other ABIs are published', () => {
    const otherAbi = process.versions.modules === '147' ? '137' : '147';
    const metadata = makeMetadata([otherAbi]);
    try {
      selectReleaseAsset(metadata);
      throw new Error('expected selectReleaseAsset to refuse');
    } catch (error) {
      expect((error as { reason?: string }).reason).toBe('runtime_not_supported');
      expect((error as { message?: string }).message).toContain(otherAbi);
    }
  });

  it('consumer refuses with release_metadata_invalid when the platform has no asset at all', () => {
    // A release that only declares assets for ANOTHER platform: identity-wise
    // valid (>=1 asset), but nothing matches THIS runtime's platform.
    const otherPlatform = process.platform === 'sunos' ? 'win32' : 'sunos';
    const metadata = buildReleaseMetadata({
      productVersion: '2.0.0',
      sourceCommit,
      minBootstrapVersion: '1.0.0',
      publicationSequence: 3,
      expiresAt: farExpiry,
      assets: [{
        platform: otherPlatform,
        arch: process.arch,
        nodeAbi: process.versions.modules,
        archiveSha256: 'a'.padEnd(64, '0'),
        archiveSizeBytes: 1024,
      }],
      dataSchemaForwardReadableFrom: '1.0.0',
    });
    try {
      selectReleaseAsset(metadata);
      throw new Error('expected selectReleaseAsset to refuse');
    } catch (error) {
      expect((error as { reason?: string }).reason).toBe('release_metadata_invalid');
    }
  });
});

describe('consumer target-name resolution (PRI-852 contract)', () => {
  afterEach(async () => {
    await disposeShadowFixtures();
  });

  it('legacy pre-ABI target name resolves through the signed fallback', async () => {
    const bytes = Buffer.from('legacy-target-bytes');
    const fixture = await createShadowFixture({
      candidateAsset: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
      artifact: () => bytes,
      // No artifactTargetPath override → fixture serves the LEGACY name.
    });
    const metadata = parseReleaseMetadata(
      JSON.parse(fs.readFileSync(
        path.join(fixture.pdHome, 'releases', fixture.releaseId, 'metadata.json'),
        'utf8',
      )) as unknown,
    );
    if (metadata === null) throw new Error('fixture metadata missing');
    const pathsModule = await import('../src/update/install-layout.js');
    const downloaded = await downloadReleaseAsset({
      paths: pathsModule.resolvePdHomePaths(fixture.pdHome),
      metadataBaseUrl: fixture.repository.baseUrl,
      releaseMetadata: metadata,
      channel: 'stable',
      transactionId: 'tx-legacy-fallback',
    });
    expect(fs.existsSync(downloaded.archivePath)).toBe(true);
  });

  it('ABI-qualified target name resolves as the primary convention', async () => {
    const bytes = Buffer.from('abi-target-bytes');
    const abiName = `release-asset-${process.platform}-${process.arch}-abi${process.versions.modules}.tar.gz`;
    const fixture = await createShadowFixture({
      candidateAsset: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
      artifact: () => bytes,
      abiQualifiedArtifactTarget: true,
    });
    // The fixture override builds the full target path; re-read it from the
    // served map is not exported, so assert via a real download using the
    // ABI-qualified name the fixture just served.
    const metadata = parseReleaseMetadata(
      JSON.parse(fs.readFileSync(
        path.join(fixture.pdHome, 'releases', fixture.releaseId, 'metadata.json'),
        'utf8',
      )) as unknown,
    );
    const pathsModule = await import('../src/update/install-layout.js');
    const downloaded = await downloadReleaseAsset({
      paths: pathsModule.resolvePdHomePaths(fixture.pdHome),
      metadataBaseUrl: fixture.repository.baseUrl,
      releaseMetadata: metadata,
      channel: 'stable',
      transactionId: 'tx-abi-primary',
    });
    expect(fs.existsSync(downloaded.archivePath)).toBe(true);
    expect(fs.readFileSync(downloaded.archivePath)).toEqual(bytes);
    expect(bytes.length).toBeGreaterThan(0);
    expect(path.basename(downloaded.archivePath)).toBe('release-asset.tar.gz');
  });
});
