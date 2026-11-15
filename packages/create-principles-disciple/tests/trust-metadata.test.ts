import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
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
  /** Status served for the `<n>.root.json` rotation probe instead of 404. */
  rootProbeStatus?: number;
  /** Status served for `timestamp.json` instead of the signed document. */
  timestampStatus?: number;
  /**
   * How many `timestampStatus` responses to serve before the signed document.
   * Omitted = keep failing (a persistent carrier fault).
   */
  timestampFailuresBeforeSuccess?: number;
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
  privateKey: KeyObject,
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

  // Remaining injected failures for timestamp.json; Infinity = persistent.
  let timestampFailuresLeft = options.timestampStatus === undefined
    ? 0
    : options.timestampFailuresBeforeSuccess ?? Number.POSITIVE_INFINITY;

  const server = http.createServer((request, response) => {
    const requestPath = request.url?.replace(/^\//, '');
    if (options.rootProbeStatus !== undefined && requestPath !== undefined && /^\d+\.root\.json$/.test(requestPath)) {
      response.writeHead(options.rootProbeStatus).end();
      return;
    }
    if (options.timestampStatus !== undefined && requestPath === 'timestamp.json' && timestampFailuresLeft > 0) {
      timestampFailuresLeft -= 1;
      response.writeHead(options.timestampStatus).end();
      return;
    }
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
      const error = await resolveTrustedReleaseTarget({
        metadataDir: repository.metadataDir,
        metadataBaseUrl: repository.metadataBaseUrl,
        targetPath,
        expectedChannel: 'stable',
        expectedPlatform: 'win32-x64',
      }).catch((failure: unknown) => failure);
      expect(error).toMatchObject<Partial<ReleaseTrustError>>({ code: 'metadata_refresh_failed' });
      // A genuine trust failure keeps the trust wording (PRI-1219 must not
      // relabel signature problems as carrier faults, only the reverse).
      expect((error as ReleaseTrustError).message).toContain('could not be verified against the trusted root');
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

  // ── PRI-1219: carrier 5xx on the root-rotation probe / download diagnostics
  it('keeps the installed trusted root when the carrier answers the rotation probe with 503', async () => {
    // TUF client workflow 5.3.3 probes `<installed root version + 1>.root.json`
    // on EVERY refresh. A carrier that answers that non-existent object with a
    // 5xx (GitHub Pages served 503 "Unicorn") must not fail the whole refresh:
    // the probe is optional and carries no trust information.
    const repository = await createRepository({ rootProbeStatus: 503 });
    try {
      const resolved = await resolveTrustedReleaseTarget({
        metadataDir: repository.metadataDir,
        metadataBaseUrl: repository.metadataBaseUrl,
        targetPath,
        expectedChannel: 'stable',
        expectedPlatform: 'win32-x64',
      });
      expect(resolved).toMatchObject({ releaseId, artifactSha256: createHash('sha256').update(artifact).digest('hex') });
      // Suppressing the probe must NOT be silent: a carrier that never recovers
      // would otherwise freeze the trust anchor with no trace on the success
      // path, and root rotation would stop propagating unnoticed.
      expect(resolved.retainedTrustAnchor).toMatchObject({
        probeUrl: `${repository.metadataBaseUrl}/2.root.json`,
        statusCode: 503,
      });
      expect(resolved.retainedTrustAnchor?.message).toContain('trusted-root rotation probe');
      expect(resolved.retainedTrustAnchor?.nextAction).toContain('answers 403/404');
    } finally {
      await repository.close();
    }
  });

  it('reports the failing object, URL, and HTTP status instead of claiming a trust failure', async () => {
    const repository = await createRepository({ timestampStatus: 503 });
    try {
      const error = await resolveTrustedReleaseTarget({
        metadataDir: repository.metadataDir,
        metadataBaseUrl: repository.metadataBaseUrl,
        targetPath,
        expectedChannel: 'stable',
        expectedPlatform: 'win32-x64',
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ReleaseTrustError);
      const trustError = error as ReleaseTrustError;
      expect(trustError.code).toBe('metadata_refresh_failed');
      expect(trustError.message).toContain('HTTP 503');
      expect(trustError.message).toContain(`${repository.metadataBaseUrl}/timestamp.json`);
      expect(trustError.message).toContain('timestamp document');
      // The misleading diagnosis the feedback report was filed against.
      expect(trustError.message).not.toContain('could not be verified against the trusted root');
      expect(trustError.nextAction).toContain('re-pinning the trust root would not help');
    } finally {
      await repository.close();
    }
  });

  it('retries a transient 5xx on a required document before judging the chain', async () => {
    const repository = await createRepository({ timestampStatus: 503, timestampFailuresBeforeSuccess: 1 });
    try {
      await expect(resolveTrustedReleaseTarget({
        metadataDir: repository.metadataDir,
        metadataBaseUrl: repository.metadataBaseUrl,
        targetPath,
        expectedChannel: 'stable',
        expectedPlatform: 'win32-x64',
      })).resolves.toMatchObject({ releaseId });
    } finally {
      await repository.close();
    }
  });

  it('keeps the transport cause when the carrier never answered HTTP', async () => {
    const repository = await createRepository();
    // Bind then release a port, so the connection is refused immediately
    // instead of hanging on a filtered one.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    const deadPort = address !== null && typeof address !== 'string' ? address.port : 1;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    try {
      const error = await resolveTrustedReleaseTarget({
        metadataDir: repository.metadataDir,
        metadataBaseUrl: `http://127.0.0.1:${deadPort}`,
        targetPath,
        expectedChannel: 'stable',
        expectedPlatform: 'win32-x64',
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ReleaseTrustError);
      const message = (error as ReleaseTrustError).message;
      expect(message).toContain('no HTTP response');
      // Node reports "fetch failed" at the top and hides ECONNREFUSED in
      // `cause`; a diagnosis that stops at the top says less than nothing.
      expect(message).toContain('ECONNREFUSED');
    } finally {
      await repository.close();
    }
  });
});
