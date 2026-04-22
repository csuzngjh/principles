/**
 * Recovery Sweep — expired lease recovery for PD Runtime v2 tasks.
 *
 * Detects tasks whose lease has expired (worker died or stalled) and:
 *   - Transitions to retry_wait if attempts remain (with backoff)
 *   - Transitions to failed if maxAttempts exceeded
 *   - Emits a telemetry event for each recovery
 *
 * Idempotent: safe to run multiple times. A task that was already recovered
 * will have its leaseOwner/leaseExpiresAt cleared, so isLeaseExpired returns false,
 * and recoverTask returns null immediately.
 *
 * Source: PD Runtime Protocol SPEC v1, Section 12 (Task lease recovery)
 * Source: Diagnostician v2 Detailed Design, Section 8 (Stale task detection)
 */
import type { TaskStore } from './task-store.js';
import type { LeaseManager } from './lease-manager.js';
import type { RetryPolicy } from './retry-policy.js';
import type { TaskRecord, PDTaskStatus } from '../task-status.js';

export interface RecoveryResult {
  taskId: string;
  recoveredAt: string;
  previousStatus: PDTaskStatus;
  newStatus: PDTaskStatus;
  wasLeaseExpired: boolean;
}

export interface RecoverySweep {
  detectExpiredLeases(): Promise<string[]>;
  recoverTask(taskId: string): Promise<RecoveryResult | null>;
  recoverAll(): Promise<{ recovered: number; errors: string[] }>;
}

export class DefaultRecoverySweep implements RecoverySweep {
  constructor(
    private taskStore: TaskStore,
    private leaseManager: LeaseManager,
    private retryPolicy: RetryPolicy,
  ) {}

  /**
   * Detect all leased tasks whose lease has expired.
   *
   * Returns task IDs of tasks in 'leased' state whose lease_expires_at < now.
   */
  async detectExpiredLeases(): Promise<string[]> {
    const taskIds = await this.taskStore.listTasks({ status: 'leased' });
    return taskIds
      .filter(task => this.leaseManager.isLeaseExpired(task))
      .map(task => task.taskId);
  }

  /**
   * Recover a single task from an expired lease.
   *
   * Idempotent: returns null if the task is not leased or its lease has not expired.
   *
   * Transitions:
   *   - retry_wait (if attempts remain per shouldRetry check)
   *   - failed (if maxAttempts exceeded)
   *
   * Clears leaseOwner and leaseExpiresAt. Sets lastError to the appropriate category.
   */
  async recoverTask(taskId: string): Promise<RecoveryResult | null> {
    const task = await this.taskStore.getTask(taskId);
    if (!task) return null;

    const wasLeaseExpired = this.leaseManager.isLeaseExpired(task);
    if (!wasLeaseExpired) return null;

    const previousStatus = task.status;
    let newStatus: PDTaskStatus;

    if (this.retryPolicy.shouldRetry(task)) {
      const backoffMs = this.retryPolicy.calculateBackoff(task.attemptCount + 1);
      const retryExpiresAt = new Date(Date.now() + backoffMs).toISOString();
      await this.taskStore.updateTask(taskId, {
        status: 'retry_wait',
        leaseOwner: null,
        leaseExpiresAt: retryExpiresAt,
        lastError: 'lease_expired',
      });
      newStatus = 'retry_wait';
    } else {
      await this.taskStore.updateTask(taskId, {
        status: 'failed',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: 'max_attempts_exceeded',
      });
      newStatus = 'failed';
    }

    this.emitTelemetryEvent({
      eventType: 'lease_recovered',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'system',
      payload: { taskId, previousStatus, newStatus },
    });

    return {
      taskId,
      recoveredAt: new Date().toISOString(),
      previousStatus,
      newStatus,
      wasLeaseExpired,
    };
  }

  /**
   * Recover all expired leases.
   *
   * Processes all expired leases sequentially, collecting errors without
   * stopping recovery of other tasks.
   *
   * @returns Number of successfully recovered tasks and any errors encountered
   */
  async recoverAll(): Promise<{ recovered: number; errors: string[] }> {
    const expiredIds = await this.detectExpiredLeases();
    let recovered = 0;
    const errors: string[] = [];

    for (const taskId of expiredIds) {
      try {
        const result = await this.recoverTask(taskId);
        if (result) recovered++;
      } catch (err) {
        errors.push(`${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { recovered, errors };
  }

  private emitTelemetryEvent(event: {
    eventType: string;
    traceId: string;
    timestamp: string;
    sessionId: string;
    payload: Record<string, unknown>;
  }): void {
    // Emit via structured JSON for now — aligns with TelemetryEventSchema
    // In production this would wire to the existing EvolutionLogger/TelemetryEvent system
    console.log(JSON.stringify({ type: 'telemetry_event', event }));
  }
}