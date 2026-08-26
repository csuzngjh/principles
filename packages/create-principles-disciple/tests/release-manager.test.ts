import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
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
import { ReleaseManager, ReleaseManagerError } from '../src/update/release-manager.js';
import {
  BootstrapProtocolError,
  handleBootstrapRequest,
  parseBootstrapRequest,
  serializeBootstrapResponse,
} from '../src/update/bootstrap-protocol.js';
import {
  ensurePdHomeLayout,
  resolvePdHomePaths,
  writeInstallConfig,
} from '../src/update/install-layout.js';
import { buildReleaseMetadata } from '../src/update/release-metadata.js';
import type { ChannelMetadata } from '../src/update/channel-metadata.js';
import type { LegacyUpdaterDecision } from '../src/update/release-manager.js';

// Full shadow-mode integration: a local signed TUF repository serves the
// channel metadata chain plus the channel payload target; the ReleaseManager
// resolves it against ~/.pd and compares its decision with a legacy updater.

const expiresFar = '2030-01-01T00:00:00Z';

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

type KeyObject = ReturnType<typeof generateKeyPairSync>['privateKey'];

function signedMetadata<T extends Root | Snapshot | Targets | Timestamp>(signed: T, signer: { keyId: string; privateKey: KeyObject }): Buffer {
  const metadata = new Metadata(signed);
  metadata.sign(
    (data) => new Signature({ keyID: signer.keyId, sig: cryptoSign(null, data, signer.privateKey).toString('hex') }),
    false,
  );
  return Buffer.from(JSON.stringify(metadata.toJSON()));
}

interface Repository {
  baseUrl: string;
  close(): Promise<void>;
}

const temporaryDirectories: string[] = [];
const openServers: Repository[] = [];

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

interface Fixture {
  pdHome: string;
  repository: Repository;
  channelPayload: ChannelMetadata;
  releaseId: string;
}

async function createShadowFixture(overrides: {
  productVersion?: string;
  publicationSequence?: number;
  channelVersion?: number;
} = {}): Promise<Fixture> {
  const signer = makeKeyMaterial();
  const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-home-'));
  temporaryDirectories.push(pdHome);
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
  fs.writeFileSync(paths.activeRecordPath, `${JSON.stringify({
    generation: 2,
    releaseId: activeRelease.releaseId,
    productVersion: activeRelease.productVersion,
  }, null, 2)}\n`);

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

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) await server.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe('ReleaseManager shadow mode', () => {
  it('inspects an empty installation as layout none with safe defaults', () => {
    const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-empty-'));
    temporaryDirectories.push(pdHome);
    const manager = new ReleaseManager({
      pdHome: path.join(pdHome, '.pd'),
      metadataBaseUrl: 'http://127.0.0.1:1',
      openclawHome: path.join(pdHome, 'no-openclaw'),
    });
    const status = manager.inspect();
    expect(status).toMatchObject({
      layout: 'none',
      productVersion: null,
      releaseId: null,
      generation: null,
      bootstrapVersion: null,
      channel: 'stable',
    });
  });

  it('inspects a dual-slot installation with bootstrap and active record', () => {
    const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-dual-'));
    temporaryDirectories.push(pdHome);
    const paths = resolvePdHomePaths(path.join(pdHome, '.pd'));
    ensurePdHomeLayout(paths);
    fs.writeFileSync(paths.bootstrapManifestPath, `${JSON.stringify({ bootstrapVersion: '1.2.0', installedAt: '2026-08-25T00:00:00Z' })}\n`);
    fs.writeFileSync(paths.activeRecordPath, `${JSON.stringify({ generation: 3, releaseId: 'c'.repeat(64), productVersion: '1.222.0' })}\n`);
    const manager = new ReleaseManager({ pdHome: paths.home, metadataBaseUrl: 'http://127.0.0.1:1' , openclawHome: path.join(os.tmpdir(), 'pd-test-no-openclaw-')});
    expect(manager.inspect()).toMatchObject({
      layout: 'dual-slot',
      productVersion: '1.222.0',
      releaseId: 'c'.repeat(64),
      generation: 3,
      bootstrapVersion: '1.2.0',
    });
  });

  it('refuses a corrupt active record with a recovery next action instead of guessing', () => {
    const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-corrupt-'));
    temporaryDirectories.push(pdHome);
    const paths = resolvePdHomePaths(path.join(pdHome, '.pd'));
    ensurePdHomeLayout(paths);
    fs.writeFileSync(paths.activeRecordPath, JSON.stringify({ generation: 'three' }));
    const manager = new ReleaseManager({ pdHome: paths.home, metadataBaseUrl: 'http://127.0.0.1:1' , openclawHome: path.join(os.tmpdir(), 'pd-test-no-openclaw-')});
    expect(() => manager.inspect()).toThrow(ReleaseManagerError);
    try {
      manager.inspect();
    } catch (error) {
      const refusal = error as ReleaseManagerError;
      expect(refusal.reason).toBe('release_metadata_invalid');
      expect(refusal.nextAction).toMatch(/journal-confirmed/i);
    }
  });

  it('checks a verified channel and compares decisions with the legacy updater', async () => {
    const fixture = await createShadowFixture();
    const agreeLegacy: LegacyUpdaterDecision = {
      source: 'legacy-updater',
      latestVersion: '1.223.0',
      updateAvailable: true,
    };
    const manager = new ReleaseManager({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
      legacyCheck: async () => agreeLegacy,
    });
    const check = await manager.check('stable');
    expect(check.candidate).toMatchObject({ productVersion: '1.223.0', publicationSequence: 9 });
    expect(check.decision).toEqual({ allowed: true, direction: 'update' });
    expect(check.shadowComparison.agrees).toBe(true);
    expect(check.shadowComparison.note).toBeNull();
  });

  it('records a structured disagreement note when the legacy updater decides differently', async () => {
    const fixture = await createShadowFixture();
    const disagreeLegacy: LegacyUpdaterDecision = {
      source: 'legacy-updater',
      latestVersion: '1.222.0',
      updateAvailable: false,
    };
    const manager = new ReleaseManager({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
      legacyCheck: async () => disagreeLegacy,
    });
    const check = await manager.check('stable');
    expect(check.shadowComparison.agrees).toBe(false);
    expect(check.shadowComparison.note).toMatch(/decision mismatch/);
  });

  it('survives a failing legacy comparison without failing the new check', async () => {
    const fixture = await createShadowFixture();
    const manager = new ReleaseManager({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
      legacyCheck: async () => {
        throw new Error('registry unreachable');
      },
    });
    const check = await manager.check('stable');
    expect(check.decision.allowed).toBe(true);
    expect(check.shadowComparison.agrees).toBeNull();
    expect(check.shadowComparison.note).toMatch(/legacy updater failed/);
  });

  it('refuses apply and rollback in shadow mode with owner-facing next actions', async () => {
    const fixture = await createShadowFixture();
    const manager = new ReleaseManager({ pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl , openclawHome: path.join(os.tmpdir(), 'pd-test-no-openclaw-')});
    await expect(manager.apply()).rejects.toMatchObject({ reason: 'shadow_mode_read_only' });
    await expect(manager.rollback()).rejects.toMatchObject({ reason: 'shadow_mode_read_only' });
  });
});

