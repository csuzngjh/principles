/**
 * PRI-680 async lifecycle characterization for EvolutionWorkerService.
 *
 * The evolution worker is PIPELINE-ADJACENT (legacy evolution path, flag
 * default OFF) — during the Episode 002 freeze its production code must not
 * change, so this file pins the CURRENT lifecycle semantics, including the
 * known defects, with evidence:
 *
 *   A. steady chain ticks at the configured interval;
 *   B. a failing iteration is caught, reported via worker-status, and the
 *      chain SURVIVES (reschedule sits outside the try/catch);
 *   C. stop() halts the chain (no zombie ticks after stop);
 *   D. duplicate start for the same workspace does not create a second chain;
 *   E. DEFECT (documented, not fixed): stop() does not clear the started
 *      set, so start() after stop() for the same workspace is silently
 *      skipped — restart requires a new gateway process;
 *   F. a failing iteration WHOSE worker-status write also fails still keeps
 *      the chain alive (writeWorkerStatus swallows its own failure) — the
 *      cycle body has no silent-death vector left; the real lifecycle risks
 *      are E and the module-global timer handle shared across workspaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../../src/core/dictionary-service.js', () => ({
  DictionaryService: { get: vi.fn(() => ({ flush: vi.fn() })) },
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  initPersistence: vi.fn(),
  flushAllSessions: vi.fn(),
}));

vi.mock('../../src/core/init.js', () => ({
  ensureStateTemplates: vi.fn(),
  ensureCorePrinciples: vi.fn(),
}));

vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn(() => { throw new Error('per-test setup must override this mock'); }),
    clearCache: vi.fn(),
  },
}));

vi.mock('../../src/utils/io.js', () => ({
  atomicWriteFileSync: vi.fn(),
}));

vi.mock('../../src/service/subagent-workflow/workflow-store.js', () => ({
  WorkflowStore: class {
    getExpiredWorkspaces: () => [];
    getExpiredWorkflows: () => [];
    updateCleanupState: () => {};
    updateWorkflowState: () => {};
    recordEvent: () => {};
    dispose: () => {};
  },
}));

vi.mock('../../src/service/workflow-watchdog.js', () => ({
  runWorkflowWatchdog: vi.fn(async () => ({ anomalies: 0, details: [] })),
}));

import { atomicWriteFileSync } from '../../src/utils/io.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EvolutionWorkerService } from '../../src/service/evolution-worker.js';

const POLL_MS = 1_000;
const INITIAL_DELAY_MS = 5_000;

type LogSink = { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

function makeCtx(stateDir: string, dictionaryFlush: () => void) {
  const logger: LogSink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const wctx = {
    workspaceDir: path.join(stateDir, 'ws'),
    stateDir,
    config: { get: (key: string) => (key === 'intervals.worker_poll_ms' ? POLL_MS : undefined) },
    eventLog: { recordHookExecution: vi.fn() },
    dictionary: { flush: dictionaryFlush },
    resolve: (key: string) => path.join(stateDir, `${key}.json`),
    trajectory: null,
  };
  return { logger, wctx };
}

async function startService(ctx: { logger: LogSink; wctx: unknown }) {
  EvolutionWorkerService.start({
    workspaceDir: (ctx.wctx as { workspaceDir: string }).workspaceDir,
    logger: ctx.logger,
    config: {},
  } as Parameters<typeof EvolutionWorkerService.start>[0]);
}

function heartbeatCount(logger: LogSink): number {
  return logger.info.mock.calls.filter((args) => String(args[0]).includes('HEARTBEAT')).length;
}

describe('EvolutionWorkerService lifecycle characterization (PRI-680)', () => {
  let stateDir: string;
  let dictionaryFlush: ReturnType<typeof vi.fn>;
  let logger: LogSink;
  let unhandled: unknown[];
  const onUnhandled = (err: unknown) => unhandled.push(err);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.clearAllMocks();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evo-life-'));
    dictionaryFlush = vi.fn();
    const ctx = makeCtx(stateDir, dictionaryFlush);
    logger = ctx.logger;
    vi.mocked(WorkspaceContext.fromHookContext).mockImplementation(() => ctx.wctx as never);
    EvolutionWorkerService.api = null;
    EvolutionWorkerService._startedWorkspaces.clear();
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    EvolutionWorkerService.stop({});
    EvolutionWorkerService._startedWorkspaces.clear();
    process.off('unhandledRejection', onUnhandled);
    vi.useRealTimers();
    // Best-effort cleanup: Windows briefly holds temp-dir handles after the
    // mocked fs flows; leftover dirs under os.tmpdir() are harmless.
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function startCurrent() {
    await startService({ logger, wctx: { workspaceDir: path.join(stateDir, 'ws') } });
  }

  it('A+B: chain ticks at interval and SURVIVES a failing iteration', async () => {
    dictionaryFlush.mockImplementationOnce(() => {
      throw new Error('simulated cycle failure');
    });
    await startCurrent();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS); // startup cycle
    await vi.advanceTimersByTimeAsync(POLL_MS); // cycle 1 → failure injected
    expect(logger.error.mock.calls.some((a) => String(a[0]).includes('Error in worker interval'))).toBe(true);
    expect(atomicWriteFileSync).toHaveBeenCalled(); // worker-status recorded the failure
    const afterFailure = heartbeatCount(logger);
    await vi.advanceTimersByTimeAsync(POLL_MS); // cycle 2 → clean
    expect(heartbeatCount(logger)).toBeGreaterThan(afterFailure);
    expect(unhandled).toHaveLength(0);
  });

  it('C: stop() halts the chain — no ticks after stop', async () => {
    await startCurrent();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + POLL_MS);
    const before = heartbeatCount(logger);
    expect(before).toBeGreaterThanOrEqual(1);
    EvolutionWorkerService.stop({});
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(heartbeatCount(logger)).toBe(before);
  });

  it('D: duplicate start for the same workspace runs ONE chain', async () => {
    await startCurrent();
    await startCurrent();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + POLL_MS);
    expect(heartbeatCount(logger)).toBe(1);
  });

  it('E (DEFECT, documented): start() after stop() for the same workspace is silently skipped', async () => {
    await startCurrent();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + POLL_MS);
    EvolutionWorkerService.stop({});
    await startCurrent();
    // The second start reports "Already started" — stop() never cleared the
    // started set — and no chain comes back. Restart needs a new process.
    const alreadyLogged = logger.info.mock.calls.some((a) => String(a[0]).includes('Already started'));
    expect(alreadyLogged).toBe(true);
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + POLL_MS * 5);
    expect(heartbeatCount(logger)).toBe(1); // unchanged since before stop
  });

  it('F: failing cycle + failing worker-status write still keeps the chain alive', async () => {
    // writeWorkerStatus swallows its own write failure (deliberate — status
    // file is monitoring-only), so a cycle error whose reporting also fails
    // still reaches the reschedule line. Characterizes the resilience shape:
    // the only cycle-level kill vectors are outside this service's body.
    dictionaryFlush.mockImplementation(() => {
      throw new Error('cycle failure');
    });
    vi.mocked(atomicWriteFileSync).mockImplementation(() => {
      throw new Error('disk full');
    });
    await startCurrent();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS); // startup cycle
    await vi.advanceTimersByTimeAsync(POLL_MS); // cycle 1: body fails + status write fails
    const afterFirstFailure = heartbeatCount(logger);
    expect(afterFirstFailure).toBe(1);
    expect(logger.error.mock.calls.some((a) => String(a[0]).includes('Error in worker interval'))).toBe(true);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(heartbeatCount(logger)).toBe(afterFirstFailure + 3); // chain kept ticking
    expect(unhandled).toHaveLength(0);
  });
});
