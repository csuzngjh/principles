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
import type { PDTaskStatus } from '../task-status.js';
import type { SqliteConnection } from './sqlite-connection.js';
import { type StoreEventEmitter } from './event-emitter.js';
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
    recoverAll(): Promise<{
        recovered: number;
        errors: string[];
    }>;
}
export declare class DefaultRecoverySweep implements RecoverySweep {
    private readonly taskStore;
    private readonly leaseManager;
    private readonly retryPolicy;
    private readonly connection;
    private readonly emitter;
    constructor(taskStore: TaskStore, leaseManager: LeaseManager, retryPolicy: RetryPolicy, connection: SqliteConnection, emitter?: StoreEventEmitter);
    /**
     * Detect all leased tasks whose lease has expired.
     *
     * Uses the leaseExpiresAtBefore filter to push predicate to SQL
     * (leverages idx_tasks_lease_expires_at index), avoiding an in-memory filter.
     */
    detectExpiredLeases(): Promise<string[]>;
    /**
     * Atomic read-check-write inside a db transaction.
     * Returns null if nothing to recover; otherwise returns RecoveryResult plus
     * internal telemetry fields.
     */
    private atomicRecover;
    /**
     * Recover a single task from an expired lease.
     *
     * Idempotent: returns null if the task is not leased or its lease has not expired.
     *
     * Transitions:
     *   - retry_wait (if attempts remain per shouldRetry check)
     *   - failed (if maxAttempts exceeded)
     *
     * Uses a db.transaction() to atomically read the task, verify lease expiry,
     * and apply the status update — avoiding TOCTOU race conditions when multiple
     * recovery scans run concurrently.
     */
    recoverTask(taskId: string): Promise<RecoveryResult | null>;
    /**
     * Recover all expired leases.
     *
     * Processes all expired leases sequentially, collecting errors without
     * stopping recovery of other tasks.
     */
    recoverAll(): Promise<{
        recovered: number;
        errors: string[];
    }>;
}
//# sourceMappingURL=recovery-sweep.d.ts.map