describe('bootstrap protocol', () => {
  it('accepts exactly one well-formed JSON object per request', () => {
    expect(parseBootstrapRequest('{"op":"inspect"}')).toEqual({ op: 'inspect' });
    expect(parseBootstrapRequest('{"op":"check","channel":"candidate"}')).toEqual({ op: 'check', channel: 'candidate' });
    expect(parseBootstrapRequest('{"op":"apply","releaseId":"' + 'a'.repeat(64) + '"}')).toMatchObject({ op: 'apply' });
    for (const bad of [
      '',
      '{} {}',
      '{"op":"inspect"} {"op":"inspect"}',
      '[]',
      'null',
      '"inspect"',
      '{"op":"restart"}',
      '{"op":"check"}',
      '{"op":"check","channel":"beta"}',
      '{"op":"apply","releaseId":""}',
      '{"op":"inspect","extra":1}',
    ]) {
      let captured: unknown;
      try {
        parseBootstrapRequest(bad);
      } catch (error) {
        captured = error;
      }
      expect(captured, bad).toBeInstanceOf(BootstrapProtocolError);
      const reason = (captured as { reason?: unknown }).reason;
      expect(typeof reason).toBe('string');
      expect((reason as string).startsWith('protocol_')).toBe(true);
    }
  });

  it('emits exactly one JSON object per response', () => {
    const line = serializeBootstrapResponse({ ok: true, result: { layout: 'none' } });
    expect(line.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(line)).not.toThrow();
    const parsed: unknown = JSON.parse(line);
    expect(typeof parsed).toBe('object');
  });

  it('dispatches inspect and surfaces manager refusals as structured failures', async () => {
    const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-proto-'));
    temporaryDirectories.push(pdHome);
    const manager = new ReleaseManager({ pdHome: path.join(pdHome, '.pd'), metadataBaseUrl: 'http://127.0.0.1:1', openclawHome: path.join(pdHome, 'no-openclaw') });

    const inspect = await handleBootstrapRequest({ op: 'inspect' }, manager);
    expect(inspect).toMatchObject({ ok: true, result: { layout: 'none' } });

    const apply = await handleBootstrapRequest({ op: 'apply', releaseId: 'a'.repeat(64) }, manager);
    expect(apply).toMatchObject({
      ok: false,
      reason: 'shadow_mode_read_only',
    });
    if (!apply.ok) {
      expect(apply.nextAction.length).toBeGreaterThan(10);
    }

    const rollback = await handleBootstrapRequest({ op: 'rollback' }, manager);
    expect(rollback).toMatchObject({ ok: false, reason: 'shadow_mode_read_only' });
  });
});
