/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-06 (review round-3 P1): atomic diagnostician
 * family reopen — one SQLite transaction re-opens the parent diagnostician
 * task and all existing stage tasks. A LIVE lease on any member aborts the
 * whole reopen (rollback; the running diagnosis wins). Store-owned SQL (PRI-47).
 */
import type { SqliteConnection } from '../sqlite-connection.js';

export interface FamilyReopenInput {
  readonly parentTaskId: string;
  readonly stageTaskIds: readonly string[];
  readonly parentPatch: { diagnosticJson?: string };
}

export function reopenDiagnosticianFamilyInConnection(
  connection: SqliteConnection,
  input: FamilyReopenInput,
): { reopened: boolean; leased: string[] } {
  const db = connection.getDb();
  const ids = [input.parentTaskId, ...input.stageTaskIds];
  const leased: string[] = [];
  const apply = db.transaction((): boolean => {
    const nowIso = new Date().toISOString();
    for (const taskId of ids) {
      const row = db.prepare('SELECT status, lease_owner FROM tasks WHERE task_id = ?').get(taskId) as { status: string; lease_owner: string | null } | undefined;
      if (row === undefined) continue; // stage not created (flat pipeline)
      // Only the status machine's `leased` state is a LIVE lease — stale
      // lease_owner residue on a failed/retry_wait row is not one.
      if (row.status === 'leased') leased.push(taskId);
    }
    if (leased.length > 0) return false; // rollback: a live diagnosis owns a member
    for (const taskId of ids) {
      const exists = db.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(taskId);
      if (exists === undefined) continue;
      if (taskId === input.parentTaskId) {
        db.prepare("UPDATE tasks SET status = 'pending', attempt_count = 0, updated_at = ?, diagnostic_json = COALESCE(?, diagnostic_json) WHERE task_id = ?")
          .run(nowIso, input.parentPatch.diagnosticJson ?? null, taskId);
      } else {
        db.prepare("UPDATE tasks SET status = 'pending', attempt_count = 0, updated_at = ? WHERE task_id = ?")
          .run(nowIso, taskId);
      }
    }
    return true;
  });
  const reopened = apply.immediate();
  return { reopened, leased };
}
