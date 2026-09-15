/**
 * PRI-732 — install-side trust root provisioning.
 *
 * Coverage:
 * 1. validateTrustRoot: strict contract (TUF Root envelope, four roles with
 *    thresholds, ed25519 key material, unexpired, validly self-signed) and
 *    the full refusal taxonomy.
 * 2. provisionBootstrapTrustRoot: fresh install pins the anchor atomically;
 *    identical re-install is a no-op; a DIFFERENT existing anchor is kept
 *    (never silently rotated); payloads without the asset stay unconfigured;
 *    invalid candidates fail loud.
 * 3. End-to-end: an anchor provisioned by THIS module lets the real
 *    ReleaseManager verify a real signed publication (tuf-js chain), while an
 *    anchor from a different key refuses with metadata_refresh_failed.
 * 4. The committed production anchor (trust/root.json) satisfies the same
 *    contract.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Key, Metadata, Root, Signature } from '@tufjs/models';
import {
  TRUST_ROOT_FILENAME,
  TrustRootValidationError,
  provisionBootstrapTrustRoot,
  validateTrustRoot,
} from '../src/update/trust-root-provisioning.js';
import { buildReleasePublication, verifySigningKeyMatchesPinnedRoot } from '../src/update/release-metadata-publisher.js';
import { ReleaseManager } from '../src/update/release-manager.js';
import { ensurePdHomeLayout, resolvePdHomePaths, writeInstallConfig } from '../src/update/install-layout.js';
import { writeActiveRecord } from '../src/update/transaction-journal.js';

const FAR_EXPIRY = '2036-01-01T00:00:00Z';
const PUBLICATION_EXPIRY = '2030-01-01T00:00:00Z';

const tempDirs: string[] = [];
const openServers: http.Server[] = [];

function trackDir(directory: string): string {
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    server?.close();
  }
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

interface TestTrustMaterial {
  keyId: string;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  privateKeyPem: string;
  key: Key;
}

function makeTrustMaterial(): TestTrustMaterial {
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const keyId = createHash('sha256').update(publicKeyPem).digest('hex');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    keyId,
    privateKey,
    privateKeyPem,
    key: new Key({ keyID: keyId, keyType: 'ed25519', scheme: 'ed25519', keyVal: { public: publicKeyPem } }),
  };
}

/** Build a self-signed TUF Root with the same shape the publisher/keygen emit. */
function buildSignedRoot(material: TestTrustMaterial, expires: string): Buffer {
  const root = new Root({ version: 1, specVersion: '1.0.31', expires, consistentSnapshot: false });
  for (const role of ['root', 'timestamp', 'snapshot', 'targets']) root.addKey(material.key, role);
  const metadata = new Metadata(root);
  metadata.sign(
    (data) => new Signature({ keyID: material.keyId, sig: cryptoSign(null, data, material.privateKey).toString('hex') }),
    false,
  );
  return Buffer.from(JSON.stringify(metadata.toJSON()), 'utf8');
}

/** Unsigned envelope (for refusal cases where an earlier check must fire first). */
function buildUnsignedRootJson(material: TestTrustMaterial, expires: string): string {
  const root = new Root({ version: 1, specVersion: '1.0.31', expires, consistentSnapshot: false });
  for (const role of ['root', 'timestamp', 'snapshot', 'targets']) root.addKey(material.key, role);
  return JSON.stringify({ signed: root.toJSON(), signatures: [] });
}

/** Parse a crafted envelope, mutate it, and re-serialize (test-fixture helper). */
function mutatingCopy(source: string, mutate: (envelope: any) => void): string {
  const envelope = JSON.parse(source);
  mutate(envelope);
  return JSON.stringify(envelope);
}

function makePdHome(): { home: string; paths: ReturnType<typeof resolvePdHomePaths> } {
  const home = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pri732-trust-')));
  const paths = resolvePdHomePaths(path.join(home, '.pd'));
  ensurePdHomeLayout(paths);
  fs.writeFileSync(paths.bootstrapManifestPath, `${JSON.stringify({ bootstrapVersion: '1.0.0', installedAt: '2026-09-15T00:00:00Z' }, null, 2)}\n`);
  writeInstallConfig(paths, { channel: 'stable', autoCheck: false });
  writeActiveRecord(paths.activeRecordPath, {
    generation: 1,
    releaseId: 'a'.repeat(64),
    releaseMetadataDigest: 'b'.repeat(64),
    previousReleaseId: null,
    transactionId: 'txn-pri732-fixture',
    productVersion: '1.0.0',
  });
  return { home, paths };
}

