/**
 * PRI-727 — release metadata publisher tests.
 *
 * Three verification layers (PRI-727 acceptance):
 *  1. Metadata contract — the publisher emits documents the strict consumer
 *     parsers accept, and fails loud on missing/invalid inputs.
 *  2. Signature verification — a real TUF client (trust-metadata.ts, tuf-js)
 *     accepts the emitted chain and rejects tampered bytes.
 *  3. ReleaseManager integration — a served publication feeds the real
 *     ReleaseManager: check() becomes ready and the artifact acquisition
 *     digest cross-check passes against the publisher's manifest.
 */

import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import {
  buildReleasePublication,
  generateEphemeralSigningKeyPem,
  gzipReleaseArchive,
  isRfc3339UtcTimestamp,
  parseSha256DigestFile,
  ReleasePublicationError,
} from '../src/update/release-metadata-publisher.js';
import { parseChannelMetadata } from '../src/update/channel-metadata.js';
import { parseReleaseMetadata, verifyReleaseMetadataIdentity } from '../src/update/release-metadata.js';
import {
  downloadTrustedReleasePayload,
  resolveTrustedReleaseTarget,
  ReleaseTrustError,
} from '../src/update/trust-metadata.js';
import { downloadReleaseAsset } from '../src/update/apply-payload.js';
import { ReleaseManager } from '../src/update/release-manager.js';
import { ensurePdHomeLayout, resolvePdHomePaths, writeInstallConfig } from '../src/update/install-layout.js';

const EXPIRES = '2030-01-01T00:00:00Z';
const SOURCE_COMMIT = '1234567890abcdef1234567890abcdef12345678';

