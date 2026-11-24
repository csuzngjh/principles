/**
 * An update starts only for a request that is still waiting for it.
 *
 * `asyncHandler` (server/index.ts) answers 504 when a route outlives its
 * budget; it does not cancel the route. The readiness gate is awaited, so a
 * gate slower than the budget used to let the route carry on and START the
 * update after the page had been told it had failed — detached, and tracked
 * by nobody. (While the gate still read the executor tree synchronously, the
 * 504 could not be sent before the gate finished, which is what hid this.)
 *
 * Nothing here is a stand-in for the path under test: the request goes through
 * the REAL dispatcher (so the REAL wrapper and its REAL budget answer), the
 * REAL route, and a real HTTP response. Held by the test: the readiness gate,
 * which answers when the test says so, and the executor, which is never really
 * started.
 *
 * 1. A request that timed out at the gate starts nothing — no executor, no
 *    request file, no transaction.
 * 2. A request that is still waiting gets its update: the guard must not
 *    become a way for `/apply-full` to silently do nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mocks = vi.hoisted(() => {
  // Both budgets are read once, when their modules load (vi.hoisted runs
  // first): the request must be able to time out inside a test, and a route
  // that is (wrongly) still running must not hold the file open for long.
  process.env.PD_UPDATE_APPLY_FULL_TIMEOUT_MS = '150';
  process.env.PD_UPDATE_ACCEPTANCE_WINDOW_MS = '500';
  return {
    fakeHome: '',
    sandboxTmp: '',
    /** The readiness gate's answer; null until a test opens the gate. */
    gate: null as Promise<unknown> | null,
    gateOpened: vi.fn(),
    spawn: vi.fn(),
  };
});

vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.fakeHome,
  tmpdir: () => mocks.sandboxTmp,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: (...args: unknown[]) => {
    mocks.spawn(...args);
    return Object.assign(new EventEmitter(), { unref: () => undefined });
  },
}));

vi.mock('create-principles-disciple/update-console', async () => {
  const nodePath = await import('node:path');
  return {
    createReleaseManagerAuthorityAsync: () => {
      mocks.gateOpened();
      if (mocks.gate === null) throw new Error('no gate was opened for this test');
      return mocks.gate;
    },
    mapReleaseManagerError: (error: unknown) => ({
      reason: 'mapped_for_test',
      message: error instanceof Error ? error.message : String(error),
      nextAction: 'retry',
      transactionOpened: false,
    }),
    resolvePdHomePaths: (pdHome: string) => ({
      bootstrapExecutorDir: nodePath.join(pdHome, 'bootstrap', 'executor'),
      transactionsDir: nodePath.join(pdHome, 'transactions'),
    }),
  };
});

import { handleRequest } from '../../../src/server/index.js';

/** How the route names a transaction (`update-<timestamp>-<8 hex>`), as the page's validator requires it. */
const TRANSACTION_ID = /^update-\d{13}-[0-9a-f]{8}$/;

/** An installation the gate pronounces ready for an update. */
function readyAuthority(): Record<string, unknown> {
  return {
    kinds: { 'apply-full': { ready: true, reasons: [] }, check: { ready: true, reasons: [] } },
    installStatus: { productVersion: '1.0.0', channel: 'stable' },
    manager: {},
  };
}

