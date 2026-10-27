/**
 * PRI-954 (F10) — oldest-ready-stage-first fairness in the REAL consumer
 * cycle.
 *
 * Dogfood evidence (2026-10-13, findings F10): with the fixed dreamer-first
 * order and one-task-per-cycle, a continuous stream of new dreamer tasks kept
 * philosopher tasks waiting 35+ minutes (13-deep backlog) even though they
 * were ready. The fix starts each cycle's stage scan at the stage owning the
 * GLOBALLY OLDEST ready task — bounded waits, no concurrency, no persisted
 * scheduler state (works across one-shot `--once` worker processes), and
 * leases/idempotency/dependency-order/single-task-per-cycle semantics
 * unchanged.
 *
 * These tests drive the REAL `runInternalizationConsumerCycle` against a real
 * workspace state.db; only the runner LLM boundary is doubled (each runner
 * marks its task succeeded), exactly like the sibling per-agent-profile test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  DreamerRunner,
  PhilosopherRunner,
  ScribeRunner,
  getDefaultPdConfig,
  type RuntimeStateManager,
} from '@principles/core/runtime-v2';
import { runInternalizationConsumerCycle, orderKindsByOldestReadyStage } from '../src/internalization-consumer-cycle.js';

const dirs: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cycle-fairness-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features.internalization_auto_consumer.enabled = true;
  config.features.internalization_full_chain.enabled = true;
  // ADR-0029: the shipped default is a pi-ai profile with empty placeholders,
  // which is deliberately `needs_setup`. This test is about ordering, not
  // setup, so declare the ready profile the same way the sibling cycle tests do.
  (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
    type: 'pi-ai', provider: 'base-prov', model: 'base-model', apiKeyEnv: 'BASE_KEY',
  };
  config.internalAgents.defaultRuntime = 'pd.default';
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}

async function withState<T>(workspaceDir: string, fn: (sm: RuntimeStateManager) => Promise<T>): Promise<T> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    return await fn(handle.stateManager);
  } finally {
    await handle.close();
  }
}

async function seedTask(workspaceDir: string, taskId: string, taskKind: string, status: string, deps: string[]): Promise<void> {
  await withState(workspaceDir, async (sm) => {
    await sm.createTask({
      taskId,
      taskKind,
      status,
      attemptCount: status === 'succeeded' ? 1 : 0,
      maxAttempts: 3,
      ...(status === 'succeeded' ? { resultRef: `${taskKind}://seed` } : {}),
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: deps,
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        correlationId: 'corr-fair',
      }),
    });
  });
}

function markSucceeded(runner: unknown): void {
  vi.spyOn(runner.prototype, 'run').mockImplementation(async function (this: { stateManager: RuntimeStateManager }, taskId: string) {
    await this.stateManager.markTaskSucceeded(taskId, 'test://run');
    return { status: 'succeeded', taskId, attemptCount: 1 } as never;
  });
}

let logger: { info: () => void; warn: () => void; error: () => void };

beforeEach(() => {
  process.env.BASE_KEY = 'test-key';
  logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  // The runner boundary is the only doubled seam; every stage succeeds.
  markSucceeded(DreamerRunner);
  markSucceeded(PhilosopherRunner);
  markSucceeded(ScribeRunner);
});

afterEach(() => {
  delete process.env.BASE_KEY;
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
  vi.restoreAllMocks();
});

function cycle(workspace: string): Promise<{ ran: boolean; taskKind?: string; skipReason?: string }> {
  return runInternalizationConsumerCycle(workspace, {
    owner: 'test',
    logLabel: 'FAIR',
    logger,
    emitEvent: () => undefined,
  }) as Promise<{ ran: boolean; taskKind?: string; skipReason?: string }>;
}

describe('PRI-954 oldest-ready-stage-first fairness', () => {
  it('A: an older ready philosopher is served before a newer ready dreamer (old order starved it)', async () => {
    const workspace = makeWorkspace();
    // A succeeded seed dreamer satisfies the philosopher dependency. Seeding
    // order fixes ages: philosopher FIRST (oldest ready), the "newest pain"
    // dreamer LAST.
    await seedTask(workspace, 'dreamer-seed-corr-fair-prompt', 'dreamer', 'succeeded', []);
    await sleep(20);
    await seedTask(workspace, 'philosopher-corr-fair-prompt', 'philosopher', 'pending', ['dreamer-seed-corr-fair-prompt']);
    await sleep(20);
    await seedTask(workspace, 'dreamer-1-corr-fair-prompt', 'dreamer', 'pending', []);

    const first = await cycle(workspace);
    console.log('C-DIAG-FULL:', JSON.stringify(first));
    expect(first.ran).toBe(true);
    // Under the old fixed order this cycle leased dreamer-1 (priority head).
    expect(first.taskKind).toBe('philosopher');

    const second = await cycle(workspace);
    expect(second.ran).toBe(true);
    expect(second.taskKind).toBe('dreamer'); // the newer dreamer is still served next
  });

  it('B: with dreamer+philosopher+scribe all ready, cycles serve them oldest-first', async () => {
    const workspace = makeWorkspace();
    await seedTask(workspace, 'dreamer-seed-corr-fair-prompt', 'dreamer', 'succeeded', []);
    await seedTask(workspace, 'philosopher-seed-corr-fair-prompt', 'philosopher', 'succeeded', []);
    await sleep(20);
    await seedTask(workspace, 'philosopher-1-corr-fair-prompt', 'philosopher', 'pending', ['dreamer-seed-corr-fair-prompt']);
    await sleep(20);
    await seedTask(workspace, 'scribe-1-corr-fair-prompt', 'scribe', 'pending', ['philosopher-seed-corr-fair-prompt']);
    await sleep(20);
    await seedTask(workspace, 'dreamer-1-corr-fair-prompt', 'dreamer', 'pending', []);

    const served: Array<string | undefined> = [];
    for (let i = 0; i < 3; i += 1) {
      const outcome = await cycle(workspace);
      expect(outcome.ran).toBe(true);
      served.push(outcome.taskKind);
    }
    // Oldest ready first: philosopher → scribe → dreamer.
    expect(served).toEqual(['philosopher', 'scribe', 'dreamer']);
  });

  it('D: exactly one task per cycle (no implicit batching)', async () => {
    const workspace = makeWorkspace();
    await seedTask(workspace, 'dreamer-seed-corr-fair-prompt', 'dreamer', 'succeeded', []);
    await seedTask(workspace, 'dreamer-1-corr-fair-prompt', 'dreamer', 'pending', []);
    await seedTask(workspace, 'dreamer-2-corr-fair-prompt', 'dreamer', 'pending', []);

    const outcome = await cycle(workspace);
    expect(outcome.ran).toBe(true);
    const statuses = await withState(workspace, async (sm) => {
      const all = await sm.listTasks({});
      return new Map(all.map((t) => [t.taskId, t.status]));
    });
    // Exactly the leased task transitioned; its sibling dreamer stays pending
    // for the next cycle (the successor the runner creates for the completed
    // stage is expected chain behavior, not batching).
    expect(statuses.get('dreamer-1-corr-fair-prompt')).toBe('succeeded');
    expect(statuses.get('dreamer-2-corr-fair-prompt')).toBe('pending');
  });

  it('G: empty queue degrades as no_ready_tasks and the next cycle resumes', async () => {
    const workspace = makeWorkspace();
    const empty = await cycle(workspace);
    expect(empty.ran).toBe(false);
    expect(empty.skipReason).toBe('no_ready_tasks');

    await seedTask(workspace, 'dreamer-1-corr-fair-prompt', 'dreamer', 'pending', []);
    const resumed = await cycle(workspace);
    expect(resumed.ran).toBe(true);
    expect(resumed.taskKind).toBe('dreamer');
  });

  it('E: a newer dreamer joining between cycles does not displace the service order', async () => {
    const workspace = makeWorkspace();
    await seedTask(workspace, 'dreamer-seed-corr-fair-prompt', 'dreamer', 'succeeded', []);
    await sleep(20);
    await seedTask(workspace, 'philosopher-1-corr-fair-prompt', 'philosopher', 'pending', ['dreamer-seed-corr-fair-prompt']);
    const first = await cycle(workspace);
    expect(first.taskKind).toBe('philosopher'); // oldest ready first

    // Cycle 1 also created the philosopher's SUCCESSOR (scribe, chain
    // convention) and it is older than the dreamer joining afterwards —
    // the successor is served next; the late dreamer never displaces it.
    await seedTask(workspace, 'dreamer-new-corr-fair-prompt', 'dreamer', 'pending', []);
    const second = await cycle(workspace);
    expect(second.taskKind).toBe('scribe');

    // Next: the philosopher successor created in cycle 1 (older than the
    // newcomer) — only then does the late dreamer get its turn.
    const third = await cycle(workspace);
    expect(third.taskKind).toBe('philosopher');
    const fourth = await cycle(workspace);
    expect(fourth.taskKind).toBe('dreamer');
  });

  it('H: the ordering policy is stateless — identical inputs across simulated process restarts order identically', async () => {
    // The fairness policy derives purely from the ready snapshot (no
    // in-process scheduler state), so a fresh `--once` worker process
    // reproduces the same service order. Direct unit check of the pure
    // ordering function, including tie-breaks and missing createdAt.
    const kinds = ['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer'] as const;
    // No ready tasks → original priority order.
    expect(orderKindsByOldestReadyStage(kinds, [])).toEqual([...kinds]);
    // Oldest ready wins regardless of priority position.
    expect(orderKindsByOldestReadyStage(kinds, [
      { taskKind: 'dreamer', createdAt: '2026-10-13T10:00:00Z' },
      { taskKind: 'philosopher', createdAt: '2026-10-13T09:00:00Z' },
    ])[0]).toBe('philosopher');
    // Ties keep the original priority order (dreamer before philosopher).
    expect(orderKindsByOldestReadyStage(kinds, [
      { taskKind: 'philosopher', createdAt: '2026-10-13T09:00:00Z' },
      { taskKind: 'dreamer', createdAt: '2026-10-13T09:00:00Z' },
    ])[0]).toBe('dreamer');
    // Missing createdAt never jumps the queue.
    expect(orderKindsByOldestReadyStage(kinds, [
      { taskKind: 'philosopher', createdAt: undefined },
      { taskKind: 'dreamer', createdAt: '2026-10-13T09:00:00Z' },
    ])[0]).toBe('dreamer');
  });
});
