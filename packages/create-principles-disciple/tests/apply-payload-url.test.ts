/**
 * PRI-854 review: contract tests for the url delivery path — the trust
 * boundary where network bytes become installable payload. Positive flow
 * plus every fail-loud branch (rc-3): sha256 mismatch, size mismatch, HTTP
 * failure, protocol refusal, url validation on parse, and the publisher's
 * url-mode naming/shape contract.
 *
 * PRI-927 (Owner decision: no insecure override): the production gate accepts
 * https only, so these tests may NOT hand the code under test a plaintext URL
 * just because a local server is easier. They hand it an https URL plus an
 * injected transport that maps that URL's path onto the local server — the
 * socket, the status codes and the connection resets are still real undici,
 * only the delivery host is swapped. The gate itself is asserted separately,
 * including that a refusal performs zero transport calls.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { createHash as createSha, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndVerifyAssetFile, downloadReleaseAsset, type AssetFetcher } from '../src/update/apply-payload.js';
import { parseReleaseMetadata, buildReleaseMetadata } from '../src/update/release-metadata.js';
import { buildReleasePublication, contentAddressedAssetName } from '../src/update/release-metadata-publisher.js';
import { resolvePdHomePaths, type PdHomePaths } from '../src/update/install-layout.js';

const PAYLOAD = Buffer.from('url-delivery-payload-bytes');
const PAYLOAD_SHA = createSha('sha256').update(PAYLOAD).digest('hex');

type Handler = (req: IncomingMessage, res: import('node:http').ServerResponse) => void;

/** The logical (signed-metadata) host the code under test is told to fetch from. */
const ASSET_HOST = 'https://release.example';

function withHttpServer(handler: Handler, run: (fetcher: AssetFetcher) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => { try { handler(req, res); } catch (error) { reject(error); } });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { server.close(() => reject(new Error('no port'))); return; }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const fetcher: AssetFetcher = (url, init) => fetch(`${baseUrl}${new URL(url).pathname}`, init);
      run(fetcher)
        .then(() => server.close(() => resolve()), (error) => server.close(() => reject(error)));
    });
  });
}

/** A transport that records calls, so a refusal can be proven to precede transport. */
function countingFetcher(target: AssetFetcher): AssetFetcher & { calls: () => number } {
  let calls = 0;
  const wrapped: AssetFetcher & { calls: () => number } = (url, init) => {
    calls += 1;
    return target(url, init);
  };
  wrapped.calls = () => calls;
  return wrapped;
}

/** Fresh staging-shaped dir per test — the assertions below inspect its contents. */
function tempDestination(prefix: string): { destination: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return { dir, destination: path.join(dir, 'release-asset.tar.gz') };
}

function leftoverCandidates(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.part'));
}

