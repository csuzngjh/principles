/**
 * PRI-854 review: contract tests for the url delivery path — the trust
 * boundary where network bytes become installable payload. Positive flow
 * plus every fail-loud branch (rc-3): sha256 mismatch, size mismatch, HTTP
 * failure, non-http(s) scheme, url validation on parse, and the publisher's
 * url-mode naming/shape contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { createHash as createSha, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndVerifyAssetFile, downloadReleaseAsset } from '../src/update/apply-payload.js';
import { parseReleaseMetadata, buildReleaseMetadata } from '../src/update/release-metadata.js';
import { buildReleasePublication, contentAddressedAssetName } from '../src/update/release-metadata-publisher.js';
import { resolvePdHomePaths, type PdHomePaths } from '../src/update/install-layout.js';

const PAYLOAD = Buffer.from('url-delivery-payload-bytes');
const PAYLOAD_SHA = createSha('sha256').update(PAYLOAD).digest('hex');

type Handler = (req: IncomingMessage, res: import('node:http').ServerResponse) => void;

function withHttpServer(handler: Handler, run: (baseUrl: string) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => { try { handler(req, res); } catch (error) { reject(error); } });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { server.close(() => reject(new Error('no port'))); return; }
      run(`http://127.0.0.1:${address.port}`)
        .then(() => server.close(() => resolve()), (error) => server.close(() => reject(error)));
    });
  });
}

function tempPaths(): PdHomePaths {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-url-dl-'));
  return resolvePdHomePaths(home);
}

describe('downloadAndVerifyAssetFile (PRI-854 trust boundary)', () => {
  it('happy path: bytes served, signed sha256+size match → written', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (base) => {
      const destination = path.join(os.tmpdir(), `pd-url-happy-${Date.now()}.tar.gz`);
      await downloadAndVerifyAssetFile({ url: `${base}/asset.tar.gz`, destinationPath: destination, expectedSha256: PAYLOAD_SHA, expectedSizeBytes: PAYLOAD.length, releaseId: 'r1' });
      expect(fs.readFileSync(destination).equals(PAYLOAD)).toBe(true);
      fs.rmSync(destination, { force: true });
    });
  });

  it('UPPERCASE signed digest is case-normalized and still passes', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (base) => {
      const destination = path.join(os.tmpdir(), `pd-url-case-${Date.now()}.tar.gz`);
      await downloadAndVerifyAssetFile({ url: `${base}/asset.tar.gz`, destinationPath: destination, expectedSha256: PAYLOAD_SHA.toUpperCase(), releaseId: 'r1' });
      expect(fs.existsSync(destination)).toBe(true);
      fs.rmSync(destination, { force: true });
    });
  });

  it('sha256 mismatch → release_metadata_invalid (fail loud before any use)', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (base) => {
      const wrong = 'b'.repeat(64);
      await expect(downloadAndVerifyAssetFile({ url: `${base}/asset.tar.gz`, destinationPath: path.join(os.tmpdir(), 'x1.tar.gz'), expectedSha256: wrong, releaseId: 'r1' }))
        .rejects.toMatchObject({ reason: 'release_metadata_invalid' });
    });
  });

  it('size mismatch → release_metadata_invalid', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (base) => {
      await expect(downloadAndVerifyAssetFile({ url: `${base}/asset.tar.gz`, destinationPath: path.join(os.tmpdir(), 'x2.tar.gz'), expectedSha256: PAYLOAD_SHA, expectedSizeBytes: PAYLOAD.length + 1, releaseId: 'r1' }))
        .rejects.toMatchObject({ reason: 'release_metadata_invalid' });
    });
  });

  it('HTTP 404 → metadata_refresh_failed', async () => {
    await withHttpServer((_req, res) => { res.writeHead(404); res.end(); }, async (base) => {
      await expect(downloadAndVerifyAssetFile({ url: `${base}/missing.tar.gz`, destinationPath: path.join(os.tmpdir(), 'x3.tar.gz'), expectedSha256: PAYLOAD_SHA, releaseId: 'r1' }))
        .rejects.toMatchObject({ reason: 'metadata_refresh_failed' });
    });
  });

  it('non-http(s) scheme refused BEFORE any network activity', async () => {
    await expect(downloadAndVerifyAssetFile({ url: 'ftp://host/asset.tar.gz', destinationPath: path.join(os.tmpdir(), 'x4.tar.gz'), expectedSha256: PAYLOAD_SHA, releaseId: 'r1' }))
      .rejects.toMatchObject({ reason: 'release_metadata_invalid' });
  });
});

describe('downloadReleaseAsset url branch (PRI-854)', () => {
  it('url-carrying metadata downloads from the delivery url and skips TUF resolution', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (base) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-url-branch-'));
      const metadata = buildReleaseMetadata({
        productVersion: '2.0.0',
        sourceCommit: '1234567890abcdef1234567890abcdef12345678',
        minBootstrapVersion: '1.0.0',
        publicationSequence: 2,
        expiresAt: '2030-01-01T00:00:00Z',
        assets: [{
          platform: process.platform,
          arch: process.arch,
          nodeAbi: process.versions.modules,
          archiveSha256: PAYLOAD_SHA,
          archiveSizeBytes: PAYLOAD.length,
          url: `${base}/release-asset.tar.gz`,
        }],
        dataSchemaForwardReadableFrom: '1.0.0',
      });
      const downloaded = await downloadReleaseAsset({
        paths: resolvePdHomePaths(home),
        metadataBaseUrl: `${base}/no-tuf-needed`,
        releaseMetadata: metadata,
        channel: 'stable',
        transactionId: 'update-1-urlpath1',
      });
      expect(fs.readFileSync(downloaded.archivePath).equals(PAYLOAD)).toBe(true);
      expect(downloaded.trustedTarget.targetPath).toBe(`${base}/release-asset.tar.gz`);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });
});

describe('assets[].url parse contract (PRI-854)', () => {
  function validDoc(url?: string): Record<string, unknown> {
    // buildReleaseMetadata computes the self-consistent releaseId/digest;
    // the optional url rides along (or is injected for the invalid cases).
    const doc = buildReleaseMetadata({
      productVersion: '2.0.0',
      sourceCommit: '1234567890abcdef1234567890abcdef12345678',
      minBootstrapVersion: '1.0.0',
      publicationSequence: 1,
      expiresAt: '2030-01-01T00:00:00Z',
      assets: [{
        platform: process.platform,
        arch: process.arch,
        nodeAbi: '147',
        archiveSha256: 'a'.repeat(64),
        archiveSizeBytes: 1024,
        ...(url !== undefined ? { url } : {}),
      }],
      dataSchemaForwardReadableFrom: '1.0.0',
    });
    return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  }

  it('valid http url survives parsing', () => {
    const parsed = parseReleaseMetadata(validDoc('https://example.com/a.tar.gz'));
    expect(parsed.assets[0]?.url).toBe('https://example.com/a.tar.gz');
  });

  it('non-http scheme rejected', () => {
    expect(() => parseReleaseMetadata(validDoc('ftp://example.com/a.tar.gz'))).toThrow(/must be an http\(s\) URL/);
  });

  it('non-string url rejected', () => {
    const doc = validDoc();
    (doc.assets as Record<string, unknown>[])[0]!.url = 42;
    expect(() => parseReleaseMetadata(doc)).toThrow(/must be an http\(s\) URL/);
  });
});

describe('publisher url-mode contract (PRI-854)', () => {
  it('emits artifactUrl + conventional artifactTargetPath, uploads list excludes in-repo bytes', () => {
    const keyPair = generateKeyPairSync('ed25519');
    const signingKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const sha = createSha('sha256').update(PAYLOAD).digest('hex');
    const publication = buildReleasePublication({
      channel: 'stable',
      channelVersion: 1,
      publicationSequence: 1,
      expiresAt: '2030-01-01T00:00:00Z',
      minBootstrapVersion: '1.0.0',
      dataSchemaForwardReadableFrom: '1.0.0',
      productVersion: '2.0.0',
      sourceCommit: '1234567890abcdef1234567890abcdef12345678',
      signingKeyPem,
      previous: null,
      archives: [
        { platform: 'win32', arch: 'x64', nodeAbi: '147', bytes: Buffer.from('url-bytes'), url: 'https://example.com/assets/rel' },
      ],
    });
    const artifact = publication.manifest.artifacts[0];
    expect(artifact?.artifactUrl).toBe('https://example.com/assets/rel');
    expect(artifact?.artifactTargetPath).toMatch(/^releases\/[0-9a-f]{64}\/release-asset-win32-x64-abi147\.tar\.gz$/);
    expect(publication.files.some((f) => f.path.includes('release-asset-'))).toBe(false);
    expect(publication.assetUploads).toHaveLength(1);
    // The upload name is content-addressed from the SAME digest the signed
    // metadata binds (consistency between url and manifest).
    expect(publication.assetUploads[0]?.name).toBe(contentAddressedAssetName({ platform: 'win32', arch: 'x64', nodeAbi: '147', digestHex: artifact?.artifactSha256 ?? '' }));
  });
});
