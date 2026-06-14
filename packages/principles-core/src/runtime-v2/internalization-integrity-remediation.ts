import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { extractPIMetadata } from './internalization-chain-integrity-read-model.js';
import { createRemediationResult, remediationAction } from './remediation-contract.js';
import type { RemediationAction, RemediationResult } from './remediation-contract.js';
import { SqliteRunStore } from './store/run/sqlite-run-store.js';

export interface InternalizationIntegrityRemediationOptions {
  workspaceDir: string;
}

interface BrokenDreamer {
  taskId: string;
  missingArtifact: boolean;
  missingSuccessor: boolean;
  hasArtifact: boolean;
}

interface StuckLease {
  taskId: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  isSafe: boolean;
  reason?: string;
}

interface OrphanedRun {
  runId: string;
  taskId: string;
  taskExists: boolean;
  taskStatus: string | null;
}

/**
 * A run row that failed TypeBox schema validation against RunRecordSchema.
 *
 * Detection reuses SqliteRunStore.getRun() so this uses the EXACT same
 * validation path as the production store (EP-01: no duplicated validation
 * logic that can drift from the real one). Repair quarantines the row as
 * failed + storage_unavailable — it never deletes it and never marks it
 * succeeded, preserving audit history.
 */
interface MalformedRun {
  runId: string;
  taskId: string;
  error: string;
  currentStatus: string | null;
}

export class InternalizationIntegrityRemediation {
  private readonly dbPath: string;

  constructor(opts: InternalizationIntegrityRemediationOptions) {
    this.dbPath = path.join(opts.workspaceDir, '.pd', 'state.db');
  }

