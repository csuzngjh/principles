import type { TaskRecord } from '../task-status.js';
import type { TaskStore } from './task-store.js';
import type { RunStore } from './run-store.js';
import type { SqliteConnection } from './sqlite-connection.js';
import { type StoreEventEmitter } from './event-emitter.js';
export interface AcquireLeaseOptions {
    taskId: string;
    owner: string;
    durationMs?: number;
    runtimeKind: string;
}
export interface LeaseManager {
    /**
     * Atomically acquire a lease on a task.
     *
     * Preconditions:
     *   - Task must exist
     *   - Task status must be 'pending' or 'retry_wait'
     *
     * Side effects (same transaction):
     *   - Task status → 'leased'
     *   - lease_owner, lease_expires_at set
     *   - A new Run record is created with execution_status = 'running'
     *
     * @returns The updated TaskRecord
     * @throws PDRuntimeError with category 'storage_unavailable' if task not found
     * @throws PDRuntimeError with category 'lease_conflict' if task not in acquireable state
     */
    acquireLease(options: AcquireLeaseOptions): Promise<TaskRecord>;
    /**
     * Release a lease, returning the task to pending state.
     *
     * Preconditions:
     *   - Task must exist
     *   - The calling owner must match the current lease_owner
     *
     * @returns The updated TaskRecord (status = 'pending')
     * @throws PDRuntimeError with category 'storage_unavailable' if task not found
     * @throws PDRuntimeError with category 'lease_conflict' if owner does not match
     */
    releaseLease(taskId: string, owner: string): Promise<TaskRecord>;
    /**
     * Renew (extend) the lease duration for a currently leased task.
     *
     * Preconditions:
     *   - Task must exist
     *   - Task must be in 'leased' state
     *   - The calling owner must match the current lease_owner
     *
     * @param durationMs - New lease duration from now (default: 300_000 ms / 5 minutes)
     * @returns The updated TaskRecord with new lease_expires_at
     * @throws PDRuntimeError with category 'storage_unavailable' if task not found
     * @throws PDRuntimeError with category 'lease_conflict' if owner/state check fails
     */
    renewLease(taskId: string, owner: string, durationMs?: number): Promise<TaskRecord>;
    /**
     * Check whether a task's lease has expired.
     *
     * Returns false if the task is not in 'leased' state or has no lease_expires_at.
     *
     * @returns true if the lease has expired, false otherwise
     */
    isLeaseExpired(task: TaskRecord): boolean;
    /**
     * Force-expire a lease without owner check (recovery use only).
     *
     * Used by the recovery sweep to reclaim tasks whose lease owner died.
     *
     * @returns The updated TaskRecord (status = 'pending')
     */
    forceExpire(taskId: string): Promise<TaskRecord>;
}
export interface LeaseManagerOptions {
    taskStore: TaskStore;
    runStore: RunStore;
    connection: SqliteConnection;
    emitter?: StoreEventEmitter;
}
export declare class DefaultLeaseManager implements LeaseManager {
    private readonly taskStore;
    private readonly runStore;
    private readonly connection;
    private readonly emitter;
    constructor(taskStore: TaskStore, runStore: RunStore, connection: SqliteConnection, options?: LeaseManagerOptions);
    acquireLease(options: AcquireLeaseOptions): Promise<TaskRecord>;
    releaseLease(taskId: string, owner: string): Promise<TaskRecord>;
    renewLease(taskId: string, owner: string, durationMs?: number): Promise<TaskRecord>;
    isLeaseExpired(task: TaskRecord): boolean;
    forceExpire(taskId: string): Promise<TaskRecord>;
}
//# sourceMappingURL=lease-manager.d.ts.map