/**
 * P0-2 (PRI-1069/1070, G1, SPEC v1.2 §5 step 6 / invariant I-4): real-child
 * tests for terminateAndJoinChild.
 *
 * The join contract under test:
 *   - already-exited child → exited:true with escalation 'already_exited';
 *   - a LIVE child must actually die and its real 'exit' event must be
 *     observed before the helper resolves (exit code / signal recorded);
 *   - a child that outlives both bounded windows → exited:false / timedOut
 *     (the caller must then refuse destructive directory operations);
 *   - no orphan child survives any path here (afterEach joins everything).
 *
 * The child fixture is a real Node process launched with an argument-array
 * child_process call (no shell involved anywhere); on Windows SIGTERM is
 * delivered as a hard terminate — the platform of the field report — and the
 * point is that the exit EVENT is awaited, not assumed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'path';
import * as os from 'os';
import { terminateAndJoinChild } from '../src/installer.js';

const spawned: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-child-join-test-'));
const ALIVE = path.join(tmpDir, 'alive-child.cjs');
fs.writeFileSync(ALIVE, 'setInterval(() => {}, 1000);\n');
const SELF_EXIT = path.join(tmpDir, 'self-exit-child.cjs');
fs.writeFileSync(SELF_EXIT, 'process.exit(0);\n');
const ALIVE_IGNORE = path.join(tmpDir, 'alive-ignore-signals.cjs');
// Windows: SIGTERM/SIGKILL are hard terminates that cannot be ignored, so
// this fixture only matters on POSIX — where it must ignore SIGTERM to force
// the SIGKILL escalation path.
fs.writeFileSync(ALIVE_IGNORE, 'process.on(\'SIGTERM\', () => {});\nsetInterval(() => {}, 1000);\n');

/** Launch a fixture script as a real Node child (argument array, no shell). */
async function launchChild(script: string): Promise<ChildProcess> {
  const childProcessModule: typeof import('node:child_process') = await import('node:child_process');
  const launch = childProcessModule.fork;
  const child = launch(script, [], { stdio: 'ignore' });
  spawned.push(child);
  return child;
}

describe('terminateAndJoinChild (P0-2)', () => {
  it('reports already_exited for a dead child without sending signals', { timeout: 30_000 }, async () => {
    const child = await launchChild(SELF_EXIT);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const join = await terminateAndJoinChild(child);
    expect(join.exited).toBe(true);
    expect(join.escalation).toBe('already_exited');
  });

  it('terminates a live child AND observes its real exit event (join, not assume)', { timeout: 30_000 }, async () => {
    const child = await launchChild(ALIVE);
    // wait until the child is genuinely running (its module has loaded)
    await new Promise((resolve) => setTimeout(resolve, 400));
    const join = await terminateAndJoinChild(child);
    expect(join.exited).toBe(true);
    expect(join.timedOut).toBe(false);
    // the OS-level exit fact is recorded (code on Windows terminate, signal on POSIX)
    expect(join.exitCode !== null || join.signal !== null).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('escalates to SIGKILL when the graceful window expires (POSIX ignore fixture)', { timeout: 60_000 }, async () => {
    if (process.platform === 'win32') {
      // On Windows SIGTERM already terminates hard; the escalation path cannot
      // be forced with a real child (no ignorable signals) — the deferral
      // contract is covered by the stub case below instead.
      return;
    }
    const child = await launchChild(ALIVE_IGNORE);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const join = await terminateAndJoinChild(child, { gracefulTimeoutMs: 300, killTimeoutMs: 8000 });
    expect(join.exited).toBe(true);
    expect(join.escalation).toBe('sigkill');
    expect(join.signal).toBe('SIGKILL');
  });

  it('returns exited:false when the exit event never arrives (stub) — caller must NOT destroy directories', { timeout: 30_000 }, async () => {
    // Windows cannot host an unkillable child (SIGTERM is already a hard
    // terminate), so this defensive branch is exercised with a stub child:
    // kill() is a no-op and NO exit event ever fires. The contract under test
    // is purely the caller-facing fact: exited:false + timedOut:true.
    const { EventEmitter } = await import('node:events');
    const stub = new EventEmitter() as unknown as ChildProcess;
    Object.defineProperty(stub, 'exitCode', { get: () => null });
    Object.defineProperty(stub, 'signalCode', { get: () => null });
    Object.defineProperty(stub, 'pid', { value: 4242 });
    stub.kill = () => false; // signal delivery fails — child outlives both windows
    const join = await terminateAndJoinChild(stub, { gracefulTimeoutMs: 50, killTimeoutMs: 50 });
    expect(join.exited).toBe(false);
    expect(join.timedOut).toBe(true);
  });
});
