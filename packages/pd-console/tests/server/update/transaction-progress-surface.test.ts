/** Update progress surface (release-handover + progress sidecar).
 *
 * The transaction endpoint is what the Update page reads while an update runs.
 * These tests drive the REAL route in front of a REAL HTTP server against the
 * REAL `update-console` seam, with a transaction journal and a progress
 * sidecar planted under an isolated PD Home, and pin:
 *
 * 1. The journal fact is unchanged — state, terminality and timestamps read
 *    exactly as before; the progress observation rides beside it.
 * 2. Progress is reported only when it is fresh, for THIS transaction, and
 *    field-validated: a stale sidecar, another transaction's sidecar, or a
 *    malformed field is "unknown", never a wrong number on screen.
 * 3. The answering Console's pid travels with every response — that is how the
 *    page tells the predecessor from its successor across a handover — and so
 *    does `handover`, who will do the replacing: the page waits only for a
 *    switch that is really going to happen.
 * 4. A journal that cannot be parsed still answers (with its reason) and still
 *    carries the pid: losing the record is no reason to lose the handover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveReleaseRecord } from '@principles/install-layout';

const mocks = vi.hoisted(() => ({ fakeHome: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.fakeHome,
}));
import { handleUpdateTransactionRoute } from '../../../src/server/routes/update-transaction.js';
import { startReleaseHandoverWatch } from '../../../src/server/release-handover.js';

const DIGEST = 'b'.repeat(64);
const TRANSACTION_ID = 'update-1795420647912-83907b3b';

function transactionsDir(): string {
  // The route resolves journals under <home>/.pd/transactions (resolvePdHomePaths).
  return path.join(mocks.fakeHome, '.pd', 'transactions');
}

function writeJournal(state: 'planned' | 'downloaded' | 'confirmed', options: { broken?: boolean } = {}): void {
  fs.mkdirSync(transactionsDir(), { recursive: true });
  const transitions = state === 'planned'
    ? [{ from: null, to: 'planned' }]
    : state === 'downloaded'
      ? [{ from: null, to: 'planned' }, { from: 'planned', to: 'downloaded' }]
      : [{ from: null, to: 'planned' }, { from: 'planned', to: 'confirmed' }];
  const body = options.broken === true
    ? '{ this is not json\n'
    : transitions.map((transition) => `${JSON.stringify({
      at: '2026-11-23T07:57:34.427Z',
      transactionId: TRANSACTION_ID,
      releaseId: 'c'.repeat(64),
      productVersion: '2.8.11',
      releaseMetadataDigest: DIGEST,
      generation: 106,
      ...transition,
    })}\n`).join('');
  fs.writeFileSync(path.join(transactionsDir(), `${TRANSACTION_ID}.jsonl`), body, 'utf8');
}

function writeProgress(progress: Record<string, unknown>, fileName = `${TRANSACTION_ID}.progress.json`): void {
  fs.mkdirSync(transactionsDir(), { recursive: true });
  fs.writeFileSync(path.join(transactionsDir(), fileName), `${JSON.stringify(progress)}\n`, 'utf8');
}

const FRESH = { schemaVersion: 1, transactionId: TRANSACTION_ID, at: new Date().toISOString() };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readTransaction(): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/update/transaction/${TRANSACTION_ID}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(Reflect.get(body, 'data'))) throw new Error('response carries no data object');
  return { ...Reflect.get(body, 'data') };
}

let port = 0;
let server: ReturnType<typeof createServer>;
let savedHome: string | undefined;

beforeEach(async () => {
  mocks.fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tx-progress-home-'));
  // The route resolves the PD Home through install-layout, which reads HOME
  // directly (outside the node:os mock) — pin it, or the test reads the REAL
  // production transactions directory.
  savedHome = process.env.HOME;
  process.env.HOME = mocks.fakeHome;
  server = createServer((req, res) => {
    void handleUpdateTransactionRoute(req, res, (req.url ?? '').replace(/^\/api\/update/, ''));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing server address');
  port = address.port;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(mocks.fakeHome, { recursive: true, force: true });
});

describe('transaction status carries the journal fact and the answering console', () => {
  it('a running transaction reads as before, plus the pid of the console that answered', async () => {
    writeJournal('downloaded');

    const data = await readTransaction();

    expect(data).toMatchObject({
      transactionId: TRANSACTION_ID,
      exists: true,
      lastState: 'downloaded',
      terminal: false,
      tornTailDetected: false,
      startedAt: '2026-11-23T07:57:34.427Z',
      productVersion: '2.8.11',
    });
    expect(data.serverPid).toBe(process.pid);
    expect(data.progress).toBeNull();
  });

  it('a journal that cannot be parsed still answers, with its reason and the pid', async () => {
    writeJournal('planned', { broken: true });

    const data = await readTransaction();

    expect(data).toMatchObject({ exists: true, lastState: null, terminal: false, serverPid: process.pid, progress: null });
    expect(typeof data.reason).toBe('string');
  });

  it('an unknown transaction answers "no such record" and still names the console', async () => {
    const data = await readTransaction();

    expect(data).toMatchObject({ transactionId: TRANSACTION_ID, exists: false, serverPid: process.pid });
  });
});

describe('transaction status says who switches the console to the new release', () => {
  it('nobody, in a console whose watch is not running — the page must not wait for a switch that will not come', async () => {
    writeJournal('confirmed');

    expect(await readTransaction()).toMatchObject({ lastState: 'confirmed', handover: 'manual' });
  });

  it('the Companion, for a console the Companion launched', async () => {
    writeJournal('confirmed');
    vi.stubEnv('PD_INVOCATION_SOURCE', 'companion');
    try {
      expect(await readTransaction()).toMatchObject({ handover: 'companion' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the console itself, exactly for as long as its watch is running', async () => {
    writeJournal('confirmed');
    const record: ActiveReleaseRecord = {
      schemaVersion: 1, generation: 106, releaseId: 'c'.repeat(64), releaseMetadataDigest: DIGEST,
      previousReleaseId: null, transactionId: TRANSACTION_ID, productVersion: '2.8.11',
    };
    const watch = startReleaseHandoverWatch({
      recordPath: 'unused',
      onSuperseded: () => undefined,
      readRecord: () => ({ ok: true, record }),
      intervalMs: 60_000,
    });
    if (watch === null) throw new Error('watch did not start');
    try {
      expect(await readTransaction()).toMatchObject({ handover: 'console' });
    } finally {
      watch.stop();
    }
    expect(await readTransaction()).toMatchObject({ handover: 'manual' });
  });
});

describe('transaction status carries progress only when it can be trusted', () => {
  it('a fresh sidecar for this transaction is reported field by field', async () => {
    writeJournal('planned');
    writeProgress({ ...FRESH, step: 'Installing pd-console...', percent: 62, bytesReceived: 50, bytesTotal: 100 });

    const data = await readTransaction();

    expect(data.progress).toEqual({
      schemaVersion: 1,
      transactionId: TRANSACTION_ID,
      at: FRESH.at,
      step: 'Installing pd-console...',
      percent: 62,
      bytesReceived: 50,
      bytesTotal: 100,
    });
  });

  it('an observation older than the stage it described is not progress any more', async () => {
    writeJournal('planned');
    writeProgress({ ...FRESH, at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), percent: 40 });

    const data = await readTransaction();

    expect(data.progress).toBeNull();
  });

  it("another transaction's sidecar is never this transaction's progress", async () => {
    writeJournal('planned');
    writeProgress({ ...FRESH, percent: 80 }, 'update-1795000000000-00000000.progress.json');

    const data = await readTransaction();

    expect(data.progress).toBeNull();
  });

  it('fields of the wrong shape are dropped rather than reported', async () => {
    writeJournal('planned');
    writeProgress({ ...FRESH, step: 7, percent: 500, bytesReceived: 120, bytesTotal: 100 });

    const data = await readTransaction();

    expect(Reflect.get(data, 'progress')).toEqual({ schemaVersion: 1, transactionId: TRANSACTION_ID, at: FRESH.at });
  });

  it('a torn read is no observation at all, not an error', async () => {
    writeJournal('planned');
    fs.mkdirSync(transactionsDir(), { recursive: true });
    fs.writeFileSync(path.join(transactionsDir(), `${TRANSACTION_ID}.progress.json`), '{"schemaVersion":1,"trans', 'utf8');

    const data = await readTransaction();

    expect(data).toMatchObject({ exists: true, lastState: 'planned', progress: null });
  });
});