function makeSigningKeyPem(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

const SIGNING_KEY_PEM = makeSigningKeyPem();

function publicationInput(overrides: Partial<Parameters<typeof buildReleasePublication>[0]> = {}) {
  return {
    productVersion: '1.223.0',
    sourceCommit: SOURCE_COMMIT,
    channel: 'stable' as const,
    channelVersion: 4,
    publicationSequence: 9,
    expiresAt: EXPIRES,
    minBootstrapVersion: '1.0.0',
    dataSchemaForwardReadableFrom: '1.220.0',
    archive: {
      platform: 'win32',
      arch: 'x64',
      nodeAbi: '147',
      bytes: gzipReleaseArchive(Buffer.from('pd-release-payload-bytes')),
    },
    signingKeyPem: SIGNING_KEY_PEM,
    previous: null,
    ...overrides,
  };
}

function fileMap(publication: { files: readonly { path: string; bytes: Buffer }[] }): Map<string, Buffer> {
  return new Map(publication.files.map((file) => [file.path, file.bytes]));
}

const temporaryDirectories: string[] = [];
const openServers: http.Server[] = [];

function trackTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-publisher-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A metadata directory pinned with the PUBLISHED root.json (tuf-js bootstrap requirement). */
function pinnedMetadataDir(files: Map<string, Buffer>): string {
  const directory = trackTempDir();
  fs.writeFileSync(path.join(directory, 'root.json'), files.get('root.json')!);
  return directory;
}

async function serveFiles(files: Map<string, Buffer>): Promise<string> {
  const server = http.createServer((request, response) => {
    const data = files.get(request.url?.replace(/^\//, '') ?? '');
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200).end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a port');
  return `http://127.0.0.1:${address.port}`;
}

afterAll(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe('release publication contract', () => {
  it('emits the exact target set ReleaseManager consumes, with consumer-valid documents', () => {
    const publication = buildReleasePublication(publicationInput());
    const paths = fileMap(publication);

    expect([...paths.keys()].sort()).toEqual([
      'root.json',
      'snapshot.json',
      'targets.json',
      'targets/channels/stable.json',
      `targets/releases/${publication.releaseMetadata.releaseId}/metadata.json`,
      `targets/releases/${publication.releaseMetadata.releaseId}/release-asset-win32-x64.tar.gz`,
      'timestamp.json',
    ].sort());

    // The produced documents pass the SAME strict parsers the ReleaseManager
    // uses (rc-3/rc-4 enforced on the producer side too).
    const channelPayload = parseChannelMetadata(JSON.parse(paths.get('targets/channels/stable.json')!.toString('utf8')));
    const metadataPayload = parseReleaseMetadata(JSON.parse(paths.get(`targets/releases/${publication.releaseMetadata.releaseId}/metadata.json`)!.toString('utf8')));
    verifyReleaseMetadataIdentity(metadataPayload);
    expect(publication.releaseMetadata).toEqual(metadataPayload);
    expect(channelPayload.releaseMetadataDigest).toBe(metadataPayload.metadataDigest);
    expect(channelPayload.releaseId).toBe(metadataPayload.releaseId);
    expect(channelPayload.publicationSequence).toBe(metadataPayload.publicationSequence);

    // Artifact digest binding: the served artifact bytes are exactly what the
    // signed metadata declares.
    const artifactBytes = paths.get(`targets/releases/${publication.releaseMetadata.releaseId}/release-asset-win32-x64.tar.gz`)!;
    expect(createHash('sha256').update(artifactBytes).digest('hex')).toBe(metadataPayload.assets[0].archiveSha256);
    expect(artifactBytes.length).toBe(metadataPayload.assets[0].archiveSizeBytes);
    expect(publication.manifest.artifactSha256).toBe(metadataPayload.assets[0].archiveSha256);
  });

  it('is byte-deterministic: same inputs and key re-emit identical files', () => {
    const first = buildReleasePublication(publicationInput());
    const second = buildReleasePublication(publicationInput());
    const firstPaths = fileMap(first);
    const secondPaths = fileMap(second);
    expect([...secondPaths.keys()]).toEqual([...firstPaths.keys()]);
    for (const [filePath, bytes] of firstPaths) {
      expect(bytes.equals(secondPaths.get(filePath)!), `${filePath} differs`).toBe(true);
    }
  });

  it('re-publishing the same release against the same previous state is a byte-level no-op', () => {
    const published = buildReleasePublication(publicationInput({
      previous: {
        channelPayload: JSON.parse(fileMap(buildReleasePublication(publicationInput())).get('targets/channels/stable.json')!.toString('utf8')),
        tufVersions: { root: 1, timestamp: 3, snapshot: 3, targets: 3 },
      },
    }));
    const republished = buildReleasePublication(publicationInput({
      previous: {
        channelPayload: JSON.parse(fileMap(buildReleasePublication(publicationInput())).get('targets/channels/stable.json')!.toString('utf8')),
        tufVersions: { root: 1, timestamp: 3, snapshot: 3, targets: 3 },
      },
    }));
    for (const [filePath, bytes] of fileMap(published)) {
      expect(bytes.equals(fileMap(republished).get(filePath)!), `${filePath} differs`).toBe(true);
    }
  });

  it('an advance bumps TUF metadata versions while the root version stays pinned', () => {
    const previousPayload = JSON.parse(
      fileMap(buildReleasePublication(publicationInput())).get('targets/channels/stable.json')!.toString('utf8'),
    );
    const advance = buildReleasePublication(publicationInput({
      publicationSequence: 10,
      channelVersion: 5,
      productVersion: '1.224.0',
      previous: { channelPayload: previousPayload, tufVersions: { root: 1, timestamp: 3, snapshot: 3, targets: 3 } },
    }));
    expect(JSON.parse(fileMap(advance).get('timestamp.json')!.toString('utf8')).signed.version).toBe(4);
    expect(JSON.parse(fileMap(advance).get('snapshot.json')!.toString('utf8')).signed.version).toBe(4);
    expect(JSON.parse(fileMap(advance).get('targets.json')!.toString('utf8')).signed.version).toBe(4);
    expect(JSON.parse(fileMap(advance).get('root.json')!.toString('utf8')).signed.version).toBe(1);
    // Snapshot meta chains to the targets version (TUF consistency).
    expect(JSON.parse(fileMap(advance).get('snapshot.json')!.toString('utf8')).signed.meta['targets.json'].version).toBe(4);
  });

  it('fails loud on invalid inputs', () => {
    expect(() => buildReleasePublication(publicationInput({ channel: 'beta' as never }))).toThrow(ReleasePublicationError);
    expect(() => buildReleasePublication(publicationInput({ sourceCommit: 'not-a-commit' }))).toThrow();
    expect(() => buildReleasePublication(publicationInput({ channelVersion: 0 }))).toThrow(ReleasePublicationError);
    expect(() => buildReleasePublication(publicationInput({ publicationSequence: -1 }))).toThrow(ReleasePublicationError);
    expect(() => buildReleasePublication(publicationInput({ expiresAt: '2030-01-01' }))).toThrow(ReleasePublicationError);
    expect(() => buildReleasePublication(publicationInput({ expiresAt: '2001-01-01T00:00:00Z' }))).toThrow(ReleasePublicationError);
    expect(() => buildReleasePublication(publicationInput({
      archive: { platform: 'win32', arch: 'x64', nodeAbi: '147', bytes: Buffer.alloc(0) },
    }))).toThrow(ReleasePublicationError);
    expect(() => buildReleasePublication(publicationInput({ signingKeyPem: '' }))).toThrow(ReleasePublicationError);
    expect(() => buildReleasePublication(publicationInput({ signingKeyPem: 'not a key' }))).toThrow(ReleasePublicationError);
  });

  it('refuses to move the channel pointer backwards', () => {
    const previousPayload = JSON.parse(
      fileMap(buildReleasePublication(publicationInput())).get('targets/channels/stable.json')!.toString('utf8'),
    );
    // Lower publication sequence than the published pointer.
    expect(() => buildReleasePublication(publicationInput({
      publicationSequence: 3,
      channelVersion: 9,
      productVersion: '1.224.0',
      previous: { channelPayload: previousPayload, tufVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 } },
    }))).toThrow(/publicationSequence/);
    // Same sequence, different release — a sequence collision.
    expect(() => buildReleasePublication(publicationInput({
      productVersion: '1.224.0',
      previous: { channelPayload: previousPayload, tufVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 } },
    }))).toThrow(/publicationSequence/);
    // Pointer version regression.
    expect(() => buildReleasePublication(publicationInput({
      publicationSequence: 10,
      channelVersion: 2,
      productVersion: '1.224.0',
      previous: { channelPayload: previousPayload, tufVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 } },
    }))).toThrow(/pointer version/);
  });

  it('refuses to mutate an already-published release under the same releaseId', () => {
    const previousPayload = JSON.parse(
      fileMap(buildReleasePublication(publicationInput())).get('targets/channels/stable.json')!.toString('utf8'),
    );
    expect(() => buildReleasePublication(publicationInput({
      publicationSequence: 11,
      previous: { channelPayload: previousPayload, tufVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 } },
    }))).toThrow(ReleasePublicationError);
  });

  it('fails loud on a corrupt previous pointer and on a missing previous TUF versions', () => {
    expect(() => buildReleasePublication(publicationInput({
      previous: { channelPayload: { channel: 'stable' }, tufVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 } },
    }))).toThrow();
    const previousPayload = JSON.parse(
      fileMap(buildReleasePublication(publicationInput())).get('targets/channels/stable.json')!.toString('utf8'),
    );
    expect(() => buildReleasePublication(publicationInput({
      productVersion: '1.224.0',
      previous: { channelPayload: previousPayload },
    }))).toThrow(/TUF metadata versions/);
  });
});

