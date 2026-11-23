/**
 * Release handover — a Console never keeps serving a release that is no longer
 * the installed one.
 *
 * The decision logic runs against injected records; the port mechanics run
 * against REAL sockets on this loopback: the retrying bind, the identity
 * probe, the gap while the port changes hands, and the fallback that stops the
 * successor and takes the port back. A handover that only works against fakes
 * is exactly the kind that leaves the Owner without a console.
 *
 * The contract pinned here:
 * 1. WHAT triggers it: only a readable active record naming a different
 *    release. Same release, unreadable record, no baseline, an installer
 *    probe, or the off switch — nothing happens. It fires once per change.
 * 2. WHO does it at all: only a console that runs from the installed runtime
 *    and was not launched by the Companion (which relaunches what it owns).
 * 3. NEVER leave the port unserved, and never leave it worse than before:
 *    stop accepting only after the successor exists; a successor that does not
 *    answer is STOPPED before the port is taken back (it may be listening
 *    already); exit only once a console answers on the port.
 * 4. The successor is started as a fixed module with its launch line on
 *    stdin — never as a path on a command line — and leaves the build
 *    directory at once, so it cannot hold the installed runtime open.
 * 5. Readiness is asked from a route a console can answer the moment it
 *    listens, and the answer names the process.
 */
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveReleaseRecord } from '@principles/install-layout';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_RELEASE_HANDOVER_ENV,
  consoleIdentityUrl,
  decideReleaseHandoverWatch,
  isInstalledConsoleCode,
  isReleaseSuperseded,
  listenWithHandoverRetry,
  performReleaseHandover,
  probeConsolePid,
  releaseHandoverOwner,
  releaseIdentityOf,
  startConsoleSuccessor,
  startReleaseHandoverWatch,
  stopSuccessor,
  waitUntilAnswer,
  type SuccessorProcess,
} from '../../src/server/release-handover.js';
import { adoptWorkingDirectory, parseSuccessorLaunchConfig } from '../../src/server/successor.js';

function record(generation: number, releaseId = `rel-${generation}`): ActiveReleaseRecord {
  return {
    schemaVersion: 1,
    generation,
    releaseId,
    releaseMetadataDigest: 'a'.repeat(64),
    previousReleaseId: null,
    transactionId: `tx-${generation}`,
    productVersion: `1.${generation}.0`,
  };
}

const temporaryDirectories: string[] = [];
function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Binds `server` on a free loopback port and resolves with that port. */
function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server reported no TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

/** Ends a listener now, connections included — the way a stopped process lets go. */
function endNow(server: Server): void {
  server.close();
  server.closeAllConnections();
}

/** Reserves a loopback port for a moment and gives its number back. */
async function freePort(): Promise<number> {
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  return port;
}

/**
 * Answers every request the way the transaction route answers an id that
 * names no transaction — which is all the handover asks of it.
 */
function consoleLike(pid: number): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { transactionId: 'none', exists: false, serverPid: pid, handover: 'console' } }));
  });
}

/** A stand-in for a forked child: emits its one event on the next tick, as a real child would. */
class FakeSuccessor extends EventEmitter implements SuccessorProcess {
  pid = 4242;
  readonly kills: unknown[] = [];
  kill(signal?: unknown): boolean {
    this.kills.push(signal);
    return true;
  }
  static upcoming(event: 'spawn' | 'error', detail?: Error): FakeSuccessor {
    const successor = new FakeSuccessor();
    queueMicrotask(() => { successor.emit(event, detail); });
    return successor;
  }
}

