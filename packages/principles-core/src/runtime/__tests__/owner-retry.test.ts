/**
 * owner-retry.ts tests — Governance Recovery Actions v1.
 *
 * The extracted owner authority reset (needs_human_review → pending, clearing
 * runnerDecision + completionIntent atomically). CLI behavior is guarded by
 * pd-cli's runtime-internalization-retry-owner-authority tests against the
 * SAME shared function; these tests exercise the function directly and via
 * the RecoverySweepService production path (EP-02: real RuntimeStateManager +
 * real SQLite temp workspace — no store mocks).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import {
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
} from '../internalization/pitask-metadata.js';
import type { PITaskMetadata } from '../internalization/pitask-metadata.js';
import { ownerRetryNeedsHumanReviewTask } from '../internalization/owner-retry.js';
import { createRecoverySweepService } from '../recovery-sweep-service.js';

const TASK_ID = 'rollout_reviewer-owner-retry-core';

let workspaceDir: string;
let stateManager: RuntimeStateManager;

/** RunnerCompletionIntent derived from the metadata type (not exported directly). */
type RunnerCompletionIntent = NonNullable<PITaskMetadata['completionIntent']>;

function intent(status: 'pending' | 'applied'): RunnerCompletionIntent {
  return {
    decision: 'needs_revision',
    sourceRunId: 'run-core-1',
    revisionEpoch: 1,
    status,
    effect: 'needs_human_review',
  };
}

async function seedNeedsHumanReview(
  opts: { taskId?: string; meta?: Partial<PITaskMetadata>; diagnosticJson?: string } = {},
): Promise<void> {
  await stateManager.createTask({
    taskId: opts.taskId ?? TASK_ID,
    taskKind: 'rollout_reviewer',
    status: 'needs_human_review',
    attemptCount: 2,
    maxAttempts: 3,
    diagnosticJson:
      opts.diagnosticJson ??
      createPITaskDiagnosticJson({
        dependencyTaskIds: ['evaluator-1'],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        correlationId: 'owner-retry-core',
        ...opts.meta,
      }),
  });
}

async function readTask(taskId: string = TASK_ID) {
  return stateManager.getTask(taskId);
}

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-retry-core-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
});

afterEach(async () => {
  await stateManager.close();
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    /* temp */
  }
});

describe('ownerRetryNeedsHumanReviewTask (direct function)', () => {
  it('resets status/attemptCount and clears runnerDecision + completionIntent', async () => {
    await seedNeedsHumanReview({
      meta: { runnerDecision: 'needs_revision', completionIntent: intent('applied') },
    });

    const outcome = await ownerRetryNeedsHumanReviewTask(stateManager, TASK_ID);
    expect(outcome).toEqual({
      status: 'requeued',
      taskKind: 'rollout_reviewer',
      previousStatus: 'needs_human_review',
    });

    const task = await readTask();
    expect(task?.status).toBe('pending');
    expect(task?.attemptCount).toBe(0);

    const meta = task ? hydratePITaskRecord(task) : null;
    expect(meta).not.toBeNull();
    expect(meta?.runnerDecision).toBeUndefined();
    expect(meta?.completionIntent).toBeUndefined();
    // lineage preserved
    expect(meta?.dependencyTaskIds).toEqual(['evaluator-1']);
    expect(meta?.channel).toBe('prompt');
  });

  it('returns not_found for an unknown task id (no mutation)', async () => {
    const outcome = await ownerRetryNeedsHumanReviewTask(stateManager, 'does-not-exist');
    expect(outcome).toEqual({ status: 'not_found' });
  });

  it('returns skipped (no mutation) for a task that is not needs_human_review', async () => {
    await seedNeedsHumanReview({ taskId: 'failed-task-1' });
    await stateManager.updateTask('failed-task-1', { status: 'failed' });

    const outcome = await ownerRetryNeedsHumanReviewTask(stateManager, 'failed-task-1');
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.previousStatus).toBe('failed');
      expect(outcome.taskKind).toBe('rollout_reviewer');
    }
    // row untouched
    expect((await readTask('failed-task-1'))?.status).toBe('failed');
  });

  it('fail-closed: metadata_invalid leaves the row completely untouched', async () => {
    await seedNeedsHumanReview({ diagnosticJson: JSON.stringify({ note: 'not pi metadata' }) });

    const outcome = await ownerRetryNeedsHumanReviewTask(stateManager, TASK_ID);
    expect(outcome).toEqual({ status: 'metadata_invalid', taskKind: 'rollout_reviewer' });

    const task = await readTask();
    expect(task?.status).toBe('needs_human_review');
    expect(task?.attemptCount).toBe(2);
  });
});

describe('RecoverySweepService.recoverNeedsHumanReviewTask (production path)', () => {
  it('delegates to the same sequence via the sweep service handle', async () => {
    await seedNeedsHumanReview({
      meta: { runnerDecision: 'needs_revision', completionIntent: intent('pending') },
    });

    const handle = await createRecoverySweepService({ workspaceDir });
    try {
      const outcome = await handle.service.recoverNeedsHumanReviewTask(TASK_ID);
      expect(outcome.status).toBe('requeued');

      const task = await readTask();
      expect(task?.status).toBe('pending');
      const meta = task ? hydratePITaskRecord(task) : null;
      expect(meta?.runnerDecision).toBeUndefined();
      expect(meta?.completionIntent).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('reports not_found through the service for an unknown id', async () => {
    const handle = await createRecoverySweepService({ workspaceDir });
    try {
      const outcome = await handle.service.recoverNeedsHumanReviewTask('nope');
      expect(outcome.status).toBe('not_found');
    } finally {
      await handle.close();
    }
  });
});
