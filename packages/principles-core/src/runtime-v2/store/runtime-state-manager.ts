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
import type { TaskStore, TaskStoreFilter, TaskStoreUpdatePatch } from './task/task-store.js';
import type { RunStore, RunRecord, TolerantRunListResult } from './run/run-store.js';
import type { LeaseManager, AcquireLeaseOptions } from './lifecycle/lease-manager.js';
import type { RetryPolicy, RetryPolicyConfig } from './lifecycle/retry-policy.js';
import type { RecoverySweep, RecoveryResult } from './lifecycle/recovery-sweep.js';
import type { PDErrorCategory } from '../error-categories.js';
import type { TaskRecord } from '../task-status.js';
import { storeEmitter, type StoreEventEmitter } from './event-emitter.js';
import { SqliteTaskStore, type TaskArtifactCasInput } from './task/sqlite-task-store.js';
import { SqliteRunStore } from './run/sqlite-run-store.js';
import { SqliteConnection as SqliteConnectionClass } from './sqlite-connection.js';
import { DefaultLeaseManager } from './lifecycle/lease-manager.js';
import { DefaultRetryPolicy } from './lifecycle/retry-policy.js';
import { DefaultRecoverySweep } from './lifecycle/recovery-sweep.js';
import { SqliteCommitStore } from './commit/sqlite-commit-store.js';
import { SqliteCandidateStore } from './candidate/sqlite-candidate-store.js';
import { SqliteArtifactStore } from './artifact/sqlite-artifact-store.js';
import { SqlitePIArtifactStore } from './artifact/sqlite-pi-artifact-store.js';
import { SqlitePainDiagnosisStore } from './pain-diagnosis/sqlite-pain-diagnosis-store.js';
import type { CommitStore } from './commit/commit-store.js';
import type { CandidateStore } from './candidate/candidate-store.js';
import type { ArtifactStore } from './artifact/artifact-store.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import type { PainDiagnosisRecord, PainDiagnosisStore, PainDiagnosisWriteInput } from './pain-diagnosis/pain-diagnosis-store.js';
import type { CommitRecord } from './commit/commit-store.js';
import type { CandidateRecord } from './candidate/candidate-store.js';
import type { ArtifactRecord, ArtifactWithCandidates } from './artifact/artifact-store.js';
import * as path from 'path';
import { updatePrinciple } from '../../principle-tree-ledger.js';

// Re-export M5 types for backward compatibility
export type { CommitRecord } from './commit/commit-store.js';
export type { CandidateRecord } from './candidate/candidate-store.js';
export type { ArtifactRecord, ArtifactWithCandidates } from './artifact/artifact-store.js';
export type { PainDiagnosisRecord, PainDiagnosisWriteInput } from './pain-diagnosis/pain-diagnosis-store.js';

// ── Options ──────────────────────────────────────────────────────────────────

export interface RuntimeStateManagerOptions {
  /** Workspace directory — DB created at <workspaceDir>/.pd/state.db */
  workspaceDir: string;
  /** Optional custom emitter (defaults to storeEmitter singleton) */
  emitter?: StoreEventEmitter;
  /** Optional retry policy config */
  retryPolicyConfig?: RetryPolicyConfig;
  /** Open DB in readonly mode — skips schema init/migration, no writes allowed */
  readonly?: boolean;
}

// ── RuntimeStateManager ──────────────────────────────────────────────────────

export class RuntimeStateManager {
  private _connection!: SqliteConnection;
  private _taskStore!: SqliteTaskStore;
  private _runStore!: RunStore;
  private _commitStore!: CommitStore;
  private _candidateStore!: CandidateStore;
  private _artifactStore!: ArtifactStore;
  private _piArtifactStore!: PIArtifactStore;
  private _painDiagnosisStore!: PainDiagnosisStore;
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