describe('digest and gzip helpers', () => {
  it('parses sha256sum-style digest files strictly', () => {
    const hex = 'a'.repeat(64);
    expect(parseSha256DigestFile(`${hex}\n`)).toBe(hex);
    expect(parseSha256DigestFile(`${hex}  asset.tar\n`)).toBe(hex);
    expect(parseSha256DigestFile(hex.toUpperCase())).toBe(hex);
    expect(() => parseSha256DigestFile('sha256: not-hex')).toThrow(ReleasePublicationError);
    expect(() => parseSha256DigestFile('')).toThrow(ReleasePublicationError);
  });

  it('gzip wrapping is deterministic and reversible', () => {
    const bytes = Buffer.from('the archive contents');
    expect(gzipReleaseArchive(bytes).equals(gzipReleaseArchive(bytes))).toBe(true);
    expect(gunzipSync(gzipReleaseArchive(bytes)).equals(bytes)).toBe(true);
  });

  it('validates RFC3339 UTC timestamps', () => {
    expect(isRfc3339UtcTimestamp('2030-01-01T00:00:00Z')).toBe(true);
    expect(isRfc3339UtcTimestamp('2030-01-01T00:00:00.123Z')).toBe(true);
    expect(isRfc3339UtcTimestamp('2030-01-01')).toBe(false);
    expect(isRfc3339UtcTimestamp(42)).toBe(false);
  });
});