/** Children a test forked for real; ended after the test whatever it found. */
const forkedChildren: SuccessorProcess[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const child of forkedChildren.splice(0)) {
    try { child.kill(); } catch { /* already gone */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('what counts as a superseded release', () => {
  it('a new generation or a different release is; the same release is not', () => {
    const baseline = releaseIdentityOf(record(7));
    expect(isReleaseSuperseded(baseline, record(8))).toBe(true);
    expect(isReleaseSuperseded(baseline, record(7, 'rel-other'))).toBe(true);
    // A downgrade replaced the installation just the same.
    expect(isReleaseSuperseded(baseline, record(6))).toBe(true);
    expect(isReleaseSuperseded(baseline, record(7))).toBe(false);
  });
});

/** A record the test can replace or make unreadable, read the way install-layout reads it. */
function recordSource() {
  let current: ActiveReleaseRecord = record(7);
  let readable = true;
  return {
    replaceWith(next: ActiveReleaseRecord): void { current = next; },
    makeUnreadable(): void { readable = false; },
    read: () => (readable
      ? { ok: true as const, record: current }
      : { ok: false as const, reason: 'active_record_json_invalid' as const, detail: 'torn' }),
  };
}

describe('which consoles hand themselves over at all', () => {
  const fromInstalledRuntime = true;

  it('one running from the installed runtime does, by default', () => {
    expect(decideReleaseHandoverWatch({}, fromInstalledRuntime)).toEqual({ watch: true });
  });

  it('one the Companion launched does not — the Companion relaunches the console it owns', () => {
    // A console that replaced itself underneath the Companion would come back
    // as somebody else's process: adopted as a foreign instance, or waited for
    // by a restart ladder that never sees its own launch succeed.
    const decision = decideReleaseHandoverWatch({ PD_INVOCATION_SOURCE: 'companion' }, fromInstalledRuntime);
    if (decision.watch) throw new Error('a console the Companion launched must not hand itself over');
    expect(decision.reason).toContain('Companion');
  });

  it('one that does not run from the installed runtime does not — its successor would be the same code again', () => {
    const decision = decideReleaseHandoverWatch({}, false);
    if (decision.watch) throw new Error('a console that is not the installed one must not hand itself over');
    expect(decision.reason).toContain('not the installed console');
  });

  it('not inside the installer verification probe, which is killed right after it answers', () => {
    expect(decideReleaseHandoverWatch({ PD_CONSOLE_VERIFY_NONCE: 'abc' }, fromInstalledRuntime).watch).toBe(false);
  });

  it('not when switched off, which is the rollback lever', () => {
    expect(decideReleaseHandoverWatch({ [CONSOLE_RELEASE_HANDOVER_ENV]: 'off' }, fromInstalledRuntime).watch).toBe(false);
    expect(decideReleaseHandoverWatch({ [CONSOLE_RELEASE_HANDOVER_ENV]: 'OFF' }, fromInstalledRuntime).watch).toBe(true);
  });

  it('says why whenever it does not — an update must never end on an unexplained "restart required"', () => {
    for (const env of [{ PD_INVOCATION_SOURCE: 'companion' }, { PD_CONSOLE_VERIFY_NONCE: 'abc' }, { [CONSOLE_RELEASE_HANDOVER_ENV]: 'off' }, {}]) {
      const decision = decideReleaseHandoverWatch(env, false);
      if (decision.watch) continue;
      expect(decision.reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('whether a console runs from the installed runtime', () => {
  /** A console package directory with the build's `dist/server/` output in it. */
  function consoleDir(prefix: string): string {
    const directory = tempDir(prefix);
    fs.mkdirSync(path.join(directory, 'dist', 'server'), { recursive: true });
    return directory;
  }

  it('is decided by where the files really are, not by how the path is spelled', () => {
    const installed = consoleDir('pd-console-installed-');
    const running = path.join(installed, 'dist', 'server');
    expect(isInstalledConsoleCode(running, installed)).toBe(true);

    // A relocated PD home reaches the same directory through a link.
    const link = path.join(tempDir('pd-console-home-'), 'console');
    fs.symlinkSync(installed, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(isInstalledConsoleCode(path.join(link, 'dist', 'server'), installed)).toBe(true);
      expect(isInstalledConsoleCode(running, link)).toBe(true);
    } finally {
      // The link itself — never what it points at (a junction on Windows, a
      // symlink on POSIX; `rmSync` without `recursive` removes either).
      fs.rmSync(link, { force: true });
    }

    // Windows paths are case-insensitive; POSIX ones are not.
    expect(isInstalledConsoleCode(running.toUpperCase(), installed)).toBe(process.platform === 'win32');
  });

  it('is false for a repository build, and whenever the installed location is not there', () => {
    const installed = consoleDir('pd-console-installed-');
    const repository = consoleDir('pd-console-repo-');
    expect(isInstalledConsoleCode(path.join(repository, 'dist', 'server'), installed)).toBe(false);

    const nothingInstalled = tempDir('pd-console-empty-');
    expect(isInstalledConsoleCode(path.join(installed, 'dist', 'server'), nothingInstalled)).toBe(false);
    expect(isInstalledConsoleCode(path.join(nothingInstalled, 'nowhere'), nothingInstalled)).toBe(false);
  });
});

describe('who the page should wait for', () => {
  it('is nobody until a watch is actually running in this process', () => {
    expect(releaseHandoverOwner({})).toBe('manual');
  });

  it('is the Companion for a console the Companion launched', () => {
    expect(releaseHandoverOwner({ PD_INVOCATION_SOURCE: 'companion' })).toBe('companion');
  });

  it('is this console exactly while its watch is running', () => {
    const source = recordSource();
    const watch = startReleaseHandoverWatch({ recordPath: 'unused', onSuperseded: vi.fn(), readRecord: source.read, intervalMs: 1000 });
    expect(releaseHandoverOwner({})).toBe('console');

    watch?.stop();
    expect(releaseHandoverOwner({})).toBe('manual');
  });

  it('is nobody again once the watch has fired — a handover called off leaves a plain console', () => {
    vi.useFakeTimers();
    const onSuperseded = vi.fn();
    const source = recordSource();
    startReleaseHandoverWatch({ recordPath: 'unused', onSuperseded, readRecord: source.read, intervalMs: 1000 });

    source.replaceWith(record(9));
    vi.advanceTimersByTime(1000);
    expect(onSuperseded).toHaveBeenCalledTimes(1);
    expect(releaseHandoverOwner({})).toBe('manual');
  });

  it('is not "this console" for a watch that could not start', () => {
    const watch = startReleaseHandoverWatch({
      recordPath: 'unused',
      onSuperseded: vi.fn(),
      readRecord: () => ({ ok: false, reason: 'active_record_absent', detail: 'no file' }),
    });
    expect(watch).toBeNull();
    expect(releaseHandoverOwner({})).toBe('manual');
  });
});

describe('the release watch', () => {
  it('watches nothing without a readable baseline — there is nothing to be stale relative to', () => {
    const log = vi.fn();
    const watch = startReleaseHandoverWatch({
      recordPath: 'unused',
      onSuperseded: vi.fn(),
      readRecord: () => ({ ok: false, reason: 'active_record_absent', detail: 'no file' }),
      log,
    });

    expect(watch).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('active_record_absent'));
  });

  it('does nothing while the installed release is the one it started on, or while the record cannot be read', () => {
    vi.useFakeTimers();
    const onSuperseded = vi.fn();
    const source = recordSource();
    startReleaseHandoverWatch({ recordPath: 'unused', onSuperseded, readRecord: source.read, intervalMs: 1000 });

    vi.advanceTimersByTime(10_000);
    expect(onSuperseded).not.toHaveBeenCalled();

    // A torn read mid-write is not a change.
    source.makeUnreadable();
    vi.advanceTimersByTime(5000);
    expect(onSuperseded).not.toHaveBeenCalled();
  });

  it('fires once when the installed release changes, then stops', () => {
    vi.useFakeTimers();
    const onSuperseded = vi.fn();
    const source = recordSource();
    const watch = startReleaseHandoverWatch({ recordPath: 'unused', onSuperseded, readRecord: source.read, intervalMs: 1000 });
    if (watch === null) throw new Error('watch did not start');

    source.replaceWith(record(9));
    vi.advanceTimersByTime(1000);
    expect(onSuperseded).toHaveBeenCalledTimes(1);
    expect(onSuperseded.mock.calls[0]?.[0]).toMatchObject({ generation: 9, releaseId: 'rel-9' });

    // A second change must not hand over twice from a process that is already leaving.
    source.replaceWith(record(10));
    vi.advanceTimersByTime(5000);
    expect(onSuperseded).toHaveBeenCalledTimes(1);
  });

  it('stops for good when told to', () => {
    vi.useFakeTimers();
    const onSuperseded = vi.fn();
    const source = recordSource();
    const watch = startReleaseHandoverWatch({ recordPath: 'unused', onSuperseded, readRecord: source.read, intervalMs: 1000 });
    watch?.stop();

    source.replaceWith(record(9));
    vi.advanceTimersByTime(5000);
    expect(onSuperseded).not.toHaveBeenCalled();
  });
});

describe('binding a port that is still being released', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      if (server.listening) await close(server);
    }
  });
  const track = (server: Server): Server => {
    servers.push(server);
    return server;
  };

  it('binds on the first try when the port is free', async () => {
    const onListening = vi.fn();
    const giveUp = vi.fn();

    listenWithHandoverRetry({ server: track(createServer()), port: await freePort(), host: '127.0.0.1', onListening, giveUp });

    await vi.waitFor(() => expect(onListening).toHaveBeenCalledTimes(1));
    expect(giveUp).not.toHaveBeenCalled();
  });

  it("retries 'address in use' until the predecessor lets go, then binds", async () => {
    const predecessor = track(createServer((_req, res) => { res.end('old'); }));
    const port = await listen(predecessor);
    const onListening = vi.fn();
    const giveUp = vi.fn();
    const successor = track(createServer((_req, res) => { res.end('new'); }));

    listenWithHandoverRetry({ server: successor, port, host: '127.0.0.1', onListening, giveUp, retryInUseForMs: 10_000, retryMs: 50 });
    // The predecessor is still serving: the successor has neither given up nor bound.
    await new Promise<void>((resolve) => { setTimeout(resolve, 200); });
    expect(giveUp).not.toHaveBeenCalled();
    expect(onListening).not.toHaveBeenCalled();
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('old');

    await close(predecessor);
    await vi.waitFor(() => expect(onListening).toHaveBeenCalledTimes(1));
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('new');
    expect(giveUp).not.toHaveBeenCalled();
  });

  it("gives up on 'address in use' at once when it was not asked to wait", async () => {
    const holder = track(createServer());
    const port = await listen(holder);
    const onListening = vi.fn();
    const giveUp = vi.fn();

    listenWithHandoverRetry({ server: track(createServer()), port, host: '127.0.0.1', onListening, giveUp });

    await vi.waitFor(() => expect(giveUp).toHaveBeenCalledTimes(1));
    expect(giveUp.mock.calls[0]?.[0]).toMatchObject({ code: 'EADDRINUSE' });
    expect(onListening).not.toHaveBeenCalled();
  });

  describe('and binding again after a called-off handover', () => {
    /** A console exactly as `main()` binds one, already listening, with the port number it owns. */
    async function boundConsole(): Promise<{ server: Server; port: number; giveUp: ReturnType<typeof vi.fn>; relisten: (ms: number) => Promise<void> }> {
      const server = track(consoleLike(111));
      const onListening = vi.fn();
      const giveUp = vi.fn();
      const port = await freePort();
      const listener = listenWithHandoverRetry({ server, port, host: '127.0.0.1', onListening, giveUp });
      await vi.waitFor(() => expect(onListening).toHaveBeenCalledTimes(1));
      return { server, port, giveUp, relisten: (ms) => listener.relisten(ms) };
    }

    it('binds again once the port is free, and that is not the dead end a failed boot is', async () => {
      const bound = await boundConsole();
      await close(bound.server);

      await bound.relisten(2000);

      expect(await probeConsolePid(consoleIdentityUrl('127.0.0.1', bound.port), 1000)).toBe(111);
      expect(bound.giveUp).not.toHaveBeenCalled();
    });

    it("retries 'address in use' while a just-stopped successor is still letting go", async () => {
      const bound = await boundConsole();
      await close(bound.server);
      // Whatever still holds the port gives it up shortly.
      const lingering = track(createServer());
      await new Promise<void>((resolve) => { lingering.listen(bound.port, '127.0.0.1', resolve); });
      setTimeout(() => endNow(lingering), 300);

      await bound.relisten(5000);

      expect(await probeConsolePid(consoleIdentityUrl('127.0.0.1', bound.port), 1000)).toBe(111);
      expect(bound.giveUp).not.toHaveBeenCalled();
    });

    it('rejects — to the handover, not to the boot-time dead end — when the port stays taken', async () => {
      const bound = await boundConsole();
      await close(bound.server);
      const squatter = track(consoleLike(999));
      await new Promise<void>((resolve) => { squatter.listen(bound.port, '127.0.0.1', resolve); });

      await expect(bound.relisten(300)).rejects.toMatchObject({ code: 'EADDRINUSE' });

      // Still somebody else's port, and this console was not ended over it.
      expect(await probeConsolePid(consoleIdentityUrl('127.0.0.1', bound.port), 1000)).toBe(999);
      expect(bound.giveUp).not.toHaveBeenCalled();
    });
  });
});

describe('asking the port who is serving', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      if (server.listening) endNow(server);
    }
  });
  const track = (server: Server): Server => {
    servers.push(server);
    return server;
  };
  const probePath = '/api/update/transaction/handover-identity-probe';

  it('names the console that answers, and nothing else', async () => {
    const serving = track(consoleLike(4242));
    const notConsole = track(createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>a login page</html>'); }));
    const failing = track(createServer((_req, res) => { res.writeHead(503); res.end(); }));

    expect(await probeConsolePid(`http://127.0.0.1:${await listen(serving)}${probePath}`, 2000)).toBe(4242);
    expect(await probeConsolePid(`http://127.0.0.1:${await listen(notConsole)}${probePath}`, 2000)).toBeNull();
    expect(await probeConsolePid(`http://127.0.0.1:${await listen(failing)}${probePath}`, 2000)).toBeNull();
  });

  it('a port nobody listens on is nobody, and is not an error either', async () => {
    expect(await probeConsolePid(consoleIdentityUrl('127.0.0.1', await freePort()), 500)).toBeNull();
  });

  it('a listener that never answers is nobody', async () => {
    const silent = track(createServer());

    expect(await probeConsolePid(`http://127.0.0.1:${await listen(silent)}${probePath}`, 300)).toBeNull();
  });

  it('an IPv6 loopback host gets the brackets a URL needs', () => {
    expect(consoleIdentityUrl('::1', 3100)).toBe(`http://[::1]:3100${probePath}`);
    expect(consoleIdentityUrl('127.0.0.1', 3100)).toBe(`http://127.0.0.1:3100${probePath}`);
  });

  it('waits through "not yet" and resolves with the first real answer', async () => {
    vi.useFakeTimers();
    let answers = 0;
    const probe = vi.fn(async () => { answers += 1; return answers >= 3 ? 4242 : null; });
    const waiting = waitUntilAnswer(probe, 10_000, { intervalMs: 100, sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }) });

    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toBe(4242);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('gives up at the deadline instead of waiting forever', async () => {
    vi.useFakeTimers();
    const waiting = waitUntilAnswer(async () => null, 1000, { intervalMs: 100, sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }) });

    await vi.advanceTimersByTimeAsync(5000);
    expect(await waiting).toBeNull();
  });
});