    this._connection = new SqliteConnectionClass({
      workspaceDir: this.options.workspaceDir,
      readonly: this.options.readonly,
    });
    this._taskStore = new SqliteTaskStore(this._connection);
    this._runStore = new SqliteRunStore(this._connection);
    this._commitStore = new SqliteCommitStore(this._connection);
    this._candidateStore = new SqliteCandidateStore(this._connection);
    this._artifactStore = new SqliteArtifactStore(this._connection);
    this._piArtifactStore = new SqlitePIArtifactStore(this._connection);
    this._painDiagnosisStore = new SqlitePainDiagnosisStore(this._connection);

    if (!this.options.readonly) {
      this.retryPolicy = new DefaultRetryPolicy(this.options.retryPolicyConfig);

      this.leaseManager = new DefaultLeaseManager(
        this._taskStore,
        this._runStore,
        this._connection,
        { taskStore: this._taskStore, runStore: this._runStore, connection: this._connection, emitter: this.emitter },
      );

      this.recoverySweep = new DefaultRecoverySweep(
        this._taskStore,
        this.leaseManager,
        this.retryPolicy,
        this._connection,
        this.emitter,
      );
    }

    this._initialized = true;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get workspaceDir(): string {
    return this.options.workspaceDir;
  }

  /** Readonly accessors for internal stores — used by CLI DiagnosticianRunner setup. */
  get connection(): SqliteConnection {
    this.assertInitialized();
    return this._connection;
  }

  get taskStore(): TaskStore {
    this.assertInitialized();
    return this._taskStore;
  }

  get runStore(): RunStore {
    this.assertInitialized();
    return this._runStore;
  }

  get piArtifactStore(): PIArtifactStore {
    this.assertInitialized();
    return this._piArtifactStore;
  }

  private assertInitialized(): void {
    if (!this._initialized) {
      throw new Error('RuntimeStateManager has not been initialized — call initialize() first');
    }
  }

  /** Close the state manager and release resources. */
  async close(): Promise<void> {
    if (this._connection) {
      this._connection.close();
    }
    this._initialized = false;
  }

  // ── Task operations ───────────────────────────────────────────────────────

  async createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord> {
    this.assertInitialized();
    return this._taskStore.createTask(record);
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    this.assertInitialized();
    return this._taskStore.getTask(taskId);
  }

