/**
 * Shared shadow-mode fixture: a local signed TUF repository plus a `~/.pd`
 * dual-slot home. Extracted from release-manager.test.ts so the
 * release-manager-authority tests exercise the exact same verified-metadata
 * chain (single fixture truth for the ReleaseManager surface).
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Key,
  MetaFile,
  Metadata,
  Root,
  Signature,
  Snapshot,
  TargetFile,
  Targets,
  Timestamp,
} from '@tufjs/models';
import { ensurePdHomeLayout, resolvePdHomePaths, writeInstallConfig } from '../../src/update/install-layout.js';
import { writeActiveRecord } from '../../src/update/transaction-journal.js';
import { buildReleaseMetadata } from '../../src/update/release-metadata.js';
import type { ChannelMetadata } from '../../src/update/channel-metadata.js';

export const expiresFar = '2030-01-01T00:00:00Z';

type KeyObject = ReturnType<typeof generateKeyPairSync>['privateKey'];

function makeKeyMaterial(): { keyId: string; privateKey: KeyObject; key: Key } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = `key-${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'pem' })).digest('hex').slice(0, 12)}`;
  return {
    keyId,
    privateKey,
    key: new Key({
      keyID: keyId,
      keyType: 'ed25519',
      scheme: 'ed25519',
      keyVal: { public: publicKey.export({ format: 'pem', type: 'spki' }).toString() },
    }),
  };
}

function signedMetadata<T extends Root | Snapshot | Targets | Timestamp>(signed: T, signer: { keyId: string; privateKey: KeyObject }): Buffer {
  const metadata = new Metadata(signed);
  metadata.sign(
    (data) => new Signature({ keyID: signer.keyId, sig: cryptoSign(null, data, signer.privateKey).toString('hex') }),
    false,
  );
  return Buffer.from(JSON.stringify(metadata.toJSON()));
}

export interface Repository {
  baseUrl: string;
  close(): Promise<void>;
}

const temporaryDirectories: string[] = [];
const openServers: Repository[] = [];

/** Register a temp dir for disposal by `disposeShadowFixtures()` (vitest afterEach). */
export function trackTempDir(directory: string): string {
  temporaryDirectories.push(directory);
  return directory;
}

