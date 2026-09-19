/** PRI-848 (SPEC §12.1): update state contract — refusals are never "up to date"
 * or "success", and transaction/recovery surfaces expose unfinished journals. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  // Assigned in beforeEach — vi.hoisted runs before imports initialize.
  fakeHome: '',
  create: vi.fn(),
  check: vi.fn(),
  apply: vi.fn(),
  readCurrentVersion: vi.fn(),
}));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.fakeHome,
}));
vi.mock('create-principles-disciple/dist/update/release-manager-authority.js', async (original) => ({
  ...await original<typeof import('create-principles-disciple/dist/update/release-manager-authority.js')>(),
  createReleaseManagerAuthority: mocks.create,
}));
vi.mock('../../../src/server/utils/installed-layout.js', () => ({
  readCurrentVersion: mocks.readCurrentVersion,
  resolvePluginDir: () => '/fake/plugin-dir',
}));
import { handleUpdateRoute } from '../../../src/server/routes/update.js';
import { handleUpdateTransactionRoute } from '../../../src/server/routes/update-transaction.js';

function writeJournal(home: string, transactionId: string, lines: Array<Record<string, unknown>>): void {
  // The route resolves journals under <homedir>/.pd/transactions (resolvePdHomePaths).
  const transactionsDir = path.join(home, '.pd', 'transactions');
  fs.mkdirSync(transactionsDir, { recursive: true });
  // The strict parser requires a 64-char hex releaseMetadataDigest per line.
  const digest = 'a'.repeat(64);
  const body = lines
    .map((line) => `${JSON.stringify({ releaseMetadataDigest: digest, ...line })}\n`)
    .join('');
  fs.writeFileSync(path.join(transactionsDir, `${transactionId}.jsonl`), body, 'utf8');
}

describe('PRI-848 update state contract', () => {
  let home: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let transactionServer: ReturnType<typeof createServer>;
  let transactionBase: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-state-ws-'));
    mocks.fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-state-home-'));
    mocks.readCurrentVersion.mockReturnValue(undefined);
    mocks.create.mockReturnValue({
      installStatus: { channel: 'stable', productVersion: '1.2.0', releaseId: 'rel-42', generation: 7 },
      kinds: { check: { ready: true, reasons: [] }, 'apply-full': { ready: true, reasons: [] } },
      manager: { check: mocks.check, apply: mocks.apply },
    });
    mocks.check.mockResolvedValue({
      candidate: { productVersion: '1.3.0' },
      decision: { allowed: true, direction: 'update' },
    });
    server = createServer((req, res) => { void handleUpdateRoute(req, res, home, req.url ?? ''); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server address');
    base = `http://127.0.0.1:${address.port}`;

    transactionServer = createServer((req, res) => {
      const subPath = (req.url ?? '').replace(/^\/api\/update/, '');
      void handleUpdateTransactionRoute(req, res, subPath);
    });
    await new Promise<void>((resolve) => transactionServer.listen(0, '127.0.0.1', resolve));
    const txAddress = transactionServer.address();
    if (txAddress === null || typeof txAddress === 'string') throw new Error('missing tx server address');
    transactionBase = `http://127.0.0.1:${txAddress.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => transactionServer.close(error => error ? reject(error) : resolve()));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mocks.fakeHome, { recursive: true, force: true });
  });

  it('policy refusal → state update_blocked with reason code, never "up to date"', async () => {
    mocks.check.mockResolvedValue({
      candidate: { productVersion: '1.3.0' },
      decision: { allowed: false, reason: 'bootstrap_too_old', message: 'Release 1.3.0 requires bootstrap >= 1.0.0.' },
    });
    const body = await (await fetch(`${base}/check`)).json();
    expect(body.data).toMatchObject({
      state: 'update_blocked',
      hasUpdate: false,
      latestVersion: '1.3.0',
      reason: 'bootstrap_too_old',
    });
    expect(body.data.upToDate).toBeUndefined();
  });

  it('reinstall direction → state up_to_date', async () => {
    mocks.check.mockResolvedValue({
      candidate: { productVersion: '1.2.0' },
      decision: { allowed: true, direction: 'reinstall' },
    });
    const body = await (await fetch(`${base}/check`)).json();
    expect(body.data).toMatchObject({ state: 'up_to_date', hasUpdate: false });
  });

  it('readiness refusal → state check_failed with the configured reason (never silent)', async () => {
    mocks.create.mockReturnValue({
      installStatus: { channel: 'stable', productVersion: '1.2.0', releaseId: 'rel-42', generation: 7 },
      kinds: { check: { ready: false, reasons: ['metadata_source_unconfigured'] }, 'apply-full': { ready: false, reasons: ['metadata_source_unconfigured'] } },
      manager: { check: mocks.check, apply: mocks.apply },
    });
    const body = await (await fetch(`${base}/check`)).json();
    expect(body.data).toMatchObject({
      state: 'check_failed',
      hasUpdate: false,
      reason: 'metadata_source_unconfigured',
    });
    expect(body.data.nextAction).toBeTruthy();
  });

  it('apply-full policy refusal → structured non-success (refusal), not success-shaped', async () => {
    mocks.apply.mockResolvedValue({
      kind: 'no_update',
      reason: 'bootstrap_too_old',
      note: 'Release 1.3.0 requires bootstrap >= 1.0.0; installed bootstrap is 0.0.0.',
    });
    const body = await (await fetch(`${base}/apply-full`, { method: 'POST' })).json();
    expect(body.data).toMatchObject({
      success: false,
      refusal: true,
      state: 'update_blocked',
      reason: 'bootstrap_too_old',
    });
    // D-7 audit trail: the refusal records the STRUCTURED reason code.
    const history = JSON.parse(fs.readFileSync(path.join(home, '.pd', 'update-history.json'), 'utf8')) as Array<{ kind: string; reason: string }>;
    expect(history.some((entry) => entry.kind === 'refusal' && entry.reason === 'bootstrap_too_old')).toBe(true);
  });

  it('apply-full applied → awaiting_restart with the queryable transaction id', async () => {
    mocks.apply.mockResolvedValue({
      kind: 'applied',
      productVersion: '1.3.0',
      transactionId: 'update-1789-abcdef01',
      journalPath: path.join(home, 'transactions', 'update-1789-abcdef01.jsonl'),
      gatewayNotice: undefined,
    });
    const body = await (await fetch(`${base}/apply-full`, { method: 'POST' })).json();
    expect(body.data).toMatchObject({
      success: true,
      state: 'awaiting_restart',
      transactionId: 'update-1789-abcdef01',
      newVersion: '1.3.0',
      requiresRestart: true,
    });
  });

  it('transaction endpoint replays journal phases; unknown id reports missing', async () => {
    writeJournal(mocks.fakeHome, 'update-42-cafe', [
      { at: '2026-09-19T00:00:00.000Z', from: null, to: 'planned', transactionId: 'update-42-cafe', releaseId: 'rel-43', productVersion: '1.3.0', generation: 1 },
      { at: '2026-09-19T00:01:00.000Z', from: 'planned', to: 'downloaded', transactionId: 'update-42-cafe', releaseId: 'rel-43', productVersion: '1.3.0', generation: 1 },
    ]);
    const found = await (await fetch(`${transactionBase}/api/update/transaction/update-42-cafe`)).json();
    expect(found.data).toMatchObject({
      exists: true,
      lastState: 'downloaded',
      terminal: false,
      productVersion: '1.3.0',
    });
    expect(found.data.transitions).toHaveLength(2);

    const missing = await (await fetch(`${transactionBase}/api/update/transaction/update-404-deadbeef`)).json();
    expect(missing.data).toMatchObject({ exists: false });

    const evil = await (await fetch(`${transactionBase}/api/update/transaction/..%2F..%2Fescape`)).json();
    expect(evil.data).toMatchObject({ exists: false, reason: 'invalid_transaction_id' });
  });

  it('recovery endpoint flags an unfinished transaction and stays quiet when all are terminal', async () => {
    writeJournal(mocks.fakeHome, 'update-1-terminal', [
      { at: '2026-09-19T00:00:00.000Z', from: null, to: 'planned', transactionId: 'update-1-terminal', releaseId: 'rel-1', productVersion: '1.1.0', generation: 1 },
      { at: '2026-09-19T00:02:00.000Z', from: 'planned', to: 'confirmed', transactionId: 'update-1-terminal', releaseId: 'rel-1', productVersion: '1.1.0', generation: 1 },
    ]);
    writeJournal(mocks.fakeHome, 'update-2-stuck', [
      { at: '2026-09-19T00:05:00.000Z', from: null, to: 'planned', transactionId: 'update-2-stuck', releaseId: 'rel-2', productVersion: '1.2.0', generation: 2 },
    ]);
    const flagged = await (await fetch(`${transactionBase}/api/update/recovery`)).json();
    expect(flagged.data.needsRecovery).toBe(true);
    expect(flagged.data.unfinished).toHaveLength(1);
    expect(flagged.data.unfinished[0]).toMatchObject({ transactionId: 'update-2-stuck', lastState: 'planned', terminal: false });
    expect(flagged.data.nextAction).toBeTruthy();

    fs.rmSync(path.join(mocks.fakeHome, '.pd', 'transactions', 'update-2-stuck.jsonl'));
    const quiet = await (await fetch(`${transactionBase}/api/update/recovery`)).json();
    expect(quiet.data.needsRecovery).toBe(false);
    expect(quiet.data.unfinished).toHaveLength(0);
  });
});
