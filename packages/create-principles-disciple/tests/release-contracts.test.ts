import { describe, expect, it } from 'vitest';
import {
  assertSha256Hex,
  compareProductVersions,
  formatShortVersion,
  parseProductVersion,
  ProductIdentityError,
} from '../src/update/product-identity.js';
import {
  buildReleaseMetadata,
  isReleaseMetadataExpired,
  parseReleaseMetadata,
  ReleaseMetadataError,
  verifyReleaseMetadataIdentity,
} from '../src/update/release-metadata.js';
import {
  canonicalJson,
  deriveReleaseId,
} from '../src/update/release-identity.js';
import {
  isChannelMetadataExpired,
  parseChannelMetadata,
  ChannelMetadataError,
} from '../src/update/channel-metadata.js';
import {
  evaluateReleaseAdvancement,
  verifyChannelPointer,
} from '../src/update/release-policy.js';

const sha256A = 'a'.repeat(64);
const sha256B = 'b'.repeat(64);
const sourceCommit = '1234567890abcdef1234567890abcdef12345678';

function validAsset(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'win32',
    arch: 'x64',
    nodeAbi: '147',
    archiveSha256: sha256A,
    archiveSizeBytes: 1024,
    ...overrides,
  };
}

function validMetadataInput(overrides: Record<string, unknown> = {}) {
  return {
    productVersion: '1.222.0',
    sourceCommit,
    minBootstrapVersion: '1.0.0',
    publicationSequence: 7,
    expiresAt: '2030-01-01T00:00:00Z',
    assets: [validAsset()],
    dataSchemaForwardReadableFrom: '1.220.0',
    ...overrides,
  };
}

describe('canonicalJson', () => {
  it('sorts keys and drops undefined deterministically', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: true }] })).toBe('{"a":[2,{"c":true,"d":null}],"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('parseProductVersion', () => {
  it('accepts strict x.y.z only', () => {
    expect(parseProductVersion('1.222.0')).toMatchObject({ major: 1, minor: 222, patch: 0 });
    for (const bad of ['1.22', 'v1.222.0', '1.222.0-beta', '01.2.0', '', 42, null]) {
      expect(() => parseProductVersion(bad)).toThrow(ProductIdentityError);
    }
  });

  it('compares versions in total order', () => {
    const older = parseProductVersion('1.9.9');
    const newer = parseProductVersion('1.10.0');
    expect(compareProductVersions(older, newer)).toBeLessThan(0);
    expect(compareProductVersions(newer, older)).toBeGreaterThan(0);
    expect(compareProductVersions(older, older)).toBe(0);
  });

  it('requires lowercase sha256 hex digests', () => {
    expect(assertSha256Hex(sha256A, 'digest')).toBe(sha256A);
    expect(() => assertSha256Hex('A'.repeat(64), 'digest')).toThrow(ProductIdentityError);
    expect(() => assertSha256Hex('abc', 'digest')).toThrow(ProductIdentityError);
  });
});

