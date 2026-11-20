/**
 * Service run lock — in-process unit semantics (Stage 2).
 *
 * Covers: normal acquire, mutual exclusion (`held`), crash recovery via
 * body-verified stale takeover, fail-closed on a stale-but-unreadable body,
 * and the release protocol never deleting a live (replaced) lock.
 */
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  SERVICE_RUN_LOCK_STALE_MS,
  acquireServiceRunLock,
  holdsServiceRunLock,
  releaseServiceRunLock,
  serviceRunLockPath,
} from '../src/locking/service-run-lock.js';

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

  it('takes over a crashed holder: stale mtime AND identical body, and reports staleTakenOver', () => {
    const home = tempHome();
    const staleBody = `${process.pid} deadtoken 2026-01-01T00:00:00.000Z`;
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, staleBody, 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const result = acquireServiceRunLock(home);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staleTakenOver).toBe(true);
    releaseServiceRunLock(result.handle);
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
    // Holder A (will go stale).
    const a = acquireServiceRunLock(home);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    // Backdate so B can take over.
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const b = acquireServiceRunLock(home);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.staleTakenOver).toBe(true);
    // A's late release must NOT delete B's lock.
    releaseServiceRunLock(a.handle);
    expect(readFileSync(lockPath, 'utf8')).toBe(b.handle.body);
    releaseServiceRunLock(b.handle);
    expect(existsSync(lockPath)).toBe(false);
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