async function serve(map: Map<string, Buffer>): Promise<Repository> {
  const server = http.createServer((request, response) => {
    const requestPath = request.url?.replace(/^\//, '') ?? '';
    const data = map.get(requestPath);
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200).end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    throw new Error('test repository did not bind a port');
  }
  const repository: Repository = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
  openServers.push(repository);
  return repository;
}

export interface Fixture {
  pdHome: string;
  repository: Repository;
  channelPayload: ChannelMetadata;
  releaseId: string;
}

export async function createShadowFixture(overrides: {
  productVersion?: string;
  publicationSequence?: number;
  channelVersion?: number;
} = {}): Promise<Fixture> {
  const signer = makeKeyMaterial();
  const pdHome = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-home-')));
  const paths = resolvePdHomePaths(path.join(pdHome, '.pd'));
  ensurePdHomeLayout(paths);

  fs.writeFileSync(paths.bootstrapManifestPath, `${JSON.stringify({ bootstrapVersion: '1.0.0', installedAt: '2026-08-25T00:00:00Z' }, null, 2)}\n`);
  writeInstallConfig(paths, { channel: 'stable', autoCheck: false });

  const releaseMetadata = buildReleaseMetadata({
    productVersion: overrides.productVersion ?? '1.223.0',
    sourceCommit: '1234567890abcdef1234567890abcdef12345678',
    minBootstrapVersion: '1.0.0',
    publicationSequence: overrides.publicationSequence ?? 9,
    expiresAt: expiresFar,
    assets: [{
      platform: 'win32', arch: 'x64', nodeAbi: '147',
      archiveSha256: 'a'.repeat(64), archiveSizeBytes: 1024,
    }],
    dataSchemaForwardReadableFrom: '1.220.0',
  });
  fs.mkdirSync(path.join(paths.releasesDir, releaseMetadata.releaseId), { recursive: true });
  fs.writeFileSync(path.join(paths.releasesDir, releaseMetadata.releaseId, 'metadata.json'), `${JSON.stringify(releaseMetadata, null, 2)}\n`);

  // The currently active release (one sequence earlier) so the shadow
  // comparison has a current productVersion to compare against.
  const activeRelease = buildReleaseMetadata({
    productVersion: '1.222.0',
    sourceCommit: '1234567890abcdef1234567890abcdef12345678',
    minBootstrapVersion: '1.0.0',
    publicationSequence: 8,
    expiresAt: expiresFar,
    assets: [{
      platform: 'win32', arch: 'x64', nodeAbi: '147',
      archiveSha256: 'b'.repeat(64), archiveSizeBytes: 1024,
    }],
    dataSchemaForwardReadableFrom: '1.220.0',
  });
  fs.mkdirSync(path.join(paths.releasesDir, activeRelease.releaseId), { recursive: true });
  fs.writeFileSync(path.join(paths.releasesDir, activeRelease.releaseId, 'metadata.json'), `${JSON.stringify(activeRelease, null, 2)}\n`);
  writeActiveRecord(paths.activeRecordPath, {
    generation: 2,
    releaseId: activeRelease.releaseId,
    releaseMetadataDigest: activeRelease.metadataDigest,
    previousReleaseId: null,
    transactionId: 'txn-fixture-active',
    productVersion: activeRelease.productVersion,
  });

  const channelPayload: ChannelMetadata = {
    schemaVersion: 1,
    channel: 'stable',
    version: overrides.channelVersion ?? 4,
    expiresAt: expiresFar,
    releaseMetadataDigest: releaseMetadata.metadataDigest,
    releaseId: releaseMetadata.releaseId,
    productVersion: releaseMetadata.productVersion,
    publicationSequence: releaseMetadata.publicationSequence,
  };
  const channelPayloadBytes = Buffer.from(`${JSON.stringify(channelPayload, null, 2)}\n`);

  const channelTargetPath = 'channels/stable.json';
  const targets = new Targets({
    version: 1,
    specVersion: '1.0.31',
    expires: expiresFar,
    targets: {
      [channelTargetPath]: new TargetFile({
        path: channelTargetPath,
        length: channelPayloadBytes.length,
        hashes: { sha256: createHash('sha256').update(channelPayloadBytes).digest('hex') },
        unrecognizedFields: {
          custom: { releaseId: releaseMetadata.releaseId, channel: 'stable', platform: 'metadata' },
        },
      }),
    },
  });
  const root = new Root({ version: 1, specVersion: '1.0.31', expires: expiresFar, consistentSnapshot: false });
  for (const role of ['root', 'timestamp', 'snapshot', 'targets']) root.addKey(signer.key, role);
  const served = new Map<string, Buffer>([
    ['root.json', signedMetadata(root, signer)],
    ['timestamp.json', signedMetadata(new Timestamp({
      version: 1, specVersion: '1.0.31', expires: expiresFar,
      snapshotMeta: new MetaFile({ version: 1 }),
    }), signer)],
    ['snapshot.json', signedMetadata(new Snapshot({
      version: 1, specVersion: '1.0.31', expires: expiresFar,
      meta: { 'targets.json': new MetaFile({ version: 1 }) },
    }), signer)],
    ['targets.json', signedMetadata(targets, signer)],
    [`targets/${channelTargetPath}`, channelPayloadBytes],
  ]);
  fs.writeFileSync(path.join(paths.trustDir, 'root.json'), served.get('root.json') as Buffer);

  const repository = await serve(served);
  return { pdHome: paths.home, repository, channelPayload, releaseId: releaseMetadata.releaseId };
}

/** Dispose every fixture artifact registered by this helper. Idempotent. */
export async function disposeShadowFixtures(): Promise<void> {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) await server.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
