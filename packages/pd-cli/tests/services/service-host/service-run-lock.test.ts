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
import {
  SERVICE_RUN_LOCK_STALE_MS,
  acquireServiceRunLock,
  holdsServiceRunLock,
  releaseServiceRunLock,
  serviceRunLockPath,
} from '../../../src/services/service-host/locking/service-run-lock.js';

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
    // The mutex was released once the takeover finished.
    expect(existsSync(`${lockPath}.mtx`)).toBe(false);
    releaseServiceRunLock(result.handle);
  });

  it('a FRESH takeover mutex blocks the takeover path entirely — the stale lock stays byte-identical', () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const staleBody = '424242 deadtoken 2026-01-01T00:00:00.000Z';
    writeFileSync(lockPath, staleBody, 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    // A live mutex = a takeover in progress right now.
    writeFileSync(`${lockPath}.mtx`, `${process.pid} mtxlive ${new Date().toISOString()}`, 'utf8');
    const result = acquireServiceRunLock(home, { probes: { processAlive: () => 'dead' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('held');
    expect(readFileSync(lockPath, 'utf8')).toBe(staleBody);
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
        processAlive: () => 'dead',
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