/** Resolves once every already-queued continuation has run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  }
}

describe('POST /api/update/apply-full starts an update only for a request that is still waiting', () => {
  let home: string;
  let workspace: string;
  let sandboxTmp: string;
  let server: Server;
  let base: string;
  let savedHome: string | undefined;
  let consoleError: ReturnType<typeof vi.spyOn>;

  /** Opens the gate; resolves with the function that answers it. */
  function holdGateOpen(): (authority: unknown) => void {
    let answer: (authority: unknown) => void = () => undefined;
    mocks.gate = new Promise<unknown>((resolve) => { answer = (authority) => resolve(authority); });
    return (authority) => answer(authority);
  }

  /** `target` resolved and proven to sit inside the sandbox's temp directory. */
  function sandboxed(target: string): string {
    const resolved = path.resolve(target);
    if (resolved !== sandboxTmp && !resolved.startsWith(sandboxTmp + path.sep)) {
      throw new Error('the route wrote outside the sandbox temp directory');
    }
    return resolved;
  }

  /** The transaction the route asked for, read from the request file among the executor's arguments (`spawn(program, argv, options)`). */
  function requestedTransaction(spawnCall: unknown[]): { transactionId: string } {
    const argv = spawnCall[1];
    if (!Array.isArray(argv)) throw new Error('the executor was not started with an argument list');
    const args = argv.map((argument) => String(argument));
    const requestFile = sandboxed(args[args.indexOf('--request-file') + 1] ?? '');
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8')) as { transactionId?: unknown };
    if (typeof request.transactionId !== 'string' || !TRANSACTION_ID.test(request.transactionId)) {
      throw new Error('request file carries no well-formed transaction id');
    }
    return { transactionId: request.transactionId };
  }

  beforeEach(async () => {
    // `os.tmpdir()` is mocked below to the route's sandbox, so the sandbox
    // itself is created under the real temp directory.
    const realTmp = fs.realpathSync(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp');
    mocks.fakeHome = fs.mkdtempSync(path.join(realTmp, 'pd-apply-guard-home-'));
    home = mocks.fakeHome;
    workspace = fs.mkdtempSync(path.join(home, 'workspace-'));
    sandboxTmp = fs.mkdtempSync(path.join(home, 'tmp-'));
    mocks.sandboxTmp = sandboxTmp;
    mocks.gate = null;
    mocks.gateOpened.mockReset();
    mocks.spawn.mockReset();
    // The PD Home authority reads HOME directly (outside the node:os mock), so
    // the sandbox is pinned through the production precedence — otherwise the
    // route would read the REAL installation on this machine.
    savedHome = process.env.HOME;
    process.env.HOME = home;
    // Past its guard the route looks for the deployed executor, and starts it.
    const executorDist = path.join(home, '.pd', 'bootstrap', 'executor', 'dist');
    fs.mkdirSync(executorDist, { recursive: true });
    fs.writeFileSync(path.join(executorDist, 'bootstrap-entry.js'), 'export {};\n', 'utf8');
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const handler = handleRequest({ workspaceDir: workspace } as unknown as Parameters<typeof handleRequest>[0]);
    server = createServer((req, res) => { handler(req, res); });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server address');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    consoleError.mockRestore();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('starts nothing for a request that timed out while the readiness gate ran', async () => {
    const answerGate = holdGateOpen();

    const response = await fetch(`${base}/api/update/apply-full`, { method: 'POST' });

    // The transport gave up first, and that is what the page is shown.
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ success: false, error: 'Request timeout' });
    expect(mocks.gateOpened).toHaveBeenCalledTimes(1);

    // Only now does the gate answer — with an installation that IS ready.
    answerGate(readyAuthority());
    await settle();

    // Nothing starts for a request nobody is waiting for: no executor, no
    // request file, no transaction — and the route says why it stopped.
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(sandboxTmp)).toEqual([]);
    expect(fs.existsSync(path.join(home, '.pd', 'transactions'))).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('/apply-full abandoned'));
  });

  it('starts it for a request that is still waiting', async () => {
    const answerGate = holdGateOpen();
    // The executor's first act, played here: it opens the transaction journal.
    mocks.spawn.mockImplementation((...args: unknown[]) => {
      const { transactionId } = requestedTransaction(args);
      const transactionsDir = path.join(home, '.pd', 'transactions');
      fs.mkdirSync(transactionsDir, { recursive: true });
      fs.writeFileSync(path.join(transactionsDir, `${transactionId}.jsonl`), '{}\n', 'utf8');
      return Object.assign(new EventEmitter(), { unref: () => undefined });
    });

    const pending = fetch(`${base}/api/update/apply-full`, { method: 'POST' });
    await vi.waitFor(() => expect(mocks.gateOpened).toHaveBeenCalledTimes(1));
    answerGate(readyAuthority());
    const response = await pending;

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        state: 'update_in_progress',
        // Names the console that took the update: the page measures the
        // release handover from it, not from the first transaction it reads.
        serverPid: process.pid,
        transactionId: expect.stringMatching(TRANSACTION_ID),
      },
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    // And nothing was abandoned.
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('abandoned'));
  });
});
