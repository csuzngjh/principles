/**
 * Bounded Worker-subprocess execution (task §8 fault injection, TD §5.3):
 * happy parse, malformed stdout, nonzero exit, hard timeout with the
 * SIGTERM→grace→SIGKILL ladder, SIGTERM-ignoring children, and caller
 * cancellation — all against REAL fixture child processes.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runWorkerProcess } from '../../../src/services/service-host/worker-process.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('runWorkerProcess (real fixture children)', () => {
  it('collects stdout and a zero exit code from a well-behaved child', async () => {
    const result = await runWorkerProcess({
      cliEntry: path.join(FIXTURES, 'echo-json.mjs'),
      args: ['C:\\ws\\fixture'],
      env: {},
      timeoutMs: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual({ workspaceDir: 'C:\\ws\\fixture', mode: 'ready' });
    expect(result.spawnError).toBeUndefined();
  });

  it('malformed stdout is returned verbatim (the adapter fails closed downstream)', async () => {
    const result = await runWorkerProcess({
      cliEntry: path.join(FIXTURES, 'garbage.mjs'),
      args: [],
      env: {},
      timeoutMs: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('not json');
  });

  it('a nonzero exit keeps its code and bounded stderr tail', async () => {
    const result = await runWorkerProcess({
      cliEntry: path.join(FIXTURES, 'exit-nonzero.mjs'),
      args: [],
      env: {},
      timeoutMs: 15_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderrTail).toContain('fixture worker exploded');
    expect(result.timedOut).toBe(false);
  });

  it('a hard timeout terminates the child and marks timedOut (task §8: one workspace cannot hang the run)', async () => {
    const startedAt = Date.now();
    const result = await runWorkerProcess({
      cliEntry: path.join(FIXTURES, 'sleep.mjs'),
      args: [],
      env: {},
      timeoutMs: 800,
      killGraceMs: 1_500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    // The whole ladder resolved well inside the fixture's own 120s sleep.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('a child ignoring SIGTERM is force-terminated within the bounded ladder (SIGKILL escalation on POSIX)', async () => {
    const result = await runWorkerProcess({
      cliEntry: path.join(FIXTURES, 'ignore-sigterm.mjs'),
      args: [],
      env: {},
      timeoutMs: 500,
      killGraceMs: 1_000,
    });
    expect(result.timedOut).toBe(true);
    if (process.platform === 'win32') {
      // Windows has no POSIX signals: SIGTERM is TerminateProcess — the child
      // dies immediately (no handler run, no stderr flush). The bounded
      // guarantee that matters — the child actually ended — still holds.
      expect(result.exitCode).not.toBe(0);
    } else {
      expect(result.stderrTail).toContain('sigterm-ignored');
      // The process actually ended — close fired after the SIGKILL.
      expect(result.exitCode).not.toBe(0);
    }
  }, 20_000);

  it('caller cancellation aborts the child and marks cancelled', async () => {
    const controller = new AbortController();
    const pending = runWorkerProcess({
      cliEntry: path.join(FIXTURES, 'sleep.mjs'),
      args: [],
      env: {},
      timeoutMs: 60_000,
      signal: controller.signal,
      killGraceMs: 2_000,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 20_000);

  it('an already-aborted signal returns cancelled BEFORE spawning (R2 review fix)', async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = 0;
    const result = await runWorkerProcess({
      cliEntry: path.join(FIXTURES, 'echo-json.mjs'),
      args: [],
      env: {},
      timeoutMs: 15_000,
      signal: controller.signal,
      spawnFn: ((...spawnArgs: Parameters<typeof spawn>) => {
        spawned += 1;
        return spawn(...spawnArgs);
      }) as typeof spawn,
    });
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    // No Worker was ever started for the queued workspace.
    expect(spawned).toBe(0);
  });

  it('a missing entry script is a worker failure (nonzero exit + stderr), never a fake success', async () => {
    const result = await runWorkerProcess({
      cliEntry: path.join(FIXTURES, 'does-not-exist.mjs'),
      args: [],
      env: {},
      timeoutMs: 10_000,
    });
    // Node itself starts fine; the missing MODULE makes the child exit 1 —
    // the adapter's parse fails closed on the empty stdout (rc-1/rc-3).
    expect(result.spawnError).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(result.stderrTail).toContain('Cannot find module');
  });
});
