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
  readCurrentVersion: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.fakeHome,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: (...spawnArgs: unknown[]) => mocks.spawn(...spawnArgs),
}));
vi.mock('create-principles-disciple/update-console', async (original) => ({
  ...await original<typeof import('create-principles-disciple/update-console')>(),
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
      installStatus: { channel: 'stable', productVersion: '1.2.0', releaseId: 'rel-42', generation: 7, layout: 'dual-slot' },
      kinds: { check: { ready: true, reasons: [] }, 'apply-full': { ready: true, reasons: [] } },
      manager: { check: mocks.check },
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

  it('apply-full without a deployed executor → bootstrap_not_registered refusal', async () => {
    const body = await (await fetch(`${base}/apply-full`, { method: 'POST' })).json();
    expect(body.data).toMatchObject({
      success: false,
      refusal: true,
      state: 'update_blocked',
      reason: 'bootstrap_not_registered',
    });
    expect(body.data.nextAction).toContain('repair-update-chain');
  });

  it('apply-full spawns the executor and returns update_in_progress once the journal opens', async () => {
    // Deployed executor entry (the only file the route spawn-guards on).
    const entryDir = path.join(mocks.fakeHome, '.pd', 'bootstrap', 'executor', 'dist');
    fs.mkdirSync(entryDir, { recursive: true });
    const entryPath = path.join(entryDir, 'bootstrap-entry.js');
    fs.writeFileSync(entryPath, '// executor entry\n', 'utf8');

    // The spawn mock reads the request file it was handed, then opens the
    // journal the route is polling for — simulating the executor reaching its
    // `planned` state.
    mocks.spawn.mockImplementation((_executable: string, argv: string[]) => {
      const requestFile = argv[argv.indexOf('--request-file') + 1] as string;
      const request = JSON.parse(fs.readFileSync(requestFile, 'utf8')) as { transactionId: string };
      setTimeout(() => {
        writeJournal(mocks.fakeHome, request.transactionId, [
          { at: '2026-09-19T00:00:00.000Z', from: null, to: 'planned', transactionId: request.transactionId, releaseId: 'rel-43', productVersion: '1.3.0', generation: 8 },
        ]);
      }, 120);
      return {
        on: vi.fn(),
        unref: vi.fn(),
      };
    });

    const body = await (await fetch(`${base}/apply-full`, { method: 'POST' })).json();
    expect(body.data).toMatchObject({
      success: true,
      state: 'update_in_progress',
      requiresRestart: false,
    });
    expect(body.data.transactionId).toMatch(/^update-\d+-[a-z0-9]{8}$/);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
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

  it('recovery resolve reports the pure journal verdict without mutating state', async () => {
    writeJournal(mocks.fakeHome, 'update-9-stuck', [
      { at: '2026-09-19T00:00:00.000Z', from: null, to: 'planned', transactionId: 'update-9-stuck', releaseId: 'rel-2', productVersion: '1.2.0', generation: 3 },
    ]);
    const before = fs.readFileSync(path.join(mocks.fakeHome, '.pd', 'transactions', 'update-9-stuck.jsonl'), 'utf8');

    const resolved = await fetch(`${transactionBase}/api/update/recovery/resolve`, {
      method: 'POST',
      body: JSON.stringify({ transactionId: 'update-9-stuck' }),
    });
    const body = await resolved.json();
    expect(body.data.ok).toBe(true);
    expect(body.data.outcome).toMatchObject({ kind: 'old_confirmed' });

    // Unknown id → structured refusal, not a 500.
    const unknown = await fetch(`${transactionBase}/api/update/recovery/resolve`, {
      method: 'POST',
      body: JSON.stringify({ transactionId: 'update-404-deadbeef' }),
    });
    expect((await unknown.json()).data).toMatchObject({ ok: false, reason: 'unknown_transaction' });

    // The journal bytes were never touched (pure decision).
    const after = fs.readFileSync(path.join(mocks.fakeHome, '.pd', 'transactions', 'update-9-stuck.jsonl'), 'utf8');
    expect(after).toBe(before);
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
