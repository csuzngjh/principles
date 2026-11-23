/**
 * PRI-1284 (PR #2750 review P1-2): candidate-chain isolation inside
 * wakeOnce selection.
 *
 * wakeOnce iterates the whole workspace queue oldest-first and skips
 * non-ready candidates (retry_wait pending, blocked, admission-refused,
 * hydration failures, lease conflicts) — so a caller-side "the workspace-
 * oldest live task is ours" pre-check does NOT bound what actually gets
 * leased: once our oldest task is skipped, the lease lands on the next
 * READY task, which can belong to a foreign sample's chain. The bound
 * caller (experiment shard formation loop) therefore passes
 * `--only-candidates` to run-once, which becomes this skipCandidate
 * predicate built on piTaskBelongsToCandidates.
 *
 * These tests prove that with the predicate active a foreign task can
 * never be leased — including the exact mixed-queue shape the review
 * required: own task in retry_wait + foreign task pending + a later
 * own-chain formation task pending.
 */
import { describe, it, expect } from 'vitest';
import type { TaskRecord } from '../../task-status.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { piTaskBelongsToCandidates } from '../intake-to-internalization-bridge.js';

const OWN_CAND = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FOREIGN_CAND = 'bbbbbbbb-0000-4000-8000-00000000000b';

function piTask(opts: {
  taskId: string;
  taskKind: string;
  status: string;
  updatedAt: string;
  correlationId?: string;
  leaseExpiresAt?: string;
  dependencyTaskIds?: string[];
}): TaskRecord {
  return {
    taskId: opts.taskId,
    taskKind: opts.taskKind,
    status: opts.status,
    attemptCount: 0,
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: opts.updatedAt,
    ...(opts.leaseExpiresAt !== undefined ? { leaseExpiresAt: opts.leaseExpiresAt } : {}),
    diagnosticJson: JSON.stringify({
      pi_metadata: {
        dependencyTaskIds: opts.dependencyTaskIds ?? [],
        channel: 'prompt',
        timeoutMs: 1000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
      },
    }),
  } as unknown as TaskRecord;
}

function makeHarness(tasks: TaskRecord[]) {
  const leased: string[] = [];
  const stateManager = {
    async listTasks(filter?: { status?: string }) {
      return tasks.filter((t) => filter?.status === undefined || t.status === filter.status);
    },
    async getTask(id: string) { return tasks.find((t) => t.taskId === id) ?? null; },
    async acquireLease({ taskId }: { taskId: string }) {
      leased.push(taskId);
      return { taskId, attemptCount: 1 } as unknown as TaskRecord;
    },
  };
  const orchestrator = new InternalizationOrchestrator(
    { stateManager: stateManager as never },
    { owner: 'test-allowlist', runtimeKind: 'test', dryRun: false },
  );
  return { orchestrator, leased };
}

const allowOwn = { skipCandidate: (t: { taskId: string; correlationId?: string }) => !piTaskBelongsToCandidates(t, [OWN_CAND]) };

