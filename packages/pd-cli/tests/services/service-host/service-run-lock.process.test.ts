/**
 * Service run lock — REAL multi-process contention (task Stage 2/6B: no mocks).
 *
 * Spawns genuine child processes (a fixed helper script by literal path; only
 * data on argv) racing for the SAME lock path through the real dist
 * implementation: exactly one winner per round, crash recovery via stale
 * takeover across processes, fail-closed on a stale-unreadable lock, and
 * clean serialization across rounds.
 *
 * ── P1-4 round 4 (SQLite arbitration) ─────────────────────────────────────
 * The T1–T8 scenarios below pin the round-4 contract: every acquire/takeover/
 * release decision runs inside the `BEGIN IMMEDIATE` gate transaction of
 * `service-run-gate.db`. There is no mutex FILE to reclaim, sweep or race —
 * the gate is held by the OS (fcntl/POSIX, LockFileEx/Windows) and released
 * automatically on process death. All interleavings are driven by the gated
 * child's flag files — a real condition poll, never a random sleep — and the
 * same assertions run on POSIX and Windows (T8: nothing is skipped per
 * platform).
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
const EXIT_UNWRITABLE = 9;

interface AttemptVerdict {
  code: number;
  stdout: string;
}

/** The arbitration gate path mirrors the module's private derivation. */
function gateDbPath(home: string): string {
  return path.join(path.dirname(serviceRunLockPath(home)), 'service-run-gate.db');
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
 * takeover phase — every phase runs INSIDE the gate transaction, so a
 * parked gated child still holds the arbitration lock for real.
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

function backdate(target: string): void {
  const old = new Date(Date.now() - SERVICE_RUN_LOCK_STALE_MS - 5000);
  utimesSync(target, old, old);
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
    backdate(lockPath);
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
    backdate(lockPath);
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
    backdate(lockPath);
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
    backdate(lockPath);
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
    backdate(lockPath);
    const result = await spawnAttempt(home);
    expect(result.code).toBe(EXIT_CORRUPT);
    // The protocol never deletes a lock it cannot verify.
    expect(existsSync(lockPath)).toBe(true);
  });

  // ── P1-4 round-4 arbitration scenarios T1–T8 (deterministic flag-driven
  //    interleavings; a parked gated child REALLY holds the gate
  //    transaction, which is what makes the rivals' verdicts meaningful) ──

  it('T1: a live arbitration gate is never reclaimed by file age — backdating the gate changes nothing (P1-4A)', async () => {
    const home = tempHome();
    const flagDir = tempHome();
    const { lockPath, body: staleBody } = await seedStaleLock(home);
    // A begins a stale takeover and parks INSIDE the gate transaction.
    const a = forkGated(home, ['mutex-acquired'], flagDir);
    await waitFlag(path.join(flagDir, 'at-mutex-acquired'));
    // The old protocol's attack: an attacker backdates the arbiter and
    // reclaims it. Backdate BOTH the gate db and the stale lock — neither
    // proves abandonment any more.
    backdate(gateDbPath(home));
    backdate(lockPath);
    const b = await spawnAttempt(home);
    expect(b.code).toBe(EXIT_HELD);
    expect(readFileSync(lockPath, 'utf8')).toBe(staleBody);
    // A is unaffected and completes the takeover.
    writeFileSync(path.join(flagDir, 'go-mutex-acquired'), '1');
    const aResult = await a.result;
    expect(aResult.code).toBe(0);
    expect((JSON.parse(aResult.stdout) as { stale: boolean }).stale).toBe(true);
  }, 20000);

  it('T2: two stale breakers serialize on the gate — exactly one enters the critical section, one winner (P1-4B)', async () => {
    const home = tempHome();
    const flagDir = tempHome();
    const { lockPath } = await seedStaleLock(home);
    // A reaches 'stale-verified' — the stale lock already re-verified dead,
    // the deletion one step away — and holds the gate parked there.
    const a = forkGated(home, ['stale-verified'], flagDir);
    await waitFlag(path.join(flagDir, 'at-stale-verified'));
    // C sees the same stale lock and wants to break it too. Under the gate
    // C's BEGIN IMMEDIATE can only lose (busy → held) or wait for A's
    // commit — either way it can NEVER delete A's freshly created lock.
    const c = await spawnAttempt(home);
    expect(c.code).toBe(EXIT_HELD);
    // The stale lock is still in place (A hasn't deleted it yet).
    expect(existsSync(lockPath)).toBe(true);
    writeFileSync(path.join(flagDir, 'go-stale-verified'), '1');
    const aResult = await a.result;
    // A alone completed the takeover; exactly one winner.
    expect(aResult.code).toBe(0);
    expect((JSON.parse(aResult.stdout) as { stale: boolean }).stale).toBe(true);
    // A exited cleanly → its own lock released; no foreign residue.
    expect(existsSync(lockPath)).toBe(false);
  }, 20000);

  it('T3: a resumed old owner outlives a stale verdict — B is blocked, A\'s lock is never deleted by B', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    // A is a LIVE lock owner (not a breaker): acquire + hold.
    const holder = fork(CHILD_SCRIPT, [home, '4000'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const aResult = new Promise<AttemptVerdict>((resolve, reject) => {
      let stdout = '';
      holder.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      holder.on('error', reject);
      holder.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    });
    await new Promise<void>((resolve, reject) => {
      holder.stdout?.once('data', () => resolve());
      holder.on('error', reject);
    });
    const aBody = readFileSync(lockPath, 'utf8');
    // Someone backdates A's live lock: B evaluates stale → owner ALIVE →
    // fail-closed held; B can never delete A's lock.
    backdate(lockPath);
    const b = await spawnAttempt(home);
    expect(b.code).toBe(EXIT_HELD);
    expect(readFileSync(lockPath, 'utf8')).toBe(aBody);
    // A completes normally and releases its own lock.
    expect((await aResult).code).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 20000);

  it('T4: a contender killed mid-arbitration frees the gate via the OS — the next breaker recovers (P1-4B crash path)', async () => {
    const home = tempHome();
    const flagDir = tempHome();
    const { lockPath } = await seedStaleLock(home);
    // A parks at 'stale-verified' inside the gate transaction, then dies
    // abruptly — the gate must be released by the OS, not by any sweep.
    const child = fork(CHILD_SCRIPT, [home, '0', 'stale-verified', flagDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    await waitFlag(path.join(flagDir, 'at-stale-verified'));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
    // No go-flag was ever written: A died inside the transaction with the
    // stale lock un-deleted. B must recover cleanly through the same gate.
    const b = await spawnAttempt(home);
    expect(b.code).toBe(0);
    expect((JSON.parse(b.stdout) as { stale: boolean }).stale).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  }, 20000);

  it('T5: a late release can never delete a re-created foreign lock — CAS under the gate (P1-4C)', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    // A acquires and holds briefly so we can swap the file mid-hold.
    const holder = fork(CHILD_SCRIPT, [home, '1500'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      holder.stdout?.once('data', () => resolve());
      holder.on('error', reject);
    });
    // The path now carries Lock-B (e.g. after A's crash a real takeover
    // happened): A's pending release must NOT unlink it.
    const foreignBody = '424244 foreigntoken 2026-01-01T00:00:00.000Z';
    rmSync(lockPath);
    writeFileSync(lockPath, foreignBody, 'utf8');
    const exit = await new Promise<number>((resolve) => holder.on('exit', (code) => resolve(code ?? -1)));
    expect(exit).toBe(0);
    expect(readFileSync(lockPath, 'utf8')).toBe(foreignBody);
  }, 20000);

  it('T6: a third contender during a breaker\'s arbitration reports held — never a second critical section', async () => {
    const home = tempHome();
    const flagDir = tempHome();
    const { lockPath } = await seedStaleLock(home);
    const a = forkGated(home, ['stale-verified'], flagDir);
    await waitFlag(path.join(flagDir, 'at-stale-verified'));
    // C and D both pile on while A holds the gate.
    const [c, d] = await Promise.all([spawnAttempt(home), spawnAttempt(home)]);
    expect(c.code).toBe(EXIT_HELD);
    expect(d.code).toBe(EXIT_HELD);
    writeFileSync(path.join(flagDir, 'go-stale-verified'), '1');
    const aResult = await a.result;
    expect(aResult.code).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 20000);

  it('T7: arbitration error paths fail closed — unusable gate → unwritable, never a decision outside the gate', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    // A directory where the gate database must live: open/transaction fails.
    mkdirSync(gateDbPath(home));
    const result = await spawnAttempt(home);
    expect(result.code).toBe(EXIT_UNWRITABLE);
    expect(JSON.parse(result.stdout)).toEqual({ kind: 'unwritable' });
    // The lock path was never touched: no lock, no sidecars.
    expect(existsSync(lockPath)).toBe(false);
  }, 20000);

  it('T8: arbitration leaves no sweepable state — gate db and journal survive every path, lock+sidecars stay clean', async () => {
    const home = tempHome();
    const flagDir = tempHome();
    const { lockPath } = await seedStaleLock(home);
    const a = forkGated(home, ['lock-removed'], flagDir);
    await waitFlag(path.join(flagDir, 'at-lock-removed'));
    // Mid-takeover: stale lock deleted under the gate, our create pending.
    expect(existsSync(lockPath)).toBe(false);
    writeFileSync(path.join(flagDir, 'go-lock-removed'), '1');
    const aResult = await a.result;
    expect(aResult.code).toBe(0);
    // No legacy mutex or rename sidecars were ever created — the sweep has
    // nothing to touch, and the gate db itself is intact (untouched by
    // sweepOrphanSidecars by construction: its name never matches the
    // `.mtx`/`.take-*`/`.rel-*` patterns).
    const entries = readdirSync(path.dirname(lockPath));
    expect(entries.filter((e) => e.includes('.mtx') || e.includes('.take-') || e.includes('.rel-'))).toEqual([]);
    expect(existsSync(gateDbPath(home))).toBe(true);
    // And a plain later acquire still works over the same gate (POSIX and
    // Windows run this identical assertion — no platform skips).
    expect((await spawnAttempt(home)).code).toBe(0);
  }, 20000);
});

describe('round-5 lifecycle scenarios (T9–T14)', () => {
  // A child that parks after a successful acquire until told to release.
  function forkHoldAndRelease(home: string, flagDir: string, mode = ''): Promise<AttemptVerdict> {
    return new Promise((resolve, reject) => {
      const child = fork(CHILD_SCRIPT, [home, '0', 'lock-held', flagDir, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    });
  }

  it('T9: an injected transaction-end failure after lock creation leaves NO orphan — the next contender recovers immediately', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    // First contender: creates the lock file, then the gate end is injected
    // to fail — compensation must remove OUR file, and the verdict is an
    // honest 'unwritable', never a masqueraded success.
    const failed = await new Promise<AttemptVerdict>((resolve, reject) => {
      const child = fork(CHILD_SCRIPT, [home, '0', '', '', 'acquire-end-fail'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    });
    expect(failed.code).toBe(EXIT_UNWRITABLE);
    expect(JSON.parse(failed.stdout)).toEqual({ kind: 'unwritable' });
    expect(existsSync(lockPath)).toBe(false); // compensated, no orphan
    // Next contender needs no stale window: the path is clean.
    const recovered = await spawnAttempt(home);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout).stale).toBe(false);
  }, 20000);

  it('T9b: end-failure compensation never deletes a foreign lock a different process created', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    const flagDir = tempHome();
    // A real foreign holder parks mid-hold; the end-fail contender must not
    // displace its lock even though the injection runs after evaluation.
    const holder = forkHoldAndRelease(home, flagDir);
    await waitFlag(path.join(flagDir, 'at-lock-held'));
    const foreignBody = readFileSync(lockPath, 'utf8');
    const failed = await new Promise<AttemptVerdict>((resolve, reject) => {
      const child = fork(CHILD_SCRIPT, [home, '0', '', '', 'acquire-end-fail'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    });
    expect(failed.code).toBe(EXIT_UNWRITABLE);
    expect(readFileSync(lockPath, 'utf8')).toBe(foreignBody);
    writeFileSync(path.join(flagDir, 'go-lock-held'), '1');
    expect((await holder).code).toBe(0);
  }, 20000);

  it('T10: a release racing a busy gate reports a real failure (exit 10) and never unlinks outside arbitration', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    const flagDir = tempHome();
    const holder = forkHoldAndRelease(home, flagDir);
    await waitFlag(path.join(flagDir, 'at-lock-held'));
    const holderBody = readFileSync(lockPath, 'utf8');
    // Occupy the gate ourselves — the child's release must wait its bounded
    // retry, fail honestly, and never bypass arbitration to unlink.
    const Database = (await import('better-sqlite3')).default;
    const gate = new Database(gateDbPath(home));
    gate.pragma('busy_timeout = 0');
    gate.exec('BEGIN IMMEDIATE');
    try {
      writeFileSync(path.join(flagDir, 'go-lock-held'), '1');
      const result = await holder;
      expect(result.code).toBe(10); // release failed — observable, not silent
      // The lock file survives byte-identical.
      expect(readFileSync(lockPath, 'utf8')).toBe(holderBody);
      // While the gate is still busy, no contender can acquire either.
      expect((await spawnAttempt(home)).code).toBe(EXIT_HELD);
    } finally {
      gate.exec('ROLLBACK');
      gate.close();
    }
    // The leftover lock carries a dead-holder PID (the child exited) —
    // recovery happens on PID evidence without waiting out the window.
    const recovered = await spawnAttempt(home);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout).stale).toBe(true);
  }, 30000);

  it('T10b: an injected release transaction-end failure is reported as a failure (exit 10), never a silent clean exit', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    const flagDir = tempHome();
    const holder = forkHoldAndRelease(home, flagDir, 'release-end-fail');
    await waitFlag(path.join(flagDir, 'at-lock-held'));
    const holderBody = readFileSync(lockPath, 'utf8');
    writeFileSync(path.join(flagDir, 'go-lock-held'), '1');
    const result = await holder;
    expect(result.code).toBe(10);
    // Whatever the transaction did before failing, the file is either gone
    // (our own verified delete) or still OUR body — never displaced by
    // something else.
    if (existsSync(lockPath)) expect(readFileSync(lockPath, 'utf8')).toBe(holderBody);
    expect((await spawnAttempt(home)).code).toBe(0);
  }, 20000);

  it('T11: acquire is zero-wait — a contender during a live hold AND during a busy release gets held, never a second run', async () => {
    const home = tempHome();
    const flagDir = tempHome();
    // Scenario A: A holds the lock (gate free between txn) — B is refused
    // immediately by the lock-file evaluation, then A finishes.
    const a = forkHoldAndRelease(home, flagDir);
    await waitFlag(path.join(flagDir, 'at-lock-held'));
    const started = Date.now();
    const b = await spawnAttempt(home);
    expect(b.code).toBe(EXIT_HELD);
    expect(Date.now() - started).toBeLessThan(5000); // refused immediately — never queued into a second dry-run
    writeFileSync(path.join(flagDir, 'go-lock-held'), '1');
    expect((await a).code).toBe(0);
    // Scenario B + C: a live arbiter (any transaction — e.g. a release in
    // progress) makes simultaneous contenders fail held, never two winners.
    const Database = (await import('better-sqlite3')).default;
    const gate = new Database(gateDbPath(home));
    gate.pragma('busy_timeout = 0');
    gate.exec('BEGIN IMMEDIATE');
    try {
      const [c, d] = await Promise.all([spawnAttempt(home), spawnAttempt(home)]);
      expect(c.code).toBe(EXIT_HELD);
      expect(d.code).toBe(EXIT_HELD);
    } finally {
      gate.exec('ROLLBACK');
      gate.close();
    }
    // Exactly one winner afterwards — single-instance semantics preserved.
    expect((await spawnAttempt(home)).code).toBe(0);
  }, 30000);

  it('T14: mixed-version boundary — a live legacy .mtx blocks a new contender across processes', async () => {
    const home = tempHome();
    const lockPath = serviceRunLockPath(home);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const flagDir = tempHome();
    // An "old-version" holder: a real process whose pid we record in .mtx.
    const holder = fork(CHILD_SCRIPT, [tempHome(), '0', 'lock-held', flagDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    await waitFlag(path.join(flagDir, 'at-lock-held'));
    expect(holder.pid).toBeGreaterThan(0);
    writeFileSync(`${lockPath}.mtx`, `${holder.pid} mtxtoken 2026-01-01T00:00:00.000Z`, 'utf8');
    // The old protocol's mutex owner is provably alive: the new contender
    // must refuse — never run a second coordinator beside it.
    expect((await spawnAttempt(home)).code).toBe(EXIT_HELD);
    expect(existsSync(lockPath)).toBe(false); // no lock created
    // The live .mtx itself is left in place.
    expect(readFileSync(`${lockPath}.mtx`, 'utf8')).toContain(`${holder.pid} mtxtoken`);
    writeFileSync(path.join(flagDir, 'go-lock-held'), '1');
    await new Promise<void>((resolve) => holder.on('exit', () => resolve()));
    // With the legacy owner dead, stale-age + dead-pid lets the sweep
    // remove it on a later acquire — recovery completes cleanly.
    backdate(`${lockPath}.mtx`);
    expect((await spawnAttempt(home)).code).toBe(0);
    expect(existsSync(`${lockPath}.mtx`)).toBe(false);
  }, 30000);
});
