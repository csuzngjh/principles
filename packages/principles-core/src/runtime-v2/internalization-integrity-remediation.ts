import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { extractPIMetadata } from './internalization-chain-integrity-read-model.js';
import { createRemediationResult, remediationAction } from './remediation-contract.js';
import type { RemediationAction, RemediationResult } from './remediation-contract.js';

export interface InternalizationIntegrityRemediationOptions {
  workspaceDir: string;
}

interface BrokenDreamer {
  taskId: string;
  missingArtifact: boolean;
  missingSuccessor: boolean;
  hasArtifact: boolean;
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

    const actions: RemediationAction[] = [];
    let repairedCount = 0;
    let skippedCount = 0;

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

    return createRemediationResult({
      mode: params.dryRun ? 'dry_run' : 'confirm',
      repairedCount,
      skippedCount,
      actions,
      generatedAt,
      includeLegacyDryRun: true,
    });
  }

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

  private getTaskStatus(taskId: string): string {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as { status: string } | undefined;
      return row?.status ?? 'unknown';
    } finally {
      db.close();
    }
  }

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
