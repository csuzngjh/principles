/** ERR-207 (cross-version contract): a deployed release-manager built before
 * the progress sidecar existed has no `readTransactionProgress` export.
 *
 * The transaction route must treat that as "no progress known" — the journal
 * fact and the answering pid still go out — and must not blow up on the
 * missing export. Driven against the REAL route with the seam wrapped so the
 * export is genuinely absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({ fakeHome: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.fakeHome,
}));
vi.mock('create-principles-disciple/update-console', async (original) => {
  const deployed = await original<typeof import('create-principles-disciple/update-console')>();
  const older: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(deployed)) {
    if (name !== 'readTransactionProgress') older[name] = value;
  }
  // Vitest throws on a missing export of a mocked module only when it is READ;
  // leaving the key out is exactly the pre-sidecar module shape.
  return older;
});
import { handleUpdateTransactionRoute } from '../../../src/server/routes/update-transaction.js';

const TRANSACTION_ID = 'update-1795000000000-00000000';

let server: ReturnType<typeof createServer>;
let savedHome: string | undefined;

beforeEach(async () => {
  mocks.fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tx-older-seam-home-'));
  savedHome = process.env.HOME;
  process.env.HOME = mocks.fakeHome;
  server = createServer((req, res) => {
    void handleUpdateTransactionRoute(req, res, (req.url ?? '').replace(/^\/api\/update/, ''));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(mocks.fakeHome, { recursive: true, force: true });
});

describe('transaction status against a release-manager without the progress sidecar', () => {
  it('answers the journal fact and the pid, with no progress, even when a sidecar file exists', async () => {
    const transactionsDir = path.join(mocks.fakeHome, '.pd', 'transactions');
    fs.mkdirSync(transactionsDir, { recursive: true });
    fs.writeFileSync(path.join(transactionsDir, `${TRANSACTION_ID}.jsonl`), `${JSON.stringify({
      at: '2026-11-23T07:57:34.427Z', from: null, to: 'planned', transactionId: TRANSACTION_ID,
      releaseId: 'd'.repeat(64), productVersion: '2.8.11', releaseMetadataDigest: 'e'.repeat(64), generation: 106,
    })}\n`, 'utf8');
    // A sidecar the older module cannot read must not be mistaken for one it vouched for.
    fs.writeFileSync(path.join(transactionsDir, `${TRANSACTION_ID}.progress.json`), JSON.stringify({
      schemaVersion: 1, transactionId: TRANSACTION_ID, at: new Date().toISOString(), percent: 99,
    }), 'utf8');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server address');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/update/transaction/${TRANSACTION_ID}`);
    const body: unknown = await response.json();

    expect(typeof body).toBe('object');
    expect(body).toMatchObject({
      success: true,
      data: { transactionId: TRANSACTION_ID, exists: true, lastState: 'planned', terminal: false, serverPid: process.pid, progress: null },
    });
  });
});