/**
 * A predecessor exactly as `main()` runs one: a real console-like listener
 * bound through the real listener, with the real stop / observe / rebind.
 */
async function startPredecessor(): Promise<{
  readonly port: number;
  readonly giveUp: ReturnType<typeof vi.fn>;
  readonly stopAccepting: () => Promise<void>;
  readonly waitForSuccessor: (timeoutMs?: number) => Promise<number | null>;
  readonly resumeAccepting: (retryMs: number) => Promise<void>;
  readonly dispose: () => Promise<void>;
}> {
  const server = consoleLike(111);
  const giveUp = vi.fn();
  const listener = listenWithHandoverRetry({ server, port: await freePort(), host: '127.0.0.1', onListening: () => undefined, giveUp });
  await vi.waitFor(() => expect(server.listening).toBe(true));
  const port = server.address();
  if (port === null || typeof port === 'string') throw new Error('predecessor reported no TCP address');
  return {
    port: port.port,
    giveUp,
    stopAccepting: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(resolve, 2000).unref();
      });
    },
    waitForSuccessor: (timeoutMs = 3000) => waitUntilAnswer(() => probeConsolePid(consoleIdentityUrl('127.0.0.1', port.port), 500), timeoutMs),
    resumeAccepting: (retryMs) => listener.relisten(retryMs),
    dispose: async () => {
      if (server.listening) endNow(server);
    },
  };
}

