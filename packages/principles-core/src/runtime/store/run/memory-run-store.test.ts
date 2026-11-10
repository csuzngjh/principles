/**
 * MemoryRunStore.getLatestRunStartedAtForTaskKind — the in-memory analogue of
 * the SQLite task/runs join used by the L2b backlog activity signal.
 *
 * Run rows carry no task_kind column, so attribution comes from the seeding
 * caller. A run the caller cannot attribute must be ignored (not guessed).
 */
import { describe, expect, it } from 'vitest';
import { MemoryRunStore } from './memory-run-store.js';
import type { RunRecord } from './run-store.js';

function run(runId: string, taskId: string, startedAt: string): Omit<RunRecord, 'createdAt' | 'updatedAt'> {
  return {
    runId,
    taskId,
    runtimeKind: 'test-double',
    executionStatus: 'succeeded',
    startedAt,
    attemptNumber: 1,
  };
}

describe('MemoryRunStore.getLatestRunStartedAtForTaskKind', () => {
  it('returns the latest startedAt among runs attributed to the kind', async () => {
    const store = new MemoryRunStore((taskId) => (taskId.startsWith('diag') ? 'diagnostician' : 'other'));
    await store.createRun(run('r1', 'diag_1', '2026-11-11T08:00:00.000Z'));
    await store.createRun(run('r2', 'diag_2', '2026-11-11T09:30:00.000Z'));
    await store.createRun(run('r3', 'other_1', '2026-11-11T10:00:00.000Z'));

    await expect(store.getLatestRunStartedAtForTaskKind('diagnostician'))
      .resolves.toBe('2026-11-11T09:30:00.000Z');
  });

  it('returns null when no run is attributed to the kind', async () => {
    const store = new MemoryRunStore(() => 'other');
    await store.createRun(run('r1', 'diag_1', '2026-11-11T08:00:00.000Z'));

    await expect(store.getLatestRunStartedAtForTaskKind('diagnostician')).resolves.toBeNull();
  });

  it('does not attribute anything when the caller gives no attribution', async () => {
    const store = new MemoryRunStore();
    await store.createRun(run('r1', 'diag_1', '2026-11-11T08:00:00.000Z'));

    await expect(store.getLatestRunStartedAtForTaskKind('diagnostician')).resolves.toBeNull();
  });
});
