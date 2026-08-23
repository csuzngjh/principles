import { createRuntimeStateHandle } from './runtime-state-handle.js';
import type { RuntimeStateHandle } from './runtime-state-handle.js';
import type { RecoveryResult } from './store/lifecycle/recovery-sweep.js';
import { PDRuntimeError } from './error-categories.js';
import { isPeerRunnerKind } from './internalization/peer-runner-contracts.js';
import { ownerRetryNeedsHumanReviewTask } from './internalization/owner-retry.js';
import type { OwnerRetryOutcome } from './internalization/owner-retry.js';

export interface FailedTaskRecoveryInfo {
  taskId: string;
  taskKind: string;
  attemptCount: number;
  maxAttempts: number;
  isExhausted: boolean;
  status: string;
}

export interface FailedTaskRecoveryResult {
  taskId: string;
  previousStatus: string;
  newStatus: string;
  attemptCount: number;
  maxAttempts: number;
  forceApplied: boolean;
}

export interface RecoverySweepService {
  detectExpiredLeases(): Promise<string[]>;
  recoverTask(taskId: string): Promise<RecoveryResult | null>;
  detectFailedTasks(): Promise<FailedTaskRecoveryInfo[]>;
  recoverFailedTask(taskId: string, force?: boolean): Promise<FailedTaskRecoveryResult | null>;
  /**
   * Governance Recovery Actions v1: Owner authority reset for a
   * needs_human_review task (→ pending, clears runnerDecision +
   * completionIntent atomically). Same sequence as
   * `pd runtime internalization retry --confirm` (shared implementation).
   */
  recoverNeedsHumanReviewTask(taskId: string): Promise<OwnerRetryOutcome>;
  close(): Promise<void>;
}

export interface RecoverySweepServiceHandle {
  service: RecoverySweepService;
  close: () => Promise<void>;
}

class RecoverySweepServiceImpl implements RecoverySweepService {
  constructor(private readonly stateManager: RuntimeStateHandle['stateManager']) {}

  async detectExpiredLeases(): Promise<string[]> {
    return this.stateManager.detectExpiredLeases();
  }

  async recoverTask(taskId: string): Promise<RecoveryResult | null> {
    return this.stateManager.recoverTask(taskId);
  }

  async detectFailedTasks(): Promise<FailedTaskRecoveryInfo[]> {
    const failedTasks = await this.stateManager.listTasks({ status: 'failed' });
    return failedTasks
      .filter(t => isPeerRunnerKind(t.taskKind))
      .map(t => ({
        taskId: t.taskId,
        taskKind: t.taskKind,
        attemptCount: t.attemptCount,
        maxAttempts: t.maxAttempts,
        isExhausted: t.attemptCount >= t.maxAttempts,
        status: t.status,
      }));
  }

  async recoverFailedTask(taskId: string, force = false): Promise<FailedTaskRecoveryResult | null> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'failed') return null;

    const isExhausted = task.attemptCount >= task.maxAttempts;
    if (isExhausted && !force) {
      throw new PDRuntimeError(
        'input_invalid',
        `Task ${taskId} has exhausted max attempts (${task.attemptCount}/${task.maxAttempts}). Use force to recover.`,
      );
    }

    const newMaxAttempts = isExhausted && force
      ? Math.max(task.maxAttempts, task.attemptCount) + 3
      : task.maxAttempts;

    const updated = await this.stateManager.updateTask(taskId, {
      status: 'pending',
      attemptCount: 0,
      maxAttempts: newMaxAttempts,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      resultRef: null,
    });

    return {
      taskId: updated.taskId,
      previousStatus: 'failed',
      newStatus: updated.status,
      attemptCount: updated.attemptCount,
      maxAttempts: updated.maxAttempts,
      forceApplied: isExhausted && force,
    };
  }

  async recoverNeedsHumanReviewTask(taskId: string): Promise<OwnerRetryOutcome> {
    return ownerRetryNeedsHumanReviewTask(this.stateManager, taskId);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async close(): Promise<void> {
    // No-op: RuntimeStateManager lifecycle managed by handle
  }
}

export async function createRecoverySweepService(
  opts: { workspaceDir: string },
): Promise<RecoverySweepServiceHandle> {
  const handle = await createRuntimeStateHandle({ workspaceDir: opts.workspaceDir });
  const service = new RecoverySweepServiceImpl(handle.stateManager);
  return {
    service,
    close: handle.close,
  };
}