describe('downloadAndVerifyAssetFile (PRI-854 trust boundary)', () => {
  it('happy path: bytes served, signed sha256+size match → canonical file only', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-url-happy');
      await downloadAndVerifyAssetFile({ url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination, expectedSha256: PAYLOAD_SHA, expectedSizeBytes: PAYLOAD.length, releaseId: 'r1', fetcher });
      expect(fs.readFileSync(destination).equals(PAYLOAD)).toBe(true);
      expect(leftoverCandidates(dir)).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('UPPERCASE signed digest is case-normalized and still passes', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-url-case');
      await downloadAndVerifyAssetFile({ url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination, expectedSha256: PAYLOAD_SHA.toUpperCase(), releaseId: 'r1', fetcher });
      expect(fs.existsSync(destination)).toBe(true);
      expect(leftoverCandidates(dir)).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('sha256 mismatch → release_metadata_invalid (fail loud before any use)', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-url-digest');
      await expect(downloadAndVerifyAssetFile({ url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination, expectedSha256: 'b'.repeat(64), releaseId: 'r1', fetcher }))
        .rejects.toMatchObject({ reason: 'release_metadata_invalid' });
      // The trust anchor refuses before anything is published: neither the
      // canonical name nor a candidate survives.
      expect(fs.existsSync(destination)).toBe(false);
      expect(leftoverCandidates(dir)).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('size mismatch → release_metadata_invalid', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-url-size');
      await expect(downloadAndVerifyAssetFile({ url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination, expectedSha256: PAYLOAD_SHA, expectedSizeBytes: PAYLOAD.length + 1, releaseId: 'r1', fetcher }))
        .rejects.toMatchObject({ reason: 'release_metadata_invalid' });
      expect(fs.existsSync(destination)).toBe(false);
      expect(leftoverCandidates(dir)).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('HTTP 404 → metadata_refresh_failed', async () => {
    await withHttpServer((_req, res) => { res.writeHead(404); res.end(); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-url-404');
      await expect(downloadAndVerifyAssetFile({ url: `${ASSET_HOST}/missing.tar.gz`, destinationPath: destination, expectedSha256: PAYLOAD_SHA, releaseId: 'r1', fetcher }))
        .rejects.toMatchObject({ reason: 'metadata_refresh_failed' });
      expect(fs.existsSync(destination)).toBe(false);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('non-https scheme refused BEFORE any transport call', async () => {
    const fetcher = countingFetcher(() => fetch('data:,'));
    await expect(downloadAndVerifyAssetFile({ url: 'ftp://host/asset.tar.gz', destinationPath: path.join(os.tmpdir(), 'x4.tar.gz'), expectedSha256: PAYLOAD_SHA, releaseId: 'r1', fetcher }))
      .rejects.toMatchObject({ reason: 'release_metadata_invalid' });
    expect(fetcher.calls()).toBe(0);
  });

  it('unparseable URL refused with a structured reason and nextAction', async () => {
    await expect(downloadAndVerifyAssetFile({ url: 'not a url', destinationPath: path.join(os.tmpdir(), 'x5.tar.gz'), expectedSha256: PAYLOAD_SHA, releaseId: 'r1' }))
      .rejects.toMatchObject({ reason: 'release_metadata_invalid', nextAction: expect.any(String) });
  });
});

/**
 * PRI-927 (Owner decision: fix, do not dismiss): unverified network bytes must
 * never be reachable under the canonical asset name. Verified bytes land in a
 * private, exclusively-created, unguessable candidate in the SAME directory as
 * the destination and only then reach the canonical name by rename — so the
 * publish is atomic on one filesystem and no partial candidate is ever named.
 */
describe('downloadAndVerifyAssetFile private candidate (PRI-927)', () => {
  const NO_SLEEP = () => Promise.resolve();

  it('https-only gate is not bypassable by injecting a transport', async () => {
    // The refusal is about the URL, not the transport: an http:// asset URL is
    // rejected even though a working fetcher is supplied.
    const fetcher = countingFetcher(() => fetch('data:,'));
    await expect(downloadAndVerifyAssetFile({
      url: 'http://127.0.0.1:1/asset.tar.gz', destinationPath: path.join(os.tmpdir(), 'pd-insecure.asset.tar.gz'),
      expectedSha256: PAYLOAD_SHA, releaseId: 'r1', fetcher,
    })).rejects.toMatchObject({ reason: 'release_metadata_invalid', message: /must be an https URL/ });
    expect(fetcher.calls()).toBe(0);
  });

  it('a stale canonical file from an earlier attempt is replaced only by a verified rename', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-url-replace');
      fs.writeFileSync(destination, 'garbage from an interrupted earlier transaction');
      await downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination,
        expectedSha256: PAYLOAD_SHA, expectedSizeBytes: PAYLOAD.length, releaseId: 'r1', fetcher,
      });
      expect(fs.readFileSync(destination).equals(PAYLOAD)).toBe(true);
      expect(leftoverCandidates(dir)).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('a failed digest leaves the pre-existing canonical bytes untouched', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-url-untouched');
      const previous = Buffer.from('previous confirmed release bytes');
      fs.writeFileSync(destination, previous);
      await expect(downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination,
        expectedSha256: 'b'.repeat(64), releaseId: 'r1', fetcher, sleep: NO_SLEEP,
      })).rejects.toMatchObject({ reason: 'release_metadata_invalid' });
      expect(fs.readFileSync(destination).equals(previous)).toBe(true);
      expect(leftoverCandidates(dir)).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('a failed publish surfaces as a structured staging error, candidate removed', async () => {
    // Real OS refusal, no mocks: the canonical name is an existing directory,
    // so the atomic rename of the verified candidate cannot succeed. Before
    // PRI-927 this same situation was a plain writeFileSync over a path the
    // caller expected to be a file.
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-url-publish-refused');
      fs.mkdirSync(destination);
      const error = await downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination,
        expectedSha256: PAYLOAD_SHA, expectedSizeBytes: PAYLOAD.length, releaseId: 'r1', fetcher,
      }).catch((thrown: unknown) => thrown as Error);
      expect(error).toMatchObject({ reason: 'metadata_refresh_failed' });
      expect(error?.message).toMatch(/could not be staged/);
      expect(leftoverCandidates(dir)).toEqual([]);
      fs.rmdirSync(destination);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  // POSIX-only: Windows reports NTFS ACLs through stat and does not honour the
  // creation mode bits, so asserting 0600 there would test the OS, not the code.
  it.runIf(process.platform !== 'win32')('the published asset is not readable by other users', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-url-mode');
      await downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination,
        expectedSha256: PAYLOAD_SHA, expectedSizeBytes: PAYLOAD.length, releaseId: 'r1', fetcher,
      });
      // Pre-fix this was 0o644 (writeFileSync default & ~umask): the verified
      // bytes were materialised under the canonical name for any local user.
      expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });
});

/**
 * PRI-924: the acquisition is a bounded-retry transport. Retry policy covers
 * the transport class ONLY (connection throw mid-body — the real-world
 * `terminated` — and 5xx/408/429); the signed sha256/size trust anchor aborts
 * on the first disagreement, and a stable 4xx refusal is never re-asked.
 */
describe('downloadAndVerifyAssetFile bounded retry (PRI-924)', () => {
  const NO_SLEEP = () => Promise.resolve();

  it('connection reset on attempt 1, full body on attempt 2 → written once', async () => {
    let requests = 0;
    await withHttpServer((_req, res) => {
      requests += 1;
      if (requests === 1) { res.destroy(); return; }
      res.writeHead(200); res.end(PAYLOAD);
    }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-retry-recover');
      await downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination,
        expectedSha256: PAYLOAD_SHA, expectedSizeBytes: PAYLOAD.length, releaseId: 'r1', sleep: NO_SLEEP, fetcher,
      });
      expect(fs.readFileSync(destination).equals(PAYLOAD)).toBe(true);
      expect(requests).toBe(2);
      expect(leftoverCandidates(dir)).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('503 then 200 → recovers through the retry', async () => {
    let requests = 0;
    await withHttpServer((_req, res) => {
      requests += 1;
      if (requests === 1) { res.writeHead(503); res.end(); return; }
      res.writeHead(200); res.end(PAYLOAD);
    }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-retry-503');
      await downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination,
        expectedSha256: PAYLOAD_SHA, expectedSizeBytes: PAYLOAD.length, releaseId: 'r1', sleep: NO_SLEEP, fetcher,
      });
      expect(fs.existsSync(destination)).toBe(true);
      expect(requests).toBe(2);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('500 WITH a body → body is cancelled, never treated as payload, retry recovers', async () => {
    let requests = 0;
    await withHttpServer((_req, res) => {
      requests += 1;
      if (requests === 1) { res.writeHead(500); res.end('error page bytes that must never reach disk'); return; }
      res.writeHead(200); res.end(PAYLOAD);
    }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-retry-500-body');
      await downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination,
        expectedSha256: PAYLOAD_SHA, expectedSizeBytes: PAYLOAD.length, releaseId: 'r1', sleep: NO_SLEEP, fetcher,
      });
      expect(fs.readFileSync(destination).equals(PAYLOAD)).toBe(true);
      expect(requests).toBe(2);
      expect(leftoverCandidates(dir)).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('persistent connection reset → attempts are BOUNDED, then metadata_refresh_failed', async () => {
    let requests = 0;
    await withHttpServer((_req, res) => { requests += 1; res.destroy(); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-retry-exhaust');
      await expect(downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination,
        expectedSha256: PAYLOAD_SHA, releaseId: 'r1', sleep: NO_SLEEP, fetcher,
      })).rejects.toMatchObject({ reason: 'metadata_refresh_failed', message: /after 3 attempts/ });
      expect(requests).toBe(3);
      expect(fs.existsSync(destination)).toBe(false);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('404 is a stable refusal — never retried', async () => {
    let requests = 0;
    await withHttpServer((_req, res) => { requests += 1; res.writeHead(404); res.end(); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-retry-404');
      await expect(downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/missing.tar.gz`, destinationPath: destination,
        expectedSha256: PAYLOAD_SHA, releaseId: 'r1', sleep: NO_SLEEP, fetcher,
      })).rejects.toMatchObject({ reason: 'metadata_refresh_failed', message: /HTTP 404/ });
      expect(requests).toBe(1);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });

  it('signed sha256 disagreement ABORTS immediately — a corrupt candidate is never re-drawn', async () => {
    let requests = 0;
    await withHttpServer((_req, res) => { requests += 1; res.writeHead(200); res.end(PAYLOAD); }, async (fetcher) => {
      const { dir, destination } = tempDestination('pd-retry-digest');
      await expect(downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination,
        expectedSha256: 'b'.repeat(64), releaseId: 'r1', sleep: NO_SLEEP, fetcher,
      })).rejects.toMatchObject({ reason: 'release_metadata_invalid' });
      expect(requests).toBe(1);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });
});

describe('downloadReleaseAsset url branch (PRI-854)', () => {
  it('url-carrying metadata downloads from the delivery url and skips TUF resolution', async () => {
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(PAYLOAD); }, async (assetFetcher) => {
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
          url: `${ASSET_HOST}/release-asset.tar.gz`,
        }],
        dataSchemaForwardReadableFrom: '1.0.0',
      });
      const downloaded = await downloadReleaseAsset({
        paths: resolvePdHomePaths(home),
        metadataBaseUrl: `${ASSET_HOST}/no-tuf-needed`,
        assetFetcher,
        releaseMetadata: metadata,
        channel: 'stable',
        transactionId: 'update-1-urlpath1',
      });
      expect(fs.readFileSync(downloaded.archivePath).equals(PAYLOAD)).toBe(true);
      expect(downloaded.trustedTarget.targetPath).toBe(`${ASSET_HOST}/release-asset.tar.gz`);
      // The whole staging transaction dir holds nothing but the canonical
      // archive — no candidate left behind by the production wiring either.
      expect(leftoverCandidates(path.dirname(downloaded.archivePath))).toEqual([]);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  });
});

describe('assets[].url parse contract (PRI-854, tightened by PRI-927)', () => {
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

  it('https url survives parsing', () => {
    const parsed = parseReleaseMetadata(validDoc('https://example.com/a.tar.gz'));
    expect(parsed.assets[0]?.url).toBe('https://example.com/a.tar.gz');
  });

  it('plaintext http url is refused — the asset carrier is TLS-only (PRI-927)', () => {
    expect(() => parseReleaseMetadata(validDoc('http://example.com/a.tar.gz'))).toThrow(/must be an https URL/);
  });

  it('case-shifted https url is accepted (the URL parser normalizes it)', () => {
    const parsed = parseReleaseMetadata(validDoc('HTTPS://example.com/a.tar.gz'));
    expect(parsed.assets[0]?.url).toBe('HTTPS://example.com/a.tar.gz');
  });

  it('non-http scheme rejected', () => {
    expect(() => parseReleaseMetadata(validDoc('ftp://example.com/a.tar.gz'))).toThrow(/must be an https URL/);
  });

  it('scheme-prefix look-alike is normalized by the URL parser, so the gate agrees with fetch', () => {
    // `https:example.com/a.tar.gz` is not an unresolvable string: WHATWG
    // recovery for a special scheme parses it into host `example.com`, and that
    // is precisely what fetch would then request. The gate must accept it —
    // rejecting here would mean the gate and the transport disagree.
    const parsed = parseReleaseMetadata(validDoc('https:example.com/a.tar.gz'));
    expect(parsed.assets[0]?.url).toBe('https:example.com/a.tar.gz');
  });

  it('hostless https url is refused — the parse itself fails', () => {
    expect(() => parseReleaseMetadata(validDoc('https://'))).toThrow(/must be an https URL/);
  });

  it('non-string url rejected', () => {
    const doc = validDoc();
    (doc.assets as Record<string, unknown>[])[0]!.url = 42;
    expect(() => parseReleaseMetadata(doc)).toThrow(/must be an https URL/);
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