describe('signature verification through the real TUF client', () => {
  it('accepts the emitted chain and rejects tampered metadata and payload bytes', async () => {
    const publication = buildReleasePublication(publicationInput());
    const artifactTargetPath = publication.manifest.artifactTargetPath;
    const baseUrl = await serveFiles(fileMap(publication));

    const trusted = await resolveTrustedReleaseTarget({
      metadataDir: pinnedMetadataDir(fileMap(publication)),
      metadataBaseUrl: baseUrl,
      targetPath: 'channels/stable.json',
      expectedChannel: 'stable',
      expectedPlatform: 'metadata',
    });
    expect(trusted.releaseId).toBe(publication.manifest.releaseId);

    // Copy before mutating: the publication's buffers are shared references.
    const tamperedFiles = (mutatePath: string) => {
      const files = fileMap(publication);
      const bytes = Buffer.from(files.get(mutatePath)!);
      bytes.write('x', 8);
      files.set(mutatePath, bytes);
      return files;
    };

    // Tampered SIGNED METADATA (targets.json) — the signature no longer
    // verifies against the pinned root: refused at refresh.
    const tamperedMetadataUrl = await serveFiles(tamperedFiles('targets.json'));
    await expect(resolveTrustedReleaseTarget({
      metadataDir: pinnedMetadataDir(fileMap(publication)),
      metadataBaseUrl: tamperedMetadataUrl,
      targetPath: 'channels/stable.json',
      expectedChannel: 'stable',
      expectedPlatform: 'metadata',
    })).rejects.toBeInstanceOf(ReleaseTrustError);

    // Tampered SERVED PAYLOAD (digest no longer matches targets.json) —
    // refused during the verified download, never written.
    const destination = path.join(trackTempDir(), 'artifact.tar.gz');
    await expect(downloadTrustedReleasePayload({
      metadataDir: pinnedMetadataDir(fileMap(publication)),
      metadataBaseUrl: await serveFiles(tamperedFiles('targets/channels/stable.json')),
      targetPath: 'channels/stable.json',
      destinationPath: path.join(trackTempDir(), 'channel.json'),
    })).rejects.toBeInstanceOf(ReleaseTrustError);

    // Tampered SERVED ARTIFACT — same integrity refusal on the artifact target.
    await expect(downloadTrustedReleasePayload({
      metadataDir: pinnedMetadataDir(fileMap(publication)),
      metadataBaseUrl: await serveFiles(tamperedFiles(`targets/${artifactTargetPath}`)),
      targetPath: artifactTargetPath,
      destinationPath: destination,
    })).rejects.toBeInstanceOf(ReleaseTrustError);
  });
});