  async listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]> {
    this.assertInitialized();
    return this._taskStore.listTasks(filter);
  }

  async updateTask(taskId: string, patch: TaskStoreUpdatePatch): Promise<TaskRecord> {
    this.assertInitialized();
    return this._taskStore.updateTask(taskId, patch);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    this.assertInitialized();
    return this._taskStore.deleteTask(taskId);
  }

  // ── Run operations ────────────────────────────────────────────────────────

  async getRunsByTask(taskId: string): Promise<RunRecord[]> {
    this.assertInitialized();
    return this._runStore.listRunsByTask(taskId);
  }

  /**
   * Tolerant variant of getRunsByTask: returns valid runs AND any
   * schema-degraded historical rows instead of throwing MalformedRunError.
   *
   * Used by the runner execution/completion path so a malformed historical
   * run row does not block recovery of a task that still has a valid run
   * (the one created by acquireLease). Callers MUST surface a non-empty
   * degradedRuns list via telemetry/notes — silent swallowing is a bug (ERR-002).
   */
  async getValidRunsByTaskTolerant(taskId: string): Promise<TolerantRunListResult> {
    this.assertInitialized();
    return this._runStore.listValidRunsByTaskTolerant(taskId);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    this.assertInitialized();
    return this._runStore.getRun(runId);
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

  // ── Task completion events ───────────────────────────────────────────────

  /** Mark a task as succeeded and emit task_succeeded event. */
  async markTaskSucceeded(taskId: string, resultRef?: string): Promise<TaskRecord> {
    this.assertInitialized();
    const now = new Date().toISOString();

    const updated = await this._taskStore.updateTask(taskId, {
      status: 'succeeded',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      resultRef: resultRef ?? null,
    });

    // Update the latest run to terminal 'succeeded' state
    const { runs, degradedRuns } = await this._runStore.listValidRunsByTaskTolerant(taskId);
    this.observeMalformedRuns(taskId, degradedRuns, 'markTaskSucceeded');
    const latestRun = runs[runs.length - 1];
    if (latestRun) {
      await this._runStore.updateRun(latestRun.runId, {
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
  async markTaskFailed(
    taskId: string,
    lastError: PDErrorCategory,
    failureReason?: string,
  ): Promise<TaskRecord> {
    this.assertInitialized();
    const now = new Date().toISOString();

    const updated = await this._taskStore.updateTask(taskId, {
      status: 'failed',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError,
    });

    // Update the latest run to terminal 'failed' state
    const { runs, degradedRuns } = await this._runStore.listValidRunsByTaskTolerant(taskId);
    this.observeMalformedRuns(taskId, degradedRuns, 'markTaskFailed');
    const latestRun = runs[runs.length - 1];
    if (latestRun) {
      await this._runStore.updateRun(latestRun.runId, {
        executionStatus: 'failed',
        endedAt: now,
        reason: failureReason ?? 'task_failed',
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

  /** Mark a task as retry_wait and emit task_retried event. Per D-03: retry with backoff.
   *  Sets leaseExpiresAt to now + backoffMs so that canRetryNow() gates correctly.
   */
  async markTaskRetryWait(
    taskId: string,
    errorCategory: PDErrorCategory,
    failureReason?: string,
  ): Promise<TaskRecord> {
    this.assertInitialized();
    const now = new Date().toISOString();

    // Fetch current task to compute backoff from attemptCount
    const currentTask = await this._taskStore.getTask(taskId);
    const attemptCount = currentTask?.attemptCount ?? 0;
    const backoffMs = this.retryPolicy.calculateBackoff(attemptCount + 1);
    const retryAfter = new Date(Date.now() + backoffMs).toISOString();

    const updated = await this._taskStore.updateTask(taskId, {
      status: 'retry_wait',
      leaseOwner: null,
      leaseExpiresAt: retryAfter,
      lastError: errorCategory,
    });

    // Update the latest run to 'failed' state with error category
    const { runs, degradedRuns } = await this._runStore.listValidRunsByTaskTolerant(taskId);
    this.observeMalformedRuns(taskId, degradedRuns, 'markTaskRetryWait');
    const latestRun = runs[runs.length - 1];
    if (latestRun) {
      await this._runStore.updateRun(latestRun.runId, {
        executionStatus: 'failed',
        endedAt: now,
        reason: failureReason ?? 'task_retry',
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

    const updated = await this._runStore.updateRun(runId, {
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

  /**
   * Observe malformed historical run rows without blocking the caller.
   *
   * The execution/completion path tolerates schema-invalid historical run
   * rows (they must not block recovery of a task that has a valid run from
   * acquireLease). But tolerance MUST be observable — silently swallowing
   * degraded rows is a bug (ERR-002). This emits a structured
   * degradation_triggered event naming the affected runIds so operators can
   * find and quarantine them via `pd runtime internalization integrity-repair`.
   */
  private observeMalformedRuns(
    taskId: string,
    degradedRuns: { runId: string; error: string }[],
    caller: string,
  ): void {
    if (degradedRuns.length === 0) return;
    this.emitter.emitTelemetry({
      eventType: 'degradation_triggered',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'runtime-state-manager',
      payload: {
        component: 'RuntimeStateManager',
        caller,
        trigger: 'malformed_historical_run_rows',
        degradedCount: degradedRuns.length,
        runIds: degradedRuns.map((r) => r.runId),
        errors: degradedRuns.map((r) => r.error),
        nextAction:
          'Quarantine malformed run rows: pd runtime internalization integrity-repair --confirm',
      },
    });
  }

  // ── Retry/Recovery operations ─────────────────────────────────────────────

  async runRecoverySweep(): Promise<{ recovered: number; errors: string[] }> {
    this.assertInitialized();
    return this.recoverySweep.recoverAll();
  }

  async detectExpiredLeases(): Promise<string[]> {
    this.assertInitialized();
    return this.recoverySweep.detectExpiredLeases();
  }

  async recoverTask(taskId: string): Promise<RecoveryResult | null> {
    this.assertInitialized();
    return this.recoverySweep.recoverTask(taskId);
  }

  async updateTaskDiagnosticJson(taskId: string, diagnosticJson: string): Promise<void> {
    this.assertInitialized();
    await this._taskStore.updateTask(taskId, { diagnosticJson });
  }

  /**
   * Narrow CAS (PRI-629): apply patch only when the task's diagnostic_json is
   * still byte-equal to expectedDiagnosticJson. Returns null on precondition
   * failure — caller re-reads and re-evaluates (idempotent-or-conflict).
   */
  async updateTaskIfDiagnosticJsonUnchanged(
    taskId: string,
    expectedDiagnosticJson: string | null,
    patch: TaskStoreUpdatePatch,
  ): Promise<TaskRecord | null> {
    this.assertInitialized();
    return this._taskStore.updateTaskIfDiagnosticJsonUnchanged(taskId, expectedDiagnosticJson, patch);
  }

  /**
   * Atomically records an Owner decision only while both the task metadata and
   * every artifact row used by its evidence snapshot remain unchanged.
   */
  async updateTaskIfDiagnosticJsonAndArtifactsUnchanged(
    input: TaskArtifactCasInput,
  ): Promise<TaskRecord | null> {
    this.assertInitialized();
    return this._taskStore.updateTaskIfDiagnosticJsonAndArtifactsUnchanged(input);
  }

  getRetryPolicy(): RetryPolicy {
    return this.retryPolicy;
  }

  // ── M5 Query methods (delegated to store modules) ────────────────────────

  async getCommitByTaskId(taskId: string): Promise<CommitRecord | null> {
    this.assertInitialized();
    return this._commitStore.getCommitByTaskId(taskId);
  }

  async getCandidatesByTaskId(taskId: string): Promise<CandidateRecord[]> {
    this.assertInitialized();
    return this._candidateStore.getCandidatesByTaskId(taskId);
  }

  async getCandidate(candidateId: string): Promise<CandidateRecord | null> {
    this.assertInitialized();
    return this._candidateStore.getCandidate(candidateId);
  }

  async updateCandidateStatus(candidateId: string, patch: { status: CandidateRecord['status'] }): Promise<boolean> {
    this.assertInitialized();
    return this._candidateStore.updateCandidateStatus(candidateId, patch);
  }

  async transitionCandidateStatus(candidateId: string, expectedStatus: CandidateRecord['status'], newStatus: CandidateRecord['status']): Promise<boolean> {
    this.assertInitialized();
    return this._candidateStore.transitionCandidateStatus(candidateId, expectedStatus, newStatus);
  }

  async archivePrinciple(principleId: string): Promise<boolean> {
    this.assertInitialized();
    const stateDir = path.join(this.options.workspaceDir, '.state');
    try {
      updatePrinciple(stateDir, principleId, {
        status: 'archived',
        updatedAt: new Date().toISOString(),
      });
    } catch {
      return false;
    }
    return true;
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    this.assertInitialized();
    return this._artifactStore.getArtifact(artifactId);
  }

  // ── Pain diagnosis persistence (Pain Diagnosis Persistence SPEC §4-§7) ────

  /**
   * Persist the diagnostician's root-cause attribution for a pain. Called by
   * PainSignalBridge.onDiagnosisComplete when pain_diagnosis_persistence is on.
   * Idempotent per (taskId, diagnosisId).
   */
  async recordPainDiagnosis(input: PainDiagnosisWriteInput): Promise<PainDiagnosisRecord> {
    this.assertInitialized();
    return this._painDiagnosisStore.recordPainDiagnosis(input);
  }

  /** All persisted diagnoses for a pain (multiple rows = re-diagnosis / mixed attribution). */
  async getDiagnosesByPainId(painId: string): Promise<PainDiagnosisRecord[]> {
    this.assertInitialized();
    return this._painDiagnosisStore.getDiagnosesByPainId(painId);
  }

  async getArtifactWithCandidates(artifactId: string): Promise<ArtifactWithCandidates | null> {
    this.assertInitialized();
    return this._artifactStore.getArtifactWithCandidates(artifactId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
}