describe('deriveReleaseId', () => {
  it('is deterministic and asset-order independent', () => {
    const base = validMetadataInput();
    const first = deriveReleaseId({
      productVersion: base.productVersion,
      sourceCommit: base.sourceCommit,
      minBootstrapVersion: base.minBootstrapVersion,
      assets: base.assets,
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveReleaseId({
      productVersion: base.productVersion,
      sourceCommit: base.sourceCommit,
      minBootstrapVersion: base.minBootstrapVersion,
      assets: [...base.assets].reverse(),
    })).toBe(first);
  });

  it('changes when any identity input changes', () => {
    const base = validMetadataInput();
    const id = (overrides: Record<string, unknown>) => deriveReleaseId({
      productVersion: (overrides.productVersion ?? base.productVersion) as string,
      sourceCommit: (overrides.sourceCommit ?? base.sourceCommit) as string,
      minBootstrapVersion: (overrides.minBootstrapVersion ?? base.minBootstrapVersion) as string,
      assets: (overrides.assets ?? base.assets) as typeof base.assets,
    });
    const baseline = id({});
    expect(id({ productVersion: '1.222.1' })).not.toBe(baseline);
    expect(id({ sourceCommit: '0'.repeat(40) })).not.toBe(baseline);
    expect(id({ minBootstrapVersion: '1.1.0' })).not.toBe(baseline);
    expect(id({ assets: [validAsset({ archiveSha256: sha256B })] })).not.toBe(baseline);
  });

  it('rejects invalid inputs loudly', () => {
    expect(() => deriveReleaseId(validMetadataInput({ assets: [] } as unknown as Record<string, unknown>))).toThrow(ProductIdentityError);
    expect(() => deriveReleaseId(validMetadataInput({ assets: [validAsset({ platform: 'Win32' })] } as unknown as Record<string, unknown>))).toThrow(ProductIdentityError);
    expect(() => deriveReleaseId(validMetadataInput({ assets: [validAsset({ archiveSizeBytes: 0 })] } as unknown as Record<string, unknown>))).toThrow(ProductIdentityError);
    expect(() => deriveReleaseId(validMetadataInput({ assets: [validAsset({ nodeAbi: 'abi' })] } as unknown as Record<string, unknown>))).toThrow(ProductIdentityError);
    expect(() => deriveReleaseId(validMetadataInput({ assets: [validAsset(), validAsset({ arch: 'arm64' })] } as unknown as Record<string, unknown>))).not.toThrow();
  });
});

describe('parseReleaseMetadata', () => {
  it('round-trips producer-built metadata and closes the identity chain', () => {
    const metadata = buildReleaseMetadata(validMetadataInput() as never);
    const parsed = parseReleaseMetadata(JSON.parse(JSON.stringify(metadata)));
    expect(parsed.releaseId).toBe(metadata.releaseId);
    expect(() => verifyReleaseMetadataIdentity(parsed)).not.toThrow();
    expect(isReleaseMetadataExpired(parsed)).toBe(false);
  });

  it('rejects missing required fields without silent skips (rc-3)', () => {
    const metadata = buildReleaseMetadata(validMetadataInput() as never);
    for (const field of ['schemaVersion', 'productVersion', 'releaseId', 'sourceCommit', 'metadataDigest', 'minBootstrapVersion', 'publicationSequence', 'expiresAt', 'assets', 'compatibility']) {
      const record = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
      delete record[field];
      expect(() => parseReleaseMetadata(record), `missing ${field}`).toThrow(ReleaseMetadataError);
    }
  });

  it('rejects unknown and inherited keys (rc-5)', () => {
    const metadata = buildReleaseMetadata(validMetadataInput() as never);
    const withUnknown = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
    withUnknown['extraField'] = 'surprise';
    expect(() => parseReleaseMetadata(withUnknown)).toThrow(/unknown field "extraField"/);

    const withProto = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    expect(Object.hasOwn(withProto, '__proto__')).toBe(true);
    expect(() => parseReleaseMetadata(withProto)).toThrow(ReleaseMetadataError);
  });

  it('rejects malformed nested values element-wise (rc-4)', () => {
    const metadata = buildReleaseMetadata(validMetadataInput() as never);
    const badAsset = JSON.parse(JSON.stringify(metadata)) as { assets: unknown[] };
    badAsset.assets = ['not-an-object'];
    expect(() => parseReleaseMetadata(badAsset)).toThrow(ReleaseMetadataError);

    const badDigest = JSON.parse(JSON.stringify(metadata)) as { assets: { archiveSha256: string }[] };
    badDigest.assets[0]!.archiveSha256 = 'zzz';
    expect(() => parseReleaseMetadata(badDigest)).toThrow(ReleaseMetadataError);
  });

  it('detects a tampered releaseId or metadataDigest as an identity mismatch', () => {
    const metadata = buildReleaseMetadata(validMetadataInput() as never);
    const tamperedId = JSON.parse(JSON.stringify(metadata));
    tamperedId.releaseId = sha256B;
    const parsedId = parseReleaseMetadata(tamperedId);
    expect(() => verifyReleaseMetadataIdentity(parsedId)).toThrow(/does not match the identity derived/);

    const tamperedDigest = JSON.parse(JSON.stringify(metadata));
    tamperedDigest.metadataDigest = sha256B;
    const parsedDigest = parseReleaseMetadata(tamperedDigest);
    expect(() => verifyReleaseMetadataIdentity(parsedDigest)).toThrow(/canonical document digest/);
  });
});

function validChannelInput(overrides: Record<string, unknown> = {}) {
  const metadata = buildReleaseMetadata(validMetadataInput() as never);
  return {
    metadata,
    channel: {
      schemaVersion: 1,
      channel: 'stable',
      version: 3,
      expiresAt: '2030-01-01T00:00:00Z',
      releaseMetadataDigest: metadata.metadataDigest,
      releaseId: metadata.releaseId,
      productVersion: metadata.productVersion,
      publicationSequence: metadata.publicationSequence,
      ...overrides,
    },
  };
}

describe('parseChannelMetadata', () => {
  it('parses a strict channel document', () => {
    const { channel } = validChannelInput();
    const parsed = parseChannelMetadata(JSON.parse(JSON.stringify(channel)));
    expect(parsed.channel).toBe('stable');
    expect(parsed.version).toBe(3);
    expect(isChannelMetadataExpired(parsed)).toBe(false);
  });

  it('rejects wrong channel names, sequences, and digests loudly', () => {
    for (const overrides of [
      { channel: 'beta' },
      { version: 0 },
      { version: '3' },
      { releaseMetadataDigest: 'nothex' },
      { productVersion: '1.2' },
      { unknownKey: 1 },
    ]) {
      const { channel } = validChannelInput(overrides);
      expect(() => parseChannelMetadata(channel), JSON.stringify(overrides)).toThrow(ChannelMetadataError);
    }
  });
});

describe('release advancement policy', () => {
  it('allows a clean first install and a forward update', () => {
    const first = validChannelInput();
    expect(evaluateReleaseAdvancement({
      channel: parseChannelMetadata(first.channel),
      candidate: first.metadata,
      current: null,
      bootstrapVersion: '1.0.0',
    })).toEqual({ allowed: true, direction: 'update' });

    const nextMetadata = buildReleaseMetadata(validMetadataInput({ publicationSequence: 8, productVersion: '1.223.0' }) as never);
    const nextChannel = validChannelInput({
      releaseMetadataDigest: nextMetadata.metadataDigest,
      releaseId: nextMetadata.releaseId,
      productVersion: nextMetadata.productVersion,
      publicationSequence: nextMetadata.publicationSequence,
      version: 4,
    });
    const decision = evaluateReleaseAdvancement({
      channel: parseChannelMetadata(nextChannel.channel),
      candidate: nextMetadata,
      current: {
        productVersion: first.metadata.productVersion,
        releaseId: first.metadata.releaseId,
        publicationSequence: first.metadata.publicationSequence,
        bootstrapVersion: '1.0.0',
        previouslyConfirmedReleaseIds: [first.metadata.releaseId],
      },
      bootstrapVersion: '1.0.0',
    });
    expect(decision).toEqual({ allowed: true, direction: 'update' });
  });

  it('classifies the same release as a reinstall', () => {
    const { channel, metadata } = validChannelInput();
    const decision = evaluateReleaseAdvancement({
      channel: parseChannelMetadata(channel),
      candidate: metadata,
      current: {
        productVersion: metadata.productVersion,
        releaseId: metadata.releaseId,
        publicationSequence: metadata.publicationSequence,
        bootstrapVersion: '1.0.0',
        previouslyConfirmedReleaseIds: [],
      },
      bootstrapVersion: '1.0.0',
    });
    expect(decision).toEqual({ allowed: true, direction: 'reinstall' });
  });

  it('refuses an older sequence with downgrade_blocked and an explicit next action (rc-9)', () => {
    const older = buildReleaseMetadata(validMetadataInput({ publicationSequence: 3, productVersion: '1.221.0' }) as never);
    const olderChannel = validChannelInput({
      releaseMetadataDigest: older.metadataDigest,
      releaseId: older.releaseId,
      productVersion: older.productVersion,
      publicationSequence: older.publicationSequence,
    });
    const current = {
      productVersion: '1.222.0',
      releaseId: 'c'.repeat(64),
      publicationSequence: 7,
      bootstrapVersion: '1.0.0',
      previouslyConfirmedReleaseIds: [],
    };
    const refusal = evaluateReleaseAdvancement({
      channel: parseChannelMetadata(olderChannel.channel),
      candidate: older,
      current,
      bootstrapVersion: '1.0.0',
    });
    expect(refusal).toMatchObject({ allowed: false, reason: 'downgrade_blocked' });
    if (!refusal.allowed) expect(refusal.nextAction.length).toBeGreaterThan(10);

    // Explicit downgrade is permitted only to a previously confirmed release.
    const confirmed = { ...current, previouslyConfirmedReleaseIds: [older.releaseId] };
    const allowedDowngrade = evaluateReleaseAdvancement({
      channel: parseChannelMetadata(olderChannel.channel),
      candidate: older,
      current: confirmed,
      bootstrapVersion: '1.0.0',
      allowExplicitDowngrade: true,
    });
    expect(allowedDowngrade).toEqual({ allowed: true, direction: 'explicit_downgrade' });

    const stillRefused = evaluateReleaseAdvancement({
      channel: parseChannelMetadata(olderChannel.channel),
      candidate: older,
      current,
      bootstrapVersion: '1.0.0',
      allowExplicitDowngrade: true,
    });
    expect(stillRefused).toMatchObject({ allowed: false, reason: 'downgrade_blocked' });
  });

  it('refuses sequence collisions, expired metadata, old bootstrap, and pointer mismatches before mutation', () => {
    const { metadata } = validChannelInput();

    const collisionChannel = validChannelInput({
      releaseMetadataDigest: 'd'.repeat(64),
      releaseId: 'd'.repeat(64),
    });
    expect(evaluateReleaseAdvancement({
      channel: parseChannelMetadata(collisionChannel.channel),
      candidate: metadata,
      current: null,
      bootstrapVersion: '1.0.0',
    })).toMatchObject({ allowed: false, reason: 'channel_pointer_mismatch' });

    const expiredRelease = buildReleaseMetadata(validMetadataInput({ expiresAt: '2001-01-01T00:00:00Z' }) as never);
    const expiredReleaseChannel = validChannelInput({
      releaseMetadataDigest: expiredRelease.metadataDigest,
      releaseId: expiredRelease.releaseId,
      productVersion: expiredRelease.productVersion,
      publicationSequence: expiredRelease.publicationSequence,
    });
    expect(evaluateReleaseAdvancement({
      channel: parseChannelMetadata(expiredReleaseChannel.channel),
      candidate: expiredRelease,
      current: null,
      bootstrapVersion: '1.0.0',
    })).toMatchObject({ allowed: false, reason: 'release_metadata_expired' });

    const highBootstrap = buildReleaseMetadata(validMetadataInput({ minBootstrapVersion: '2.0.0' }) as never);
    const highBootstrapChannel = validChannelInput({
      releaseMetadataDigest: highBootstrap.metadataDigest,
      releaseId: highBootstrap.releaseId,
      productVersion: highBootstrap.productVersion,
      publicationSequence: highBootstrap.publicationSequence,
    });
    expect(evaluateReleaseAdvancement({
      channel: parseChannelMetadata(highBootstrapChannel.channel),
      candidate: highBootstrap,
      current: null,
      bootstrapVersion: '1.5.0',
    })).toMatchObject({ allowed: false, reason: 'bootstrap_too_old' });

    const equalSequence = buildReleaseMetadata(validMetadataInput({ productVersion: '1.222.1' }) as never);
    const equalSequenceChannel = validChannelInput({
      releaseMetadataDigest: equalSequence.metadataDigest,
      releaseId: equalSequence.releaseId,
      productVersion: equalSequence.productVersion,
    });
    expect(evaluateReleaseAdvancement({
      channel: parseChannelMetadata(equalSequenceChannel.channel),
      candidate: equalSequence,
      current: {
        productVersion: '1.222.0',
        releaseId: metadata.releaseId,
        publicationSequence: equalSequence.publicationSequence,
        bootstrapVersion: '1.0.0',
        previouslyConfirmedReleaseIds: [],
      },
      bootstrapVersion: '1.0.0',
    })).toMatchObject({ allowed: false, reason: 'sequence_regression' });

    const mismatched = verifyChannelPointer(parseChannelMetadata(validChannelInput({ releaseId: 'e'.repeat(64) }).channel), metadata);
    expect(mismatched).toMatchObject({ reason: 'channel_pointer_mismatch' });
  });
});

describe('formatShortVersion', () => {
  it('renders the stable short text contract', () => {
    expect(formatShortVersion({ productVersion: '1.222.0', releaseId: sha256A }))
      .toBe(`Principles Disciple 1.222.0 (${sha256A.slice(0, 12)})`);
  });
});