describe('ReleaseManager integration over a served publication', () => {
  it('metadata → verified download → check() ready with the published candidate', async () => {
    // The acquisition path selects the asset for THIS runtime
    // (selectReleaseAsset + releaseAssetTargetPath use process values), so
    // the publication must declare the runtime platform.
    const publication = buildReleasePublication(publicationInput({
      archive: {
        platform: process.platform,
        arch: process.arch,
        nodeAbi: process.versions.modules,
        bytes: gzipReleaseArchive(Buffer.from('pd-release-payload-bytes')),
      },
    }));
    const files = fileMap(publication);
    const baseUrl = await serveFiles(files);

    // A clean dual-slot home pinned with the PUBLISHED root.
    const pdHome = trackTempDir();
    const paths = resolvePdHomePaths(path.join(pdHome, '.pd'));
    ensurePdHomeLayout(paths);
    fs.writeFileSync(paths.bootstrapManifestPath, `${JSON.stringify({ bootstrapVersion: '1.0.0', installedAt: '2026-09-11T00:00:00Z' }, null, 2)}\n`);
    writeInstallConfig(paths, { channel: 'stable', autoCheck: false });
    fs.writeFileSync(path.join(paths.trustDir, 'root.json'), files.get('root.json')!);

    // Production acquisition path: channel payload, then the release
    // metadata document (what apply()'s ensureReleaseMetadataDocument does).
    const trustedTarget = await resolveTrustedReleaseTarget({
      metadataDir: paths.trustDir,
      metadataBaseUrl: baseUrl,
      targetPath: 'channels/stable.json',
      expectedChannel: 'stable',
      expectedPlatform: 'metadata',
    });
    expect(trustedTarget.releaseId).toBe(publication.manifest.releaseId);
    // The channel target's own digest binds the served channel payload bytes.
    expect(trustedTarget.artifactSha256).toBe(
      createHash('sha256').update(files.get('targets/channels/stable.json')!).digest('hex'),
    );
    await downloadTrustedReleasePayload({
      metadataDir: paths.trustDir,
      metadataBaseUrl: baseUrl,
      targetPath: 'channels/stable.json',
      destinationPath: path.join(paths.channelsDir, 'stable.json'),
    });
    await downloadTrustedReleasePayload({
      metadataDir: paths.trustDir,
      metadataBaseUrl: baseUrl,
      targetPath: `releases/${publication.manifest.releaseId}/metadata.json`,
      destinationPath: path.join(paths.releasesDir, publication.manifest.releaseId, 'metadata.json'),
    });

    const manager = new ReleaseManager({
      pdHome: paths.home,
      metadataBaseUrl: baseUrl,
      openclawHome: path.join(os.tmpdir(), 'pd-publisher-test-no-openclaw-'),
    });
    const check = await manager.check('stable');
    expect(check.decision.allowed).toBe(true);
    expect(check.candidate?.releaseId).toBe(publication.manifest.releaseId);
    expect(check.candidate?.productVersion).toBe('1.223.0');
    expect(check.candidate?.publicationSequence).toBe(9);
    // check()'s trustedTarget is the verified channel pointer target.
    expect(check.trustedTarget?.targetPath).toBe('channels/stable.json');
    expect(check.trustedTarget?.releaseId).toBe(publication.manifest.releaseId);

    // Artifact acquisition through the real digest cross-check path.
    const downloaded = await downloadReleaseAsset({
      paths,
      metadataBaseUrl: baseUrl,
      releaseMetadata: publication.releaseMetadata,
      channel: 'stable',
      transactionId: 'txn-publisher-test',
    });
    const downloadedBytes = fs.readFileSync(downloaded.archivePath);
    expect(createHash('sha256').update(downloadedBytes).digest('hex')).toBe(publication.manifest.artifactSha256);
  });
});

describe('ephemeral dry-run keys', () => {
  it('generates a usable ed25519 signing key', () => {
    const pem = generateEphemeralSigningKeyPem();
    const publication = buildReleasePublication(publicationInput({ signingKeyPem: pem }));
    expect(publication.manifest.signingScheme).toBe('ed25519');
    // Distinct ephemeral keys produce distinct key ids.
    const other = buildReleasePublication(publicationInput({ signingKeyPem: generateEphemeralSigningKeyPem() }));
    expect(other.manifest.keyId).not.toBe(publication.manifest.keyId);
    // The key material parses back as a private key.
    expect(() => createPrivateKey(pem)).not.toThrow();
  });
});