describe('handing the port over', () => {
  const noSuccessorToStop = async (): Promise<void> => undefined;

  it('keeps serving when no successor can be started', async () => {
    const predecessor = await startPredecessor();
    const exit = vi.fn();
    const stopAccepting = vi.fn(predecessor.stopAccepting);

    await performReleaseHandover({
      startSuccessor: () => null,
      stopAccepting,
      waitForSuccessor: predecessor.waitForSuccessor,
      abandonSuccessor: noSuccessorToStop,
      resumeAccepting: () => predecessor.resumeAccepting(0),
      exit,
    });

    expect(stopAccepting).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(await probeConsolePid(consoleIdentityUrl('127.0.0.1', predecessor.port), 1000)).toBe(111);
    await predecessor.dispose();
  });

  it('keeps serving when starting the successor throws, and when the successor itself fails to start', async () => {
    const predecessor = await startPredecessor();
    const exit = vi.fn();
    const stopAccepting = vi.fn(predecessor.stopAccepting);
    const log = vi.fn();

    await performReleaseHandover({
      startSuccessor: () => { throw new Error('fork failed'); },
      stopAccepting,
      waitForSuccessor: predecessor.waitForSuccessor,
      abandonSuccessor: noSuccessorToStop,
      resumeAccepting: () => predecessor.resumeAccepting(0),
      exit,
      log,
    });
    await performReleaseHandover({
      startSuccessor: () => FakeSuccessor.upcoming('error', new Error('ENOENT')),
      stopAccepting,
      waitForSuccessor: predecessor.waitForSuccessor,
      abandonSuccessor: noSuccessorToStop,
      resumeAccepting: () => predecessor.resumeAccepting(0),
      exit,
      log,
    });

    expect(stopAccepting).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fork failed'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
    expect(await probeConsolePid(consoleIdentityUrl('127.0.0.1', predecessor.port), 1000)).toBe(111);
    await predecessor.dispose();
  });

  it('keeps serving when the successor was started but never confirmed to exist', async () => {
    const predecessor = await startPredecessor();
    const exit = vi.fn();
    const stopAccepting = vi.fn(predecessor.stopAccepting);
    // A successor that emits neither 'spawn' nor 'error' in time.
    const silent = new FakeSuccessor();

    await performReleaseHandover({
      startSuccessor: () => silent,
      stopAccepting,
      waitForSuccessor: predecessor.waitForSuccessor,
      abandonSuccessor: noSuccessorToStop,
      resumeAccepting: () => predecessor.resumeAccepting(0),
      exit,
      spawnTimeoutMs: 20,
    });

    expect(stopAccepting).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    await predecessor.dispose();
  });

  it('hands the port to the successor and exits only once the successor answers on it', async () => {
    const predecessor = await startPredecessor();
    const exit = vi.fn();
    const log = vi.fn();
    const order: string[] = [];
    // The successor: a console-like listener that takes the port the moment
    // the predecessor releases it, after a boot pause.
    const successor = consoleLike(4242);
    try {
      await performReleaseHandover({
        startSuccessor: () => FakeSuccessor.upcoming('spawn'),
        stopAccepting: async () => { order.push('stopAccepting'); await predecessor.stopAccepting(); },
        waitForSuccessor: async () => {
          order.push('waitForSuccessor');
          setTimeout(() => { successor.listen(predecessor.port, '127.0.0.1'); }, 150);
          return predecessor.waitForSuccessor();
        },
        abandonSuccessor: async () => { order.push('abandonSuccessor'); },
        resumeAccepting: async () => { order.push('resumeAccepting'); await predecessor.resumeAccepting(0); },
        exit: (code) => { order.push(`exit:${code}`); exit(code); },
        log,
      });

      expect(order).toEqual(['stopAccepting', 'waitForSuccessor', 'exit:0']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('successor console (pid 4242)'));
      expect(await probeConsolePid(consoleIdentityUrl('127.0.0.1', predecessor.port), 1000)).toBe(4242);
    } finally {
      endNow(successor);
      await predecessor.dispose();
    }
  });

  it('exits all the same when another console has taken the port — it was started after the release changed', async () => {
    const predecessor = await startPredecessor();
    const exit = vi.fn();
    const log = vi.fn();

    await performReleaseHandover({
      startSuccessor: () => FakeSuccessor.upcoming('spawn'),
      stopAccepting: predecessor.stopAccepting,
      waitForSuccessor: async () => 7777,
      abandonSuccessor: async () => { throw new Error('a serving console must not be stopped'); },
      resumeAccepting: async () => { throw new Error('a served port must not be rebound'); },
      exit,
      log,
    });

    expect(exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Another console (pid 7777)'));
    await predecessor.dispose();
  });

  it('stops the successor before taking the port back, in that order, and does not exit', async () => {
    const predecessor = await startPredecessor();
    const exit = vi.fn();
    const log = vi.fn();
    const order: string[] = [];

    await performReleaseHandover({
      startSuccessor: () => FakeSuccessor.upcoming('spawn'),
      stopAccepting: async () => { order.push('stopAccepting'); await predecessor.stopAccepting(); },
      waitForSuccessor: async () => { order.push('waitForSuccessor'); return null; },
      // Binding over a live successor is not possible: it has to be gone first.
      abandonSuccessor: async () => { order.push('abandonSuccessor'); },
      resumeAccepting: async () => { order.push('resumeAccepting'); await predecessor.resumeAccepting(0); },
      exit,
      log,
    });

    expect(order).toEqual(['stopAccepting', 'waitForSuccessor', 'abandonSuccessor', 'resumeAccepting']);
    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Port taken back'));
    expect(await probeConsolePid(consoleIdentityUrl('127.0.0.1', predecessor.port), 1000)).toBe(111);
    await predecessor.dispose();
  });

  it('takes the port back from a successor that is BOUND but never answers — with real listeners', async () => {
    const predecessor = await startPredecessor();
    const exit = vi.fn();
    // The worst case: the successor got as far as listening, and answers nothing.
    const boundNotReady = createServer();
    const started = FakeSuccessor.upcoming('spawn');
    const order: string[] = [];
    try {
      await performReleaseHandover({
        startSuccessor: () => started,
        stopAccepting: async () => {
          await predecessor.stopAccepting();
          await new Promise<void>((resolve) => { boundNotReady.listen(predecessor.port, '127.0.0.1', resolve); });
        },
        waitForSuccessor: () => predecessor.waitForSuccessor(700),
        // As a stopped process lets go: ended, and not waited for.
        abandonSuccessor: async () => { order.push('abandonSuccessor'); started.kill(); endNow(boundNotReady); },
        resumeAccepting: () => predecessor.resumeAccepting(5000),
        exit,
      });

      expect(order).toEqual(['abandonSuccessor']);
      expect(started.kills).toHaveLength(1);
      // The predecessor is serving again, and neither exited nor hit its dead end.
      expect(exit).not.toHaveBeenCalled();
      expect(predecessor.giveUp).not.toHaveBeenCalled();
      expect(await probeConsolePid(consoleIdentityUrl('127.0.0.1', predecessor.port), 1000)).toBe(111);
    } finally {
      endNow(boundNotReady);
      await predecessor.dispose();
    }
  });

  it('exits with a failure only when the port cannot be taken back at all', async () => {
    const predecessor = await startPredecessor();
    const exit = vi.fn();
    const log = vi.fn();
    // Not a console, and never letting go.
    const squatter = createServer();
    const order: string[] = [];
    try {
      await performReleaseHandover({
        startSuccessor: () => FakeSuccessor.upcoming('spawn'),
        stopAccepting: async () => { await predecessor.stopAccepting(); await new Promise<void>((resolve) => { squatter.listen(predecessor.port, '127.0.0.1', resolve); }); },
        waitForSuccessor: () => predecessor.waitForSuccessor(400),
        abandonSuccessor: async () => { order.push('abandonSuccessor'); },
        resumeAccepting: () => predecessor.resumeAccepting(300),
        exit: (code) => { order.push(`exit:${code}`); exit(code); },
        log,
      });

      expect(order).toEqual(['abandonSuccessor', 'exit:1']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Could not take the port back'));
    } finally {
      endNow(squatter);
      await predecessor.dispose();
    }
  });
});

describe('stopping the successor', () => {
  it('is nothing to do when no successor was started', async () => {
    await stopSuccessor(null);
  });

  it('ends a real successor, and resolves once it is gone', async () => {
    const directory = tempDir('pd-successor-alive-');
    // A stand-in that does what a stuck process does: stays alive.
    fs.writeFileSync(path.join(directory, 'successor.js'), 'setInterval(() => {}, 1000);\n', 'utf8');
    const child = startConsoleSuccessor({ args: ['--port', '3100'] }, vi.fn(), { cwd: directory });
    if (child === null) throw new Error('successor did not start');
    forkedChildren.push(child);
    let exited = false;
    child.once('exit', () => { exited = true; });
    await new Promise<void>((resolve) => { child.once('spawn', resolve); });

    await stopSuccessor(child);

    expect(exited).toBe(true);
  }, 20_000);

  it('stops waiting after the bound, so a successor that will not die cannot hold the port decision', async () => {
    vi.useFakeTimers();
    const stubborn = new FakeSuccessor();
    let stopped = false;

    const stopping = stopSuccessor(stubborn, 200).then(() => { stopped = true; });
    expect(stubborn.kills).toHaveLength(1);
    await Promise.race([stopping, Promise.resolve()]);
    expect(stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(300);
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe('starting the successor', () => {
  it("forks the fixed module from the build's own directory and sends the launch line over stdin", async () => {
    const directory = tempDir('pd-successor-');
    const receivedPath = path.join(directory, 'received.json');
    // A stand-in for the compiled successor: it writes what it read on stdin
    // to a file, so the test sees exactly what the predecessor sent.
    fs.writeFileSync(path.join(directory, 'successor.js'), [
      "const fs = require('node:fs');",
      'const input = fs.readFileSync(0, "utf8");',
      `fs.writeFileSync(${JSON.stringify(receivedPath)}, JSON.stringify({ input, argv: process.argv.slice(2) }));`,
    ].join('\n'), 'utf8');
    const log = vi.fn();

    const child = startConsoleSuccessor({ args: ['--workspace', 'D:\\a dir\\ws', '--port', '3100'] }, log, { cwd: directory });
    // First the failure channel: if the fork threw, this line names why.
    expect(log).not.toHaveBeenCalled();
    expect(child).not.toBeNull();

    await vi.waitFor(() => { expect(fs.existsSync(receivedPath)).toBe(true); }, { timeout: 15_000 });
    const received: unknown = JSON.parse(fs.readFileSync(receivedPath, 'utf8'));
    expect(received).toEqual({
      // The launch line is data on stdin: nothing from it is on a command line.
      // It carries where this process was working from, so the successor can
      // leave the build directory for it.
      input: `${JSON.stringify({ args: ['--workspace', 'D:\\a dir\\ws', '--port', '3100'], cwd: process.cwd() })}\n`,
      argv: [],
    });
  }, 30_000);
});

describe('the successor reads its launch line as untrusted input', () => {
  it('accepts one JSON object with a non-empty list of string arguments', () => {
    expect(parseSuccessorLaunchConfig('{"args":["--workspace","/w s","--port","3100"]}')).toEqual({
      args: ['--workspace', '/w s', '--port', '3100'],
    });
  });

  it('takes the working directory it is told only when that is an absolute path', () => {
    const absolute = path.resolve(path.sep, 'where', 'the', 'launcher', 'stood');
    expect(parseSuccessorLaunchConfig(JSON.stringify({ args: ['--port', '3100'], cwd: absolute }))).toEqual({
      args: ['--port', '3100'],
      cwd: absolute,
    });
    // A relative one would be resolved against the very directory the
    // successor is about to leave; anything else is "not told".
    for (const cwd of ['relative/dir', '', 42, null, 'C:\\dir\u0000', 'x'.repeat(4097)]) {
      expect(parseSuccessorLaunchConfig(JSON.stringify({ args: ['--port', '3100'], cwd }))).toEqual({ args: ['--port', '3100'] });
    }
  });

  it('refuses anything a console must not be started from', () => {
    expect(parseSuccessorLaunchConfig('')).toBeNull();
    expect(parseSuccessorLaunchConfig('not json')).toBeNull();
    expect(parseSuccessorLaunchConfig('[]')).toBeNull();
    expect(parseSuccessorLaunchConfig('{}')).toBeNull();
    expect(parseSuccessorLaunchConfig('{"args":[]}')).toBeNull();
    expect(parseSuccessorLaunchConfig('{"args":"--port 3100"}')).toBeNull();
    expect(parseSuccessorLaunchConfig('{"args":["--workspace",42]}')).toBeNull();
    expect(parseSuccessorLaunchConfig('{"args":["--port\\u00003100"]}')).toBeNull();
    expect(parseSuccessorLaunchConfig(JSON.stringify({ args: new Array<string>(65).fill('--x') }))).toBeNull();
    expect(parseSuccessorLaunchConfig(JSON.stringify({ args: ['x'.repeat(4097)] }))).toBeNull();
  });
});

describe('the successor leaves the build directory at once', () => {
  // The working directory is this whole process's: every test puts it back.
  const whereTheTestStood = process.cwd();
  afterEach(() => { process.chdir(whereTheTestStood); });

  /** Where this process is really working from — links and short names resolved, as the OS reports it. */
  const really = (directory: string): string => fs.realpathSync.native(directory);

  it('works from the directory the launcher stood in, not from the build', () => {
    const build = tempDir('pd-build-');
    const launcher = tempDir('pd-launcher-');
    process.chdir(build);

    adoptWorkingDirectory(launcher);

    expect(process.cwd()).toBe(really(launcher));
  });

  it('falls back to the temp directory when the launcher\u2019s directory is gone', () => {
    process.chdir(tempDir('pd-build-'));

    adoptWorkingDirectory(path.join(tempDir('pd-launcher-'), 'since-deleted'));

    expect(process.cwd()).toBe(really(path.resolve(os.tmpdir())));
  });

  it('falls back the same way when the launch line named no directory', () => {
    process.chdir(tempDir('pd-build-'));

    adoptWorkingDirectory(undefined);

    expect(process.cwd()).toBe(really(path.resolve(os.tmpdir())));
  });
});
