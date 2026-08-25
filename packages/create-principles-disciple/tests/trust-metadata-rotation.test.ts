import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
import { resolveTrustedReleaseTarget } from '../src/update/trust-metadata.js';

// Root-rotation, rollback, wrong-root, and replay-stability regressions for
// the trusted metadata chain (SPEC §4.3). Each scenario drives a REAL tuf-js
// Updater against a local repository that swaps its served metadata between
// refreshes, with the on-disk trusted cache persisting across the swap.

const targetPath = 'releases/stable/win32-x64/1.222.0/package.tgz';
const artifact = Buffer.from('rotated release artifact');
const expiresFar = '2030-01-01T00:00:00Z';

interface KeyMaterial {
  keyId: string;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  key: Key;
}

function makeKeyMaterial(): KeyMaterial {
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

function signedMetadata<T extends Root | Snapshot | Targets | Timestamp>(
  signed: T,
  signers: KeyMaterial[],
): Buffer {
  const metadata = new Metadata(signed);
  // Metadata.sign(signer, append=false) RESETS the signature set — only the
  // first signer may reset; every later signer must append (append=true) or
  // it silently wipes earlier signatures (breaking root-rotation continuity,
  // where the new root must carry BOTH keys' signatures).
  signers.forEach((signer, index) => {
    metadata.sign(
      (data) => new Signature({ keyID: signer.keyId, sig: sign(null, data, signer.privateKey).toString('hex') }),
      index > 0,
    );
  });
  return Buffer.from(JSON.stringify(metadata.toJSON()));
}

interface RepositoryVersionSet {
  rootVersion: number;
  timestampVersion: number;
  snapshotVersion: number;
  targetsVersion: number;
}

function buildMetadataSet(
  primary: KeyMaterial,
  options: {
    versions: RepositoryVersionSet;
    signers?: Partial<Record<'root' | 'timestamp' | 'snapshot' | 'targets', KeyMaterial[]>>;
    rootKeys?: KeyMaterial[];
    expires?: string;
  },
): Map<string, Buffer> {
  const versions = options.versions;
  const expiry = options.expires ?? expiresFar;
  const root = new Root({ version: versions.rootVersion, specVersion: '1.0.31', expires: expiry, consistentSnapshot: false });
  const rootRoleKeys = (options.rootKeys ?? [primary]).length > 0 ? options.rootKeys ?? [primary] : [primary];
  for (const key of rootRoleKeys) {
    for (const role of ['root', 'timestamp', 'snapshot', 'targets']) {
      root.addKey(key.key, role);
    }
  }
  const targets = new Targets({
    version: versions.targetsVersion,
    specVersion: '1.0.31',
    expires: expiry,
    targets: {
      [targetPath]: new TargetFile({
        path: targetPath,
        length: artifact.length,
        hashes: { sha256: createHash('sha256').update(artifact).digest('hex') },
        unrecognizedFields: {
          custom: {
            releaseId: `release-v${versions.targetsVersion}`,
            channel: 'stable',
            platform: 'win32-x64',
          },
        },
      }),
    },
  });
  return new Map<string, Buffer>([
    ['root.json', signedMetadata(root, options.signers?.root ?? [primary])],
    ['timestamp.json', signedMetadata(
      new Timestamp({
        version: versions.timestampVersion,
        specVersion: '1.0.31',
        expires: expiry,
        snapshotMeta: new MetaFile({ version: versions.snapshotVersion }),
      }),
      options.signers?.timestamp ?? [primary],
    )],
    ['snapshot.json', signedMetadata(
      new Snapshot({
        version: versions.snapshotVersion,
        specVersion: '1.0.31',
        expires: expiry,
        meta: { 'targets.json': new MetaFile({ version: versions.targetsVersion }) },
      }),
      options.signers?.snapshot ?? [primary],
    )],
    ['targets.json', signedMetadata(targets, options.signers?.targets ?? [primary])],
  ]);
}

class MutableRepository {
  readonly metadataDir: string;
  readonly metadataBaseUrl: string;
  private readonly server: http.Server;
  // The HTTP handler closes over this holder — swap() must be visible to it.
  private readonly state: { served: Map<string, Buffer> };

  private constructor(metadataDir: string, server: http.Server, state: { served: Map<string, Buffer> }, baseUrl: string) {
    this.metadataDir = metadataDir;
    this.server = server;
    this.state = state;
    this.metadataBaseUrl = baseUrl;
  }

  static async create(served: Map<string, Buffer>): Promise<MutableRepository> {
    const metadataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trust-rotation-'));
    temporaryDirectories.push(metadataDir);
    fs.writeFileSync(path.join(metadataDir, 'root.json'), served.get('root.json') as Buffer);
    const state = { served };
    const server = http.createServer((request, response) => {
      const requestPath = request.url?.replace(/^\//, '');
      const data = requestPath ? state.served.get(requestPath) : undefined;
      if (!data) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(data);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      throw new Error('Rotation test repository did not bind a TCP port');
    }
    return new MutableRepository(metadataDir, server, state, `http://127.0.0.1:${address.port}`);
  }

  swap(next: Map<string, Buffer>): void {
    this.state.served = next;
  }

  close(): Promise<void> {
    return new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }
}

const temporaryDirectories: string[] = [];
const openRepositories: MutableRepository[] = [];

afterEach(async () => {
  while (openRepositories.length > 0) {
    const repository = openRepositories.pop();
    if (repository) await repository.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

const baseVersions: RepositoryVersionSet = { rootVersion: 1, timestampVersion: 1, snapshotVersion: 1, targetsVersion: 1 };

describe('trusted metadata rotation and rollback protection', () => {
  it('follows a legitimate root rotation to a new signing key', async () => {
    const oldKey = makeKeyMaterial();
    const newKey = makeKeyMaterial();
    const v1 = buildMetadataSet(oldKey, { versions: baseVersions });
    const repository = await MutableRepository.create(v1);
    openRepositories.push(repository);

    const first = await resolveTrustedReleaseTarget({
      metadataDir: repository.metadataDir,
      metadataBaseUrl: repository.metadataBaseUrl,
      targetPath,
      expectedChannel: 'stable',
      expectedPlatform: 'win32-x64',
    });
    expect(first.releaseId).toBe('release-v1');

    // Root v2 keeps role continuity (signed by the OLD root key) while all
    // roles now resolve to the NEW key; downstream metadata is signed by it.
    // tuf-js follows rotation via the versioned root path (2.root.json), so
    // the rotated root is published under BOTH names.
    const v2 = buildMetadataSet(newKey, {
      versions: { rootVersion: 2, timestampVersion: 2, snapshotVersion: 2, targetsVersion: 2 },
      rootKeys: [newKey],
      signers: { root: [oldKey, newKey] },
    });
    v2.set('2.root.json', v2.get('root.json') as Buffer);
    repository.swap(v2);

    const second = await resolveTrustedReleaseTarget({
      metadataDir: repository.metadataDir,
      metadataBaseUrl: repository.metadataBaseUrl,
      targetPath,
      expectedChannel: 'stable',
      expectedPlatform: 'win32-x64',
    });
    expect(second.releaseId).toBe('release-v2');
  });

  it('refuses a rolled-back metadata chain after a newer one is trusted (cached old sequence)', async () => {
    const key = makeKeyMaterial();
    const v2 = buildMetadataSet(key, { versions: { rootVersion: 1, timestampVersion: 2, snapshotVersion: 2, targetsVersion: 2 } });
    const repository = await MutableRepository.create(v2);
    openRepositories.push(repository);

    const current = await resolveTrustedReleaseTarget({
      metadataDir: repository.metadataDir,
      metadataBaseUrl: repository.metadataBaseUrl,
      targetPath,
      expectedChannel: 'stable',
      expectedPlatform: 'win32-x64',
    });
    expect(current.releaseId).toBe('release-v2');

    repository.swap(buildMetadataSet(key, { versions: baseVersions }));

    await expect(resolveTrustedReleaseTarget({
      metadataDir: repository.metadataDir,
      metadataBaseUrl: repository.metadataBaseUrl,
      targetPath,
      expectedChannel: 'stable',
      expectedPlatform: 'win32-x64',
    })).rejects.toThrow(/could not be verified|rollback/i);
  });

  it('refuses metadata signed by an unrelated root (wrong trust root)', async () => {
    const trustedKey = makeKeyMaterial();
    const attackerKey = makeKeyMaterial();
    const attackerSet = buildMetadataSet(attackerKey, { versions: baseVersions });
    const repository = await MutableRepository.create(buildMetadataSet(trustedKey, { versions: baseVersions }));
    openRepositories.push(repository);
    repository.swap(attackerSet);

    await expect(resolveTrustedReleaseTarget({
      metadataDir: repository.metadataDir,
      metadataBaseUrl: repository.metadataBaseUrl,
      targetPath,
      expectedChannel: 'stable',
      expectedPlatform: 'win32-x64',
    })).rejects.toThrow(/could not be verified/i);
  });

  it('keeps a stable identity when the repository replays the same unexpired versions (no freeze drift)', async () => {
    const key = makeKeyMaterial();
    const repository = await MutableRepository.create(buildMetadataSet(key, { versions: baseVersions }));
    openRepositories.push(repository);

    const first = await resolveTrustedReleaseTarget({
      metadataDir: repository.metadataDir,
      metadataBaseUrl: repository.metadataBaseUrl,
      targetPath,
      expectedChannel: 'stable',
      expectedPlatform: 'win32-x64',
    });
    const second = await resolveTrustedReleaseTarget({
      metadataDir: repository.metadataDir,
      metadataBaseUrl: repository.metadataBaseUrl,
      targetPath,
      expectedChannel: 'stable',
      expectedPlatform: 'win32-x64',
    });
    expect(second.releaseId).toBe(first.releaseId);
    expect(second.artifactSha256).toBe(first.artifactSha256);
  });
});