  repair(params: { dryRun: boolean }): RemediationResult {
    const generatedAt = new Date().toISOString();

    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`state.db not found at ${this.dbPath} — cannot remediate`);
    }

    const brokenDreamers = this.detectBrokenDreamers();
    const stuckLeases = this.detectStuckLeases();
    const orphanedRuns = this.detectOrphanedRuns();
    const malformedRuns = this.detectMalformedRuns();

    const actions: RemediationAction[] = [];
    const warnings: string[] = [];
    let repairedCount = 0;
    let skippedCount = 0;

    // ── 1. Fix broken dreamers (existing logic) ──────────────────────────
    for (const bd of brokenDreamers) {
      if (bd.missingArtifact) {
        if (params.dryRun) {
          actions.push(remediationAction({
            action: 'requeue',
            targetId: bd.taskId,
            taskId: bd.taskId,
            type: 'missing_dreamer_pi_artifact',
            severity: 'error',
            previousState: 'succeeded',
            nextState: 'retry_wait',
            previousStatus: 'succeeded',
            newStatus: 'retry_wait',
            recommendedAction: 'requeue',
            reason: 'Succeeded dreamer missing dreamer_pi artifact — operator repair: requeue to retry_wait for re-execution',
          }));
        } else {
          const currentStatus = this.getTaskStatus(bd.taskId);
          if (currentStatus !== 'succeeded') {
            actions.push(remediationAction({
              action: 'already_repaired',
              targetId: bd.taskId,
              taskId: bd.taskId,
              type: 'missing_dreamer_pi_artifact',
              severity: 'error',
              previousState: currentStatus,
              nextState: currentStatus,
              previousStatus: currentStatus,
              newStatus: currentStatus,
              recommendedAction: 'already_repaired',
              reason: `Task already in ${currentStatus} — no repair needed`,
            }));
            skippedCount++;
            continue;
          }

          this.requeueTask(bd.taskId);
          repairedCount++;

          actions.push(remediationAction({
            action: 'requeue',
            targetId: bd.taskId,
            taskId: bd.taskId,
            type: 'missing_dreamer_pi_artifact',
            severity: 'error',
            previousState: 'succeeded',
            nextState: 'retry_wait',
            previousStatus: 'succeeded',
            newStatus: 'retry_wait',
            recommendedAction: 'requeue',
            reason: 'Succeeded dreamer missing dreamer_pi artifact — operator repair: requeue to retry_wait for re-execution',
          }));
        }
      }

      if (bd.missingSuccessor) {
        if (!bd.hasArtifact) {
          actions.push(remediationAction({
            action: 'skip_missing_artifact',
            targetId: bd.taskId,
            taskId: bd.taskId,
            type: 'missing_philosopher_successor',
            severity: 'warning',
            previousState: this.getTaskStatus(bd.taskId),
            nextState: this.getTaskStatus(bd.taskId),
            previousStatus: this.getTaskStatus(bd.taskId),
            newStatus: this.getTaskStatus(bd.taskId),
            recommendedAction: 'skip_missing_artifact',
            reason: 'Cannot create philosopher successor — dreamer has no dreamer_pi artifact. Fix artifact first.',
          }));
          skippedCount++;
        } else if (params.dryRun) {
          actions.push(remediationAction({
            action: 'enqueue_successor',
            targetId: bd.taskId,
            taskId: bd.taskId,
            type: 'missing_philosopher_successor',
            severity: 'warning',
            previousState: 'succeeded',
            nextState: 'succeeded',
            previousStatus: 'succeeded',
            newStatus: 'succeeded',
            recommendedAction: 'enqueue_successor',
            reason: 'Dreamer has artifact but no philosopher successor — would create philosopher task',
          }));
        } else {
          const existingSuccessor = this.findExistingSuccessor(bd.taskId);
          if (existingSuccessor) {
            actions.push(remediationAction({
              action: 'successor_exists',
              targetId: bd.taskId,
              taskId: bd.taskId,
              type: 'missing_philosopher_successor',
              severity: 'warning',
              previousState: 'succeeded',
              nextState: 'succeeded',
              previousStatus: 'succeeded',
              newStatus: 'succeeded',
              recommendedAction: 'successor_exists',
              reason: `Philosopher successor already exists: ${existingSuccessor}`,
              successorTaskId: existingSuccessor,
            }));
            skippedCount++;
          } else {
            const successorTaskId = this.createPhilosopherSuccessor(bd.taskId);
            repairedCount++;

            actions.push(remediationAction({
              action: 'enqueue_successor',
              targetId: bd.taskId,
              taskId: bd.taskId,
              type: 'missing_philosopher_successor',
              severity: 'warning',
              previousState: 'succeeded',
              nextState: 'succeeded',
              previousStatus: 'succeeded',
              newStatus: 'succeeded',
              recommendedAction: 'enqueue_successor',
              reason: 'Created philosopher successor task',
              successorTaskId,
            }));
          }
        }
      }
    }

    // ── 2. Fix stuck leases ────────────────────────────────────────────
    for (const sl of stuckLeases) {
      if (!sl.isSafe) {
        actions.push(remediationAction({
          action: 'refuse_repair',
          targetId: sl.taskId,
          taskId: sl.taskId,
          type: 'lease_stuck',
          severity: 'error',
          previousState: 'leased',
          nextState: 'leased',
          previousStatus: 'leased',
          newStatus: 'leased',
          recommendedAction: 'manual_intervention',
          reason: `Cannot safely repair: ${sl.reason ?? 'unknown reason'}. nextAction: Manually update/fix the task status or lease_expires_at in state.db`,
        }));
        warnings.push(`Task ${sl.taskId} has unsafe/unparseable lease state and cannot be safely repaired automatically.`);
        skippedCount++;
        continue;
      }

      if (params.dryRun) {
        actions.push(remediationAction({
          action: 'force_expire_lease',
          targetId: sl.taskId,
          taskId: sl.taskId,
          type: 'lease_stuck',
          severity: 'warning',
          previousState: 'leased',
          nextState: 'pending',
          previousStatus: 'leased',
          newStatus: 'pending',
          recommendedAction: 'force_expire_lease',
          reason: `Task ${sl.taskId} has expired lease (owner: ${sl.leaseOwner ?? 'unknown'}) — would force-expire to pending and mark latest run as failed`,
        }));
      } else {
        const currentStatus = this.getTaskStatus(sl.taskId);
        if (currentStatus !== 'leased') {
          actions.push(remediationAction({
            action: 'already_repaired',
            targetId: sl.taskId,
            taskId: sl.taskId,
            type: 'lease_stuck',
            severity: 'warning',
            previousState: currentStatus,
            nextState: currentStatus,
            previousStatus: currentStatus,
            newStatus: currentStatus,
            recommendedAction: 'already_repaired',
            reason: `Task already in ${currentStatus} — no repair needed`,
          }));
          skippedCount++;
          continue;
        }

        this.forceExpireAndMarkRunFailed(sl.taskId);
        repairedCount++;

        actions.push(remediationAction({
          action: 'force_expire_lease',
          targetId: sl.taskId,
          taskId: sl.taskId,
          type: 'lease_stuck',
          severity: 'warning',
          previousState: 'leased',
          nextState: 'pending',
          previousStatus: 'leased',
          newStatus: 'pending',
          recommendedAction: 'force_expire_lease',
          reason: `Task ${sl.taskId} had expired lease (owner: ${sl.leaseOwner ?? 'unknown'}) — force-expired to pending and latest run marked as failed`,
        }));
      }
    }

    // ── 3. Fix orphaned running runs ───────────────────────────────────
    for (const or of orphanedRuns) {
      if (params.dryRun) {
        actions.push(remediationAction({
          action: 'mark_run_failed',
          targetId: or.runId,
          taskId: or.taskId,
          type: 'running_run_stuck',
          severity: 'error',
          previousState: 'running',
          nextState: 'failed',
          previousStatus: 'running',
          newStatus: 'failed',
          recommendedAction: 'mark_run_failed',
          reason: `Run ${or.runId} for task ${or.taskId} is 'running' but task status is ${or.taskStatus ?? 'none'} — would mark run as failed`,
        }));
      } else {
        const currentRunStatus = this.getRunStatus(or.runId);
        if (currentRunStatus !== 'running') {
          actions.push(remediationAction({
            action: 'already_repaired',
            targetId: or.runId,
            taskId: or.taskId,
            type: 'running_run_stuck',
            severity: 'warning',
            previousState: currentRunStatus,
            nextState: currentRunStatus,
            previousStatus: currentRunStatus,
            newStatus: currentRunStatus,
            recommendedAction: 'already_repaired',
            reason: `Run already in ${currentRunStatus} — no repair needed`,
          }));
          skippedCount++;
          continue;
        }

        this.markOrphanedRunFailed(or.runId, or.taskId);
        repairedCount++;

        actions.push(remediationAction({
          action: 'mark_run_failed',
          targetId: or.runId,
          taskId: or.taskId,
          type: 'running_run_stuck',
          severity: 'error',
          previousState: 'running',
          nextState: 'failed',
          previousStatus: 'running',
          newStatus: 'failed',
          recommendedAction: 'mark_run_failed',
          reason: `Run ${or.runId} for task ${or.taskId} was 'running' with task status ${or.taskStatus ?? 'none'} — marked as failed (recovery repair)`,
        }));
      }
    }

    // ── 4. Quarantine malformed run rows ────────────────────────────────
    // Schema-invalid historical run rows block runner recovery (resolveStoreRunId
    // and the mark* completion methods tolerate them at runtime, but they stay
    // in the DB forever without this pass). Quarantine is conservative:
    //   - mark execution_status='failed' + error_category='storage_unavailable'
    //   - NEVER delete the row (preserves audit history)
    //   - NEVER mark as succeeded (would forge a successful run)
    //   - idempotent: rows already 'failed' are skipped
    for (const mr of malformedRuns) {
      if (mr.currentStatus === 'failed') {
        actions.push(remediationAction({
          action: 'already_repaired',
          targetId: mr.runId,
          taskId: mr.taskId,
          type: 'malformed_run_row',
          severity: 'warning',
          previousState: 'failed',
          nextState: 'failed',
          previousStatus: 'failed',
          newStatus: 'failed',
          recommendedAction: 'already_repaired',
          reason: `Malformed run ${mr.runId} already quarantined (failed). Validation error: ${mr.error}`,
        }));
        skippedCount++;
        continue;
      }

      if (params.dryRun) {
        actions.push(remediationAction({
          action: 'quarantine_malformed_run',
          targetId: mr.runId,
          taskId: mr.taskId,
          type: 'malformed_run_row',
          severity: 'warning',
          previousState: mr.currentStatus ?? 'unknown',
          nextState: 'failed',
          previousStatus: mr.currentStatus ?? 'unknown',
          newStatus: 'failed',
          recommendedAction: 'quarantine_malformed_run',
          reason: `Run ${mr.runId} (task ${mr.taskId}) failed schema validation — would quarantine as failed + storage_unavailable. Error: ${mr.error}`,
        }));
      } else {
        this.quarantineMalformedRun(mr.runId, mr.error);
        repairedCount++;

        actions.push(remediationAction({
          action: 'quarantine_malformed_run',
          targetId: mr.runId,
          taskId: mr.taskId,
          type: 'malformed_run_row',
          severity: 'warning',
          previousState: mr.currentStatus ?? 'unknown',
          nextState: 'failed',
          previousStatus: mr.currentStatus ?? 'unknown',
          newStatus: 'failed',
          recommendedAction: 'quarantine_malformed_run',
          reason: `Run ${mr.runId} (task ${mr.taskId}) failed schema validation — quarantined as failed + storage_unavailable. Error: ${mr.error}`,
        }));
      }
    }

    return createRemediationResult({
      mode: params.dryRun ? 'dry_run' : 'confirm',
      repairedCount,
      skippedCount,
      actions,
      warnings,
      generatedAt,
      includeLegacyDryRun: true,
    });
  }

  // ── Detection helpers ─────────────────────────────────────────────────

  private detectBrokenDreamers(): BrokenDreamer[] {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const dreamerTasks = db.prepare(
        "SELECT task_id, diagnostic_json FROM tasks WHERE task_kind = 'dreamer' AND status = 'succeeded'",
      ).all() as { task_id: string; diagnostic_json: string | null }[];

      const piArtifacts = db.prepare(
        "SELECT source_task_id, artifact_kind FROM pi_artifacts WHERE artifact_kind = 'principle'",
      ).all() as { source_task_id: string; artifact_kind: string }[];

      const philosopherTasks = db.prepare(
        "SELECT task_id, diagnostic_json FROM tasks WHERE task_kind = 'philosopher'",
      ).all() as { task_id: string; diagnostic_json: string | null }[];

      const artifactTaskIds = new Set(piArtifacts.map(a => a.source_task_id));

      const philosopherParentIds = new Set<string>();
      for (const pt of philosopherTasks) {
        const meta = extractPIMetadata(pt.diagnostic_json);
        if (meta.status === 'parsed') {
          if (meta.dependencyTaskIds) {
            for (const depId of meta.dependencyTaskIds) {
              philosopherParentIds.add(depId);
            }
          }
          if (meta.parentTaskId) {
            philosopherParentIds.add(meta.parentTaskId);
          }
        } else if (meta.status === 'malformed') {
          for (const id of meta.bestEffortParentIds) {
            philosopherParentIds.add(id);
          }
        }
      }

      const results: BrokenDreamer[] = [];

      for (const dt of dreamerTasks) {
        const hasArtifact = artifactTaskIds.has(dt.task_id);
        const missingArtifact = !hasArtifact;
        const missingSuccessor = !philosopherParentIds.has(dt.task_id);

        if (missingArtifact || missingSuccessor) {
          results.push({
            taskId: dt.task_id,
            missingArtifact,
            missingSuccessor,
            hasArtifact,
          });
        }
      }

      return results;
    } finally {
      db.close();
    }
  }

  /**
   * Detect tasks that are still 'leased' with an expired lease.
   * These are tasks where the lease owner crashed or the runner failed
   * before releasing/renewing the lease.
   */
  private detectStuckLeases(): StuckLease[] {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const leasedTasks = db.prepare(
        "SELECT task_id, lease_owner, lease_expires_at FROM tasks WHERE status = 'leased'",
      ).all() as { task_id: string; lease_owner: string | null; lease_expires_at: string | null }[];

      const now = Date.now();
      const results: StuckLease[] = [];

      for (const t of leasedTasks) {
        if (!t.lease_expires_at) {
          results.push({
            taskId: t.task_id,
            leaseOwner: t.lease_owner,
            leaseExpiresAt: null,
            isSafe: false,
            reason: `Task ${t.task_id} is leased but lease_expires_at is missing/null`,
          });
          continue;
        }
        const expiresAt = new Date(t.lease_expires_at).getTime();
        if (Number.isNaN(expiresAt)) {
          results.push({
            taskId: t.task_id,
            leaseOwner: t.lease_owner,
            leaseExpiresAt: t.lease_expires_at,
            isSafe: false,
            reason: `Task ${t.task_id} is leased but lease_expires_at '${t.lease_expires_at}' is unparseable`,
          });
          continue;
        }
        if (expiresAt < now) {
          results.push({
            taskId: t.task_id,
            leaseOwner: t.lease_owner,
            leaseExpiresAt: t.lease_expires_at,
            isSafe: true,
          });
        }
      }

      return results;
    } finally {
      db.close();
    }
  }

  /**
   * Detect runs that are 'running' but their owning task is no longer
   * in 'leased' state. These are orphan runs from crashed/completed
   * runners that didn't properly close the run record.
   */
  private detectOrphanedRuns(): OrphanedRun[] {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const runningRuns = db.prepare(
        "SELECT run_id, task_id FROM runs WHERE execution_status = 'running'",
      ).all() as { run_id: string; task_id: string }[];

      const results: OrphanedRun[] = [];

      for (const run of runningRuns) {
        const taskRow = db.prepare(
          'SELECT status FROM tasks WHERE task_id = ?',
        ).get(run.task_id) as { status: string } | undefined;

        if (!taskRow) {
          // Task no longer exists — definitely a stuck run
          results.push({
            runId: run.run_id,
            taskId: run.task_id,
            taskExists: false,
            taskStatus: null,
          });
        } else if (taskRow.status !== 'leased') {
          // Task is no longer leased but run is still 'running'
          results.push({
            runId: run.run_id,
            taskId: run.task_id,
            taskExists: true,
            taskStatus: taskRow.status,
          });
        }
        // If task is still 'leased', the run might be legitimate — skip
      }

      return results;
    } finally {
      db.close();
    }
  }

  /**
   * Detect run rows that fail TypeBox schema validation against
   * RunRecordSchema — the exact failure mode that throws MalformedRunError
   * from SqliteRunStore and historically blocked runner recovery.
   *
   * Detection reuses SqliteRunStore.rowToRecord() (the SAME validation used
   * by production reads — EP-01: no duplicated schema logic that can drift).
   * rowToRecord throws PDRuntimeError{storage_unavailable} for invalid rows;
   * we capture the validation message.
   */
  private detectMalformedRuns(): MalformedRun[] {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT * FROM runs').all() as Record<string, unknown>[];
      const results: MalformedRun[] = [];
      for (const row of rows) {
        try {
          SqliteRunStore.rowToRecord(row);
        } catch (err) {
          // rowToRecord throws PDRuntimeError{storage_unavailable} for invalid rows.
          const runId = typeof row.run_id === 'string' ? row.run_id : String(row.run_id ?? 'unknown');
          const taskId = typeof row.task_id === 'string' ? row.task_id : String(row.task_id ?? 'unknown');
          const executionStatus = typeof row.execution_status === 'string' ? row.execution_status : null;
          const msg = err instanceof Error ? err.message : String(err);
          results.push({
            runId,
            taskId,
            error: msg,
            currentStatus: executionStatus,
          });
        }
      }
      return results;
    } finally {
      db.close();
    }
  }

  // ── State readers ─────────────────────────────────────────────────────

  // Get current task status from DB
  private getTaskStatus(taskId: string): string {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as { status: string } | undefined;
      return row?.status ?? 'unknown';
    } finally {
      db.close();
    }
  }

  // Get current run execution status from DB
  private getRunStatus(runId: string): string {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT execution_status FROM runs WHERE run_id = ?').get(runId) as { execution_status: string } | undefined;
      return row?.execution_status ?? 'unknown';
    } finally {
      db.close();
    }
  }

  // ── Mutators ──────────────────────────────────────────────────────────

  private requeueTask(taskId: string): void {
    const db = new Database(this.dbPath);
    try {
      db.prepare(
        `UPDATE tasks SET status = 'retry_wait', attempt_count = 0, lease_owner = NULL, lease_expires_at = NULL, result_ref = NULL, updated_at = datetime('now') WHERE task_id = ?`,
      ).run(taskId);
    } finally {
      db.close();
    }
  }

  /**
   * Force-expire a stuck lease: set task to 'pending' and mark the latest
   * running run as 'failed' with a reason.
   */
  private forceExpireAndMarkRunFailed(taskId: string): void {
    const db = new Database(this.dbPath);
    try {
      const tx = db.transaction(() => {
        // Reset task to pending (force-expire lease)
        db.prepare(`
          UPDATE tasks
          SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = datetime('now')
          WHERE task_id = ?
        `).run(taskId);

        // Mark the latest run as failed
        const latestRun = db.prepare(
          `SELECT run_id FROM runs WHERE task_id = ? AND execution_status = 'running' ORDER BY started_at DESC LIMIT 1`,
        ).get(taskId) as { run_id: string } | undefined;

        if (latestRun) {
          const now = new Date().toISOString();
          db.prepare(`
            UPDATE runs
            SET execution_status = 'failed', ended_at = ?, reason = ?, error_category = ?
            WHERE run_id = ?
          `).run(now, 'Lease expired — force-expired by integrity-repair', 'lease_expired', latestRun.run_id);
        }
      });

      tx();
    } finally {
      db.close();
    }
  }

  /**
   * Mark an orphaned running run as 'failed'. When the owning task still
   * exists and is in a terminal/failed/retry_wait state, the run should
   * reflect the terminal outcome.
   */
  private markOrphanedRunFailed(runId: string, _taskId: string): void {
    const db = new Database(this.dbPath);
    try {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE runs
        SET execution_status = 'failed', ended_at = ?, reason = ?, error_category = ?
        WHERE run_id = ?
      `).run(now, `Orphaned run — recovered by integrity-repair (task not leased)`, 'recovery_sweep', runId);
    } finally {
      db.close();
    }
  }

  /**
   * Quarantine a schema-malformed run row: mark it failed + storage_unavailable.
   *
   * Conservative by design:
   *   - NEVER deletes the row (audit history preserved)
   *   - NEVER marks as succeeded (would forge a successful run)
   *   - The reason records the validation error so operators can trace root cause
   */
  private quarantineMalformedRun(runId: string, validationError: string): void {
    const db = new Database(this.dbPath);
    try {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE runs
        SET execution_status = 'failed', ended_at = ?, reason = ?, error_category = ?
        WHERE run_id = ?
      `).run(
        now,
        `Malformed run row quarantined by integrity-repair. Validation error: ${validationError}`,
        'storage_unavailable',
        runId,
      );
    } finally {
      db.close();
    }
  }

  // ── Successor helpers (unchanged) ──────────────────────────────────────

  private findExistingSuccessor(dreamerTaskId: string): string | null {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const philosopherTasks = db.prepare(
        "SELECT task_id, diagnostic_json FROM tasks WHERE task_kind = 'philosopher'",
      ).all() as { task_id: string; diagnostic_json: string | null }[];

      for (const pt of philosopherTasks) {
        const meta = extractPIMetadata(pt.diagnostic_json);
        if (meta.status === 'parsed') {
          if (meta.dependencyTaskIds?.includes(dreamerTaskId) || meta.parentTaskId === dreamerTaskId) {
            return pt.task_id;
          }
        } else if (meta.status === 'malformed') {
          if (meta.bestEffortParentIds.includes(dreamerTaskId)) {
            return pt.task_id;
          }
        }
      }

      const successorTaskId = `philosopher-${dreamerTaskId}-prompt`;
      const existing = db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(successorTaskId) as { task_id: string } | undefined;
      if (existing) {
        return existing.task_id;
      }

      return null;
    } finally {
      db.close();
    }
  }

  private createPhilosopherSuccessor(dreamerTaskId: string): string {
    const db = new Database(this.dbPath);
    try {
      const successorTaskId = `philosopher-${dreamerTaskId}-prompt`;

      const artifactRow = db.prepare(
        "SELECT artifact_id FROM pi_artifacts WHERE source_task_id = ? AND artifact_kind = 'principle' LIMIT 1",
      ).get(dreamerTaskId) as { artifact_id: string } | undefined;

      const metadata = {
        dependencyTaskIds: [dreamerTaskId],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: artifactRow ? [{ artifactId: artifactRow.artifact_id, kind: 'principle' }] : [],
        outputArtifactRefs: [],
        parentTaskId: dreamerTaskId,
      };

      db.prepare(
        `INSERT OR IGNORE INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, input_ref, diagnostic_json, created_at, updated_at)
         VALUES (?, 'philosopher', 'pending', 0, 3, ?, ?, datetime('now'), datetime('now'))`,
      ).run(successorTaskId, artifactRow?.artifact_id ?? null, JSON.stringify(metadata));

      return successorTaskId;
    } finally {
      db.close();
    }
  }
}