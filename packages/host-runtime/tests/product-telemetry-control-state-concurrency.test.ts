/**
 * PRI-1151 — REAL cross-process concurrency tests for the product-telemetry
 * control-state lock, running the REAL BUILT production code (dist/, built
 * before the suites in CI) in separate OS processes with a deterministic
 * stdio barrier (no mocks, no sleeps for ordering).
 *
 * Highest acceptance principle under test: once disable succeeds, no
 * concurrent migration / enable / reset / bookkeeping merge can restore the
 * previous granted consent or secret from a stale read.
 *
 * Process launching lives in ./concurrency/child-launcher.mjs (literal
 * fork target, child inputs on stdin); this file only speaks the line
 * protocol.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getProductTelemetryStatePath,
  readProductTelemetryControlState,
  withControlStateLock,
} from '../src/product-telemetry/consent-store.js';
import { createProductTelemetryService } from '../src/product-telemetry/service.js';
import { launchTelemetryChild } from './concurrency/child-launcher.mjs';

const EXPECTED_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'concurrency', 'telemetry-child.mjs');

interface ChildLike {
  stdin: { write(chunk: string): void };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  exitCode: number | null;
  on(event: string, listener: (...args: never[]) => void): unknown;
  kill(): void;
}

let homeDir: string;
let children: ChildLike[];

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-lock-'));
  children = [];
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
});

interface ChildHandle {
  child: ChildLike;
  /** Resolves with the next line carrying the given prefix (every matching
   *  waiter is served — a line is never swallowed by an abandoned waiter).
   *  Fails loudly on child exit. */
  waitLine(prefix: string, timeoutMs?: number): Promise<string>;
  send(line: string): void;
  /** Resolves with the parsed RESULT payload. */
  waitResult(timeoutMs?: number): Promise<Record<string, unknown>>;
  exited(): Promise<number | null>;
}

function assertChildBuilt(): void {
  if (!fs.statSync(EXPECTED_ENTRY).isFile()) {
    throw new Error(`telemetry child entry not found: ${EXPECTED_ENTRY}`);
  }
}

function startChild(mode: string, arg1?: string, arg2?: string): ChildHandle {
  assertChildBuilt();
  const config: Record<string, string> = { homeDir, mode };
  if (arg1 !== undefined) config.arg1 = arg1;
  if (arg2 !== undefined) config.arg2 = arg2;
  const child = launchTelemetryChild(config) as unknown as ChildLike;
  children.push(child);
  const lines: string[] = [];
  const waiters: Array<{ prefix: string; resolve: (line: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line: string) => {
    lines.push(line);
    for (const waiter of [...waiters]) {
      if (line.startsWith(waiter.prefix)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.on('exit', () => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`child exited before '${waiter.prefix}'; stderr: ${stderr.slice(0, 400)}`));
    }
  });
  const waitLine = (prefix: string, timeoutMs = 20_000) =>
    new Promise<string>((resolve, reject) => {
      const existing = lines.find((line) => line.startsWith(prefix));
      if (existing !== undefined) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`timeout waiting for '${prefix}'`)), timeoutMs);
      waiters.push({ prefix, resolve, reject, timer });
    });
  return {
    child,
    waitLine,
    send: (line: string) => child.stdin.write(`${line}\n`),
    waitResult: async (timeoutMs?: number) => {
      const raw = await waitLine('RESULT ', timeoutMs);
      return JSON.parse(raw.slice('RESULT '.length)) as Record<string, unknown>;
    },
    exited: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) resolve(child.exitCode);
        else child.on('exit', (code: number) => resolve(code));
      }),
  };
}

async function runToResult(mode: string, arg1?: string, arg2?: string): Promise<Record<string, unknown>> {
  const handle = startChild(mode, arg1, arg2);
  await handle.waitLine('READY');
  handle.send('RUN');
  const json = await handle.waitResult();
  expect(await handle.exited()).toBe(0);
  return json;
}

