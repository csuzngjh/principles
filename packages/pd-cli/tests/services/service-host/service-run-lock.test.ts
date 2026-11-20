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
