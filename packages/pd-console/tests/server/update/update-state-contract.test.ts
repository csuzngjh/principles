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

  it('recovery resolve ignores a fabricated previous.json — it is not a recovery input (PRI-922)', async () => {
    writeJournal(mocks.fakeHome, 'update-9-stuck', [
      { at: '2026-09-19T00:00:00.000Z', from: null, to: 'planned', transactionId: 'update-9-stuck', releaseId: 'rel-2', productVersion: '1.2.0', generation: 3 },
    ]);
    const liveRelease = 'e'.repeat(64);
    fs.writeFileSync(path.join(mocks.fakeHome, '.pd', 'active.json'), JSON.stringify({
      schemaVersion: 1, generation: 3, releaseId: liveRelease,
      releaseMetadataDigest: '4'.repeat(64), previousReleaseId: null,
      transactionId: 'txn-live', productVersion: '1.2.0',
    }), 'utf8');
    // Ghost-slot file from the pre-retirement era, pointing at a release that
    // exists nowhere in the lineage. Not even valid JSON schema — the endpoint
    // must never parse it.
    fs.writeFileSync(path.join(mocks.fakeHome, '.pd', 'previous.json'), '{"generation":"bogus"}', 'utf8');

    const body = await (await fetch(`${transactionBase}/api/update/recovery/resolve`, {
      method: 'POST',
      body: JSON.stringify({ transactionId: 'update-9-stuck' }),
    })).json();
    expect(body.data.ok).toBe(true);
    expect(body.data.outcome).toMatchObject({ kind: 'old_confirmed', releaseId: liveRelease, generation: 3 });
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

  it('PRI-896: a never-activated orphan superseded by the live release does not alarm', async () => {
    // Exactly the stranded residue a killed install leaves behind: one
    // `planned` line, no terminal state, generation long since replaced.
    writeJournal(mocks.fakeHome, 'install-1790046654982-450b61dc', [
      { at: '2026-09-20T00:00:00.000Z', from: null, to: 'planned', transactionId: 'install-1790046654982-450b61dc', releaseId: 'a'.repeat(64), productVersion: '1.2.0', generation: 2 },
    ]);
    const liveRelease = 'e'.repeat(64);
    fs.writeFileSync(path.join(mocks.fakeHome, '.pd', 'active.json'), JSON.stringify({
      schemaVersion: 1, generation: 29, releaseId: liveRelease,
      releaseMetadataDigest: '4'.repeat(64), previousReleaseId: null,
      transactionId: 'update-live', productVersion: '2.2.1',
    }), 'utf8');

    const body = await (await fetch(`${transactionBase}/api/update/recovery`)).json();
    // The banner must go quiet: the product's OWN verdict already calls this a
    // harmless superseded orphan (PRI-853 `old_confirmed`), so alarming forever
    // with no official way to converge is the defect.
    expect(body.data.needsRecovery).toBe(false);
    expect(body.data.unfinished).toHaveLength(0);
    // rc-9: the demotion is observable, never a silent drop.
    expect(body.data.superseded).toMatchObject([{ transactionId: 'install-1790046654982-450b61dc' }]);
    expect(body.data.superseded[0].reason).toMatch(/activation was never journaled/);
    // Still pure: nothing was written to the journal.
    expect(fs.readFileSync(path.join(mocks.fakeHome, '.pd', 'transactions', 'install-1790046654982-450b61dc.jsonl'), 'utf8'))
      .toContain('"to":"planned"');
  });

  it('PRI-896: an interrupted activation still alarms — demotion is not a blanket mute', async () => {
    // Pointer landed for THIS transaction but host verification never ran:
    // the verdict is `explicit_refusal`, so the alarm is real and must stay.
    writeJournal(mocks.fakeHome, 'update-3-halfway', [
      { at: '2026-09-20T00:00:00.000Z', from: null, to: 'planned', transactionId: 'update-3-halfway', releaseId: 'r'.repeat(64), productVersion: '1.3.0', generation: 4 },
      { at: '2026-09-20T00:01:00.000Z', from: 'planned', to: 'staged', transactionId: 'update-3-halfway', releaseId: 'r'.repeat(64), productVersion: '1.3.0', generation: 4 },
      { at: '2026-09-20T00:02:00.000Z', from: 'staged', to: 'probed', transactionId: 'update-3-halfway', releaseId: 'r'.repeat(64), productVersion: '1.3.0', generation: 4 },
      { at: '2026-09-20T00:03:00.000Z', from: 'probed', to: 'activated', transactionId: 'update-3-halfway', releaseId: 'r'.repeat(64), productVersion: '1.3.0', generation: 4 },
    ]);
    fs.writeFileSync(path.join(mocks.fakeHome, '.pd', 'active.json'), JSON.stringify({
      schemaVersion: 1, generation: 4, releaseId: 'r'.repeat(64),
      releaseMetadataDigest: '4'.repeat(64), previousReleaseId: null,
      transactionId: 'update-3-halfway', productVersion: '1.3.0',
    }), 'utf8');

    const body = await (await fetch(`${transactionBase}/api/update/recovery`)).json();
    expect(body.data.needsRecovery).toBe(true);
    expect(body.data.unfinished.map((item: { transactionId: string }) => item.transactionId))
      .toEqual(['update-3-halfway']);
    expect(body.data.superseded).toHaveLength(0);
    expect(body.data.nextAction).toBeTruthy();
  });

  it('PRI-896 (CR-2): a corrupt active.json is surfaced as activeRecordUnreadable, never silently swallowed (rc-9)', async () => {
    // The conservative direction keeps alarming when active.json cannot be
    // read — but silence would hide WHY. This asserts the failure is observable
    // in the recovery payload instead of masquerading as "no active record".
    writeJournal(mocks.fakeHome, 'update-4-corrupt-active', [
      { at: '2026-09-20T00:00:00.000Z', from: null, to: 'planned', transactionId: 'update-4-corrupt-active', releaseId: 'c'.repeat(64), productVersion: '1.4.0', generation: 5 },
    ]);
    // active.json exists but is not valid JSON: readActiveRecord throws
    // (active_record_corrupt) rather than returning null.
    fs.writeFileSync(path.join(mocks.fakeHome, '.pd', 'active.json'), '{ not valid json', 'utf8');

    const body = await (await fetch(`${transactionBase}/api/update/recovery`)).json();
    // The unfinished transaction is still flagged (conservative, unmuted).
    expect(body.data.unfinished.map((item: { transactionId: string }) => item.transactionId))
      .toContain('update-4-corrupt-active');
    // rc-9: the read failure is now explicit in the payload, and the next
    // action points the Owner at repairing active.json rather than the journal.
    expect(body.data.activeRecordUnreadable).toBe(true);
    expect(body.data.nextAction).toMatch(/active\.json/i);
  });

  it('PRI-896 (CR-2): a healthy active.json reports activeRecordUnreadable=false', async () => {
    // Companion to the corrupt case: the flag must default false when the sole
    // active pointer is readable, so the field is a genuine signal not an alarm.
    writeJournal(mocks.fakeHome, 'update-5-healthy', [
      { at: '2026-09-20T00:00:00.000Z', from: null, to: 'planned', transactionId: 'update-5-healthy', releaseId: 'd'.repeat(64), productVersion: '1.5.0', generation: 6 },
    ]);
    fs.writeFileSync(path.join(mocks.fakeHome, '.pd', 'active.json'), JSON.stringify({
      schemaVersion: 1, generation: 6, releaseId: 'd'.repeat(64),
      releaseMetadataDigest: '4'.repeat(64), previousReleaseId: null,
      transactionId: 'update-live', productVersion: '1.5.0',
    }), 'utf8');

    const body = await (await fetch(`${transactionBase}/api/update/recovery`)).json();
    expect(body.data.activeRecordUnreadable).toBe(false);
  });

  it('PRI-896 (CR-2): a corrupt active.json flags activeRecordUnreadable and keeps non-terminal journals as alarms (rc-9)', async () => {
    // A non-terminal journal whose "superseded" verdict depends on comparing
    // against the live release record. With active.json corrupt there is NO
    // live-release evidence, so the journal must stay an alarm (unfinished),
    // NOT be demoted to superseded — and the response must say WHY via
    // activeRecordUnreadable instead of collapsing "absent" and "unreadable"
    // into one silent null (rc-9 no-silent-fallback).
    writeJournal(mocks.fakeHome, 'update-4-cant-decide', [
      { at: '2026-09-20T00:00:00.000Z', from: null, to: 'planned', transactionId: 'update-4-cant-decide', releaseId: 'r'.repeat(64), productVersion: '1.4.0', generation: 5 },
    ]);
    // Corrupt active.json: valid path, unparseable bytes. readActiveRecord throws
    // active_record_corrupt rather than returning null.
    fs.writeFileSync(path.join(mocks.fakeHome, '.pd', 'active.json'), '{"schemaVersion":1,', 'utf8');

    const body = await (await fetch(`${transactionBase}/api/update/recovery`)).json();
    expect(body.data.needsRecovery).toBe(true);
    expect(body.data.activeRecordUnreadable).toBe(true);
    // No live-release evidence ⇒ the journal is conservatively an alarm, never demoted.
    expect(body.data.unfinished.map((item: { transactionId: string }) => item.transactionId))
      .toEqual(['update-4-cant-decide']);
    expect(body.data.superseded).toHaveLength(0);
    // rc-9: the next action points at repairing active.json, not the journals.
    expect(body.data.nextAction).toMatch(/active\.json/i);
  });

  it('PRI-896 (CR-2): an ABSENT active.json is not flagged unreadable (absent ≠ unreadable)', async () => {
    // Distinguishing fact for the CR-2 contract: "file absent" must NOT set
    // activeRecordUnreadable — only a present-but-unreadable file does. This is
    // exactly the two states the pre-fix catch collapsed.
    writeJournal(mocks.fakeHome, 'update-5-no-active', [
      { at: '2026-09-20T00:00:00.000Z', from: null, to: 'planned', transactionId: 'update-5-no-active', releaseId: 'r'.repeat(64), productVersion: '1.5.0', generation: 6 },
    ]);
    // No active.json written at all: readActiveRecord returns null.
    const body = await (await fetch(`${transactionBase}/api/update/recovery`)).json();
    expect(body.data.needsRecovery).toBe(true);
    expect(body.data.activeRecordUnreadable).toBe(false);
    // Absent evidence also keeps the alarm (conservative), but for the OTHER reason.
    expect(body.data.unfinished.map((item: { transactionId: string }) => item.transactionId))
      .toEqual(['update-5-no-active']);
    expect(body.data.nextAction).not.toMatch(/active\.json/i);
  });
});
