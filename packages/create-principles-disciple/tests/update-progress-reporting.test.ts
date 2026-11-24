/**
 * Update progress reporting — how a long update becomes visible to the Owner.
 *
 * The transaction journal says when a stage begins and nothing about how far
 * along it is. Three things carry that "how far": the download's byte count,
 * the verify step's two halves, and the installer's own weighted step
 * completion. They all end up in one derived sidecar next to the journal.
 *
 * Pinned here, each against the real boundary:
 * 1. The download counts the bytes it actually receives — monotonically within
 *    one attempt, from zero again after a transport failure — and still
 *    verifies exactly as before (PRI-854: narration changes no verdict).
 * 2. The sidecar is observational: written atomically and throttled, removed
 *    when the transaction ends, and never able to fail the update.
 * 3. Its reader reports only what it can vouch for; everything else is null.
 * 4. The verify step narrates both halves in order, before each runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  downloadAndVerifyAssetFile,
  extractAndVerifyReleaseAsset,
  type AssetFetcher,
} from '../src/update/apply-payload.js';
import {
  createTransactionProgressReporter,
  readTransactionProgress,
  transactionProgressPath,
} from '../src/update/transaction-progress.js';

const temporaryDirectories: string[] = [];
function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ─── 1. The download counts its bytes ────────────────────────────────────────

const ASSET_HOST = 'https://release.example';

type Handler = (req: IncomingMessage, res: import('node:http').ServerResponse) => void;

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

function asset(): { bytes: Buffer; sha: string; size: number } {
  const bytes = Buffer.alloc(300 * 1024, 7);
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

describe('downloadAndVerifyAssetFile narrates the bytes it receives', () => {
  it('reports a rising byte count that ends at the asset size, and still verifies the signed digest', async () => {
    const { bytes, sha, size } = asset();
    // Three chunks with a pause between them: the count must follow the wire.
    const third = Math.floor(size / 3);
    await withHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(size) });
      res.write(bytes.subarray(0, third));
      setTimeout(() => {
        res.write(bytes.subarray(third, 2 * third));
        setTimeout(() => { res.end(bytes.subarray(2 * third)); }, 20);
      }, 20);
    }, async (fetcher) => {
      const dir = tempDir('pd-progress-download-');
      const destination = path.join(dir, 'release-asset.tar.gz');
      const counts: number[] = [];

      await downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: destination,
        expectedSha256: sha, expectedSizeBytes: size, releaseId: 'r1', fetcher,
        onProgress: (receivedBytes) => { counts.push(receivedBytes); },
      });

      expect(counts.length).toBeGreaterThan(1);
      expect(counts[counts.length - 1]).toBe(size);
      for (let index = 1; index < counts.length; index += 1) {
        const previous = counts[index - 1] ?? 0;
        const current = counts[index] ?? 0;
        expect(current).toBeGreaterThan(previous);
        expect(current).toBeLessThanOrEqual(size);
      }
      expect(fs.readFileSync(destination).equals(bytes)).toBe(true);
    });
  });

  it('does not narrate a body it refuses: a retriable status is retried, not counted', async () => {
    const { bytes, sha, size } = asset();
    let requests = 0;
    await withHttpServer((_req, res) => {
      requests += 1;
      if (requests === 1) { res.writeHead(503); res.end('unavailable'); return; }
      res.writeHead(200); res.end(bytes);
    }, async (fetcher) => {
      const dir = tempDir('pd-progress-retry-');
      const counts: number[] = [];
      await downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: path.join(dir, 'release-asset.tar.gz'),
        expectedSha256: sha, expectedSizeBytes: size, releaseId: 'r1', fetcher,
        sleep: async () => undefined,
        onProgress: (receivedBytes) => { counts.push(receivedBytes); },
      });

      expect(requests).toBe(2);
      // The refused body ("unavailable") was never the asset, so none of it was
      // ever "received": every count is already a chunk of the real asset.
      expect(Math.min(...counts)).toBeGreaterThan('unavailable'.length);
      expect(counts[counts.length - 1]).toBe(size);
    });
  });

  it('starts counting from zero again when the connection drops mid-body and the attempt is retried', async () => {
    const { bytes, sha, size } = asset();
    const third = Math.floor(size / 3);
    let requests = 0;
    let countsWhenRetried = -1;
    const counts: number[] = [];
    await withHttpServer((_req, res) => {
      requests += 1;
      if (requests === 2) countsWhenRetried = counts.length;
      res.writeHead(200, { 'Content-Length': String(size) });
      if (requests === 1) {
        // Half the asset is delivered, then the carrier resets the connection
        // (PRI-924). The pause makes sure the client has the half first.
        res.write(bytes.subarray(0, Math.floor(size / 2)));
        setTimeout(() => { res.destroy(); }, 150);
        return;
      }
      // The retry arrives in thirds, so its first count is far below the half.
      res.write(bytes.subarray(0, third));
      setTimeout(() => {
        res.write(bytes.subarray(third, 2 * third));
        setTimeout(() => { res.end(bytes.subarray(2 * third)); }, 20);
      }, 20);
    }, async (fetcher) => {
      const dir = tempDir('pd-progress-reset-');
      await downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: path.join(dir, 'release-asset.tar.gz'),
        expectedSha256: sha, expectedSizeBytes: size, releaseId: 'r1', fetcher,
        sleep: async () => undefined,
        onProgress: (receivedBytes) => { counts.push(receivedBytes); },
      });

      expect(requests).toBe(2);
      expect(countsWhenRetried).toBeGreaterThan(0);
      const firstAttempt = counts.slice(0, countsWhenRetried);
      const afterDrop = counts.slice(countsWhenRetried);
      // The first attempt got at least a third of the way before it died...
      const highWater = Math.max(...firstAttempt);
      expect(highWater).toBeGreaterThanOrEqual(third);
      // ...and a count far below that afterwards is the retry starting over.
      expect(afterDrop.length).toBeGreaterThan(1);
      expect(Math.min(...afterDrop)).toBeLessThan(highWater);
      expect(counts[counts.length - 1]).toBe(size);
    });
  });

  it('counts a body the transport hands over without a stream, from the whole buffer', async () => {
    // A response with no body stream is read in one piece; an empty asset makes
    // that path's verification (digest of nothing) observable without a fake.
    const empty = createHash('sha256').digest('hex');
    await withHttpServer((_req, res) => { res.writeHead(200); res.end(); }, async () => {
      const dir = tempDir('pd-progress-whole-');
      const counts: number[] = [];
      const unstreamed: AssetFetcher = async () => new Response(null, { status: 200 });

      await downloadAndVerifyAssetFile({
        url: `${ASSET_HOST}/asset.tar.gz`, destinationPath: path.join(dir, 'release-asset.tar.gz'),
        expectedSha256: empty, releaseId: 'r1', fetcher: unstreamed,
        onProgress: (receivedBytes) => { counts.push(receivedBytes); },
      });

      expect(counts).toEqual([0]);
      expect(fs.statSync(path.join(dir, 'release-asset.tar.gz')).size).toBe(0);
    });
  });
});

// ─── 2 + 3. The sidecar and its reader ──────────────────────────────────────

describe('the progress sidecar', () => {
  it('a step is written at once, and a new step ends the download view that came before it', async () => {
    const transactions = tempDir('pd-progress-tx-');
    const reporter = createTransactionProgressReporter(transactions, 'update-1', { minWriteIntervalMs: 5 });

    reporter.step('Downloading the release asset…');
    expect(readTransactionProgress(transactions, 'update-1')).toMatchObject({ step: 'Downloading the release asset…' });

    reporter.bytes(40, 100);
    await new Promise<void>((resolve) => { setTimeout(resolve, 40); });
    expect(readTransactionProgress(transactions, 'update-1')).toMatchObject({ step: 'Downloading the release asset…', bytesReceived: 40, bytesTotal: 100 });

    reporter.step('Installing pd-console...', 62);
    expect(readTransactionProgress(transactions, 'update-1')).toMatchObject({ step: 'Installing pd-console...', percent: 62 });
    expect(readTransactionProgress(transactions, 'update-1')).not.toHaveProperty('bytesReceived');
  });

  it('throttles byte updates so the disk is not hammered, and still ends on the latest count', async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const transactions = tempDir('pd-progress-throttle-');
    const reporter = createTransactionProgressReporter(transactions, 'update-1', { minWriteIntervalMs: 1000, now: () => clock });

    // A burst right after a write: only scheduled, none of it written yet.
    reporter.bytes(10, 100);
    clock += 100;
    reporter.bytes(20, 100);
    clock += 100;
    reporter.bytes(30, 100);
    expect(readTransactionProgress(transactions, 'update-1')).toMatchObject({ bytesReceived: 10 });

    // One interval later exactly one write lands, and it carries the LAST count.
    clock += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(readTransactionProgress(transactions, 'update-1')).toMatchObject({ bytesReceived: 30, bytesTotal: 100 });

    // The next byte update, a full interval after the previous write, goes out at once.
    clock += 1000;
    reporter.bytes(60, 100);
    expect(readTransactionProgress(transactions, 'update-1')).toMatchObject({ bytesReceived: 60 });
  });

  it('never keeps the executor alive: a scheduled write left pending at close just goes away', async () => {
    vi.useFakeTimers();
    const transactions = tempDir('pd-progress-pending-');
    const reporter = createTransactionProgressReporter(transactions, 'update-1', { minWriteIntervalMs: 60_000 });

    reporter.bytes(1, 100);
    reporter.bytes(2, 100);
    reporter.close();

    await vi.advanceTimersByTimeAsync(120_000);
    // A write that fires after the transaction ended would resurrect a file nobody is reading.
    expect(fs.existsSync(transactionProgressPath(transactions, 'update-1'))).toBe(false);
  });

  it('rounds and bounds the installer completion it is handed', () => {
    const transactions = tempDir('pd-progress-percent-');
    const reporter = createTransactionProgressReporter(transactions, 'update-1');

    reporter.step('a', 61.6);
    expect(readTransactionProgress(transactions, 'update-1')).toMatchObject({ percent: 62 });
    reporter.step('b', 500);
    expect(readTransactionProgress(transactions, 'update-1')).not.toHaveProperty('percent');
    reporter.step('c', Number.NaN);
    expect(readTransactionProgress(transactions, 'update-1')).not.toHaveProperty('percent');
  });

  it('is removed when the transaction is over, and closing twice is harmless', () => {
    const transactions = tempDir('pd-progress-close-');
    const reporter = createTransactionProgressReporter(transactions, 'update-1');
    reporter.step('x');
    expect(fs.existsSync(transactionProgressPath(transactions, 'update-1'))).toBe(true);

    reporter.close();
    reporter.close();
    reporter.step('after close');

    expect(fs.existsSync(transactionProgressPath(transactions, 'update-1'))).toBe(false);
    expect(readTransactionProgress(transactions, 'update-1')).toBeNull();
  });

  it('can never fail an update: a location that refuses writes is swallowed', () => {
    const transactions = tempDir('pd-progress-unwritable-');
    fs.mkdirSync(transactionProgressPath(transactions, 'update-1')); // a DIRECTORY where the file must go

    const reporter = createTransactionProgressReporter(transactions, 'update-1');
    expect(() => { reporter.step('x'); reporter.bytes(1, 2); reporter.close(); }).not.toThrow();
    expect(readTransactionProgress(transactions, 'update-1')).toBeNull();
  });

  it('does nothing at all for a transaction id that is not a safe file name', () => {
    const transactions = tempDir('pd-progress-id-');
    const reporter = createTransactionProgressReporter(transactions, '../escape');

    expect(() => { reporter.step('x'); reporter.bytes(1, 2); reporter.close(); }).not.toThrow();
    expect(fs.readdirSync(transactions)).toEqual([]);
    expect(readTransactionProgress(transactions, '../escape')).toBeNull();
  });
});

describe('reading the progress sidecar', () => {
  const FRESH = { schemaVersion: 1, transactionId: 'update-1', at: '2026-11-23T07:58:00.000Z' };

  function written(progress: unknown): string {
    const transactions = tempDir('pd-progress-read-');
    fs.writeFileSync(transactionProgressPath(transactions, 'update-1'), `${JSON.stringify(progress)}\n`, 'utf8');
    return transactions;
  }

  it('is null when nothing was ever written', () => {
    expect(readTransactionProgress(tempDir('pd-progress-none-'), 'update-1')).toBeNull();
  });

  it('is null for a torn, unreadable or structurally foreign record', () => {
    const transactions = tempDir('pd-progress-bad-');
    const file = transactionProgressPath(transactions, 'update-1');
    for (const body of ['{"schemaVersion":1,"trans', '[]', 'null', '"text"']) {
      fs.writeFileSync(file, body, 'utf8');
      expect(readTransactionProgress(transactions, 'update-1')).toBeNull();
    }
    for (const progress of [{ ...FRESH, schemaVersion: 2 }, { ...FRESH, at: 'yesterday' }, { ...FRESH, transactionId: 'update-2' }]) {
      fs.writeFileSync(file, JSON.stringify(progress), 'utf8');
      expect(readTransactionProgress(transactions, 'update-1')).toBeNull();
    }
  });

  it('reports a complete, well-formed observation exactly as written', () => {
    const transactions = written({ ...FRESH, step: 'Verifying the release asset…', percent: 50, bytesReceived: 10, bytesTotal: 20 });

    expect(readTransactionProgress(transactions, 'update-1')).toEqual({
      schemaVersion: 1, transactionId: 'update-1', at: FRESH.at, step: 'Verifying the release asset…', percent: 50, bytesReceived: 10, bytesTotal: 20,
    });
  });
});

// ─── 4. The verify step narrates both halves ────────────────────────────────

describe('extractAndVerifyReleaseAsset narrates its two halves', () => {
  it('says "extracting" before untarring and "verifying" before the preflight, in that order', async () => {
    const transactionDir = tempDir('pd-progress-verify-');
    const payload = path.join(transactionDir, 'payload');
    fs.mkdirSync(path.join(payload, '_release'), { recursive: true });
    // A manifest without the rest of a release asset: extraction succeeds, the
    // preflight refuses. Both halves are narrated before either runs.
    fs.writeFileSync(path.join(payload, '_release', 'manifest.json'), '{}', 'utf8');
    execFileSync('tar', ['czf', 'release-asset.tar.gz', '-C', 'payload', '_release'], { cwd: transactionDir });
    fs.rmSync(payload, { recursive: true, force: true });
    const steps: string[] = [];

    await expect(extractAndVerifyReleaseAsset({
      transactionDir,
      archivePath: path.join(transactionDir, 'release-asset.tar.gz'),
      onStep: (message) => { steps.push(message); },
    })).rejects.toMatchObject({ reason: 'release_metadata_invalid' });

    expect(steps).toEqual(['Extracting the release asset…', 'Verifying the release asset…']);
  });
});