describe('wakeOnce + --only-candidates allowlist (PR #2750 P1-2)', () => {
  it('never leases a foreign task when own task is in retry_wait and a foreign task is pending', async () => {
    const tasks = [
      // Foreign sample's task — OLDEST in the queue, pending and leasable.
      piTask({ taskId: `philosopher-${FOREIGN_CAND}-prompt`, taskKind: 'philosopher', status: 'pending', updatedAt: '2026-11-22T00:01:00.000Z' }),
      // Own chain's task — retry_wait whose backoff has NOT elapsed.
      piTask({ taskId: `dreamer-${OWN_CAND}-prompt`, taskKind: 'dreamer', status: 'retry_wait', updatedAt: '2026-11-22T00:02:00.000Z', correlationId: OWN_CAND, leaseExpiresAt: '2999-01-01T00:00:00.000Z' }),
      // Own chain's later formation task — pending (a different kind).
      piTask({ taskId: `scribe-${OWN_CAND}-prompt`, taskKind: 'scribe', status: 'pending', updatedAt: '2026-11-22T00:03:00.000Z', correlationId: OWN_CAND }),
    ];
    const { orchestrator, leased } = makeHarness(tasks);

    const result = await orchestrator.wakeOnce('philosopher', allowOwn);

    // The foreign pending philosopher is skipped by the caller predicate;
    // nothing else of this kind exists. It must NOT be leased.
    expect(leased).toEqual([]);
    expect(result.decision).toBe('no_ready_tasks');
    expect((result as { taskId?: string }).taskId).toBeUndefined();
  });

  it('never leases a foreign task even without the kind filter', async () => {
    const tasks = [
      piTask({ taskId: `philosopher-${FOREIGN_CAND}-prompt`, taskKind: 'philosopher', status: 'pending', updatedAt: '2026-11-22T00:01:00.000Z' }),
      piTask({ taskId: `scribe-${OWN_CAND}-prompt`, taskKind: 'scribe', status: 'retry_wait', updatedAt: '2026-11-22T00:02:00.000Z', correlationId: OWN_CAND, leaseExpiresAt: '2999-01-01T00:00:00.000Z' }),
    ];
    const { orchestrator, leased } = makeHarness(tasks);

    // Own scribe is retry_wait-pending (queue-side skip); foreign
    // philosopher is caller-skipped. No lease may happen at all.
    const result = await orchestrator.wakeOnce(undefined, allowOwn);
    expect(leased).toEqual([]);
    expect(result.decision).toBe('no_ready_tasks');
  });

  it('leases an OWN ready task ahead of nothing while foreign tasks stay queued', async () => {
    const tasks = [
      piTask({ taskId: `philosopher-${FOREIGN_CAND}-prompt`, taskKind: 'philosopher', status: 'pending', updatedAt: '2026-11-22T00:01:00.000Z' }),
      piTask({ taskId: `philosopher-${OWN_CAND}-prompt`, taskKind: 'philosopher', status: 'pending', updatedAt: '2026-11-22T00:02:00.000Z', correlationId: OWN_CAND }),
    ];
    const { orchestrator, leased } = makeHarness(tasks);

    const result = await orchestrator.wakeOnce('philosopher', allowOwn);
    expect(result.decision).toBe('leased');
    expect((result as { taskId?: string }).taskId).toBe(`philosopher-${OWN_CAND}-prompt`);
    expect(leased).toEqual([`philosopher-${OWN_CAND}-prompt`]);
  });

  it('control: without the allowlist the same queue leases the OLDEST foreign task', async () => {
    const tasks = [
      piTask({ taskId: `philosopher-${FOREIGN_CAND}-prompt`, taskKind: 'philosopher', status: 'pending', updatedAt: '2026-11-22T00:01:00.000Z' }),
      piTask({ taskId: `philosopher-${OWN_CAND}-prompt`, taskKind: 'philosopher', status: 'pending', updatedAt: '2026-11-22T00:02:00.000Z', correlationId: OWN_CAND }),
    ];
    const { orchestrator, leased } = makeHarness(tasks);

    const result = await orchestrator.wakeOnce('philosopher');
    // This is exactly the leak the allowlist closes: oldest-first selection
    // picks the foreign task when no filter is applied.
    expect(result.decision).toBe('leased');
    expect(leased).toEqual([`philosopher-${FOREIGN_CAND}-prompt`]);
  });

  it('piTaskBelongsToCandidates matches by correlationId OR embedded candidate id', () => {
    expect(piTaskBelongsToCandidates({ taskId: `dreamer-${OWN_CAND}-prompt` }, [OWN_CAND])).toBe(true);
    expect(piTaskBelongsToCandidates({ taskId: 'task-no-embed', correlationId: OWN_CAND }, [OWN_CAND])).toBe(true);
    expect(piTaskBelongsToCandidates({ taskId: `dreamer-${FOREIGN_CAND}-prompt`, correlationId: FOREIGN_CAND }, [OWN_CAND])).toBe(false);
    expect(piTaskBelongsToCandidates({ taskId: 'anything' }, [])).toBe(false);
  });
});
