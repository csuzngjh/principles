/**
 * RuntimeStateManager — integration layer wiring all M2 store components.
 *
 * Single entry point for CLI and diagnostician runner to interact with
 * task/run state. Owns the lifecycle of:
 *   - SqliteConnection (shared by TaskStore + RunStore)
 *   - SqliteTaskStore + SqliteRunStore
 *   - DefaultLeaseManager (with event emission)
 *   - DefaultRetryPolicy
 *   - DefaultRecoverySweep
 *
 * Usage:
 * ```typescript
 * const mgr = new RuntimeStateManager({ workspaceDir: process.cwd() });
 * await mgr.initialize();
 * const task = await mgr.acquireLease({ ... });
 * await mgr.close();
 * ```
 */
import type { SqliteConnection } from './sqlite-connection.js';
import type { TaskStore, TaskStoreFilter, TaskStoreUpdatePatch } from './task-store.js';
import type { RunStore, RunRecord } from './run-store.js';
import type { LeaseManager, AcquireLeaseOptions } from './lease-manager.js';
import type { RetryPolicy, RetryPolicyConfig } from './retry-policy.js';
import type { RecoverySweep } from './recovery-sweep.js';
import type { PDErrorCategory } from '../error-categories.js';
import type { TaskRecord } from '../task-status.js';
import { storeEmitter, type StoreEventEmitter } from './event-emitter.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { SqliteConnection as SqliteConnectionClass } from './sqlite-connection.js';
import { DefaultLeaseManager } from './lease-manager.js';
import { DefaultRetryPolicy } from './retry-policy.js';
import { DefaultRecoverySweep } from './recovery-sweep.js';

// ── Options ──────────────────────────────────────────────────────────────────

export interface RuntimeStateManagerOptions {
  /** Workspace directory — DB created at <workspaceDir>/.pd/state.db */
  workspaceDir: string;
  /** Optional custom emitter (defaults to storeEmitter singleton) */
  emitter?: StoreEventEmitter;
  /** Optional retry policy config */
  retryPolicyConfig?: RetryPolicyConfig;
}

// ── RuntimeStateManager ──────────────────────────────────────────────────────

export class RuntimeStateManager {
  private connection!: SqliteConnection;
  private taskStore!: TaskStore;
  private runStore!: RunStore;
  private leaseManager!: LeaseManager;
  private retryPolicy!: RetryPolicy;
  private recoverySweep!: RecoverySweep;
  private readonly emitter: StoreEventEmitter;
  private _initialized = false;

  constructor(private readonly options: RuntimeStateManagerOptions) {
    this.emitter = options.emitter ?? storeEmitter;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Initialize all store components. Must be called before any other method. */
  async initialize(): Promise<void> {
    if (this._initialized) return;

    this.connection = new SqliteConnectionClass(this.options.workspaceDir);
    this.taskStore = new SqliteTaskStore(this.connection);
    this.runStore = new SqliteRunStore(this.connection);

    this.retryPolicy = new DefaultRetryPolicy(this.options.retryPolicyConfig);

    this.leaseManager = new DefaultLeaseManager(
      this.taskStore,
      this.runStore,
      this.connection,
      { taskStore: this.taskStore, runStore: this.runStore, connection: this.connection, emitter: this.emitter },
    );

    this.recoverySweep = new DefaultRecoverySweep(
      this.taskStore,
      this.leaseManager,
      this.retryPolicy,
      this.connection,
      this.emitter,
    );

    this._initialized = true;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  /** Close the state manager and release resources. */
  async close(): Promise<void> {
    if (this.connection) {
      this.connection.close();
    }
    this._initialized = false;
  }

  // ── Task operations ───────────────────────────────────────────────────────

  async createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord> {
    this.assertInitialized();
    return this.taskStore.createTask(record);
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    this.assertInitialized();
    return this.taskStore.getTask(taskId);
  }

  async listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]> {
    this.assertInitialized();
    return this.taskStore.listTasks(filter);
  }

  async updateTask(taskId: string, patch: TaskStoreUpdatePatch): Promise<TaskRecord> {
    this.assertInitialized();
    return this.taskStore.updateTask(taskId, patch);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    this.assertInitialized();
    return this.taskStore.deleteTask(taskId);
  }

  // ── Run operations ────────────────────────────────────────────────────────

  async getRunsByTask(taskId: string): Promise<RunRecord[]> {
    this.assertInitialized();
    return this.runStore.listRunsByTask(taskId);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    this.assertInitialized();
    return this.runStore.getRun(runId);
  }

  // ── Lease operations ──────────────────────────────────────────────────────

  async acquireLease(options: AcquireLeaseOptions): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.acquireLease(options);
  }

