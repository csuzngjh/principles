/**
 * InternalizationQueueReadModel unit tests — core snapshot aggregation logic.
 *
 * Tests the read model's ability to:
 *   - distinguish empty queue from non-empty queue (no_candidates guard)
 *   - pendingCount/retryWaitCount count only PI tasks (not all runtime tasks)
 *   - invalid metadata → hydration failures counted correctly
 *   - blocked / dependency_failed samples
 *   - ready tasks collected correctly
 *   - dominance: hydration > dependency_failed > blocked
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { InternalizationQueueReadModel } from '../internalization-queue-read-model.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { TaskRecord } from '../task-status.js';

// ── Task factory ─────────────────────────────────────────────────────────────

/**
 * Creates a TaskRecord with PI metadata for peer-runner tasks.
 * Omits optional TaskRecord fields (leaseOwner, leaseExpiresAt, etc.) that
 * the read model doesn't inspect.
 */
type MakeTaskOptions = {
  taskId?: string;
  taskKind?: string;
  status?: 'pending' | 'retry_wait' | 'failed';
  diagnosticJson?: string;
  dependencyTaskIds?: string[];
  channel?: string;
  timeoutMs?: number;
  inputArtifactRefs?: { artifactType: string; ref: string }[];
  outputArtifactRefs?: { artifactType: string; ref: string }[];
  attemptCount?: number;
  maxAttempts?: number;
  rejectionCount?: number;
};

function makeTask(overrides: MakeTaskOptions & { taskId: string; taskKind: string; status: 'pending' | 'retry_wait' | 'failed' }): TaskRecord {
  const {taskId} = overrides;
  const {taskKind} = overrides;
  const {status} = overrides;
  const dependencyTaskIds = overrides.dependencyTaskIds ?? [];
  const channel = overrides.channel ?? 'prompt';
  const timeoutMs = overrides.timeoutMs ?? 30000;
  const inputArtifactRefs = overrides.inputArtifactRefs ?? [];
  const outputArtifactRefs = overrides.outputArtifactRefs ?? [];
  const attemptCount = overrides.attemptCount ?? 0;
  const maxAttempts = overrides.maxAttempts ?? 3;
  const rejectionCount = overrides.rejectionCount ?? 0;

  let {diagnosticJson} = overrides;
  if (diagnosticJson === undefined) {
    diagnosticJson = JSON.stringify({
      pi_metadata: {
        channel,
        dependencyTaskIds,
        timeoutMs,
        inputArtifactRefs,
        outputArtifactRefs,
        rejectionCount,
      },
    });
  }

  return {
    taskId,
    taskKind,
    status,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    attemptCount,
    maxAttempts,
    diagnosticJson,
  } as unknown as TaskRecord;
}

// ── Mock state manager ───────────────────────────────────────────────────────

