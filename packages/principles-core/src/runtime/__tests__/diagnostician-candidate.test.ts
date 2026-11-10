/**
 * Shared Diagnostician candidate selection (SPEC §8.4.3 / §9.1).
 *
 * These cases protect the two properties the extraction must preserve:
 * a retry_wait task whose backoff has NOT elapsed can never starve a younger
 * eligible task, and the round-robin cursor serves pending and due-retry at
 * least every other cycle.
 */
import { describe, expect, it } from 'vitest';
import { DIAGNOSTICIAN_FAIR_SHARE_SCOPE, pickDiagnosticianCandidate } from '../diagnostician-candidate.js';
import type { DiagnosticianCandidateStatePort } from '../diagnostician-candidate.js';
import type { TaskRecord } from '../task-status.js';

const NOW = '2026-11-11T10:00:00.000Z';
// The backoff window is evaluated against Date.now() by the production guard,
// so the fixtures are relative to the real clock rather than a fixed instant.
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

type Cursor = Awaited<ReturnType<DiagnosticianCandidateStatePort['getDiagnosticianServiceCursor']>>;

function task(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    taskKind: 'diagnostician',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

class FakeState implements DiagnosticianCandidateStatePort {
  readonly cursorWrites: { scope: string; value: { lastUpdatedAt: string; lastTaskId?: string } }[] = [];
  cursorReads = 0;

  constructor(
    private readonly tasks: TaskRecord[],
    private cursor: Cursor = null,
  ) {}

  async listTasks(options: Parameters<DiagnosticianCandidateStatePort['listTasks']>[0]): Promise<TaskRecord[]> {
    const filtered = this.tasks.filter(
      (candidate) => candidate.taskKind === options.taskKind
        && (options.status === undefined || candidate.status === options.status),
    );
    filtered.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    return filtered.slice(0, options.limit ?? filtered.length);
  }

  async getDiagnosticianServiceCursor(scope: string): Promise<Cursor> {
    this.cursorReads += 1;
    expect(scope).toBe(DIAGNOSTICIAN_FAIR_SHARE_SCOPE);
    return this.cursor;
  }

  async setDiagnosticianServiceCursor(
    scope: string,
    value: { lastUpdatedAt: string; lastTaskId?: string },
  ): Promise<void> {
    this.cursor = value;
    this.cursorWrites.push({ scope, value });
  }
}

describe('pickDiagnosticianCandidate', () => {
  it('returns null and writes no cursor when nothing is eligible', async () => {
    const state = new FakeState([]);
    await expect(pickDiagnosticianCandidate(state, 10, NOW)).resolves.toBeNull();
    expect(state.cursorWrites).toEqual([]);
  });

  it('serves the only pending task and records the pending class', async () => {
    const state = new FakeState([task({ taskId: 'p1' })]);
    await expect(pickDiagnosticianCandidate(state, 10, NOW)).resolves.toMatchObject({ taskId: 'p1' });
    expect(state.cursorWrites).toHaveLength(1);
    expect(state.cursorWrites[0]?.value.lastTaskId).toBe('pending');
    expect(state.cursorWrites[0]?.scope).toBe(DIAGNOSTICIAN_FAIR_SHARE_SCOPE);
  });

  it('serves a retry_wait task only after its backoff window elapsed', async () => {
    const due = new FakeState([task({ taskId: 'r-due', status: 'retry_wait', leaseExpiresAt: PAST })]);
    await expect(pickDiagnosticianCandidate(due, 10, NOW)).resolves.toMatchObject({ taskId: 'r-due' });
    expect(due.cursorWrites[0]?.value.lastTaskId).toBe('retry_wait');

    const waiting = new FakeState([task({ taskId: 'r-wait', status: 'retry_wait', leaseExpiresAt: FUTURE })]);
    await expect(pickDiagnosticianCandidate(waiting, 10, NOW)).resolves.toBeNull();
    expect(waiting.cursorWrites).toEqual([]);
  });

  it('skips a still-waiting retry ahead of an eligible one instead of starving it', async () => {
    const state = new FakeState([
      task({ taskId: 'r-wait', status: 'retry_wait', leaseExpiresAt: FUTURE, updatedAt: '2026-11-11T08:00:00.000Z' }),
      task({ taskId: 'r-due', status: 'retry_wait', leaseExpiresAt: PAST, updatedAt: '2026-11-11T09:00:00.000Z' }),
    ]);
    await expect(pickDiagnosticianCandidate(state, 10, NOW)).resolves.toMatchObject({ taskId: 'r-due' });
  });

  it('alternates classes: no cursor -> retry, last retry -> pending, last pending -> retry', async () => {
    const tasks = [
      task({ taskId: 'p1', updatedAt: '2026-11-11T08:00:00.000Z' }),
      task({ taskId: 'r1', status: 'retry_wait', leaseExpiresAt: PAST, updatedAt: '2026-11-11T08:30:00.000Z' }),
    ];

    const fresh = new FakeState(tasks);
    await expect(pickDiagnosticianCandidate(fresh, 10, NOW)).resolves.toMatchObject({ taskId: 'r1' });
    expect(fresh.cursorWrites[0]?.value.lastTaskId).toBe('retry_wait');

    const afterRetry = new FakeState(tasks, { lastUpdatedAt: PAST, lastTaskId: 'retry_wait' });
    await expect(pickDiagnosticianCandidate(afterRetry, 10, NOW)).resolves.toMatchObject({ taskId: 'p1' });
    expect(afterRetry.cursorWrites[0]?.value.lastTaskId).toBe('pending');

    const afterPending = new FakeState(tasks, { lastUpdatedAt: PAST, lastTaskId: 'pending' });
    await expect(pickDiagnosticianCandidate(afterPending, 10, NOW)).resolves.toMatchObject({ taskId: 'r1' });
    expect(afterPending.cursorWrites[0]?.value.lastTaskId).toBe('retry_wait');
    expect(afterPending.cursorReads).toBe(1);
  });

  it('keeps the candidate set bounded by the caller-supplied limit', async () => {
    const state = new FakeState([
      task({ taskId: 'p-old', updatedAt: '2026-11-11T07:00:00.000Z' }),
      task({ taskId: 'p-new', updatedAt: '2026-11-11T09:00:00.000Z' }),
    ]);
    await expect(pickDiagnosticianCandidate(state, 1, NOW)).resolves.toMatchObject({ taskId: 'p-old' });
  });
});