  async releaseLease(taskId: string, owner: string): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.releaseLease(taskId, owner);
  }

  async renewLease(taskId: string, owner: string, durationMs?: number): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.renewLease(taskId, owner, durationMs);
  }

  async forceExpireLease(taskId: string): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.forceExpire(taskId);
  }

  isLeaseExpired(task: TaskRecord): boolean {
    return this.leaseManager.isLeaseExpired(task);
  }

  // ── Task completion events ────────────────────────────────────────────────

  /** Mark a task as succeeded and emit task_succeeded event. */
  async markTaskSucceeded(taskId: string, resultRef?: string): Promise<TaskRecord> {
    this.assertInitialized();
    const now = new Date().toISOString();

    const updated = await this.taskStore.updateTask(taskId, {
      status: 'succeeded',
      leaseOwner: null,
      leaseExpiresAt: null,
      resultRef: resultRef ?? null,
    });

    // Update the latest run to terminal 'succeeded' state
    const runs = await this.runStore.listRunsByTask(taskId);
    const latestRun = runs[runs.length - 1];
    if (latestRun) {
      await this.runStore.updateRun(latestRun.runId, {
        executionStatus: 'succeeded',
        endedAt: now,
        reason: 'task_completed',
        outputRef: resultRef ?? undefined,
      });
    }

    this.emitter.emitTelemetry({
      eventType: 'task_succeeded',
      traceId: taskId,
      timestamp: now,
      sessionId: updated.leaseOwner ?? 'system',
      payload: { taskId, resultRef: updated.resultRef },
    });

    return updated;
  }

  /** Mark a task as failed and emit task_failed event. */
  async markTaskFailed(taskId: string, lastError: PDErrorCategory): Promise<TaskRecord> {
    this.assertInitialized();
    const now = new Date().toISOString();

    const updated = await this.taskStore.updateTask(taskId, {
      status: 'failed',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError,
    });

    // Update the latest run to terminal 'failed' state
    const runs = await this.runStore.listRunsByTask(taskId);
    const latestRun = runs[runs.length - 1];
    if (latestRun) {
      await this.runStore.updateRun(latestRun.runId, {
        executionStatus: 'failed',
        endedAt: now,
        reason: 'task_failed',
        errorCategory: lastError,
      });
    }

    this.emitter.emitTelemetry({
      eventType: 'task_failed',
      traceId: taskId,
      timestamp: now,
      sessionId: updated.leaseOwner ?? 'system',
      payload: { taskId, lastError, attemptCount: updated.attemptCount },
    });

    return updated;
  }

  /** Mark a task as retry_wait and emit task_retried event. Per D-03: retry with backoff. */
  async markTaskRetryWait(taskId: string, errorCategory: PDErrorCategory): Promise<TaskRecord> {
    this.assertInitialized();
    const now = new Date().toISOString();

    const updated = await this.taskStore.updateTask(taskId, {
      status: 'retry_wait',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: errorCategory,
    });

    // Update the latest run to 'failed' state with error category
    const runs = await this.runStore.listRunsByTask(taskId);
    const latestRun = runs[runs.length - 1];
    if (latestRun) {
      await this.runStore.updateRun(latestRun.runId, {
        executionStatus: 'failed',
        endedAt: now,
        reason: 'task_retry',
        errorCategory,
      });
    }

    this.emitter.emitTelemetry({
      eventType: 'task_retried',
      traceId: taskId,
      timestamp: now,
      sessionId: updated.leaseOwner ?? 'system',
      payload: { taskId, errorCategory, attemptCount: updated.attemptCount },
    });

    return updated;
  }

  /**
   * Write output payload to a run record.
   * Per D-04: DiagnosticianOutputV1 JSON serialized into RunRecord.outputPayload.
   */
  async updateRunOutput(runId: string, outputPayload: string): Promise<RunRecord> {
    this.assertInitialized();
    const now = new Date().toISOString();

    const updated = await this.runStore.updateRun(runId, {
      outputPayload,
      executionStatus: 'succeeded',
      endedAt: now,
      reason: 'output_captured',
    });

    this.emitter.emitTelemetry({
      eventType: 'run_completed',
      traceId: updated.taskId,
      timestamp: now,
      sessionId: 'runner',
      payload: { runId, taskId: updated.taskId, outputPayloadSize: outputPayload.length },
    });

    return updated;
  }

  // ── Retry/Recovery operations ─────────────────────────────────────────────

  async runRecoverySweep(): Promise<{ recovered: number; errors: string[] }> {
    this.assertInitialized();
    return this.recoverySweep.recoverAll();
  }

  getRetryPolicy(): RetryPolicy {
    return this.retryPolicy;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private assertInitialized(): void {
    if (!this._initialized) {
      throw new Error('RuntimeStateManager not initialized — call initialize() first');
    }
  }
}
