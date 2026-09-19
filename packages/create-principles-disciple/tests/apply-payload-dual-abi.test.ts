/**
 * PRI-852: same-platform dual-ABI publication and consumption.
 *
 * Publish side — two runtimes on one platform are DISTINCT signed targets
 * (no duplicate-platform refusal, both bytes served).
 * Consume side — selectReleaseAsset picks the exact platform+arch+ABI match
 * for THIS runtime and refuses with `runtime_not_supported` when only other
 * ABIs exist.
 */
import { describe, expect, it } from 'vitest';
import { buildReleaseMetadata } from '../src/update/release-metadata.js';
import { buildReleasePublication } from '../src/update/release-metadata-publisher.js';
import { generateKeyPairSync } from 'node:crypto';
import { selectReleaseAsset } from '../src/update/apply-payload.js';

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
});