function createSm(
  pendingTasks: TaskRecord[],
  retryWaitTasks: TaskRecord[],
  getTaskFn: (id: string) => TaskRecord | null,
): RuntimeStateManager {
  const listTasks = vi.fn();
  const getTask = vi.fn();
  return {
    listTasks: listTasks.mockImplementation(async (filter: { status: string }) => {
      if (filter.status === 'pending') return pendingTasks;
      if (filter.status === 'retry_wait') return retryWaitTasks;
      return [];
    }),
    getTask: getTask.mockImplementation(async (id: string) => getTaskFn(id)),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as RuntimeStateManager;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('InternalizationQueueReadModel.getSnapshot', () => {

  // eslint-disable-next-line @typescript-eslint/init-declarations
  let model: InternalizationQueueReadModel;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await model?.close();
  });

  // ── P0: Empty queue → no_candidates ─────────────────────────────────────

  it('pure empty store: no tasks at all → no_candidates, inspectedCount=0', async () => {
    const sm = createSm([], [], () => null);
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.pendingCount).toBe(0);
    expect(snap.retryWaitCount).toBe(0);
    expect(snap.readyTasks).toEqual([]);
    expect(snap.noReadyTasks?.reason).toBe('no_candidates');
    expect(snap.noReadyTasks?.inspectedCount).toBe(0);
  });

  it('non-PI tasks only → counts=0, no_candidates (PI queue is empty)', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'd1', taskKind: 'diagnostician', status: 'pending' }),
        makeTask({ taskId: 'd2', taskKind: 'evaluator_janitor', status: 'pending' }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.pendingCount).toBe(0);
    expect(snap.retryWaitCount).toBe(0);
    expect(snap.noReadyTasks?.reason).toBe('no_candidates');
    expect(snap.noReadyTasks?.inspectedCount).toBe(0);
  });

  // ── P1: pendingCount / retryWaitCount exclude non-PI tasks ──────────────

  it('pendingCount / retryWaitCount count only PI peer tasks', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'non1', taskKind: 'diagnostician', status: 'pending' }),
        makeTask({ taskId: 'pi1', taskKind: 'dreamer', status: 'pending' }),
      ],
      [
        makeTask({ taskId: 'pi2', taskKind: 'philosopher', status: 'retry_wait' }),
        makeTask({ taskId: 'non2', taskKind: 'evaluator_janitor', status: 'retry_wait' }),
      ],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.pendingCount).toBe(1);   // pi1 only
    expect(snap.retryWaitCount).toBe(1); // pi2 only
  });

  // ── P2: Invalid metadata ─────────────────────────────────────────────────

  it('invalid diagnosticJson → hydration failure counted, valid tasks still ready', async () => {
    // bad1: valid pi_metadata kind but malformed JSON → hydration failure
    // good1: valid pi_metadata → ready
    const sm = createSm(
      [
        makeTask({ taskId: 'bad1', taskKind: 'dreamer', status: 'pending', diagnosticJson: '{bad' }),
        makeTask({ taskId: 'good1', taskKind: 'artificer', status: 'pending' }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.invalidMetadataCount).toBe(1);
    expect(snap.sampleInvalidTaskIds).toContain('bad1');
    expect(snap.readyTasks.find(t => t.taskId === 'good1')).toBeTruthy();
    expect(snap.noReadyTasks).toBeNull();
  });

  it('no pi_metadata at all → hydration failure, noReadyTasks=null (good tasks exist)', async () => {
    // bad2: no pi_metadata key at all (diagnosticJson = '{}')
    // good1: valid pi_metadata → ready
    const sm = createSm(
      [
        makeTask({ taskId: 'bad2', taskKind: 'scribe', status: 'pending', diagnosticJson: '{}' }),
        makeTask({ taskId: 'good1', taskKind: 'artificer', status: 'pending' }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.invalidMetadataCount).toBe(1);
    expect(snap.sampleInvalidTaskIds).toContain('bad2');
    expect(snap.readyTasks.find(t => t.taskId === 'good1')).toBeTruthy();
    expect(snap.noReadyTasks).toBeNull();
  });

  it('all PI tasks have invalid metadata → all_hydration_failed', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'bad1', taskKind: 'dreamer', status: 'pending', diagnosticJson: '{bad' }),
        makeTask({ taskId: 'bad2', taskKind: 'scribe', status: 'pending', diagnosticJson: '{}' }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.invalidMetadataCount).toBe(2);
    expect(snap.readyTasks).toEqual([]);
    expect(snap.noReadyTasks?.reason).toBe('all_hydration_failed');
  });

  // ── P3: Blocked tasks ──────────────────────────────────────────────────

  it('task with missing dependency → blocked, all_blocked', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'blocked_1', taskKind: 'philosopher', status: 'pending', dependencyTaskIds: ['missing_dep'] }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.blockedSummary.count).toBe(1);
    const [blockedSample] = snap.blockedSummary.samples;
    expect(blockedSample?.taskId).toBe('blocked_1');
    expect(blockedSample?.blockedBy).toContain('missing_dep');
    expect(snap.noReadyTasks?.reason).toBe('all_blocked');
  });

  // ── P4: Dependency failed ───────────────────────────────────────────────

  it('task waiting on a failed dependency → dependency_failed, all_dependency_failed', async () => {
    const failedDep = makeTask({ taskId: 'failed_dep', taskKind: 'dreamer', status: 'failed', diagnosticJson: '{}' });
    const sm = createSm(
      [
        makeTask({ taskId: 'waiting', taskKind: 'scribe', status: 'pending', dependencyTaskIds: ['failed_dep'] }),
      ],
      [],
      (id) => {
        if (id === 'failed_dep') return failedDep;
        return null;
      },
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.dependencyFailedSummary.count).toBe(1);
    const [depFailedSample] = snap.dependencyFailedSummary.samples;
    expect(depFailedSample?.taskId).toBe('waiting');
    expect(snap.noReadyTasks?.reason).toBe('all_dependency_failed');
  });

  // ── P5: Ready tasks ────────────────────────────────────────────────────

  it('PI task with no deps → ready, no noReadyTasks', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'ready_1', taskKind: 'dreamer', status: 'pending' }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.readyTasks).toContainEqual({ taskId: 'ready_1', taskKind: 'dreamer', channel: 'prompt' });
    expect(snap.noReadyTasks).toBeNull();
  });

  it('ready tasks collected from both pending and retry_wait', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'ready_p', taskKind: 'artificer', status: 'pending' }),
      ],
      [
        makeTask({ taskId: 'ready_r', taskKind: 'evaluator', status: 'retry_wait' }),
      ],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.readyTasks.map(t => t.taskId).sort()).toEqual(['ready_p', 'ready_r']);
    expect(snap.noReadyTasks).toBeNull();
  });

  // ── P6: Counts aggregation ──────────────────────────────────────────────

  it('countsByTaskKind and countsByChannel aggregate correctly', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'r1', taskKind: 'dreamer', status: 'pending', channel: 'prompt' }),
        makeTask({ taskId: 'r2', taskKind: 'dreamer', status: 'pending', channel: 'prompt' }),
        makeTask({ taskId: 'r3', taskKind: 'philosopher', status: 'pending', channel: 'skill' }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.countsByTaskKind.dreamer).toBe(2);
    expect(snap.countsByTaskKind.philosopher).toBe(1);
    expect(snap.countsByChannel.prompt).toBe(2);
    expect(snap.countsByChannel.skill).toBe(1);
  });

  // ── P7: Dominance ─────────────────────────────────────────────────────

  it('hydration failures dominate over blocked and dependency_failed', async () => {
    const failedDep = makeTask({ taskId: 'fd', taskKind: 'dreamer', status: 'failed', diagnosticJson: '{}' });
    const sm = createSm(
      [
        makeTask({ taskId: 'inv_1', taskKind: 'dreamer', status: 'pending', diagnosticJson: '{bad' }),
        makeTask({ taskId: 'blk_1', taskKind: 'philosopher', status: 'pending', dependencyTaskIds: ['missing'] }),
        makeTask({ taskId: 'df_1', taskKind: 'scribe', status: 'pending', dependencyTaskIds: ['fd'] }),
      ],
      [],
      (id) => {
        if (id === 'missing') return null;
        if (id === 'fd') return failedDep;
        return null;
      },
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.invalidMetadataCount).toBe(1);
    expect(snap.blockedSummary.count).toBe(1);
    expect(snap.dependencyFailedSummary.count).toBe(1);
    expect(snap.noReadyTasks?.reason).toBe('all_hydration_failed');
  });

  it('dependency_failed dominates over blocked when both present and hydration=0', async () => {
    const failedDep = makeTask({ taskId: 'fd', taskKind: 'dreamer', status: 'failed', diagnosticJson: '{}' });
    const sm = createSm(
      [
        makeTask({ taskId: 'df_1', taskKind: 'scribe', status: 'pending', dependencyTaskIds: ['fd'] }),
        makeTask({ taskId: 'blk_1', taskKind: 'artificer', status: 'pending', dependencyTaskIds: ['missing'] }),
      ],
      [],
      (id) => {
        if (id === 'fd') return failedDep;
        if (id === 'missing') return null;
        return null;
      },
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.dependencyFailedSummary.count).toBe(1);
    expect(snap.blockedSummary.count).toBe(1);
    expect(snap.noReadyTasks?.reason).toBe('all_dependency_failed');
  });

  // ── P8: Unresolvable tasks (PRI-141) ────────────────────────────────────

  it('unresolvable task (rejectionCount >= 3) excluded from readyTasks', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'unresolvable_1', taskKind: 'scribe', status: 'pending', rejectionCount: 3 }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.readyTasks).toEqual([]);
    expect(snap.unresolvableSummary.count).toBe(1);
    expect(snap.unresolvableSummary.samples[0]?.taskId).toBe('unresolvable_1');
    expect(snap.unresolvableSummary.samples[0]?.rejectionCount).toBe(3);
  });

  it('all unresolvable tasks → all_unresolvable reason', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'u1', taskKind: 'scribe', status: 'pending', rejectionCount: 3 }),
        makeTask({ taskId: 'u2', taskKind: 'artificer', status: 'pending', rejectionCount: 5 }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.readyTasks).toEqual([]);
    expect(snap.unresolvableSummary.count).toBe(2);
    expect(snap.noReadyTasks?.reason).toBe('all_unresolvable');
  });

  it('unresolvable task mixed with ready task: ready task still available', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'u1', taskKind: 'scribe', status: 'pending', rejectionCount: 3 }),
        makeTask({ taskId: 'r1', taskKind: 'dreamer', status: 'pending', rejectionCount: 0 }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.readyTasks).toContainEqual({ taskId: 'r1', taskKind: 'dreamer', channel: 'prompt' });
    expect(snap.unresolvableSummary.count).toBe(1);
    expect(snap.noReadyTasks).toBeNull();
  });

  it('task with rejectionCount < 3 is NOT unresolvable', async () => {
    const sm = createSm(
      [
        makeTask({ taskId: 'retry_1', taskKind: 'scribe', status: 'pending', rejectionCount: 2 }),
      ],
      [],
      () => null,
    );
    model = new InternalizationQueueReadModel(sm);
    const snap = await model.getSnapshot();

    expect(snap.readyTasks).toContainEqual({ taskId: 'retry_1', taskKind: 'scribe', channel: 'prompt' });
    expect(snap.unresolvableSummary.count).toBe(0);
  });

});
