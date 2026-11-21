/**
 * Service run lock — in-process unit semantics (Stage 2).
 *
 * Covers: normal acquire, mutual exclusion (`held`), crash recovery via
 * body-verified stale takeover, fail-closed on a stale-but-unreadable body,
 * and the release protocol never deleting a live (replaced) lock.
 */
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  SERVICE_RUN_LOCK_STALE_MS,
  acquireServiceRunLock,
  holdsServiceRunLock,
  releaseServiceRunLock,
  serviceRunLockPath,
} from '../../../src/services/service-host/locking/service-run-lock.js';

/** The arbitration gate path mirrors the module's private derivation. */
function gateDbPath(home: string): string {
  return path.join(path.dirname(serviceRunLockPath(home)), 'service-run-gate.db');
}

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-sh-lock-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SHORT_STALE = 50;

describe('acquireServiceRunLock', () => {
  it('acquires cleanly and writes an owner body containing pid + token', () => {
    const home = tempHome();
    const result = acquireServiceRunLock(home);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staleTakenOver).toBe(false);
    const body = readFileSync(serviceRunLockPath(home), 'utf8');
    expect(body).toBe(result.handle.body);
    expect(body).toContain(String(process.pid));
    expect(body.split(' ')[1]).toBe(result.handle.token);
    releaseServiceRunLock(result.handle);
    expect(existsSync(serviceRunLockPath(home))).toBe(false);
  });

  it('refuses a second instance while a valid lock is held (`held`, never takeover)', () => {
    const home = tempHome();
    const first = acquireServiceRunLock(home);
    if (!first.ok) throw new Error('first acquire must succeed');
    expect(holdsServiceRunLock(first.handle)).toBe(true);
    const second = acquireServiceRunLock(home);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe('held');
    expect(second.holderBodyHash.length).toBeGreaterThan(0);
    // The first holder still owns it.
    expect(holdsServiceRunLock(first.handle)).toBe(true);
    releaseServiceRunLock(first.handle);
    expect(existsSync(serviceRunLockPath(home))).toBe(false);
  });

  it('takes over a provably crashed holder: stale mtime AND identical body AND dead holder PID', () => {
    const home = tempHome();
    const staleBody = '424242 deadtoken 2026-01-01T00:00:00.000Z';
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, staleBody, 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    // The recorded holder pid is demonstrably dead (probe authority).
    const result = acquireServiceRunLock(home, { probes: { processAlive: (pid) => (pid === 424242 ? 'dead' : 'alive') } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staleTakenOver).toBe(true);
    releaseServiceRunLock(result.handle);
  });

  it('a stale lock whose recorded holder PID is ALIVE is never taken over (mtime alone proves nothing)', () => {
    const home = tempHome();
    const staleBody = `${process.pid} livetoken 2026-01-01T00:00:00.000Z`;
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, staleBody, 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    // This process IS the recorded holder — alive → fail-closed held, lock untouched.
    const result = acquireServiceRunLock(home);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('held');
    expect(readFileSync(lockPath, 'utf8')).toBe(staleBody);
  });

  it('a stale lock whose holder identity is unverifiable (no pid) fails closed as corrupt', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, 'notapid sometoken 2026-01-01T00:00:00.000Z', 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const result = acquireServiceRunLock(home);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('corrupt');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('an inconclusive liveness probe fails closed as held (never a guessed takeover)', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '424243 sometoken 2026-01-01T00:00:00.000Z', 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const unknown = acquireServiceRunLock(home, { probes: { processAlive: () => 'unknown' } });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.kind).toBe('held');
    expect(readFileSync(lockPath, 'utf8')).toContain('sometoken');
    const throwing = acquireServiceRunLock(home, {
      probes: {
        processAlive: () => {
          throw new Error('platform probe unavailable');
        },
      },
    });
    expect(throwing.ok).toBe(false);
    if (!throwing.ok) expect(throwing.kind).toBe('held');
  });

  it('fail-closed (`corrupt`) when the lock is stale but its body is unreadable — never a silent takeover', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    // A directory at the lock path → unreadable body.
    mkdirSync(lockPath, { recursive: true });
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const result = acquireServiceRunLock(home);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('corrupt');
  });

  it('runs the deterministic takeover phases in order (mutex → verify → delete → create)', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '424242 deadtoken 2026-01-01T00:00:00.000Z', 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const phases: string[] = [];
    const result = acquireServiceRunLock(home, {
      probes: {
        processAlive: () => 'dead',
        takeoverSync: (phase) => {
          phases.push(phase);
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(phases).toEqual(['mutex-acquired', 'stale-verified', 'lock-removed']);
    // No file mutex exists under SQLite arbitration — the gate DB holds
    // no residual locks once the transaction commits.
    expect(existsSync(`${lockPath}.mtx`)).toBe(false);
    releaseServiceRunLock(result.handle);
  });

  it('a live arbitration gate blocks the takeover path entirely — the stale lock stays byte-identical', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const staleBody = '424242 deadtoken 2026-01-01T00:00:00.000Z';
    writeFileSync(lockPath, staleBody, 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    // Another process holds BEGIN IMMEDIATE — our acquire must report
    // `held` (SQLITE_BUSY → held), never reclaim the gate by file age.
    const gate = new Database(gateDbPath(home));
    gate.exec('BEGIN IMMEDIATE');
    try {
      const result = acquireServiceRunLock(home, { probes: { processAlive: () => 'dead' } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe('held');
      expect(readFileSync(lockPath, 'utf8')).toBe(staleBody);
    } finally {
      gate.exec('ROLLBACK');
      gate.close();
    }
    // After the gate frees, the stale lock is recoverable again.
    const recovered = acquireServiceRunLock(home, { probes: { processAlive: () => 'dead' } });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) releaseServiceRunLock(recovered.handle);
  });

  it('an unusable arbitration gate fails closed as unwritable — never decides outside arbitration', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    // A directory where the gate database must live: open fails.
    mkdirSync(gateDbPath(home));
    const result = acquireServiceRunLock(home, { probes: { processAlive: () => 'dead' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unwritable');
    // And release, unable to arbitrate, must NOT unlink outside the gate:
    // plant a foreign body — it stays byte-identical.
    const foreignBody = '424244 foreigntoken 2026-01-01T00:00:00.000Z';
    writeFileSync(lockPath, foreignBody, 'utf8');
    releaseServiceRunLock({ lockPath, token: 'x', body: `${process.pid} mine 2026-01-01T00:00:00.000Z` });
    expect(readFileSync(lockPath, 'utf8')).toBe(foreignBody);
  });

  it('an abandoned (stale) takeover mutex is broken and swept — takeover still succeeds', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '424242 deadtoken 2026-01-01T00:00:00.000Z', 'utf8');
    const mtxPath = `${lockPath}.mtx`;
    writeFileSync(mtxPath, '999990 mtxtoken 2026-01-01T00:00:00.000Z', 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    utimesSync(mtxPath, old, old);
    const result = acquireServiceRunLock(home, { probes: { processAlive: () => 'dead' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staleTakenOver).toBe(true);
    expect(existsSync(mtxPath)).toBe(false);
    releaseServiceRunLock(result.handle);
  });

  it('a contender losing the post-removal create race reports held — the winner lock is untouched', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const staleBody = '424242 deadtoken 2026-01-01T00:00:00.000Z';
    writeFileSync(lockPath, staleBody, 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const winnerBody = '424243 winnertoken 2026-01-01T00:00:00.000Z';
    const result = acquireServiceRunLock(home, {
      probes: {
        processAlive: () => 'dead',
        takeoverSync: (phase) => {
          // A third process wins the create inside our removal gap —
          // deterministic, not a random sleep.
          if (phase === 'lock-removed') writeFileSync(lockPath, winnerBody, 'utf8');
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('held');
    expect(readFileSync(lockPath, 'utf8')).toBe(winnerBody);
    expect(existsSync(`${lockPath}.mtx`)).toBe(false);
  });

  it('a lock replaced mid-takeover by a FRESH foreign lock is never displaced — takeover aborts held', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '424242 deadtoken 2026-01-01T00:00:00.000Z', 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const freshBody = '424244 freshtoken 2026-01-01T00:00:00.000Z';
    const result = acquireServiceRunLock(home, {
      probes: {
        // The foreign lock's owner is a LIVE pid — only the stale one is dead.
        processAlive: (pid) => (pid === 424244 ? 'alive' : 'dead'),
        takeoverSync: (phase) => {
          // Between our stale observation and the mutex critical section a
          // different process created a live lock: the inner re-evaluation
          // must see it and refuse — the verify inside the mutex is what
          // the old rename-aside protocol lacked.
          if (phase === 'mutex-acquired') writeFileSync(lockPath, freshBody, 'utf8');
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('held');
    expect(readFileSync(lockPath, 'utf8')).toBe(freshBody);
  });

  it('the mutex is released even when the takeover critical section fails (fail-closed, retriable)', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const staleBody = '424242 deadtoken 2026-01-01T00:00:00.000Z';
    writeFileSync(lockPath, staleBody, 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    // Corrupt the lock inside the mutex: inner evaluation fails closed.
    const attempt = acquireServiceRunLock(home, {
      probes: {
        processAlive: () => 'dead',
        takeoverSync: (phase) => {
          if (phase === 'mutex-acquired') {
            // Replace the lock file with an unreadable directory AND keep it
            // stale — the inner re-evaluation must see a corrupt lock, not a
            // fresh one.
            rmSync(lockPath);
            mkdirSync(lockPath);
            utimesSync(lockPath, old, old);
          }
        },
      },
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.kind).toBe('corrupt');
    // The mutex was released by the finally — a new contender sees the
    // same corrupt verdict, not a stale-mutex hang.
    const second = acquireServiceRunLock(home, { probes: { processAlive: () => 'dead' } });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.kind).toBe('corrupt');
    // The arbitration transaction rolled back — no residual gate hold.
    expect(existsSync(`${lockPath}.mtx`)).toBe(false);
  });

  it('never takes over a FRESH lock, even with a foreign body (valid run protection)', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${process.pid} livetoken ${new Date().toISOString()}`, 'utf8');
    const result = acquireServiceRunLock(home);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('held');
  });

  it('a fresh foreign lock is never taken over nor deleted (valid-run protection)', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    // Fresh lock with a body this process never wrote: below the stale
    // window, so no takeover attempt may touch it at all.
    writeFileSync(lockPath, `${process.pid} livetoken ${new Date().toISOString()}`, 'utf8');
    const attempt = acquireServiceRunLock(home, { staleMs: SHORT_STALE });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.kind).toBe('held');
    // The live lock still exists, byte-identical.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toContain('livetoken');
  });
});

describe('releaseServiceRunLock', () => {
  it('release is ownership-checked: a taken-over holder cannot delete the new holder lock', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    // Holder A (will go stale AND is reported dead by the probe — simulating
    // A's crash; takeover requires the dead-holder proof now).
    const a = acquireServiceRunLock(home);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    // Backdate so B can take over.
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const b = acquireServiceRunLock(home, { probes: { processAlive: () => 'dead' } });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.staleTakenOver).toBe(true);
    // A's late release must NOT delete B's lock.
    releaseServiceRunLock(a.handle);
    expect(readFileSync(lockPath, 'utf8')).toBe(b.handle.body);
    releaseServiceRunLock(b.handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('release NEVER moves a foreign lock — not even transiently (P1-4 pre-check)', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    // A lock belonging entirely to another holder.
    const foreignBody = '424244 foreigntoken 2026-01-01T00:00:00.000Z';
    writeFileSync(lockPath, foreignBody, 'utf8');
    // A stale-outed holder releasing MUST leave the file exactly in place —
    // the pre-check means it is never even renamed aside.
    releaseServiceRunLock({ lockPath, token: 'mytoken', body: `${process.pid} mytoken 2026-01-01T00:00:00.000Z` });
    expect(readFileSync(lockPath, 'utf8')).toBe(foreignBody);
    // No .rel-* sidecar was ever created for the foreign lock.
    const leftovers = readdirSync(path.dirname(lockPath)).filter((e) => e.includes('.rel-') || e.includes('.take-'));
    expect(leftovers).toEqual([]);
  });

  it('release of an already-released lock is a no-op', () => {
    const home = tempHome();
    const result = acquireServiceRunLock(home);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    releaseServiceRunLock(result.handle);
    releaseServiceRunLock(result.handle);
    expect(existsSync(serviceRunLockPath(home))).toBe(false);
  });
});

describe('round-5 lock lifecycle (P0/P1)', () => {
  it('a fresh lock whose recorded holder is provably dead is recovered without waiting for the stale window (§P0.8)', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    // Fresh mtime, dead recorded holder — the 30-minute window bounds only
    // UNVERIFIABLE ownership, never verified death.
    writeFileSync(lockPath, '424242 deadtoken 2026-01-01T00:00:00.000Z', 'utf8');
    const result = acquireServiceRunLock(home, { probes: { processAlive: () => 'dead' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staleTakenOver).toBe(true);
    releaseServiceRunLock(result.handle);
  });

  it('a fresh lock whose recorded holder is ALIVE or unverifiable stays held — never a guessed takeover', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '424242 livetoken 2026-01-01T00:00:00.000Z', 'utf8');
    for (const probe of [() => 'alive' as const, () => 'unknown' as const]) {
      const result = acquireServiceRunLock(home, { probes: { processAlive: probe } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('held');
      expect(readFileSync(lockPath, 'utf8')).toContain('livetoken');
    }
  });

  it('P0/T9: a transaction-end failure after creating the lock is compensated — no orphan survives (§P0)', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    // Injected transaction-end failure: the lock file WAS created, then the
    // gate end failed — compensation must remove OUR file, and the verdict
    // must be an honest failure, never a masqueraded success.
    const failed = acquireServiceRunLock(home, { probes: { gateEndFailure: true } });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.kind).toBe('unwritable');
    expect(existsSync(lockPath)).toBe(false);
    // The next acquire needs no stale window: the path is clean.
    const recovered = acquireServiceRunLock(home);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.staleTakenOver).toBe(false);
    releaseServiceRunLock(recovered.handle);
  });

  it('P0/T9: end-failure compensation never deletes a lock a different process created', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    // A live foreign lock is already in place: the failed contender must
    // leave it byte-identical.
    const foreignBody = `${process.pid} foreigntoken 2026-01-01T00:00:00.000Z`;
    writeFileSync(lockPath, foreignBody, 'utf8');
    const failed = acquireServiceRunLock(home, { probes: { gateEndFailure: true } });
    expect(failed.ok).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toBe(foreignBody);
  });

  it('P1/T10: release returns released / not_owned / failed_unwritable / failed_busy as structured results', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    // released
    const held = acquireServiceRunLock(home);
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(releaseServiceRunLock(held.handle)).toBe('released');
    let postReleaseBody: string | undefined;
    try {
      postReleaseBody = readFileSync(lockPath, 'utf8');
    } catch {
      postReleaseBody = undefined;
    }
    expect(postReleaseBody).toBeUndefined();
    // not_owned: foreign body in place — never deleted.
    const foreignBody = '424244 foreigntoken 2026-01-01T00:00:00.000Z';
    writeFileSync(lockPath, foreignBody, 'utf8');
    expect(releaseServiceRunLock({ lockPath, token: 'mine', body: `${process.pid} mine 2026-01-01T00:00:00.000Z` })).toBe('not_owned');
    expect(readFileSync(lockPath, 'utf8')).toBe(foreignBody);
    // failed_unwritable: injected transaction-end failure. The compare-and-
    // delete inside the transaction may already have removed our verified
    // lock — the honest contract is only that the result reports the failure
    // and no FOREIGN body is ever displaced.
    expect(releaseServiceRunLock({ lockPath, token: 'mine', body: foreignBody }, { injectEndFailure: true })).toBe('failed_unwritable');
    let survivingBody: string | undefined;
    try {
      survivingBody = readFileSync(lockPath, 'utf8');
    } catch {
      survivingBody = undefined;
    }
    if (survivingBody !== undefined) expect(survivingBody).toBe(foreignBody);
    rmSync(lockPath, { force: true });
    // not_owned again once the file is simply gone.
    expect(releaseServiceRunLock({ lockPath, token: 'mine', body: 'x y z' })).toBe('not_owned');
  });

  it('P1/T10: a busy gate makes release fail as failed_busy after the bounded retry — never an unlink outside the gate', () => {
    const home = tempHome();
    const held = acquireServiceRunLock(home);
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    const gate = new Database(gateDbPath(home));
    gate.exec('BEGIN IMMEDIATE');
    try {
      expect(releaseServiceRunLock(held.handle)).toBe('failed_busy');
      // The lock file stays — a failed release never bypasses arbitration.
      expect(readFileSync(serviceRunLockPath(home), 'utf8')).toBe(held.handle.body);
    } finally {
      gate.exec('ROLLBACK');
      gate.close();
    }
    // Once the gate frees, release completes normally.
    expect(releaseServiceRunLock(held.handle)).toBe('released');
    expect(existsSync(serviceRunLockPath(home))).toBe(false);
  }, 15000);

  it('P1/T13: a live legacy .mtx blocks a new-protocol acquire — mixed-version double-run is impossible', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    // An old-version coordinator mid-takeover: its .mtx records a LIVE pid.
    writeFileSync(`${lockPath}.mtx`, `${process.pid} mtxtoken 2026-01-01T00:00:00.000Z`, 'utf8');
    const result = acquireServiceRunLock(home);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('held');
    expect(existsSync(lockPath)).toBe(false);
    // The .mtx itself is untouched (fresh mtime anyway — nothing swept).
    expect(existsSync(`${lockPath}.mtx`)).toBe(true);
  });

  it('P1/T13: legacy .mtx with unverifiable ownership fails closed — corrupt body and unreadable file both held', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    // Unparseable body → cannot prove the legacy holder died.
    writeFileSync(`${lockPath}.mtx`, 'garbage-without-pid', 'utf8');
    const corrupt = acquireServiceRunLock(home, { probes: { processAlive: () => 'dead' } });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.kind).toBe('held');
    // Unreadable .mtx (a directory at the path) → still fail-closed held.
    rmSync(`${lockPath}.mtx`);
    mkdirSync(`${lockPath}.mtx`);
    const unreadable = acquireServiceRunLock(home, { probes: { processAlive: () => 'dead' } });
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.kind).toBe('held');
  });

  it('P1/T13: the sweep removes only stale+dead-pid sidecars — live, unknown, unparseable and fresh stay', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    const seed = (name: string, body: string, stale: boolean) => {
      const p = path.join(path.dirname(lockPath), name);
      writeFileSync(p, body, 'utf8');
      if (stale) utimesSync(p, old, old);
      return p;
    };
    const deadMtx = seed(`${path.basename(lockPath)}.mtx`, '424242 m 2026-01-01T00:00:00.000Z', true);
    const liveTake = seed(`${path.basename(lockPath)}.take-live`, '424243 t 2026-01-01T00:00:00.000Z', true);
    // Fresh = the BODY's recorded createdAt is recent (staleness reads the
    // recorded timestamp, never mtime) — a dead pid alone is not enough.
    const freshRel = seed(`${path.basename(lockPath)}.rel-fresh`, `424242 r ${new Date().toISOString()}`, false);
    const junk = seed(`${path.basename(lockPath)}.take-junk`, 'unparseable', true);
    const gateShm = seed('service-run-gate.db-shm', 'x', true);
    const result = acquireServiceRunLock(home, {
      probes: { processAlive: (pid) => (pid === 424242 ? 'dead' : 'alive') },
    });
    expect(result.ok).toBe(true);
    // dead+stale swept; live/unknown/fresh/unparseable kept; gate sidecars never touched.
    expect(existsSync(deadMtx)).toBe(false);
    expect(existsSync(liveTake)).toBe(true);
    expect(existsSync(freshRel)).toBe(true);
    expect(existsSync(junk)).toBe(true);
    expect(existsSync(gateShm)).toBe(true);
    if (result.ok) releaseServiceRunLock(result.handle);
  });
});