/** Serve a publication file set over a local HTTP server (same shape as the metadata repository). */
async function servePublication(files: readonly { path: string; bytes: Buffer }[]): Promise<string> {
  const map = new Map<string, Buffer>(files.map((file) => [file.path, file.bytes]));
  const server = http.createServer((request, response) => {
    const data = map.get(request.url?.replace(/^\//, '') ?? '');
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200).end(data);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a port');
  return `http://127.0.0.1:${address.port}`;
}

describe('validateTrustRoot (PRI-732)', () => {
  it('accepts a valid self-signed root and reports its identity', () => {
    const material = makeTrustMaterial();
    const validated = validateTrustRoot(buildSignedRoot(material, FAR_EXPIRY));
    expect(validated.keyIds).toContain(material.keyId);
    expect(validated.version).toBe(1);
    expect(validated.expires).toBe(FAR_EXPIRY);
  });

  it('rejects bytes that are not JSON', () => {
    expect(() => validateTrustRoot(Buffer.from('not json{'))).toThrowError(TrustRootValidationError);
  });

  it('rejects JSON that is not an object', () => {
    expect(() => validateTrustRoot(Buffer.from('[1,2,3]'))).toThrowError(TrustRootValidationError);
  });

  it('rejects an envelope whose signed type is not root', () => {
    const envelope = JSON.stringify({
      signed: { _type: 'timestamp', version: 1, specVersion: '1.0.31', expires: FAR_EXPIRY, snapshotMeta: { version: 1 } },
      signatures: [],
    });
    expect(() => validateTrustRoot(envelope)).toThrowError(/envelope/i);
  });

  it('rejects a root missing a role', () => {
    const material = makeTrustMaterial();
    const crafted = mutatingCopy(buildUnsignedRootJson(material, FAR_EXPIRY), (envelope) => {
      delete envelope.signed.roles.snapshot;
    });
    // The TUF models parser itself refuses a root without a top-level role
    // (envelope reason); the validator's own role check is the second layer.
    expect(() => validateTrustRoot(crafted)).toThrowError(/missing|envelope/i);
  });

  it('rejects a role with threshold zero', () => {
    const material = makeTrustMaterial();
    const crafted = mutatingCopy(buildUnsignedRootJson(material, FAR_EXPIRY), (envelope) => {
      envelope.signed.roles.root.threshold = 0;
    });
    expect(() => validateTrustRoot(crafted)).toThrowError(/threshold/i);
  });

  it('rejects a key reference without carried material', () => {
    const material = makeTrustMaterial();
    const crafted = mutatingCopy(buildUnsignedRootJson(material, FAR_EXPIRY), (envelope) => {
      delete envelope.signed.keys[material.keyId];
    });
    expect(() => validateTrustRoot(crafted)).toThrowError(/does not carry its material/i);
  });

  it('rejects non-ed25519 key material', () => {
    const material = makeTrustMaterial();
    const crafted = mutatingCopy(buildUnsignedRootJson(material, FAR_EXPIRY), (envelope) => {
      envelope.signed.keys[material.keyId].keytype = 'rsa';
      envelope.signed.keys[material.keyId].scheme = 'rsassa-pss-sha256';
    });
    expect(() => validateTrustRoot(crafted)).toThrowError(/ed25519/i);
  });

  it('rejects unparseable public key material', () => {
    const material = makeTrustMaterial();
    const crafted = mutatingCopy(buildUnsignedRootJson(material, FAR_EXPIRY), (envelope) => {
      envelope.signed.keys[material.keyId].keyval.public = 'not a pem';
    });
    expect(() => validateTrustRoot(crafted)).toThrowError(/PEM/i);
  });

  it('rejects an expired root', () => {
    const material = makeTrustMaterial();
    expect(() => validateTrustRoot(buildUnsignedRootJson(material, '2020-01-01T00:00:00Z'))).toThrowError(/expired/i);
  });

  it('rejects a tampered self-signature', () => {
    const material = makeTrustMaterial();
    const crafted = mutatingCopy(buildSignedRoot(material, FAR_EXPIRY).toString('utf8'), (envelope) => {
      const sig = envelope.signatures[0].sig as string;
      envelope.signatures[0].sig = `${sig.slice(0, -4)}${sig.endsWith('0000') ? '1111' : '0000'}`;
    });
    expect(() => validateTrustRoot(crafted)).toThrowError(/self-signed/i);
  });

  it('accepts the committed production anchor shipped with the package', () => {
    const committed = fs.readFileSync(path.resolve(__dirname, '..', 'trust', TRUST_ROOT_FILENAME));
    const validated = validateTrustRoot(committed);
    expect(validated.keyIds).toHaveLength(1);
    expect(validated.version).toBe(1);
    expect(Date.parse(validated.expires)).toBeGreaterThan(Date.now());
  });
});

describe('provisionBootstrapTrustRoot (PRI-732)', () => {
  function payloadWith(rootBytes: Buffer | null): string {
    const payloadRoot = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pri732-payload-')));
    if (rootBytes !== null) {
      fs.mkdirSync(path.join(payloadRoot, 'trust'), { recursive: true });
      fs.writeFileSync(path.join(payloadRoot, 'trust', TRUST_ROOT_FILENAME), rootBytes);
    }
    return payloadRoot;
  }

  it('pins the anchor into a fresh install, byte-identical to the payload asset', () => {
    const material = makeTrustMaterial();
    const rootBytes = buildSignedRoot(material, FAR_EXPIRY);
    const { paths } = makePdHome();
    const outcome = provisionBootstrapTrustRoot({ pdHome: paths.home, payloadRoot: payloadWith(rootBytes) });
    expect(outcome.outcome).toBe('provisioned');
    expect(fs.readFileSync(path.join(paths.trustDir, TRUST_ROOT_FILENAME))).toEqual(rootBytes);
  });

  it('is idempotent for an identical anchor', () => {
    const material = makeTrustMaterial();
    const rootBytes = buildSignedRoot(material, FAR_EXPIRY);
    const { paths } = makePdHome();
    const payloadRoot = payloadWith(rootBytes);
    provisionBootstrapTrustRoot({ pdHome: paths.home, payloadRoot });
    const second = provisionBootstrapTrustRoot({ pdHome: paths.home, payloadRoot });
    expect(second.outcome).toBe('already-pinned');
  });

  it('keeps an existing different anchor instead of silently rotating', () => {
    const installedMaterial = makeTrustMaterial();
    const payloadMaterial = makeTrustMaterial();
    const { paths } = makePdHome();
    const installedRoot = buildSignedRoot(installedMaterial, FAR_EXPIRY);
    fs.mkdirSync(paths.trustDir, { recursive: true });
    fs.writeFileSync(path.join(paths.trustDir, TRUST_ROOT_FILENAME), installedRoot);

    const outcome = provisionBootstrapTrustRoot({ pdHome: paths.home, payloadRoot: payloadWith(buildSignedRoot(payloadMaterial, FAR_EXPIRY)) });
    expect(outcome.outcome).toBe('retained-existing');
    expect(fs.readFileSync(path.join(paths.trustDir, TRUST_ROOT_FILENAME))).toEqual(installedRoot);
  });

  it('stays unconfigured for a payload without the trust asset (pre-PRI-732 assets)', () => {
    const { paths } = makePdHome();
    const outcome = provisionBootstrapTrustRoot({ pdHome: paths.home, payloadRoot: payloadWith(null) });
    expect(outcome.outcome).toBe('skipped-no-source');
    expect(fs.existsSync(path.join(paths.trustDir, TRUST_ROOT_FILENAME))).toBe(false);
  });

  it('fails loud on an invalid payload anchor', () => {
    const { paths } = makePdHome();
    expect(() => provisionBootstrapTrustRoot({ pdHome: paths.home, payloadRoot: payloadWith(Buffer.from('garbage')) }))
      .toThrowError(TrustRootValidationError);
    expect(fs.existsSync(path.join(paths.trustDir, TRUST_ROOT_FILENAME))).toBe(false);
  });
});

describe('provisioned anchor × real ReleaseManager verification (PRI-732 end-to-end)', () => {
  /** pdHome + payload-pinned anchor + pre-seeded candidate release metadata (shadow check semantics). */
  async function provisionedInstallation(material: TestTrustMaterial, publication: { releaseMetadata: { releaseId: string } }): Promise<{ paths: ReturnType<typeof resolvePdHomePaths>; payloadRoot: string }> {
    const { paths } = makePdHome();
    const pinnedRoot = buildSignedRoot(material, FAR_EXPIRY);
    const payloadRoot = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pri732-payload-')));
    fs.mkdirSync(path.join(payloadRoot, 'trust'), { recursive: true });
    fs.writeFileSync(path.join(payloadRoot, 'trust', TRUST_ROOT_FILENAME), pinnedRoot);
    const outcome = provisionBootstrapTrustRoot({ pdHome: paths.home, payloadRoot });
    expect(outcome.outcome).toBe('provisioned');
    // check() evaluates already-cached release metadata (shadow-mode
    // contract) — pre-seed the candidate document like the shadow fixture.
    fs.mkdirSync(path.join(paths.releasesDir, publication.releaseMetadata.releaseId), { recursive: true });
    return { paths, payloadRoot };
  }

  it('a payload-pinned anchor (different bytes, same key) verifies a real signed publication', async () => {
    const material = makeTrustMaterial();
    const publication = buildReleasePublication({
      productVersion: '9.9.9',
      sourceCommit: '1'.repeat(40),
      channel: 'stable',
      channelVersion: 1,
      publicationSequence: 1,
      expiresAt: PUBLICATION_EXPIRY,
      minBootstrapVersion: '1.0.0',
      dataSchemaForwardReadableFrom: '1.0.0',
      archive: { platform: process.platform, arch: process.arch, nodeAbi: '127', bytes: Buffer.from('pri732-fake-archive') },
      signingKeyPem: material.privateKeyPem,
      previous: null,
    });
    const { paths } = await provisionedInstallation(material, publication);
    fs.mkdirSync(path.join(paths.releasesDir, publication.releaseMetadata.releaseId), { recursive: true });
    fs.writeFileSync(
      path.join(paths.releasesDir, publication.releaseMetadata.releaseId, 'metadata.json'),
      `${JSON.stringify(publication.releaseMetadata, null, 2)}\n`,
    );
    const baseUrl = await servePublication(publication.files);
    const manager = new ReleaseManager({ pdHome: paths.home, metadataBaseUrl: baseUrl });
    const check = await manager.check('stable');
    expect(check.candidate.productVersion).toBe('9.9.9');
  });

  it('refuses metadata signed by a different key than the pinned anchor', async () => {
    const pinnedMaterial = makeTrustMaterial();
    const publisherMaterial = makeTrustMaterial();
    const publication = buildReleasePublication({
      productVersion: '9.9.9',
      sourceCommit: '1'.repeat(40),
      channel: 'stable',
      channelVersion: 1,
      publicationSequence: 1,
      expiresAt: PUBLICATION_EXPIRY,
      minBootstrapVersion: '1.0.0',
      dataSchemaForwardReadableFrom: '1.0.0',
      archive: { platform: process.platform, arch: process.arch, nodeAbi: '127', bytes: Buffer.from('pri732-fake-archive') },
      signingKeyPem: publisherMaterial.privateKeyPem,
      previous: null,
    });
    const { paths } = await provisionedInstallation(pinnedMaterial, publication);
    fs.writeFileSync(
      path.join(paths.releasesDir, publication.releaseMetadata.releaseId, 'metadata.json'),
      `${JSON.stringify(publication.releaseMetadata, null, 2)}\n`,
    );
    const baseUrl = await servePublication(publication.files);
    const manager = new ReleaseManager({ pdHome: paths.home, metadataBaseUrl: baseUrl });
    await expect(manager.check('stable')).rejects.toThrowError(/metadata_refresh_failed|trusted root/i);
  });
});

describe('publish-side guard: signing key must match the pinned trust root (PRI-732)', () => {
  it('accepts the signing key whose id is a root-role key of the pinned root', () => {
    const material = makeTrustMaterial();
    const pinnedRoot = buildSignedRoot(material, FAR_EXPIRY).toString('utf8');
    const match = verifySigningKeyMatchesPinnedRoot(material.privateKeyPem, pinnedRoot);
    expect(match.keyId).toBe(material.keyId);
    expect(match.pinnedRootKeyIds).toContain(material.keyId);
  });

  it('refuses a signing key that does not match the pinned root', () => {
    const pinnedMaterial = makeTrustMaterial();
    const otherMaterial = makeTrustMaterial();
    const pinnedRoot = buildSignedRoot(pinnedMaterial, FAR_EXPIRY).toString('utf8');
    expect(() => verifySigningKeyMatchesPinnedRoot(otherMaterial.privateKeyPem, pinnedRoot))
      .toThrowError(/does not match the pinned trust root/i);
  });

  it('refuses an unparseable pinned root document', () => {
    const material = makeTrustMaterial();
    expect(() => verifySigningKeyMatchesPinnedRoot(material.privateKeyPem, 'not json'))
      .toThrowError(/not a parseable TUF Root/i);
  });
});
