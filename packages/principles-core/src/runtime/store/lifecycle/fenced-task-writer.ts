/**
 * Fenced Task Lifecycle Writer — the ONE write authority for execution-owned
 * task/run transitions.
 *
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.3 (remediation).
 *
 * Before this module `RuntimeStateManager.markTaskSucceeded/Failed/RetryWait`
 * (a) guarded only some paths, (b) cleared the lease and THEN looked up the
 * newest run to update, and (c) therefore let a superseded worker stamp a new
 * execution's run as failed. This module:
 *
 *   - fences the task UPDATE with the caller's lease identity (owner +
 *     generation + not-expired) in the same statement;
 *   - updates the run identified by the EXPLICIT `runId` supplied by the
 *     executing context — never "the latest run";
 *   - performs both writes inside ONE SQLite transaction, so a fence failure
 *     rolls back the run write and a missing run rolls back the task write.
 *
 * The SQL lives here (store-owned) rather than in the manager (PRI-47).
 */
import { PDRuntimeError, type PDErrorCategory } from '../../error-categories.js';
import type { SqliteConnection } from '../sqlite-connection.js';
import type { TaskRecord } from '../../task-status.js';
import { assertLeaseFenceShape, leaseFenceValues, type LeaseFence } from './lease-fence.js';

export interface FencedTerminalWriteInput {
  readonly fence: LeaseFence;
  /** The run created by THIS acquisition (never resolved by "latest"). */
  readonly runId: string;
  /** Classified failure category; `null` clears it (success). */
  readonly errorCategory: PDErrorCategory | null;
  readonly failureReason?: string;
  readonly resultRef?: string;
  /** Required for retry_wait: the ISO time at which the retry becomes due. */
  readonly retryAfterIso?: string;
}

type TerminalStatus = 'succeeded' | 'failed' | 'retry_wait';

function isValidFence(fence: LeaseFence): boolean {
  try {
    assertLeaseFenceShape(fence);
    return true;
  } catch {
    return false;
  }
}

function buildTaskPatch(
  input: FencedTerminalWriteInput,
  terminal: TerminalStatus,
  nowIso: string,
): { setSql: string; values: unknown[] } {
  if (terminal === 'retry_wait') {
    return {
      setSql: 'status = ?, lease_owner = NULL, lease_expires_at = ?, last_error = ?, updated_at = ?',
      values: ['retry_wait', input.retryAfterIso, input.errorCategory, nowIso],
    };
  }
  if (terminal === 'failed') {
    return {
      setSql: 'status = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?',
      values: ['failed', input.errorCategory, nowIso],
    };
  }
  return {
    setSql: 'status = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, result_ref = ?, updated_at = ?',
    values: ['succeeded', input.resultRef ?? null, nowIso],
  };
}

/**
 * Narrow a raw task row into a TaskRecord.
 *
 * Duplicated deliberately from SqliteTaskStore's private mapper: importing a
 * private method across modules would be a shallow seam, and the fields read
 * here are validated structurally (rc-1/rc-3).
 */
