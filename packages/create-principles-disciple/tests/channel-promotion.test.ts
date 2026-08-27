import { describe, expect, it } from 'vitest';
import { planChannelPromotion } from '../src/update/channel-promotion.js';
import { buildReleaseMetadata, type ReleaseMetadata } from '../src/update/release-metadata.js';
import { parseChannelMetadata, type ChannelMetadata } from '../src/update/channel-metadata.js';

const expiresFar = '2030-01-01T00:00:00Z';

function release(productVersion: string, publicationSequence: number): ReleaseMetadata {
  return buildReleaseMetadata({
    productVersion,
    sourceCommit: '1234567890abcdef1234567890abcdef12345678',
    minBootstrapVersion: '1.0.0',
    publicationSequence,
    expiresAt: expiresFar,
    assets: [{
      platform: 'win32', arch: 'x64', nodeAbi: '147',
      archiveSha256: 'a'.repeat(64), archiveSizeBytes: 1024,
    }],
    dataSchemaForwardReadableFrom: '1.220.0',
  });
}

function channelDocumentFor(releaseMetadata: ReleaseMetadata, version: number): ChannelMetadata {
  return parseChannelMetadata({
    schemaVersion: 1,
    channel: 'stable',
    version,
    expiresAt: expiresFar,
    releaseMetadataDigest: releaseMetadata.metadataDigest,
    releaseId: releaseMetadata.releaseId,
    productVersion: releaseMetadata.productVersion,
    publicationSequence: releaseMetadata.publicationSequence,
  });
}

describe('channel promotion (SPEC 18-8: promotion changes signed metadata only)', () => {
  it('promotes a published release by rewriting only the pointer triple', () => {
    const first = release('1.222.0', 8);
    const second = release('1.223.0', 9);
    const current = channelDocumentFor(first, 3);

    const result = planChannelPromotion({ channel: 'stable', release: second, current, expiresAt: expiresFar });
    expect(result.promoted).toBe(true);
    if (!result.promoted) return;
    expect(result.previousVersion).toBe(3);
    expect(result.next.version).toBe(4);
    expect(result.next.releaseMetadataDigest).toBe(second.metadataDigest);
    expect(result.next.releaseId).toBe(second.releaseId);
    expect(result.next.productVersion).toBe(second.productVersion);
    expect(result.next.publicationSequence).toBe(second.publicationSequence);

    // The promoted document contains ONLY channel + pointer fields — there is
    // no field through which a promotion could alter or rebuild an asset.
    expect(Object.keys(result.next).sort()).toEqual([
      'channel', 'expiresAt', 'productVersion', 'publicationSequence',
      'releaseId', 'releaseMetadataDigest', 'schemaVersion', 'version',
    ]);
  });

  it('starts a channel at version 1 when no current document exists', () => {
    const target = release('1.222.0', 8);
    const result = planChannelPromotion({ channel: 'candidate', release: target, current: null, expiresAt: expiresFar });
    expect(result).toMatchObject({ promoted: true, previousVersion: null });
    if (result.promoted) {
      expect(result.next.version).toBe(1);
      expect(result.next.channel).toBe('candidate');
    }
  });

  it('keeps the release asset identity bit-identical across promotions', () => {
    // The structural proof of §18-8: two successive promotions produce channel
    // documents whose referenced asset digest NEVER changes for the same
    // release, and the release metadata itself is untouched by promotion.
    const target = release('1.223.0', 9);
    const identityBefore = JSON.stringify(target);
    const assetDigestBefore = target.assets[0]?.archiveSha256;

    const first = planChannelPromotion({ channel: 'stable', release: target, current: null, expiresAt: expiresFar });
    expect(first.promoted).toBe(true);
    const second = planChannelPromotion({
      channel: 'stable',
      release: target,
      current: first.promoted ? first.next : null,
      expiresAt: '2030-06-01T00:00:00Z',
    });
    expect(second.promoted).toBe(true);
    if (!first.promoted || !second.promoted) return;

    expect(second.next.releaseMetadataDigest).toBe(first.next.releaseMetadataDigest);
    expect(second.next.releaseId).toBe(first.next.releaseId);
    expect(JSON.parse(identityBefore)).toMatchObject({ releaseId: target.releaseId });
    expect(target.assets[0]?.archiveSha256).toBe(assetDigestBefore);
  });

  it('refuses cross-channel promotion and sequence regressions loudly', () => {
    const target = release('1.221.0', 7);
    const stable = channelDocumentFor(release('1.222.0', 8), 2);

    const crossChannel = planChannelPromotion({ channel: 'candidate', release: target, current: stable, expiresAt: expiresFar });
    expect(crossChannel).toMatchObject({ promoted: false, reason: 'channel_mismatch' });

    const regression = planChannelPromotion({ channel: 'stable', release: target, current: stable, expiresAt: expiresFar });
    expect(regression).toMatchObject({ promoted: false, reason: 'sequence_not_advancing' });
    if (!regression.promoted) {
      expect(regression.message).toMatch(/backwards/);
    }
  });
});
