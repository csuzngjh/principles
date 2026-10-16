/**
 * PRI-990 — single-task failed recovery (strict path) against a REAL
 * temp-workspace SQLite store.
 *
 * The batch `recoverFailedTask(taskId, force)` authority has existed in core
 * since PRI-674, but the only CLI that reached it was the batch
 * `failed-tasks` command — there was no safe way to recover ONE exhausted
 * task (the candidate IAER Pilot chain) without the batch `--force`
 * side effect on every other exhausted task.
 *
 * Covered here (core contract):
 *   - inspectFailedTaskRecovery: read-only structured precheck (existence,
 *     kind legality, status, budget, lease conflict, pending completion
 *     intent, eligibility + stable reasonCode).
 *   - recoverSingleFailedTask: exact-taskId strict recovery — budget reset
 *     is opt-in, history preserved, lease/intent guards, CAS conflict
 *     arbitration (two concurrent confirms → exactly one `recovered`),
 *     repeat confirm → `not_failed`.
 *   - legacy recoverFailedTask keeps its batch contract (null on missing /
 *     not-failed / CAS-lost, throw on exhausted-without-force) while gaining
 *     the same CAS precondition.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  inspectFailedTaskRecovery,
  recoverFailedTask,
  recoverSingleFailedTask,
  type TaskRecord,
} from '../index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-single-task-recovery-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

function failedArtificer(overrides: Partial<TaskRecord> = {}): Omit<TaskRecord, 'createdAt' | 'updatedAt'> {
  return {
    taskId: 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook',
    taskKind: 'artificer',
    status: 'failed',
    attemptCount: 3,
    maxAttempts: 3,
    lastError: 'max_attempts_exceeded',
    diagnosticJson: createPITaskDiagnosticJson({
      channel: 'code_tool_hook',
      dependencyTaskIds: [],
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

async function seed(handle: Awaited<ReturnType<typeof createRuntimeStateHandle>>, record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord> {
  return handle.stateManager.createTask(record);
}

describe('inspectFailedTaskRecovery (read-only)', () => {
  it('reports not_found for an unknown exact taskId', async () => {
    const handle = await createRuntimeStateHandle({ workspaceDir: makeWorkspace(), readonly: false });
    try {
      const inspection = await inspectFailedTaskRecovery(handle.stateManager, 'artificer-does-not-exist');
      expect(inspection.found).toBe(false);
      expect(inspection.eligible).toBe(false);
      expect(inspection.reasonCode).toBe('task_not_found');
    } finally {
      await handle.close();
    }
  });

  it('reports the full precheck for an exhausted failed artificer', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer());
      const inspection = await inspectFailedTaskRecovery(handle.stateManager, 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook');
      expect(inspection.found).toBe(true);
      expect(inspection.taskKind).toBe('artificer');
      expect(inspection.status).toBe('failed');
      expect(inspection.attemptCount).toBe(3);
      expect(inspection.maxAttempts).toBe(3);
      expect(inspection.isExhausted).toBe(true);
      expect(inspection.budgetResetRequired).toBe(true);
      expect(inspection.leaseConflict).toBe(false);
      expect(inspection.completionIntentPending).toBe(false);
      expect(inspection.eligible).toBe(true);
      expect(inspection.reasonCode).toBe('eligible_budget_reset_required');
    } finally {
      await handle.close();
    }
  });

  it('flags an active lease as a conflict', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer({
        leaseOwner: 'auto-consumer',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const inspection = await inspectFailedTaskRecovery(handle.stateManager, 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook');
      expect(inspection.leaseConflict).toBe(true);
      expect(inspection.eligible).toBe(false);
      expect(inspection.reasonCode).toBe('lease_conflict');
    } finally {
      await handle.close();
    }
  });

  it('flags a pending completion intent as a conflict', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      const base = failedArtificer();
      const withIntent = createPITaskDiagnosticJson({
        channel: 'code_tool_hook',
        dependencyTaskIds: [],
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        completionIntent: {
          decision: 'approved',
          sourceRunId: 'run_artificer-x_1',
          revisionEpoch: 0,
          status: 'pending',
        },
      });
      await seed(handle, failedArtificer({ diagnosticJson: withIntent }));
      const inspection = await inspectFailedTaskRecovery(handle.stateManager, base.taskId);
      expect(inspection.completionIntentPending).toBe(true);
      expect(inspection.eligible).toBe(false);
      expect(inspection.reasonCode).toBe('completion_intent_pending');
    } finally {
      await handle.close();
    }
  });

  it('rejects a non-recoverable task kind and a non-failed status', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer({ taskId: 'intake-1', taskKind: 'principle_candidate_intake', status: 'pending', attemptCount: 0 }));
      const inspection = await inspectFailedTaskRecovery(handle.stateManager, 'intake-1');
      expect(inspection.kindRecoverable).toBe(false);
      expect(inspection.eligible).toBe(false);
      expect(inspection.reasonCode).toBe('kind_not_recoverable');

      await seed(handle, failedArtificer({ taskId: 'artificer-pending-1', status: 'pending', attemptCount: 0 }));
      const inspection2 = await inspectFailedTaskRecovery(handle.stateManager, 'artificer-pending-1');
      expect(inspection2.status).toBe('pending');
      expect(inspection2.eligible).toBe(false);
      expect(inspection2.reasonCode).toBe('not_failed');
    } finally {
      await handle.close();
    }
  });
});

describe('recoverSingleFailedTask (strict single-task path)', () => {
  it('recovers the exact failed task to pending with budget reset applied (T02/T04)', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer());
      const outcome = await recoverSingleFailedTask(handle.stateManager, 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook', { resetBudget: true });
      expect(outcome.status).toBe('recovered');
      if (outcome.status !== 'recovered') return;
      expect(outcome.previousStatus).toBe('failed');
      expect(outcome.previousAttemptCount).toBe(3);
      expect(outcome.previousMaxAttempts).toBe(3);
      expect(outcome.budgetResetApplied).toBe(true);
      expect(outcome.newMaxAttempts).toBe(6);

      const task = await handle.stateManager.getTask('artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook');
      expect(task?.status).toBe('pending');
      expect(task?.attemptCount).toBe(0);
      expect(task?.maxAttempts).toBe(6);
      expect(task?.leaseOwner ?? null).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('refuses an exhausted task without an explicit budget reset (T03)', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer());
      const outcome = await recoverSingleFailedTask(handle.stateManager, 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook');
      expect(outcome.status).toBe('budget_exhausted');
      if (outcome.status !== 'budget_exhausted') return;
      expect(outcome.nextAction).toContain('--reset-budget');

      const task = await handle.stateManager.getTask('artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook');
      expect(task?.status).toBe('failed');
      expect(task?.attemptCount).toBe(3);
    } finally {
      await handle.close();
    }
  });

  it('recovers a non-exhausted failed task without reset-budget (attempts remain)', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer({ attemptCount: 1, maxAttempts: 3 }));
      const outcome = await recoverSingleFailedTask(handle.stateManager, 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook');
      expect(outcome.status).toBe('recovered');
      if (outcome.status !== 'recovered') return;
      expect(outcome.budgetResetApplied).toBe(false);
      expect(outcome.previousAttemptCount).toBe(1);

      const task = await handle.stateManager.getTask('artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook');
      expect(task?.status).toBe('pending');
      expect(task?.attemptCount).toBe(0);
      expect(task?.maxAttempts).toBe(3);
    } finally {
      await handle.close();
    }
  });

  it('preserves the metadata payload across the recovery (diagnosticJson untouched)', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      const seeded = await seed(handle, failedArtificer());
      await recoverSingleFailedTask(handle.stateManager, seeded.taskId, { resetBudget: true });
      const task = await handle.stateManager.getTask(seeded.taskId);
      expect(task?.diagnosticJson).toBe(seeded.diagnosticJson);
    } finally {
      await handle.close();
    }
  });

  it('two concurrent confirms: exactly one recovered, the other CAS-conflicted (T06)', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer());
      const [a, b] = await Promise.all([
        recoverSingleFailedTask(handle.stateManager, 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook', { resetBudget: true }),
        recoverSingleFailedTask(handle.stateManager, 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook', { resetBudget: true }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual(['conflict', 'recovered']);
      const task = await handle.stateManager.getTask('artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook');
      expect(task?.status).toBe('pending');
      expect(task?.attemptCount).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it('refuses an actively leased task (T07) and a pending completion intent (T08) with zero mutation', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer({
        taskId: 'artificer-leased-1',
        leaseOwner: 'auto-consumer',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const leased = await recoverSingleFailedTask(handle.stateManager, 'artificer-leased-1', { resetBudget: true });
      expect(leased.status).toBe('lease_conflict');
      let task = await handle.stateManager.getTask('artificer-leased-1');
      expect(task?.status).toBe('failed');

      const intent = createPITaskDiagnosticJson({
        channel: 'prompt',
        dependencyTaskIds: [],
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        completionIntent: { decision: 'needs_revision', sourceRunId: 'run_evaluator-x_1', revisionEpoch: 0, status: 'pending' },
      });
      await seed(handle, failedArtificer({ taskId: 'artificer-intent-1', attemptCount: 1, diagnosticJson: intent }));
      const pendingIntent = await recoverSingleFailedTask(handle.stateManager, 'artificer-intent-1', { resetBudget: true });
      expect(pendingIntent.status).toBe('completion_intent_pending');
      task = await handle.stateManager.getTask('artificer-intent-1');
      expect(task?.status).toBe('failed');
    } finally {
      await handle.close();
    }
  });

  it('a repeat confirm after success is refused as not_failed (T09)', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer());
      const first = await recoverSingleFailedTask(handle.stateManager, 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook', { resetBudget: true });
      expect(first.status).toBe('recovered');
      const second = await recoverSingleFailedTask(handle.stateManager, 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook', { resetBudget: true });
      expect(second.status).toBe('not_failed');
      if (second.status !== 'not_failed') return;
      expect(second.previousStatus).toBe('pending');
    } finally {
      await handle.close();
    }
  });

  it('refuses an unknown exact taskId and never treats a prefix as a match (T10)', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer());
      const prefix = await recoverSingleFailedTask(handle.stateManager, 'artificer-605ba208');
      expect(prefix.status).toBe('not_found');
      const exact = await recoverSingleFailedTask(handle.stateManager, 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook', { resetBudget: true });
      expect(exact.status).toBe('recovered');
    } finally {
      await handle.close();
    }
  });

  it('refuses a kind outside the recoverable set', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer({ taskId: 'intake-2', taskKind: 'principle_candidate_intake', status: 'failed', attemptCount: 1 }));
      const outcome = await recoverSingleFailedTask(handle.stateManager, 'intake-2');
      expect(outcome.status).toBe('kind_not_recoverable');
    } finally {
      await handle.close();
    }
  });
});

describe('legacy recoverFailedTask keeps its batch contract under the CAS upgrade', () => {
  it('recovers, throws on exhausted without force, returns null on missing/not-failed (T16)', async () => {
    const ws = makeWorkspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
    try {
      await seed(handle, failedArtificer({ taskId: 'artificer-batch-1', attemptCount: 1, maxAttempts: 3 }));
      const result = await recoverFailedTask(handle.stateManager, 'artificer-batch-1', false);
      expect(result).not.toBeNull();
      expect(result?.newStatus).toBe('pending');
      expect(result?.forceApplied).toBe(false);

      const missing = await recoverFailedTask(handle.stateManager, 'artificer-missing', false);
      expect(missing).toBeNull();

      await seed(handle, failedArtificer({ taskId: 'artificer-batch-2' }));
      await expect(recoverFailedTask(handle.stateManager, 'artificer-batch-2', false)).rejects.toThrow(/exhausted max attempts/);
      const forced = await recoverFailedTask(handle.stateManager, 'artificer-batch-2', true);
      expect(forced?.forceApplied).toBe(true);
      expect(forced?.maxAttempts).toBe(6);

      const repeat = await recoverFailedTask(handle.stateManager, 'artificer-batch-2', true);
      expect(repeat).toBeNull();
    } finally {
      await handle.close();
    }
  });
});