/** Run a 'hold' child through its full protocol without parking it. */
async function runHoldToResult(op: string, scope: string): Promise<Record<string, unknown>> {
  const handle = startChild('hold', op, scope);
  await handle.waitLine('READY');
  handle.send('RUN');
  await handle.waitLine('IN_LOCK');
  handle.send('PROCEED');
  await handle.waitLine('READ ');
  handle.send('FINISH');
  const json = await handle.waitResult();
  expect(await handle.exited()).toBe(0);
  return json;
}

function statePath(): string {
  return getProductTelemetryStatePath(homeDir);
}

function writeV1Granted(secret: string): void {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify({ consent: 'granted', consentVersion: '1', telemetrySecret: secret, schemaVersion: '1' }));
}

function readDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Record<string, unknown>;
}

/** Drain a promise that must NOT settle within `ms` (barrier for "blocked"). */
function assertPending(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    promise.then(
      () => {
        settled = true;
        reject(new Error('promise settled while the lock was held by another process'));
      },
      () => {
        settled = true;
        reject(new Error('promise rejected while blocked on the lock'));
      },
    );
    setTimeout(() => {
      if (!settled) resolve();
    }, ms);
  });
}

describe('PRI-1151 cross-process control-state concurrency', () => {
  it('Test A: a migration mid-transaction cannot beat disable — disable always lands (the PRI-1138 race, deterministically)', async () => {
    const secret = 'a'.repeat(64);
    writeV1Granted(secret);
    // Park a child INSIDE the migration transaction right after its locked
    // read of the v1 file — the exact position where the pre-PRI-1151 code
    // would blindly rename the migrated granted state over a concurrent
    // disable.
    const migrating = startChild('hold', 'migrate');
    await migrating.waitLine('READY');
    migrating.send('RUN');
    await migrating.waitLine('IN_LOCK');
    migrating.send('PROCEED');
    const readLine = await migrating.waitLine('READ ');
    expect(readLine).toContain('"diskSchemaVersion":"1"');
    expect(readLine).toContain('"consent":"granted"');
    // Disable runs CONCURRENTLY and must block on the lock (never write
    // around it).
    const disablePromise = createProductTelemetryService({ homeDir }).disable();
    await assertPending(disablePromise, 300);
    // Let the migration finish its write of the migrated granted state...
    migrating.send('FINISH');
    expect(await migrating.waitResult()).toEqual({ ok: true, applied: true });
    // ...then disable, which serialized behind the lock, overwrites it.
    const disabled = await disablePromise;
    expect(disabled).toEqual({ ok: true, consent: 'denied' });
    // Final state: denied, identity gone, current format, stable on re-read.
    const disk = readDisk();
    expect(disk.schemaVersion).toBe('2');
    expect(disk.consent).toBe('denied');
    expect(disk.telemetrySecret).toBeUndefined();
    expect(disk.workspaceExports).toBeUndefined();
    const reread = readProductTelemetryControlState(homeDir);
    expect(reread.ok && reread.state.consent).toBe('denied');
    // Reverse order: disable first, migration afterwards is a no-op.
    writeV1Granted('b'.repeat(64));
    const disableFirst = await createProductTelemetryService({ homeDir }).disable();
    expect(disableFirst).toEqual({ ok: true, consent: 'denied' });
    expect(await runToResult('migrate')).toEqual({ ok: true });
    expect(readDisk().consent).toBe('denied');
    expect(readDisk().schemaVersion).toBe('2');
  }, 30_000);

  it('Test A (simultaneous): disable racing a migration from a cold start still ends denied', async () => {
    for (let round = 0; round < 3; round += 1) {
      writeV1Granted('c'.repeat(64));
      const migrating = startChild('migrate');
      await migrating.waitLine('READY');
      const disablePromise = createProductTelemetryService({ homeDir }).disable();
      migrating.send('RUN');
      const [migrateResult, disabled] = await Promise.all([migrating.waitResult(), disablePromise]);
      expect(migrateResult.ok).toBe(true);
      expect(disabled.ok && disabled.consent).toBe('denied');
      expect(readDisk().consent).toBe('denied');
      expect(readDisk().telemetrySecret).toBeUndefined();
      expect(await migrating.exited()).toBe(0);
    }
  }, 60_000);

  it('Test B: migration vs reset — the reset identity always survives', async () => {
    const oldSecret = 'd'.repeat(64);
    // Order 1: migration completes first, reset serializes behind it and
    // rotates the (migrated) identity.
    writeV1Granted(oldSecret);
    expect(await runToResult('migrate')).toEqual({ ok: true });
    const reset = await createProductTelemetryService({ homeDir }).reset();
    expect(reset.ok && reset.consent).toBe('granted');
    const afterReset = readProductTelemetryControlState(homeDir);
    const newSecret = afterReset.ok ? afterReset.state.telemetrySecret : undefined;
    expect(newSecret).toBeDefined();
    expect(newSecret).not.toBe(oldSecret);
    // A LATE migration cannot restore the old secret (it is a v2 no-op).
    expect(await runToResult('migrate')).toEqual({ ok: true });
    const final = readDisk();
    expect(final.schemaVersion).toBe('2');
    expect(final.consent).toBe('granted');
    expect(final.telemetrySecret).toBe(newSecret);
    // Order 2: reset first on the raw v1 file (reads v1 in-lock), migration
    // afterwards is a no-op against the rotated v2 identity.
    writeV1Granted(oldSecret);
    const reset2 = await createProductTelemetryService({ homeDir }).reset();
    expect(reset2.ok && reset2.consent).toBe('granted');
    const rotated = readProductTelemetryControlState(homeDir);
    const rotatedSecret = rotated.ok ? rotated.state.telemetrySecret : undefined;
    expect(rotatedSecret).not.toBe(oldSecret);
    expect(await runToResult('migrate')).toEqual({ ok: true });
    expect(readDisk().telemetrySecret).toBe(rotatedSecret);
  }, 30_000);

  it('Test C: migration vs enable — the explicit grant always survives', async () => {
    for (const order of ['migrate-first', 'enable-first', 'simultaneous'] as const) {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify({ consent: 'denied', consentVersion: '1', schemaVersion: '1' }));
      if (order === 'migrate-first') {
        expect(await runToResult('migrate')).toEqual({ ok: true });
        const enabled = await createProductTelemetryService({ homeDir }).enable();
        expect(enabled.ok && enabled.consent).toBe('granted');
      } else if (order === 'enable-first') {
        const enabled = await createProductTelemetryService({ homeDir }).enable();
        expect(enabled.ok && enabled.consent).toBe('granted');
        expect(await runToResult('migrate')).toEqual({ ok: true });
      } else {
        const migrating = startChild('migrate');
        await migrating.waitLine('READY');
        const enablePromise = createProductTelemetryService({ homeDir }).enable();
        migrating.send('RUN');
        const [, enabled] = await Promise.all([migrating.waitResult(), enablePromise]);
        expect(enabled.ok && enabled.consent).toBe('granted');
      }
      const disk = readDisk();
      expect(disk.schemaVersion).toBe('2');
      expect(disk.consent).toBe('granted');
      expect(typeof disk.telemetrySecret).toBe('string');
    }
  }, 60_000);

  it('Test D: migration and workspace merges share the lock — no lost updates, consent/secret never overwritten', async () => {
    const secret = 'e'.repeat(64);
    // Order 1: a merge transaction parked mid-lock; a migration child
    // blocks behind it; the merge write lands first, the migration is then
    // a v2 no-op — and the merge's entry survives.
    writeV1Granted(secret);
    const merging = startChild('hold', 'merge', 'cccc0000cccc0000');
    await merging.waitLine('READY');
    merging.send('RUN');
    await merging.waitLine('IN_LOCK');
    merging.send('PROCEED');
    await merging.waitLine('READ ');
    const migrating = startChild('migrate');
    await migrating.waitLine('READY');
    migrating.send('RUN');
    await assertPending(migrating.waitResult(15_000), 300); // blocked behind the merge
    merging.send('FINISH');
    expect(await merging.waitResult()).toEqual({ ok: true, applied: true });
    expect(await migrating.waitResult()).toEqual({ ok: true });
    let disk = readDisk();
    expect(disk.schemaVersion).toBe('2');
    expect(disk.consent).toBe('granted');
    expect(disk.telemetrySecret).toBe(secret);
    expect(Object.keys(disk.workspaceExports as Record<string, unknown>)).toContain('cccc0000cccc0000');
    // Order 2: sequential merges compose — earlier entries are preserved.
    expect(await runHoldToResult('merge', 'aaaa0000aaaa0000')).toEqual({ ok: true, applied: true });
    expect(await runHoldToResult('merge', 'bbbb0000bbbb0000')).toEqual({ ok: true, applied: true });
    disk = readDisk();
    const entries = Object.keys(disk.workspaceExports as Record<string, unknown>);
    expect(entries).toContain('cccc0000cccc0000');
    expect(entries).toContain('aaaa0000aaaa0000');
    expect(entries).toContain('bbbb0000bbbb0000');
    // Order 3: disable vs a parked merge — the merge serializes first, then
    // disable overwrites; the final state is denied with identity gone.
    const parked = startChild('hold', 'merge', 'dddd0000dddd0000');
    await parked.waitLine('READY');
    parked.send('RUN');
    await parked.waitLine('IN_LOCK');
    parked.send('PROCEED');
    const parkedRead = await parked.waitLine('READ ');
    expect(parkedRead).toContain('"consent":"granted"');
    const disablePromise = createProductTelemetryService({ homeDir }).disable();
    await assertPending(disablePromise, 300);
    parked.send('FINISH'); // merge completes first (granted still true then)
    expect(await parked.waitResult()).toEqual({ ok: true, applied: true });
    const disabled = await disablePromise;
    expect(disabled.ok && disabled.consent).toBe('denied');
    expect(readDisk().consent).toBe('denied');
    expect(readDisk().telemetrySecret).toBeUndefined();
  }, 60_000);

  it('Test E: lock contention — mutual exclusion across processes, bounded failure, recovery', async () => {
    // N children + the parent all do locked read-modify-write on a counter:
    // the lock must serialize them with zero lost updates.
    const counterPath = path.join(homeDir, 'counter.json');
    const workers = Array.from({ length: 5 }, () => startChild('rmw', counterPath));
    for (const worker of workers) await worker.waitLine('READY');
    const parentTurn = withControlStateLock(homeDir, async () => {
      let value = 0;
      try {
        value = (JSON.parse(fs.readFileSync(counterPath, 'utf8')) as { value: number }).value;
      } catch {
        value = 0;
      }
      fs.writeFileSync(counterPath, JSON.stringify({ value: value + 1 }));
      return value + 1;
    });
    for (const worker of workers) worker.send('RUN');
    const childResults = await Promise.all(workers.map((worker) => worker.waitResult()));
    const parentResult = await parentTurn;
    // Order-independent serialization proof: 6 serialized read-modify-write
    // transactions must observe exactly the values 1..6, each once — any
    // lost update or concurrent execution would duplicate or skip a value.
    const observed = childResults.map((result) => {
      expect(result.ok).toBe(true);
      return result.value as number;
    });
    expect(parentResult.ok).toBe(true);
    if (parentResult.ok) observed.push(parentResult.value as number);
    expect(observed.length).toBe(6);
    expect([...observed].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((JSON.parse(fs.readFileSync(counterPath, 'utf8')) as { value: number }).value).toBe(6);
    for (const worker of workers) expect(await worker.exited()).toBe(0);
    // Bounded wait: while the parent holds the lock, a child times out loud
    // WITHOUT running its body, then the parent releases.
    let releaseParent: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const held = withControlStateLock(homeDir, async () => {
      await gate;
      return 'held';
    });
    const timedOut = await runToResult('timeout');
    expect(timedOut.ok).toBe(false);
    expect(String(timedOut.reason)).toContain('product_telemetry_state_lock_timeout');
    releaseParent();
    expect(await held).toEqual({ ok: true, value: 'held' });
    // Crash recovery: a stale lock (crashed holder) is taken over safely.
    const lockPath = `${statePath()}.state-lock`;
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(lockPath, '999999 deadbeefdeadbeef 2026-01-01T00:00:00.000Z\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    expect(await runToResult('migrate')).toEqual({ ok: true });
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 60_000);
});
