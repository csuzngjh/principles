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
import type { LeaseManager, AcquireLeaseOptions, LeaseAcquisition } from './lifecycle/lease-manager.js';
import type { LeaseFence } from './lifecycle/lease-fence.js';
import { assertLeaseFenceInTransaction } from './lifecycle/lease-fence.js';
import { SqliteFencedTaskLifecycle } from './lifecycle/fenced-task-writer.js';
import type { RetryPolicy, RetryPolicyConfig } from './lifecycle/retry-policy.js';
import type { RecoverySweep, RecoveryResult } from './lifecycle/recovery-sweep.js';
import type { PDErrorCategory } from '../error-categories.js';
import { PDRuntimeError } from '../error-categories.js';
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
import { SqliteReconciliationCursorStore } from './reconciliation-cursor-store.js';
import { reopenDiagnosticianFamilyInConnection } from './task/sqlite-family-reopen.js';
import { SqliteArtifactStore } from './artifact/sqlite-artifact-store.js';
import { SqlitePIArtifactStore } from './artifact/sqlite-pi-artifact-store.js';
import { SqlitePainDiagnosisStore } from './pain-diagnosis/sqlite-pain-diagnosis-store.js';
import { SqliteDiagnosticianCommitter } from './commit/diagnostician-committer.js';
import type { CommitResult, CommitInput, CommitPIArtifactInput } from './commit/diagnostician-committer.js';
import type { PIArtifactRecord } from '../internalization/pi-artifact.js';
import type { CommitStore } from './commit/commit-store.js';
import type { CandidateStore } from './candidate/candidate-store.js';
import type { AdmissionEvaluationRecord, AdmissionProcessingRecord, CandidateAdmissionDocument } from './candidate/admission-document.js';
import type { ArtifactStore } from './artifact/artifact-store.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import type { PainDiagnosisRecord, PainDiagnosisStore, PainDiagnosisWriteInput } from './pain-diagnosis/pain-diagnosis-store.js';
import type { CommitRecord } from './commit/commit-store.js';
import type { CandidateRecord } from './candidate/candidate-store.js';
import type { ArtifactRecord, ArtifactWithCandidates } from './artifact/artifact-store.js';
import * as path from 'path';
import { updatePrinciple } from '../../principle-tree-ledger.js';

// Re-export M5 types for backward compatibility
export type { CandidateRecord } from './candidate/candidate-store.js';
export type {
  AdmissionEvaluationRecord,
  AdmissionProcessingRecord,
  CandidateAdmissionDocument,
} from './candidate/admission-document.js';
export type { ArtifactRecord } from './artifact/artifact-store.js';
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
  /**
   * PRI-991 (P1-01): when false, a missing state.db is NEVER bootstrapped —
   * readonly callers fail loudly instead of silently creating databases.
   * Default true (backward compatible). Forwarded to SqliteConnection.
   */
  bootstrapIfMissing?: boolean;
}

// ── RuntimeStateManager ──────────────────────────────────────────────────────

export class RuntimeStateManager {
  private _connection!: SqliteConnection;
  private _taskStore!: SqliteTaskStore;
  private _runStore!: RunStore;
  private _commitStore!: CommitStore;
  private _candidateStore!: CandidateStore;
  private _artifactStore!: ArtifactStore;
  private _piArtifactStore!: SqlitePIArtifactStore;
  private _painDiagnosisStore!: PainDiagnosisStore;
  private leaseManager!: LeaseManager;
  private retryPolicy!: RetryPolicy;
  private recoverySweep!: RecoverySweep;
  private fencedLifecycle!: SqliteFencedTaskLifecycle;
  private diagnosticianCommitter!: SqliteDiagnosticianCommitter;
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
      bootstrapIfMissing: this.options.bootstrapIfMissing,
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
      this.fencedLifecycle = new SqliteFencedTaskLifecycle(this._connection);
      this.diagnosticianCommitter = new SqliteDiagnosticianCommitter(this._connection);

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

  /**
   * Acquisition variant that returns the execution identity (runId + fencing
   * token). Every production execution path uses this; `acquireLease` exists
   * only for bootstrap tooling that never writes an execution result.
   */
  async acquireLeaseDetailed(options: AcquireLeaseOptions): Promise<LeaseAcquisition> {
    this.assertInitialized();
    return this.leaseManager.acquireLeaseDetailed(options);
  }

