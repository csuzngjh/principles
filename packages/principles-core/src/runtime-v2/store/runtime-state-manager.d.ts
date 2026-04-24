import type { TaskStoreFilter, TaskStoreUpdatePatch } from './task-store.js';
import type { RunRecord } from './run-store.js';
import type { AcquireLeaseOptions } from './lease-manager.js';
import type { RetryPolicy, RetryPolicyConfig } from './retry-policy.js';
import type { PDErrorCategory } from '../error-categories.js';
import type { TaskRecord } from '../task-status.js';
import { type StoreEventEmitter } from './event-emitter.js';
export interface RuntimeStateManagerOptions {
    /** Workspace directory — DB created at <workspaceDir>/.pd/state.db */
    workspaceDir: string;
    /** Optional custom emitter (defaults to storeEmitter singleton) */
    emitter?: StoreEventEmitter;
    /** Optional retry policy config */
    retryPolicyConfig?: RetryPolicyConfig;
}
export declare class RuntimeStateManager {
    private readonly options;
    private connection;
    private taskStore;
    private runStore;
    private leaseManager;
    private retryPolicy;
    private recoverySweep;
    private readonly emitter;
    private _initialized;
    constructor(options: RuntimeStateManagerOptions);
    /** Initialize all store components. Must be called before any other method. */
    initialize(): Promise<void>;
    get isInitialized(): boolean;
    /** Close the state manager and release resources. */
    close(): Promise<void>;
    createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord>;
    getTask(taskId: string): Promise<TaskRecord | null>;
    listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]>;
    updateTask(taskId: string, patch: TaskStoreUpdatePatch): Promise<TaskRecord>;
    deleteTask(taskId: string): Promise<boolean>;
    getRunsByTask(taskId: string): Promise<RunRecord[]>;
    getRun(runId: string): Promise<RunRecord | null>;
    acquireLease(options: AcquireLeaseOptions): Promise<TaskRecord>;
    releaseLease(taskId: string, owner: string): Promise<TaskRecord>;
    renewLease(taskId: string, owner: string, durationMs?: number): Promise<TaskRecord>;
    forceExpireLease(taskId: string): Promise<TaskRecord>;
    isLeaseExpired(task: TaskRecord): boolean;
    /** Mark a task as succeeded and emit task_succeeded event. */
    markTaskSucceeded(taskId: string, resultRef?: string): Promise<TaskRecord>;
    /** Mark a task as failed and emit task_failed event. */
    markTaskFailed(taskId: string, lastError: PDErrorCategory): Promise<TaskRecord>;
    /** Mark a task as retry_wait and emit task_retried event. Per D-03: retry with backoff. */
    markTaskRetryWait(taskId: string, errorCategory: PDErrorCategory): Promise<TaskRecord>;
    /**
     * Write output payload to a run record.
     * Per D-04: DiagnosticianOutputV1 JSON serialized into RunRecord.outputPayload.
     */
    updateRunOutput(runId: string, outputPayload: string): Promise<RunRecord>;
    runRecoverySweep(): Promise<{
        recovered: number;
        errors: string[];
    }>;
    getRetryPolicy(): RetryPolicy;
    private assertInitialized;
}
//# sourceMappingURL=runtime-state-manager.d.ts.map