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

/**
 * Fork a gated child (deterministic takeover interleaving): it writes
 * `<flagDir>/at-<phase>` and waits for `<flagDir>/go-<phase>` at each listed
 * takeover phase. Returns the child handle plus its result promise so the
 * parent can interleave contenders at exact critical-section points.
 */
function forkGated(home: string, phases: string[], flagDir: string, holdMs = 0): { result: Promise<AttemptVerdict> } {
  const result = new Promise<AttemptVerdict>((resolve, reject) => {
    const child = fork(CHILD_SCRIPT, [home, String(holdMs), phases.join(','), flagDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
  });
  return { result };
}

/** Wait until a flag file appears (bounded poll on a real condition). */
async function waitFlag(flagPath: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!existsSync(flagPath)) {
    if (Date.now() > deadline) throw new Error(`flag timeout: ${flagPath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A guaranteed-dead PID: spawn a child that acquires+releases in a scratch
 * home and exits for real; its PID is demonstrably dead afterwards. */
async function deadPid(): Promise<number> {
  const child = fork(CHILD_SCRIPT, [tempHome(), '0'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', () => resolve());
  });
  const pid = child.pid ?? -1;
  expect(pid).toBeGreaterThan(0);
  return pid;
}

/** Seed a provably-dead stale lock; returns its exact body for assertions. */
async function seedStaleLock(home: string): Promise<{ lockPath: string; body: string }> {
  const pid = await deadPid();
  const lockPath = serviceRunLockPath(home);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const body = `${pid} deadtoken 2026-01-01T00:00:00.000Z`;
  writeFileSync(lockPath, body, 'utf8');
  const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
  utimesSync(lockPath, old, old);
  return { lockPath, body };
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

  // ── P1-4 deterministic takeover interleavings (no random sleeps: the
  //    gated child pauses at injected sync points and the parent runs a
  //    second contender at an exact critical-section boundary) ──

  it('a second takeover contender is BLOCKED by the mutex — it can never displace the in-progress takeover (P1-4 regression)', async () => {
    const home = tempHome();
    const flagDir = tempHome();
    const { lockPath, body: staleBody } = await seedStaleLock(home);
    // A begins the takeover and pauses INSIDE the mutex, before the
    // verify→delete step.
    const a = forkGated(home, ['mutex-acquired'], flagDir);
    await waitFlag(path.join(flagDir, 'at-mutex-acquired'));
    // B sees the same stale lock and wants it too. With the takeover mutex
    // held by A, B's ONLY answer is `held` — it can never reach the lock
    // file. The old rename-aside protocol let B move A's lock aside right
    // here; the lock body must therefore stay byte-identical and no
    // `.take-*` sidecar may appear while B runs.
    const b = await spawnAttempt(home);
    expect(b.code).toBe(EXIT_HELD);
    expect(readFileSync(lockPath, 'utf8')).toBe(staleBody);
    const leftovers = readdirSync(path.dirname(lockPath)).filter((e) => e.includes('.take-'));
    expect(leftovers).toEqual([]);
    // Let A finish: it takes over and wins.
    writeFileSync(path.join(flagDir, 'go-mutex-acquired'), '1');
    const aResult = await a.result;
    expect(aResult.code).toBe(0);
    expect((JSON.parse(aResult.stdout) as { stale: boolean }).stale).toBe(true);
  });

  it('a direct creator racing the takeover deletion gap gets the lock and the takeover loses honestly — exactly one holder', async () => {
    const home = tempHome();
    const flagDir = tempHome();
    const { lockPath } = await seedStaleLock(home);
    // A pauses AFTER unlinking the stale lock, before creating its own —
    // the exact gap where a third process can win the create.
    const a = forkGated(home, ['lock-removed'], flagDir);
    await waitFlag(path.join(flagDir, 'at-lock-removed'));
    expect(existsSync(lockPath)).toBe(false);
    // C does a plain acquire: the path is empty, so C wins the create and
    // holds the lock (long hold so A's create attempt definitely overlaps).
    const c = fork(CHILD_SCRIPT, [home, '1500'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const cResult = new Promise<AttemptVerdict>((resolve, reject) => {
      let stdout = '';
      c.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      c.on('error', reject);
      c.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    });
    // Wait until C actually holds the lock before letting A continue.
    await new Promise<void>((resolve, reject) => {
      c.stdout?.once('data', () => resolve());
      c.on('error', reject);
    });
    writeFileSync(path.join(flagDir, 'go-lock-removed'), '1');
    const aResult = await a.result;
    // A's takeover created nothing: C is the single holder and A reports
    // held honestly — never a second lock, never a displaced holder.
    expect(aResult.code).toBe(EXIT_HELD);
    const cOutcome = await cResult;
    expect(cOutcome.code).toBe(0);
  }, 20000);

  it('an abandoned takeover mutex (crashed mid-takeover) is broken safely — recovery, one winner, no orphans', async () => {
    const home = tempHome();
    const flagDir = tempHome();
    const { lockPath } = await seedStaleLock(home);
    // Simulate a takeover that crashed holding the mutex: a stale .mtx orphan.
    const mtxPath = `${lockPath}.mtx`;
    writeFileSync(mtxPath, '999990 mtxtoken 2026-01-01T00:00:00.000Z', 'utf8');
    const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
    utimesSync(mtxPath, old, old);
    // B takes over: it can only reach 'stale-verified' by having broken the
    // stale mutex and acquired its own — the flag proves recovery works.
    const b = forkGated(home, ['stale-verified'], flagDir);
    await waitFlag(path.join(flagDir, 'at-stale-verified'));
    // While B is inside the critical section a second contender is blocked
    // by B's FRESH mutex: 'held', deterministic — never a second winner.
    const a = await spawnAttempt(home);
    expect(a.code).toBe(EXIT_HELD);
    writeFileSync(path.join(flagDir, 'go-stale-verified'), '1');
    const bResult = await b.result;
    expect(bResult.code).toBe(0);
    expect((JSON.parse(bResult.stdout) as { stale: boolean }).stale).toBe(true);
    // No lock, mutex, or sidecar orphans survive.
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(mtxPath)).toBe(false);
    const leftovers = readdirSync(path.dirname(lockPath)).filter(
      (e) => e.includes('.take-') || e.includes('.rel-') || e.includes('.mtx'),
    );
    expect(leftovers).toEqual([]);
  });

  it('a fresh takeover mutex blocks a real contender until released (fail-closed held)', async () => {
    const home = tempHome();
    const flagDir = tempHome();
    const { lockPath } = await seedStaleLock(home);
    const a = forkGated(home, ['mutex-acquired'], flagDir);
    await waitFlag(path.join(flagDir, 'at-mutex-acquired'));
    // While A holds the mutex, a real second contender reports held and
    // the stale lock is untouched.
    const b = await spawnAttempt(home);
    expect(b.code).toBe(EXIT_HELD);
    writeFileSync(path.join(flagDir, 'go-mutex-acquired'), '1');
    const aResult = await a.result;
    expect(aResult.code).toBe(0);
    expect(existsSync(`${lockPath}.mtx`)).toBe(false);
  });
});