  async releaseLease(fence: LeaseFence): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.releaseLease(fence);
  }

  async renewLease(fence: LeaseFence, durationMs?: number): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.renewLease(fence, durationMs);
  }

  async forceExpireLease(taskId: string): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.forceExpire(taskId);
  }

  isLeaseExpired(task: TaskRecord): boolean {
    return this.leaseManager.isLeaseExpired(task);
  }

  /** Fence-only ownership probe (task exists + leased + owner + generation + live). */
  async assertLeaseOwned(fence: LeaseFence): Promise<boolean> {
    this.assertInitialized();
    return this.fencedLifecycle.assertOwned(fence);
  }

  // ── Task completion events (fenced) ───────────────────────────────────────

  /**
   * Mark a task as succeeded. SPEC §5.3: the fence is REQUIRED and is part of
   * the same UPDATE that mutates the row; the caller's explicit `runId` is the
   * only run updated, in the same transaction.
   */
  // eslint-disable-next-line @typescript-eslint/max-params -- SPEC §5.3 fixes the positional execution identity (task, result, fence, run); the fence and runId must stay explicit at every call site
  async markTaskSucceeded(
    taskId: string,
    resultRef: string | undefined,
    fence: LeaseFence,
    runId: string,
  ): Promise<TaskRecord> {
    this.assertInitialized();
    return this.finalizeFenced(taskId, fence, runId, 'succeeded', { resultRef });
  }

  /** Mark a task as failed (fenced; run addressed explicitly). */
  // eslint-disable-next-line @typescript-eslint/max-params -- SPEC §5.3 fixes the positional execution identity (task, category, reason, fence, run); grouping it would hide the required fence
  async markTaskFailed(
    taskId: string,
    lastError: PDErrorCategory,
    failureReason: string | undefined,
    fence: LeaseFence,
    runId: string,
  ): Promise<TaskRecord> {
    this.assertInitialized();
    return this.finalizeFenced(taskId, fence, runId, 'failed', { errorCategory: lastError, failureReason });
  }

  /**
   * Mark a task as retry_wait (fenced).
   *
   * The run is the caller's OWN run — never "the newest run", which after a
   * concurrent re-acquisition belongs to a different execution. Task and run
   * are written in one transaction, so a failed CAS leaves neither changed.
   */
  // eslint-disable-next-line @typescript-eslint/max-params -- SPEC §5.3 fixes the positional execution identity (task, category, reason, fence, run); grouping it would hide the required fence
  async markTaskRetryWait(
    taskId: string,
    errorCategory: PDErrorCategory,
    failureReason: string | undefined,
    fence: LeaseFence,
    runId: string,
  ): Promise<TaskRecord> {
    this.assertInitialized();
    const currentTask = await this._taskStore.getTask(taskId);
    const attemptCount = currentTask?.attemptCount ?? 0;
    const backoffMs = this.retryPolicy.calculateBackoff(attemptCount + 1);
    const retryAfterIso = new Date(Date.now() + backoffMs).toISOString();
    return this.finalizeFenced(taskId, fence, runId, 'retry_wait', {
      errorCategory,
      failureReason,
      retryAfterIso,
    });
  }

  // eslint-disable-next-line @typescript-eslint/max-params -- private fan-in for the three fenced terminal writers; the shape mirrors their positional contract
  private async finalizeFenced(
    taskId: string,
    fence: LeaseFence,
    runId: string,
    terminal: 'succeeded' | 'failed' | 'retry_wait',
    outcome: { resultRef?: string; errorCategory?: PDErrorCategory | null; failureReason?: string; retryAfterIso?: string },
  ): Promise<TaskRecord> {
    if (fence.taskId !== taskId) {
      throw new PDRuntimeError('input_invalid', `Lease fence taskId ${fence.taskId} does not match ${taskId}`, {
        taskId,
      });
    }
    const input = {
      fence,
      runId,
      errorCategory: outcome.errorCategory ?? null,
      ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
      ...(outcome.resultRef !== undefined ? { resultRef: outcome.resultRef } : {}),
      ...(outcome.retryAfterIso !== undefined ? { retryAfterIso: outcome.retryAfterIso } : {}),
    };
    const updated = terminal === 'succeeded'
      ? await this.fencedLifecycle.markSucceeded(input)
      : terminal === 'failed'
        ? await this.fencedLifecycle.markFailed(input)
        : await this.fencedLifecycle.markRetryWait(input);

    this.emitter.emitTelemetry({
      eventType: terminal === 'succeeded' ? 'task_succeeded' : terminal === 'failed' ? 'task_failed' : 'task_retried',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: fence.owner,
      payload: {
        taskId,
        runId,
        leaseGeneration: fence.leaseGeneration,
        ...(terminal === 'succeeded' ? { resultRef: updated.resultRef } : {}),
        ...(terminal === 'failed' ? { lastError: outcome.errorCategory ?? null, attemptCount: updated.attemptCount } : {}),
        ...(terminal === 'retry_wait' ? { errorCategory: outcome.errorCategory ?? null, attemptCount: updated.attemptCount } : {}),
      },
    });

    return updated;
  }

  /**
   * ONE transaction for the whole Stage C result publication:
   *   fence CAS → artifact + commit + candidates → pi_artifacts → task/run success.
   *
   * SPEC §5.3: calling `assertOwned()` before `committer.commit()` and then
   * writing three times is a check-then-write race — the lease can be
   * reclaimed in between, publishing a result nobody owns. Here every write is
   * inside the same transaction as the CAS, so either the whole result becomes
   * durable under a live fence or nothing does.
   *
   * The idempotency key passed to the committer must already bind the execution
   * identity (`taskId:runId`); this method does not invent a second key.
   */
  async commitDiagnosticianAndFinalize(input: {
    fence: LeaseFence;
    runId: string;
    /** Defaults to `commit://<commitId>` (the id is minted inside the unit). */
    resultRef?: string;
    commit: CommitInput;
    piArtifact?: CommitPIArtifactInput & { sourceTaskId: string };
  }): Promise<{ commit: CommitResult; task: TaskRecord; resultRef: string }> {
    this.assertInitialized();
    if (input.commit.taskId !== input.fence.taskId) {
      throw new PDRuntimeError(
        'input_invalid',
        `Commit task ${input.commit.taskId} does not match lease task ${input.fence.taskId}`,
        { taskId: input.fence.taskId },
      );
    }
    const db = this._connection.getDb();
    const nowIso = new Date().toISOString();

    const outcome = db.transaction((): { commit: CommitResult; task: TaskRecord } => {
      assertLeaseFenceInTransaction(db, input.fence, nowIso);
      const commit = this.diagnosticianCommitter.commitSync(input.commit);
      const resultRef = input.resultRef ?? `commit://${commit.commitId}`;
      if (input.piArtifact) {
        const { sourceTaskId, ...artifact } = input.piArtifact;
        this._piArtifactStore.upsertArtifactSync({
          artifactId: artifact.artifactId,
          artifactKind: artifact.artifactKind as PIArtifactRecord['artifactKind'],
          sourceTaskId,
          lineageArtifactIds: artifact.lineageArtifactIds,
          validationStatus: artifact.validationStatus as PIArtifactRecord['validationStatus'],
          contentJson: artifact.contentJson,
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
        });
      }
      const task = this.fencedLifecycle.markSucceededSync({
        fence: input.fence,
        runId: input.runId,
        errorCategory: null,
        resultRef,
      });
      return { commit, task };
    }).immediate();

    this.emitter.emitTelemetry({
      eventType: 'task_succeeded',
      traceId: input.fence.taskId,
      timestamp: nowIso,
      sessionId: input.fence.owner,
      payload: {
        taskId: input.fence.taskId,
        runId: input.runId,
        leaseGeneration: input.fence.leaseGeneration,
        resultRef: input.resultRef ?? `commit://${outcome.commit.commitId}`,
        commitId: outcome.commit.commitId,
        artifactId: outcome.commit.artifactId,
        candidateCount: outcome.commit.candidateCount,
        atomicCommitUnit: true,
      },
    });

    return { ...outcome, resultRef: outcome.task.resultRef ?? `commit://${outcome.commit.commitId}` };
  }

  /**
   * Fenced diagnostic-JSON write: read + mutate + conditional UPDATE in ONE
   * transaction. A superseded worker gets `lease_conflict`, never a silent
   * overwrite of the new execution's facts.
   */
  async applyFencedDiagnosticJson(
    fence: LeaseFence,
    mutate: (currentDiagnosticJson: string | null) => string,
  ): Promise<TaskRecord> {
    this.assertInitialized();
    return this.fencedLifecycle.applyDiagnosticJson(fence, mutate);
  }

  /**
   * Write output payload to a run record.
   * Per D-04: DiagnosticianOutputV2 JSON serialized into RunRecord.outputPayload.
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
   * PRI-983: `options.expectedStatus` additionally requires the task to still
   * sit in that status (SPEC-PD-IAER-001 §6.3) — arbitrates content-neutral
   * authority resets under concurrent writers.
   */
  // eslint-disable-next-line @typescript-eslint/max-params -- the 4th parameter is a CAS PRECONDITION (SPEC-PD-IAER-001 §6.3), not write payload: folding it into the patch type would let it leak into TaskRecord on unconditional updateTask paths.
  async updateTaskIfDiagnosticJsonUnchanged(
    taskId: string,
    expectedDiagnosticJson: string | null,
    patch: TaskStoreUpdatePatch,
    options?: {
      readonly expectedStatus?: string;
      readonly expectedAttemptCount?: number;
      readonly expectedMaxAttempts?: number;
      readonly expectedLeaseOwner?: string | null;
      readonly expectedLeaseExpiresAt?: string | null;
    },
  ): Promise<TaskRecord | null> {
    this.assertInitialized();
    return this._taskStore.updateTaskIfDiagnosticJsonUnchanged(taskId, expectedDiagnosticJson, patch, options);
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

  /** SPEC-CODEX-PAIN-CLOSURE-001 CR-03 (PRI-958): persisted admission disposition. */
  async getAdmissionDocument(candidateId: string): Promise<
    { ok: true; document: CandidateAdmissionDocument | null } | { ok: false; reason: string }
  > {
    this.assertInitialized();
    return this._candidateStore.getAdmissionDocument(candidateId);
  }

  async appendAdmissionEvaluation(candidateId: string, evaluation: AdmissionEvaluationRecord): Promise<
    { status: 'appended' | 'reused'; document: CandidateAdmissionDocument } | { status: 'refused'; reason: string }
  > {
    this.assertInitialized();
    return this._candidateStore.appendAdmissionEvaluation(candidateId, evaluation);
  }

  async updateAdmissionProcessing(candidateId: string, processing: AdmissionProcessingRecord): Promise<boolean> {
    this.assertInitialized();
    return this._candidateStore.updateAdmissionProcessing(candidateId, processing);
  }

  async reopenDiagnosticianFamilyAtomic(input: {
    parentTaskId: string;
    stageTaskIds: string[];
    parentPatch: { diagnosticJson?: string };
  }): Promise<{ reopened: boolean; leased: string[] }> {
    this.assertInitialized();
    // Store-owned SQL (PRI-47): the manager delegates, no inline SQL here.
    return reopenDiagnosticianFamilyInConnection(this._connection, input);
  }

  /** SPEC §9.1 fair-share service cursor (same reconciliation_cursor authority, scoped). */
  async getDiagnosticianServiceCursor(scope: string): Promise<{ lastUpdatedAt: string; lastTaskId: string } | null> {
    this.assertInitialized();
    const store = new SqliteReconciliationCursorStore(this._connection);
    return store.get(scope);
  }

  async setDiagnosticianServiceCursor(scope: string, cursor: { lastUpdatedAt: string; lastTaskId: string }): Promise<void> {
    this.assertInitialized();
    const store = new SqliteReconciliationCursorStore(this._connection);
    store.set(scope, cursor);
  }

  /**
   * SPEC-CODEX-PAIN-CLOSURE-001 CR-05 (SPEC §9.1): the diagnosis post-processing
   * backlog — candidates of SUCCEEDED diagnostician tasks whose admission /
   * intake / seeding never completed. Includes pre-CR-03 pending rows with no
   * persisted disposition (the original stuck-candidates incident shape) and
   * rows whose processing domain is still open and whose nextRetryAt has
   * elapsed. Terminal processing states (complete / awaiting_owner / exhausted)
   * and admission_json-NULL consumed rows are excluded — they are saved
   * explainable states, not work.
   */
  async listDiagnosisPostProcessingBacklog(options: { limit: number; nowIso?: string }): Promise<{
    eligible: { candidateId: string; taskId: string; status: string; createdAt: string; processingState: string | null }[];
    corrupt: { candidateId: string; taskId: string; status: string; createdAt: string }[];
  }> {
    this.assertInitialized();
    // Store-owned query (PRI-47): the manager delegates; no inline SQL here.
    return this._candidateStore.listDiagnosisPostProcessingBacklog(options);
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

  /**
   * All persisted diagnoses produced by one diagnostician task (PRI-917 PR3B
   * Phase 2: the candidate → pain bridge for reuse evidence resolution).
   */
  async getDiagnosesByTaskId(taskId: string): Promise<PainDiagnosisRecord[]> {
    this.assertInitialized();
    return this._painDiagnosisStore.getDiagnosesByTaskId(taskId);
  }

  async getArtifactWithCandidates(artifactId: string): Promise<ArtifactWithCandidates | null> {
    this.assertInitialized();
    return this._artifactStore.getArtifactWithCandidates(artifactId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
}