function rowToTaskRecord(row: Record<string, unknown>): TaskRecord {
  const record: TaskRecord = {
    taskId: String(row.task_id),
    taskKind: String(row.task_kind),
    status: String(row.status) as TaskRecord['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    lastError: (row.last_error ?? null) as TaskRecord['lastError'],
    leaseGeneration: Number(row.lease_generation ?? 0),
  };
  if (typeof row.lease_owner === 'string') record.leaseOwner = row.lease_owner;
  if (typeof row.lease_expires_at === 'string') record.leaseExpiresAt = row.lease_expires_at;
  if (typeof row.input_ref === 'string') record.inputRef = row.input_ref;
  if (typeof row.result_ref === 'string') record.resultRef = row.result_ref;
  if (typeof row.diagnostic_json === 'string') record.diagnosticJson = row.diagnostic_json;
  return record;
}

export class SqliteFencedTaskLifecycle {
  constructor(private readonly connection: SqliteConnection) {}

  /** Fenced success: task → succeeded, the caller's run → succeeded. */
  async markSucceeded(input: FencedTerminalWriteInput): Promise<TaskRecord> {
    return this.markTerminalSync(input, 'succeeded');
  }

  /** Sync variant for composing the terminal write into a larger transaction. */
  markSucceededSync(input: FencedTerminalWriteInput): TaskRecord {
    return this.markTerminalSync(input, 'succeeded');
  }

  /** Fenced failure: task → failed, the caller's run → failed. */
  async markFailed(input: FencedTerminalWriteInput): Promise<TaskRecord> {
    return this.markTerminalSync(input, 'failed');
  }

  /** Fenced retry: task → retry_wait, the caller's run → failed. */
  async markRetryWait(input: FencedTerminalWriteInput): Promise<TaskRecord> {
    return this.markTerminalSync(input, 'retry_wait');
  }

  /**
   * Apply a diagnostic-JSON mutation under the fence.
   *
   * Read and write happen inside one transaction: the mutation receives the
   * CURRENT persisted JSON, so two concurrent fenced writers cannot overwrite
   * each other from a stale snapshot, and a superseded worker cannot write at
   * all.
   *
   * @throws PDRuntimeError{lease_conflict} when the fence no longer holds.
   */
  async applyDiagnosticJson(
    fence: LeaseFence,
    mutate: (currentDiagnosticJson: string | null) => string,
  ): Promise<TaskRecord> {
    assertLeaseFenceShape(fence);
    const db = this.connection.getDb();
    const nowIso = new Date().toISOString();

    db.transaction((): void => {
      const row = db
        .prepare('SELECT diagnostic_json FROM tasks WHERE task_id = ?')
        .get(fence.taskId) as { diagnostic_json: string | null } | undefined;
      if (!row) {
        throw new PDRuntimeError('storage_unavailable', `Task not found: ${fence.taskId}`, {
          taskId: fence.taskId,
        });
      }
      const nextJson = mutate(row.diagnostic_json ?? null);
      const { changes } = db
        .prepare(
          `UPDATE tasks SET diagnostic_json = ?, updated_at = ?
           WHERE task_id = ?
             AND status = 'leased'
             AND lease_owner = ?
             AND lease_generation = ?
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at >= ?`,
        )
        .run(nextJson, nowIso, fence.taskId, ...leaseFenceValues(fence, nowIso));
      if (changes === 0) {
        throw new PDRuntimeError(
          'lease_conflict',
          `Task ${fence.taskId} diagnostic write refused: lease generation ${fence.leaseGeneration} is no longer the owner`,
          { taskId: fence.taskId, owner: fence.owner, leaseGeneration: fence.leaseGeneration },
        );
      }
    })();

    const updated = await this.readTask(fence.taskId);
    if (!updated) {
      throw new PDRuntimeError('storage_unavailable', `Task not found after diagnostic write: ${fence.taskId}`, {
        taskId: fence.taskId,
      });
    }
    return updated;
  }

  /** Fence-only probe used by heartbeat/ownership checks. */
  async assertOwned(fence: LeaseFence): Promise<boolean> {
    if (!isValidFence(fence)) return false;
    const db = this.connection.getDb();
    const nowIso = new Date().toISOString();
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM tasks
         WHERE task_id = ?
           AND status = 'leased'
           AND lease_owner = ?
           AND lease_generation = ?
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at >= ?`,
      )
      .get(fence.taskId, ...leaseFenceValues(fence, nowIso));
    return row !== undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private markTerminalSync(
    input: FencedTerminalWriteInput,
    terminal: TerminalStatus,
  ): TaskRecord {
    assertLeaseFenceShape(input.fence);
    if (!input.runId) {
      throw new PDRuntimeError('input_invalid', 'Fenced terminal write requires the execution runId', {
        taskId: input.fence.taskId,
      });
    }
    if (terminal === 'retry_wait' && !input.retryAfterIso) {
      throw new PDRuntimeError('input_invalid', 'markRetryWait requires retryAfterIso', {
        taskId: input.fence.taskId,
      });
    }
    const db = this.connection.getDb();
    const nowIso = new Date().toISOString();
    const { fence } = input;

    db.transaction(() => {
      const patch = buildTaskPatch(input, terminal, nowIso);
      const { changes } = db
        .prepare(
          `UPDATE tasks SET ${patch.setSql}
           WHERE task_id = ?
             AND status = 'leased'
             AND lease_owner = ?
             AND lease_generation = ?
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at >= ?`,
        )
        .run(...patch.values, fence.taskId, ...leaseFenceValues(fence, nowIso));

      if (changes === 0) {
        throw new PDRuntimeError(
          'lease_conflict',
          `Task ${fence.taskId} ${terminal} write refused: lease generation ${fence.leaseGeneration} (owner ${fence.owner}) is no longer the owner`,
          {
            taskId: fence.taskId,
            owner: fence.owner,
            leaseGeneration: fence.leaseGeneration,
            terminal,
          },
        );
      }

      // The run is addressed explicitly. A missing/mismatched run means the
      // caller's execution context does not describe this task's run — a
      // storage fault that must roll the task write back (rc-3).
      const runChanges = db
        .prepare(
          `UPDATE runs SET execution_status = ?, ended_at = ?, reason = ?, error_category = ?
           WHERE run_id = ? AND task_id = ?`,
        )
        .run(
          terminal === 'succeeded' ? 'succeeded' : 'failed',
          nowIso,
          terminal === 'succeeded'
            ? 'task_completed'
            : terminal === 'failed'
              ? 'task_failed'
              : (input.failureReason ?? 'task_retry'),
          input.errorCategory,
          input.runId,
          fence.taskId,
        ).changes;

      if (runChanges === 0) {
        throw new PDRuntimeError(
          'storage_unavailable',
          `Run ${input.runId} does not belong to task ${fence.taskId}; fenced ${terminal} write rolled back`,
          { taskId: fence.taskId, runId: input.runId },
        );
      }
    })();

    const updated = this.readTaskSync(fence.taskId);
    if (!updated) {
      throw new PDRuntimeError('storage_unavailable', `Task not found after fenced write: ${fence.taskId}`, {
        taskId: fence.taskId,
      });
    }
    return updated;
  }

  private async readTask(taskId: string): Promise<TaskRecord | null> {
    return this.readTaskSync(taskId);
  }

  private readTaskSync(taskId: string): TaskRecord | null {
    const db = this.connection.getDb();
    const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTaskRecord(row) : null;
  }
}

