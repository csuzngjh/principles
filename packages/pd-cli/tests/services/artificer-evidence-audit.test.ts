/**
 * PRI-985 / SPEC-PD-IAER-001 FR-09 — artificer evidence-pack failure history audit.
 *
 * Unit tests for the PURE aggregation function. Fixture rows mirror the real
 * production signature observed in production state.db (T11): 385 runs across
 * 82 tasks — many runs, few tasks. The aggregation must never report one run
 * as one task.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateArtificerEvidenceRuns,
  loadPackMissingRuns,
  loadSucceededTaskIds,
  type ArtificerEvidenceRunRow,
  type ArtificerEvidenceTaskRow,
} from '../../src/services/artificer-evidence-audit.js';

function runRow(overrides: Partial<ArtificerEvidenceRunRow> = {}): ArtificerEvidenceRunRow {
  return {
    taskId: 'artificer-repair-task-a-r1',
    runtimeKind: 'pi-ai-l2',
    executionStatus: 'failed',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:01:00.000Z',
    reason: 'behavior_example_pack_missing: no pack assembled',
    errorCategory: 'execution_failed',
    attemptNumber: 1,
    ...overrides,
  };
}

function taskRow(overrides: Partial<ArtificerEvidenceTaskRow> = {}): ArtificerEvidenceTaskRow {
  return {
    taskId: 'artificer-repair-task-a-r1',
    taskKind: 'artificer',
    status: 'failed',
    attemptCount: 3,
    maxAttempts: 3,
    ...overrides,
  };
}

const NO_SUCCEEDED = new Set<string>();
const NO_GOVERNANCE = new Set<string>();

describe('aggregateArtificerEvidenceRuns', () => {
  it('aggregates multiple runs of one task into ONE task entry (T11: runs are not tasks)', () => {
    const runs = [
      runRow({ attemptNumber: 1, startedAt: '2026-09-01T10:00:00.000Z' }),
      runRow({ attemptNumber: 2, startedAt: '2026-09-01T11:00:00.000Z', errorCategory: 'max_attempts_exceeded' }),
      runRow({ attemptNumber: 3, startedAt: '2026-09-01T12:00:00.000Z' }),
    ];
    const report = aggregateArtificerEvidenceRuns({
      runs,
      tasks: [taskRow()],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
    });

    expect(report.summary.totalRuns).toBe(3);
    expect(report.summary.distinctTasks).toBe(1);
    expect(report.tasks).toHaveLength(1);

    const task = report.tasks[0];
    expect(task.taskId).toBe('artificer-repair-task-a-r1');
    expect(task.runCount).toBe(3);
    expect(task.failureCategories).toEqual({ execution_failed: 2, max_attempts_exceeded: 1 });
    expect(task.firstFailureAt).toBe('2026-09-01T10:00:00.000Z');
    expect(task.lastFailureAt).toBe('2026-09-01T12:00:00.000Z');
  });

  it('keeps tasks of both runtime kinds in the same per-task aggregation', () => {
    const runs = [
      runRow({ runtimeKind: 'pi-ai-l2', attemptNumber: 1 }),
      runRow({ runtimeKind: 'pi-ai', taskId: 'artificer-repair-task-a-r1', attemptNumber: 2 }),
    ];
    const report = aggregateArtificerEvidenceRuns({
      runs,
      tasks: [taskRow()],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
    });

    expect(report.summary.distinctTasks).toBe(1);
    expect(report.summary.byRuntimeKind).toEqual({ 'pi-ai-l2': 1, 'pi-ai': 1 });
  });

  it('flags repeated_retry_consumption when a task has more than one failing run', () => {
    const runs = [runRow({ attemptNumber: 1 }), runRow({ attemptNumber: 2 })];
    const report = aggregateArtificerEvidenceRuns({
      runs,
      tasks: [taskRow()],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
    });
    expect(report.tasks[0].anomalies.repeatedRetryConsumption).toBe(true);
  });

  it('does not flag repeated_retry_consumption for a single failing run', () => {
    const report = aggregateArtificerEvidenceRuns({
      runs: [runRow()],
      tasks: [taskRow()],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
    });
    expect(report.tasks[0].anomalies.repeatedRetryConsumption).toBe(false);
  });

  it('flags succeeded_run_then_failed only when a succeeded run exists AND the task finally failed', () => {
    const succeeded = new Set(['task-ok-final', 'task-failed-after-success']);

    const bothFlags = aggregateArtificerEvidenceRuns({
      runs: [runRow({ taskId: 'task-failed-after-success' })],
      tasks: [taskRow({ taskId: 'task-failed-after-success', status: 'failed' })],
      succeededTaskIds: succeeded,
      governanceTaskIds: NO_GOVERNANCE,
    });
    expect(bothFlags.tasks[0].anomalies.succeededRunThenFailed).toBe(true);

    const succeededOnly = aggregateArtificerEvidenceRuns({
      runs: [runRow({ taskId: 'task-ok-final' })],
      tasks: [taskRow({ taskId: 'task-ok-final', status: 'succeeded' })],
      succeededTaskIds: succeeded,
      governanceTaskIds: NO_GOVERNANCE,
    });
    expect(succeededOnly.tasks[0].anomalies.succeededRunThenFailed).toBe(false);
  });

  it('flags has_governance_side_effects from the provided governance task ids', () => {
    const governance = new Set(['artificer-repair-task-a-r1']);
    const report = aggregateArtificerEvidenceRuns({
      runs: [runRow()],
      tasks: [taskRow()],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: governance,
    });
    expect(report.tasks[0].anomalies.hasGovernanceSideEffects).toBe(true);
    expect(report.summary.anomalyCounts.hasGovernanceSideEffects).toBe(1);
  });

  it('marks pack_missing_failure true for every audited task (the scan filter is the signature)', () => {
    const report = aggregateArtificerEvidenceRuns({
      runs: [runRow({ taskId: 't1' }), runRow({ taskId: 't2', startedAt: '2026-09-02T10:00:00.000Z' })],
      tasks: [taskRow({ taskId: 't1' }), taskRow({ taskId: 't2' })],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
    });
    for (const task of report.tasks) {
      expect(task.anomalies.packMissingFailure).toBe(true);
    }
    expect(report.summary.anomalyCounts.packMissingFailure).toBe(2);
  });

  it('summarizes final task statuses and reports a task row join miss without inventing state', () => {
    const report = aggregateArtificerEvidenceRuns({
      runs: [runRow({ taskId: 't-has-row' }), runRow({ taskId: 't-orphan', startedAt: '2026-09-02T10:00:00.000Z' })],
      tasks: [taskRow({ taskId: 't-has-row', status: 'needs_human_review' })],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
    });

    expect(report.summary.byFinalTaskStatus).toEqual({
      needs_human_review: 1,
      unknown_missing_task_row: 1,
    });

    const orphan = report.tasks.find((t) => t.taskId === 't-orphan');
    expect(orphan?.taskRowFound).toBe(false);
    expect(orphan?.taskStatus).toBeNull();
    expect(orphan?.attemptCount).toBeNull();
    expect(orphan?.nextAction).toContain('integrity');
  });

  it('branches nextAction by final task status toward real recovery entry points', () => {
    const report = aggregateArtificerEvidenceRuns({
      runs: [
        runRow({ taskId: 't-nhr' }),
        runRow({ taskId: 't-failed', startedAt: '2026-09-02T10:00:00.000Z' }),
      ],
      tasks: [
        taskRow({ taskId: 't-nhr', status: 'needs_human_review' }),
        taskRow({ taskId: 't-failed', status: 'failed', attemptCount: 3, maxAttempts: 3 }),
      ],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
    });

    const nhr = report.tasks.find((t) => t.taskId === 't-nhr');
    expect(nhr?.nextAction).toContain('pd runtime internalization retry --task t-nhr --confirm');
    expect(nhr?.nextAction).toContain('PRI-983');

    const failed = report.tasks.find((t) => t.taskId === 't-failed');
    expect(failed?.nextAction).toContain('pd runtime recovery failed-tasks --confirm');
    expect(failed?.nextAction).toContain('--force'); // attempts exhausted (3/3)
  });

  it('orders tasks deterministically by first failure then task id', () => {
    const report = aggregateArtificerEvidenceRuns({
      runs: [
        runRow({ taskId: 'b-task', startedAt: '2026-09-01T10:00:00.000Z' }),
        runRow({ taskId: 'a-task', startedAt: '2026-08-01T10:00:00.000Z' }),
        runRow({ taskId: 'a-task', startedAt: '2026-09-03T10:00:00.000Z' }),
      ],
      tasks: [taskRow({ taskId: 'b-task' }), taskRow({ taskId: 'a-task' })],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
    });
    expect(report.tasks.map((t) => t.taskId)).toEqual(['a-task', 'b-task']);
  });

  it('returns a structured empty report when no matching runs exist', () => {
    const report = aggregateArtificerEvidenceRuns({
      runs: [],
      tasks: [],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
    });
    expect(report.summary.totalRuns).toBe(0);
    expect(report.summary.distinctTasks).toBe(0);
    expect(report.tasks).toEqual([]);
    expect(report.summary.byRuntimeKind).toEqual({});
  });

  it('carries the governance detection method through to the report', () => {
    const available = aggregateArtificerEvidenceRuns({
      runs: [runRow()],
      tasks: [taskRow()],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
      governanceDetection: 'approvals JOIN pi_artifacts ON source_task_id',
    });
    expect(available.governanceDetection).toBe('approvals JOIN pi_artifacts ON source_task_id');

    const unavailable = aggregateArtificerEvidenceRuns({
      runs: [runRow()],
      tasks: [taskRow()],
      succeededTaskIds: NO_SUCCEEDED,
      governanceTaskIds: NO_GOVERNANCE,
      governanceDetection: 'unavailable',
    });
    expect(unavailable.governanceDetection).toBe('unavailable');
  });
});

describe('row validation (rc-1/rc-3: DB rows are untrusted; malformed rows fail loud)', () => {
  function fakeDb(allResult: unknown[]): { prepare: (sql: string) => { all: () => unknown[] } } {
    return { prepare: () => ({ all: () => allResult }) };
  }

  it('rejects a run row with a missing required field instead of skipping it', () => {
    const db = fakeDb([{ task_id: 't1', runtime_kind: 'pi-ai-l2', execution_status: 'failed', started_at: null }]);
    expect(() => loadPackMissingRuns(db as never)).toThrow(/started_at/);
  });

  it('rejects a non-object row instead of coercing it', () => {
    const db = fakeDb(['not-an-object']);
    expect(() => loadPackMissingRuns(db as never)).toThrow(/not an object/);
  });

  it('rejects a succeeded-task row whose task_id is not a non-empty string', () => {
    const db = fakeDb([{ task_id: 42 }]);
    expect(() => loadSucceededTaskIds(db as never, ['t1'])).toThrow(/task_id/);
  });
});
