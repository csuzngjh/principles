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
  Role,
  Signature,
  Snapshot,
  TargetFile,
  Targets,
  Timestamp,
} from '@tufjs/models';
import {
  ReleaseTrustError,
  resolveTrustedReleaseTarget,
} from '../src/update/trust-metadata.js';

const releaseId = 'release-2026-08-25-a';
const targetPath = 'releases/stable/win32-x64/1.222.0/package.tgz';
const artifact = Buffer.from('signed release artifact');

interface TestRepositoryOptions {
  tamperTargets?: boolean;
  timestampExpires?: string;
}

interface TestRepository {
  metadataDir: string;
  close(): Promise<void>;
  metadataBaseUrl: string;
}

const temporaryDirectories: string[] = [];

function signedBytes<T extends Root | Snapshot | Targets | Timestamp>(
  signed: T,
  keyId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): Buffer {
  const metadata = new Metadata(signed);
  metadata.sign(
    (data) => new Signature({
      keyID: keyId,
      sig: sign(null, data, privateKey).toString('hex'),
    }),
    false,
  );
  return Buffer.from(JSON.stringify(metadata.toJSON()));
}

async function createRepository(options: TestRepositoryOptions = {}): Promise<TestRepository> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = 'release-test-key';
  const key = new Key({
    keyID: keyId,
    keyType: 'ed25519',
    scheme: 'ed25519',
    keyVal: {
      public: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    },
  });
  const expires = '2030-01-01T00:00:00Z';
  const root = new Root({ version: 1, specVersion: '1.0.31', expires, consistentSnapshot: false });
  for (const role of ['root', 'timestamp', 'snapshot', 'targets']) {
    root.addKey(key, role);
  }

  const targetBytes = signedBytes(
    new Targets({
      version: 1,
      specVersion: '1.0.31',
      expires,
      targets: {
        [targetPath]: new TargetFile({
          path: targetPath,
          length: artifact.length,
          hashes: { sha256: createHash('sha256').update(artifact).digest('hex') },
          unrecognizedFields: {
            custom: {
              releaseId,
              channel: 'stable',
              platform: 'win32-x64',
            },
          },
        }),
      },
    }),
    keyId,
    privateKey,
  );
  const metadata = new Map<string, Buffer>([
    ['timestamp.json', signedBytes(
      new Timestamp({
        version: 1,
        specVersion: '1.0.31',
        expires: options.timestampExpires ?? expires,
        snapshotMeta: new MetaFile({ version: 1 }),
      }),
      keyId,
      privateKey,
    )],
    ['snapshot.json', signedBytes(
      new Snapshot({
        version: 1,
        specVersion: '1.0.31',
        expires,
        meta: { 'targets.json': new MetaFile({ version: 1 }) },
      }),
      keyId,
      privateKey,
    )],
    ['targets.json', options.tamperTargets
      ? Buffer.from(targetBytes.toString().replace(releaseId, 'release-2026-08-25-b'))
      : targetBytes],
  ]);
  const metadataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trust-metadata-'));
  temporaryDirectories.push(metadataDir);
  fs.writeFileSync(path.join(metadataDir, 'root.json'), signedBytes(root, keyId, privateKey));

  const server = http.createServer((request, response) => {
    const requestPath = request.url?.replace(/^\//, '');
    const data = requestPath ? metadata.get(requestPath) : undefined;
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    throw new Error('Test repository did not bind a TCP port');
  }

  return {
    metadataDir,
    metadataBaseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('resolveTrustedReleaseTarget', () => {
  it('returns a release identity only after TUF verifies the root-to-target metadata chain', async () => {
    const repository = await createRepository();
    try {
      await expect(resolveTrustedReleaseTarget({
        metadataDir: repository.metadataDir,
        metadataBaseUrl: repository.metadataBaseUrl,
        targetPath,
        expectedChannel: 'stable',
        expectedPlatform: 'win32-x64',
      })).resolves.toEqual({
        artifactSha256: createHash('sha256').update(artifact).digest('hex'),
        artifactSize: artifact.length,
        channel: 'stable',
        platform: 'win32-x64',
        releaseId,
        targetPath,
      });
    } finally {
      await repository.close();
    }
  });

  it('refuses a targets document whose signed content was altered', async () => {
    const repository = await createRepository({ tamperTargets: true });
    try {
      await expect(resolveTrustedReleaseTarget({
        metadataDir: repository.metadataDir,
        metadataBaseUrl: repository.metadataBaseUrl,
        targetPath,
        expectedChannel: 'stable',
        expectedPlatform: 'win32-x64',
      })).rejects.toMatchObject<Partial<ReleaseTrustError>>({ code: 'metadata_refresh_failed' });
    } finally {
      await repository.close();
    }
  });

  it('refuses metadata that is signed but expired', async () => {
    const repository = await createRepository({ timestampExpires: '2020-01-01T00:00:00Z' });
    try {
      await expect(resolveTrustedReleaseTarget({
        metadataDir: repository.metadataDir,
        metadataBaseUrl: repository.metadataBaseUrl,
        targetPath,
        expectedChannel: 'stable',
        expectedPlatform: 'win32-x64',
      })).rejects.toMatchObject<Partial<ReleaseTrustError>>({ code: 'metadata_refresh_failed' });
    } finally {
      await repository.close();
    }
  });

  it('refuses a verified artifact when its signed channel is not the requested channel', async () => {
    const repository = await createRepository();
    try {
      await expect(resolveTrustedReleaseTarget({
        metadataDir: repository.metadataDir,
        metadataBaseUrl: repository.metadataBaseUrl,
        targetPath,
        expectedChannel: 'beta',
        expectedPlatform: 'win32-x64',
      })).rejects.toMatchObject<Partial<ReleaseTrustError>>({ code: 'target_identity_mismatch' });
    } finally {
      await repository.close();
    }
  });
});
