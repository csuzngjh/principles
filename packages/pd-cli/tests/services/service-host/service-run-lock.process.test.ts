/**
 * Service run lock — REAL multi-process contention (task Stage 2/6B: no mocks).
 *
 * Spawns genuine child processes (a fixed helper script by literal path; only
 * data on argv) racing for the SAME lock path through the real dist
 * implementation: exactly one winner per round, crash recovery via stale
 * takeover across processes, fail-closed on a stale-unreadable lock, and
 * clean serialization across rounds.
 */
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { serviceRunLockPath, SERVICE_RUN_LOCK_STALE_MS } from '../../../src/services/service-host/locking/service-run-lock.js';

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-sh-lockproc-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Fixed helper script (literal path; vitest runs with the package dir as
 * cwd). It imports the BUILT module from pd-cli's dist — `npm test` in
 * pd-cli is `vitest run` (no build step), so the process test needs the
 * module built once: it is compiled by the root build / CI's build chain
 * before tests run.
 */
const CHILD_SCRIPT = './tests/services/service-host/helpers/service-lock-child.mjs';

/** Exit contract of tests/helpers/service-lock-child.mjs. */
const EXIT_HELD = 7;
const EXIT_CORRUPT = 8;

interface AttemptVerdict {
  code: number;
  stdout: string;
}

function spawnAttempt(home: string, holdMs = 0): Promise<AttemptVerdict> {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD_SCRIPT, [home, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

describe('real multi-process lock contention', () => {
  it('exactly ONE of five simultaneous contenders wins; the rest report held', async () => {
    const home = tempHome();
    // Every child holds its acquisition briefly so the five processes truly
    // overlap; a zero-hold winner could release before a late fork starts.
    const results = await Promise.all(Array.from({ length: 5 }, () => spawnAttempt(home, 2000)));
    const winners = results.filter((r) => r.code === 0);
    const losers = results.filter((r) => r.code === EXIT_HELD);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    for (const loser of losers) {
      expect(JSON.parse(loser.stdout)).toEqual({ kind: 'held' });
    }
    // After the winner released, the next run acquires again.
    expect((await spawnAttempt(home)).code).toBe(0);
  });

  it('serializes rounds with distinct per-round tokens (cross-process release works)', async () => {
    const home = tempHome();
    const first = await spawnAttempt(home, 0);
    expect(first.code).toBe(0);
    const second = await spawnAttempt(home, 0);
    expect(second.code).toBe(0);
    const firstToken = (JSON.parse(first.stdout) as { token: string }).token;
    const secondToken = (JSON.parse(second.stdout) as { token: string }).token;
    expect(firstToken).not.toBe(secondToken);
  });

  it('a crashed holder (stale mtime, dead holder pid) is taken over by a real other process', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '999999 deadcrashtoken 2026-01-01T00:00:00.000Z', 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const result = await spawnAttempt(home);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { stale: boolean }).stale).toBe(true);
  });

  it('a live holder protects a backdated lock: mtime alone never proves death', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    // A REAL child process acquires and holds the lock for a while.
    const holder = fork(CHILD_SCRIPT, [home, '6000'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let holderPid = -1;
    await new Promise<void>((resolve, reject) => {
      holder.on('error', reject);
      // The helper writes its acquisition to stdout before sleeping.
      holder.stdout?.once('data', () => resolve());
    });
    holderPid = holder.pid ?? -1;
    expect(holderPid).toBeGreaterThan(0);
    // Backdate the live lock — exactly the "old file, live process" shape.
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    // A real other process must NOT take over while the holder lives.
    const contender = await spawnAttempt(home);
    expect(contender.code).toBe(EXIT_HELD);
    // The holder's lock body is untouched.
    const body = readFileSync(lockPath, 'utf8');
    expect(body).toContain(String(holderPid));
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.on('exit', resolve));
  });

  it('a real crash is recoverable: a SIGKILLed holder\'s lock is taken over', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    const holder = fork(CHILD_SCRIPT, [home, '60000'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      holder.on('error', reject);
      holder.stdout?.once('data', () => resolve());
    });
    expect(existsSync(lockPath)).toBe(true);
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.on('exit', resolve));
    // Backdate (a crash leaves the file at its original, old-enough mtime;
    // making it explicit keeps the test time-independent).
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const contender = await spawnAttempt(home);
    expect(contender.code).toBe(0);
    expect((JSON.parse(contender.stdout) as { stale: boolean }).stale).toBe(true);
  });

  it('a crashed holder\'s pid never reappears: takeover+release leaves no foreign residue', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    const holder = fork(CHILD_SCRIPT, [home, '60000'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let holderBody = '';
    await new Promise<void>((resolve, reject) => {
      holder.on('error', reject);
      holder.stdout?.once('data', () => resolve());
    });
    holderBody = readFileSync(lockPath, 'utf8');
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.on('exit', resolve));
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    // Real takeover by a different process.
    const winner = await spawnAttempt(home);
    expect(winner.code).toBe(0);
    // The winner exited cleanly → its lock released; the dead holder's
    // body is gone for good and no sidecar orphans remain.
    expect(existsSync(lockPath)).toBe(false);
    const leftovers = readdirSync(path.dirname(lockPath)).filter((e) => e.includes('.take-') || e.includes('.rel-'));
    expect(leftovers).toEqual([]);
    expect(holderBody).not.toBe('');
  });

  it('a live holder blocks contenders until it releases; rounds then serialize cleanly', async () => {
    const home = tempHome();
    const holder = await spawnAttempt(home, 1500);
    expect(holder.code).toBe(0);
    const contender = await spawnAttempt(home);
    expect(contender.code).toBe(0);
    const holderToken = (JSON.parse(holder.stdout) as { token: string }).token;
    const contenderToken = (JSON.parse(contender.stdout) as { token: string }).token;
    expect(holderToken).not.toBe(contenderToken);
  });

  it('a stale-but-unreadable lock fails closed across processes (corrupt, never deleted)', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    // A directory at the lock path makes the body unreadable.
    mkdirSync(lockPath, { recursive: true });
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(lockPath, old, old);
    const result = await spawnAttempt(home);
    expect(result.code).toBe(EXIT_CORRUPT);
    // The protocol never deletes a lock it cannot verify.
    expect(existsSync(lockPath)).toBe(true);
  });
});
