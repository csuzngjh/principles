/**
 * PRI-1069/1070 (G1 P0-4, SPEC v1.2 §17): terminal `failed` transactions
 * whose detail carries a restore inconsistency marker (`restore_incomplete:`
 * / `restore_deferred:`) MUST stay visible in the recovery surface — they
 * describe a PHYSICAL install the terminal state cannot vouch for. Skipping
 * terminal facts wholesale is exactly how the PRI-1069 half-restored runtime
 * stayed invisible to the Owner.
 *
 * Real journals + real route handler over a fake home (same harness pattern
 * as update-state-contract.test.ts); only the homedir is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

const mocks = vi.hoisted(() => ({ fakeHome: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.fakeHome,
}));
import { handleUpdateTransactionRoute } from '../../../src/server/routes/update-transaction.js';

function writeJournal(home: string, transactionId: string, lines: Array<Record<string, unknown>>): void {
  const transactionsDir = path.join(home, '.pd', 'transactions');
  fs.mkdirSync(transactionsDir, { recursive: true });
  const digest = 'a'.repeat(64);
  const body = lines.map((line) => `${JSON.stringify({ releaseMetadataDigest: digest, ...line })}\n`).join('');
  fs.writeFileSync(path.join(transactionsDir, `${transactionId}.jsonl`), body, 'utf8');
}

interface RecoveryPayload {
  needsRecovery: boolean;
  unfinished: Array<{ transactionId: string }>;
  recoveryRequired?: Array<{ transactionId: string; reason: string }>;
  broken: Array<{ transactionId: string }>;
}

describe('P0-4 recovery visibility of restore-inconsistent terminal failures', () => {
  let home: string;
  let server: ReturnType<typeof createServer>;
  let base: string;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-recovery-visibility-'));
    mocks.fakeHome = home;
    server = createServer((req, res) => {
      void (async () => {
        if (req.url === '/api/update/recovery') {
          await handleUpdateTransactionRoute(req, res, '/recovery');
          return;
        }
        res.statusCode = 404;
        res.end();
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(home)) fs.rmSync(home, { recursive: true, force: true });
  });

  async function getRecovery(): Promise<RecoveryPayload> {
    const response = await fetch(`${base}/api/update/recovery`);
    const body = (await response.json()) as { success: boolean; data: RecoveryPayload };
    expect(body.success).toBe(true);
    return body.data;
  }

  it('a terminal failed WITH restore_incomplete marker appears in recoveryRequired and sets needsRecovery', async () => {
    writeJournal(home, 'update-1793533600000-abcdef01', [
      { at: '2026-11-01T03:25:44.000Z', from: null, to: 'planned', transactionId: 'update-1793533600000-abcdef01', releaseId: 'r1', productVersion: '2.7.0', generation: 1 },
      { at: '2026-11-01T03:38:06.000Z', from: 'planned', to: 'failed', transactionId: 'update-1793533600000-abcdef01', releaseId: 'r1', productVersion: '2.7.0', generation: 1, detail: 'restore_incomplete: extension=restored runtime=failed; preserved=[<runtime-backup>]; re-run the installer to retry recovery' },
    ]);
    const recovery = await getRecovery();
    expect(recovery.needsRecovery).toBe(true);
    expect(recovery.recoveryRequired ?? []).toHaveLength(1);
    expect(recovery.recoveryRequired![0]!.transactionId).toBe('update-1793533600000-abcdef01');
    expect(recovery.recoveryRequired![0]!.reason).toContain('restore_incomplete');
  });

  it('a terminal failed WITH restore_deferred marker is equally visible', async () => {
    writeJournal(home, 'update-1793533600001-bcdef012', [
      { at: '2026-11-01T03:25:44.000Z', from: null, to: 'planned', transactionId: 'update-1793533600001-bcdef012', releaseId: 'r1', productVersion: '2.7.0', generation: 1 },
      { at: '2026-11-01T03:38:06.000Z', from: 'planned', to: 'failed', transactionId: 'update-1793533600001-bcdef012', releaseId: 'r1', productVersion: '2.7.0', generation: 1, detail: 'restore_deferred: child pid=4242 not confirmed exited; destructive restore deferred' },
    ]);
    const recovery = await getRecovery();
    expect(recovery.needsRecovery).toBe(true);
    expect((recovery.recoveryRequired ?? []).some((r) => r.transactionId === 'update-1793533600001-bcdef012')).toBe(true);
  });

  it('an ordinary terminal failed (clean rollback story, no marker) stays hidden — history, not an alarm', async () => {
    writeJournal(home, 'update-1793533600002-cdef0123', [
      { at: '2026-11-01T03:25:44.000Z', from: null, to: 'planned', transactionId: 'update-1793533600002-cdef0123', releaseId: 'r1', productVersion: '2.7.0', generation: 1 },
      { at: '2026-11-01T03:38:06.000Z', from: 'planned', to: 'failed', transactionId: 'update-1793533600002-cdef0123', releaseId: 'r1', productVersion: '2.7.0', generation: 1, detail: 'Console verification failed: all attempts failed' },
    ]);
    const recovery = await getRecovery();
    expect(recovery.needsRecovery).toBe(false);
    expect(recovery.recoveryRequired ?? []).toHaveLength(0);
    expect(recovery.unfinished).toHaveLength(0);
  });

  it('a terminal rolled_back transaction is never treated as a recovery need', async () => {
    writeJournal(home, 'update-1793533600003-def01234', [
      { at: '2026-11-01T03:25:44.000Z', from: null, to: 'planned', transactionId: 'update-1793533600003-def01234', releaseId: 'r1', productVersion: '2.7.0', generation: 1 },
      { at: '2026-11-01T03:38:06.000Z', from: 'planned', to: 'rolled_back', transactionId: 'update-1793533600003-def01234', releaseId: 'r1', productVersion: '2.7.0', generation: 1, detail: 'previous release restored' },
    ]);
    const recovery = await getRecovery();
    expect(recovery.needsRecovery).toBe(false);
    expect(recovery.recoveryRequired ?? []).toHaveLength(0);
  });
});
