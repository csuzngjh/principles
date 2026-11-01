import type { SqliteConnection } from '../sqlite-connection.js';
import type { TaskRecord } from '../../task-status.js';
import type { ActivationStatusRecord, PIArtifactSnapshot } from '../../activation/activation-types.js';

/** The family CAS reuses task metadata/epochs; no second revision ledger. */
export function reopenApprovedRuleInConnection(connection: SqliteConnection, input: {
  activation: ActivationStatusRecord;
  artifact: PIArtifactSnapshot;
  approvalId: string;
  artifactDigest: string;
  controlVersion: number;
  tasks: readonly TaskRecord[];
  artificerTaskId: string;
  diagnosticJson: string;
}): boolean {
  const db = connection.getDb();
  return db.transaction(() => {
    const { activation } = input;
    if (!db.prepare(`SELECT 1 FROM activations WHERE activation_id = ? AND artifact_id = ?
      AND channel = 'code_tool_hook' AND action = 'code_tool_hook_shadow_activate'
      AND deactivated_at IS NULL AND promoted_at IS NULL AND activated_at = ?`)
      .get(activation.activationId, input.artifact.artifactId, activation.activatedAt)) return false;
    if (!db.prepare(`SELECT 1 FROM approvals WHERE approval_id = ? AND artifact_id = ?
      AND channel = 'code_tool_hook' AND status = 'approved' AND artifact_digest = ?`)
      .get(input.approvalId, input.artifact.artifactId, input.artifactDigest)) return false;
    if (!db.prepare(`SELECT 1 FROM activation_control_states WHERE activation_id = ? AND version = ?`)
      .get(activation.activationId, input.controlVersion)) return false;
    const { artifact } = input;
    if (!db.prepare(`SELECT 1 FROM pi_artifacts WHERE artifact_id = ? AND artifact_kind = ?
      AND source_task_id = ? AND source_principle_id IS ? AND source_rule_id IS ?
      AND lineage_artifact_ids = ? AND validation_status = ? AND content_json = ?
      AND created_at = ? AND updated_at = ?`)
      .get(artifact.artifactId, artifact.artifactKind, artifact.sourceTaskId, artifact.sourcePrincipleId ?? null,
        artifact.sourceRuleId ?? null, JSON.stringify(artifact.lineageArtifactIds), artifact.validationStatus,
        artifact.contentJson, artifact.createdAt, artifact.updatedAt)) return false;
    for (const task of input.tasks) {
      if (!db.prepare(`SELECT 1 FROM tasks WHERE task_id = ? AND task_kind = ? AND status = ?
        AND diagnostic_json IS ? AND attempt_count = ? AND max_attempts = ?
        AND lease_owner IS ? AND lease_expires_at IS ? AND result_ref IS ?`)
        .get(task.taskId, task.taskKind, task.status, task.diagnosticJson ?? null, task.attemptCount,
          task.maxAttempts, task.leaseOwner ?? null, task.leaseExpiresAt ?? null, task.resultRef ?? null)) return false;
    }
    // Only the entry stage is runnable. Existing revision-wave continuation
    // reopens Evaluator and Rollout after their new dependencies succeed.
    return db.prepare(`UPDATE tasks SET diagnostic_json = ?, status = 'pending', attempt_count = 0,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE task_id = ?`)
      .run(input.diagnosticJson, new Date().toISOString(), input.artificerTaskId).changes === 1;
  }).immediate();
}
