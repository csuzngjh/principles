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

// ── M5 Query Result Types ─────────────────────────────────────────────────────

export interface CommitRecord {
  commitId: string;
  taskId: string;
  runId: string;
  artifactId: string;
  idempotencyKey: string;
  status: string;
  createdAt: string;
}

export interface CandidateRecord {
  candidateId: string;
  artifactId: string;
  taskId: string;
  sourceRunId: string;
  title: string;
  description: string;
  confidence: number | null;
  sourceRecommendationJson: string;
  status: 'pending' | 'consumed' | 'expired';
  createdAt: string;
}

export interface ArtifactRecord {
  artifactId: string;
  runId: string;
  taskId: string;
  artifactKind: string;
  contentJson: string;
  createdAt: string;
}

export interface ArtifactWithCandidates {
  artifact: ArtifactRecord;
  candidates: CandidateRecord[];
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

  // ── M5 Query methods ───────────────────────────────────────────────────────

  /** Returns the most recent CommitRecord for a task, or null if no commit exists. */
  async getCommitByTaskId(taskId: string): Promise<CommitRecord | null> {
    this.assertInitialized();
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at
      FROM commits WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(taskId) as { commit_id: string; task_id: string; run_id: string; artifact_id: string; idempotency_key: string; status: string; created_at: string } | undefined;
    if (!row) return null;
    return { commitId: row.commit_id, taskId: row.task_id, runId: row.run_id, artifactId: row.artifact_id, idempotencyKey: row.idempotency_key, status: row.status, createdAt: row.created_at };
  }

  /** Returns all principle candidates reachable via tasks→runs→commits chain for a given taskId. */
  async getCandidatesByTaskId(taskId: string): Promise<CandidateRecord[]> {
    this.assertInitialized();
    const db = this.connection.getDb();
    const rows = db.prepare(`
      SELECT pc.candidate_id, pc.artifact_id, pc.task_id, pc.source_run_id,
             pc.title, pc.description, pc.confidence, pc.status, pc.created_at, pc.source_recommendation_json
      FROM principle_candidates pc
      JOIN commits c ON c.artifact_id = pc.artifact_id
      JOIN runs r ON r.run_id = c.run_id
      JOIN tasks t ON t.task_id = r.task_id
      WHERE t.task_id = ?
      ORDER BY pc.created_at DESC
    `).all(taskId) as { candidate_id: string; artifact_id: string; task_id: string; source_run_id: string; title: string; description: string; confidence: number | null; status: string; created_at: string; source_recommendation_json: string }[];
    return rows.map((r) => ({ candidateId: r.candidate_id, artifactId: r.artifact_id, taskId: r.task_id, sourceRunId: r.source_run_id, title: r.title, description: r.description, confidence: r.confidence, sourceRecommendationJson: r.source_recommendation_json, status: r.status as CandidateRecord['status'], createdAt: r.created_at }));
  }

  /** Returns a single candidate by ID, or null if not found. */
  async getCandidate(candidateId: string): Promise<CandidateRecord | null> {
    this.assertInitialized();
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT candidate_id, artifact_id, task_id, source_run_id, title, description,
             confidence, source_recommendation_json, status, created_at
      FROM principle_candidates WHERE candidate_id = ?
    `).get(candidateId) as { candidate_id: string; artifact_id: string; task_id: string; source_run_id: string; title: string; description: string; confidence: number | null; source_recommendation_json: string; status: string; created_at: string } | undefined;
    if (!row) return null;
    return { candidateId: row.candidate_id, artifactId: row.artifact_id, taskId: row.task_id, sourceRunId: row.source_run_id, title: row.title, description: row.description, confidence: row.confidence, sourceRecommendationJson: row.source_recommendation_json, status: row.status as CandidateRecord['status'], createdAt: row.created_at };
  }

  /** Returns a single artifact by ID, or null if not found. */
  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    this.assertInitialized();
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT artifact_id, run_id, task_id, artifact_kind, content_json, created_at
      FROM artifacts WHERE artifact_id = ?
    `).get(artifactId) as { artifact_id: string; run_id: string; task_id: string; artifact_kind: string; content_json: string; created_at: string } | undefined;
    if (!row) return null;
    return { artifactId: row.artifact_id, runId: row.run_id, taskId: row.task_id, artifactKind: row.artifact_kind, contentJson: row.content_json, createdAt: row.created_at };
  }

  /** Returns an artifact with its inline candidate array, or null if artifact not found. */
  async getArtifactWithCandidates(artifactId: string): Promise<ArtifactWithCandidates | null> {
    this.assertInitialized();
    const artifact = await this.getArtifact(artifactId);
    if (!artifact) return null;
    const db = this.connection.getDb();
    const rows = db.prepare(`
      SELECT candidate_id, artifact_id, task_id, source_run_id, title, description,
             confidence, source_recommendation_json, status, created_at
      FROM principle_candidates WHERE artifact_id = ?
      ORDER BY created_at DESC
    `).all(artifactId) as { candidate_id: string; artifact_id: string; task_id: string; source_run_id: string; title: string; description: string; confidence: number | null; source_recommendation_json: string; status: string; created_at: string }[];
    const candidates: CandidateRecord[] = rows.map((r) => ({ candidateId: r.candidate_id, artifactId: r.artifact_id, taskId: r.task_id, sourceRunId: r.source_run_id, title: r.title, description: r.description, confidence: r.confidence, sourceRecommendationJson: r.source_recommendation_json, status: r.status as CandidateRecord['status'], createdAt: r.created_at }));
    return { artifact, candidates };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private assertInitialized(): void {
    if (!this._initialized) {
      throw new Error('RuntimeStateManager not initialized — call initialize() first');
    }
  }
}
