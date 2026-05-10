import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

export interface BrokenLink {
  type: string;
  severity: 'warning' | 'error';
  taskId?: string;
  candidateId?: string;
  artifactId?: string;
  reason: string;
  recommendedAction: string;
}

export interface ChainIntegrityResult {
  overallStatus: 'ok' | 'degraded' | 'error';
  brokenLinks: BrokenLink[];
  chainSummaries: {
    totalCandidates: number;
    totalDreamerTasks: number;
    totalPhilosopherTasks: number;
    totalPIArtifacts: number;
    chainsWithBrokenLinks: number;
  };
  generatedAt: string;
}

export interface InternalizationChainIntegrityReadModelOptions {
  workspaceDir: string;
}

export class InternalizationChainIntegrityReadModel {
  private readonly dbPath: string;

  constructor(opts: InternalizationChainIntegrityReadModelOptions) {
    this.dbPath = path.join(opts.workspaceDir, '.pd', 'state.db');
  }

  check(): ChainIntegrityResult {
    const generatedAt = new Date().toISOString();
    const brokenLinks: BrokenLink[] = [];

    if (!fs.existsSync(this.dbPath)) {
      return {
        overallStatus: 'error',
        brokenLinks: [{
          type: 'database_missing',
          severity: 'error',
          reason: 'state.db does not exist',
          recommendedAction: 'Initialize workspace with a writable SqliteConnection.',
        }],
        chainSummaries: {
          totalCandidates: 0,
          totalDreamerTasks: 0,
          totalPhilosopherTasks: 0,
          totalPIArtifacts: 0,
          chainsWithBrokenLinks: 0,
        },
        generatedAt,
      };
    }

    let db: Database.Database | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true } as Database.Options);

      const consumedCandidates = db.prepare(
        "SELECT candidate_id, task_id, source_run_id FROM principle_candidates WHERE status = 'consumed'"
      ).all() as { candidate_id: string; task_id: string; source_run_id: string }[];

      const allTasks = db.prepare(
        'SELECT task_id, task_kind, status, result_ref, lease_owner, lease_expires_at, attempt_count, max_attempts, diagnostic_json FROM tasks'
      ).all() as { task_id: string; task_kind: string; status: string; result_ref: string | null; lease_owner: string | null; lease_expires_at: string | null; attempt_count: number; max_attempts: number; diagnostic_json: string | null }[];

      const allRuns = db.prepare(
        'SELECT run_id, task_id, execution_status FROM runs'
      ).all() as { run_id: string; task_id: string; execution_status: string }[];

      const piArtifacts = db.prepare(
        'SELECT artifact_id, artifact_kind, source_task_id FROM pi_artifacts'
      ).all() as { artifact_id: string; artifact_kind: string; source_task_id: string }[];

      const taskMap = new Map(allTasks.map(t => [t.task_id, t]));
      const runsByTask = new Map<string, { run_id: string; execution_status: string }[]>();
      for (const run of allRuns) {
        const list = runsByTask.get(run.task_id) ?? [];
        list.push(run);
        runsByTask.set(run.task_id, list);
      }

      const dreamerTasks = allTasks.filter(t => t.task_kind === 'dreamer');
      const philosopherTasks = allTasks.filter(t => t.task_kind === 'philosopher');

      for (const candidate of consumedCandidates) {
        const hasAnyDreamerForCandidate = dreamerTasks.some(dt => {
          try {
            const diag = dt.diagnostic_json ? JSON.parse(dt.diagnostic_json) : null;
            return diag?.candidateId === candidate.candidate_id;
          } catch {
            return false;
          }
        }) || dreamerTasks.some(dt => dt.task_id === candidate.task_id);

        if (!hasAnyDreamerForCandidate) {
          brokenLinks.push({
            type: 'missing_dreamer_task',
            severity: 'warning',
            candidateId: candidate.candidate_id,
            reason: `Consumed candidate ${candidate.candidate_id} has no corresponding dreamer task`,
            recommendedAction: 'Seed a dreamer task via `pd candidate internalize --candidate-id <id>`.',
          });
        }
      }

      for (const dreamerTask of dreamerTasks) {
        if (dreamerTask.status !== 'succeeded') continue;

        const hasDreamerArtifact = piArtifacts.some(
          a => a.source_task_id === dreamerTask.task_id && a.artifact_kind === 'dreamer_pi'
        );
        if (!hasDreamerArtifact) {
          brokenLinks.push({
            type: 'missing_dreamer_pi_artifact',
            severity: 'error',
            taskId: dreamerTask.task_id,
            reason: `Succeeded dreamer task ${dreamerTask.task_id} has no dreamer_pi artifact`,
            recommendedAction: 'Re-run the dreamer task or investigate artifact commit failure.',
          });
        }

        const hasPhilosopherSuccessor = philosopherTasks.some(pt => {
          try {
            const diag = pt.diagnostic_json ? JSON.parse(pt.diagnostic_json) : null;
            return diag?.parentTaskId === dreamerTask.task_id || diag?.dependencyTaskIds?.includes(dreamerTask.task_id);
          } catch {
            return false;
          }
        });
        if (!hasPhilosopherSuccessor) {
          brokenLinks.push({
            type: 'missing_philosopher_successor',
            severity: 'warning',
            taskId: dreamerTask.task_id,
            reason: `Succeeded dreamer task ${dreamerTask.task_id} has no philosopher successor task`,
            recommendedAction: 'Check orchestrator successor proposal logic or manually enqueue philosopher task.',
          });
        }
      }

      for (const philosopherTask of philosopherTasks) {
        if (philosopherTask.status === 'pending' || philosopherTask.status === 'leased') {
          let hasDreamerDependency = false;
          try {
            const diag = philosopherTask.diagnostic_json ? JSON.parse(philosopherTask.diagnostic_json) : null;
            if (diag?.dependencyTaskIds?.length > 0) {
              hasDreamerDependency = diag.dependencyTaskIds.some((id: string) => taskMap.has(id) && taskMap.get(id)?.task_kind === 'dreamer');
            }
          } catch { /* skip */ }

          if (!hasDreamerDependency) {
            const dreamerArtifacts = piArtifacts.filter(
              a => a.artifact_kind === 'dreamer_pi'
            );
            if (dreamerArtifacts.length === 0) {
              brokenLinks.push({
                type: 'philosopher_missing_dreamer_artifact',
                severity: 'warning',
                taskId: philosopherTask.task_id,
                reason: `Philosopher task ${philosopherTask.task_id} cannot find dreamer artifact dependency`,
                recommendedAction: 'Ensure dreamer tasks have completed and committed artifacts before philosopher runs.',
              });
            }
          }
        }
      }

      for (const task of allTasks) {
        if (task.status === 'succeeded' && task.result_ref) {
          const ref = task.result_ref;
          if (!ref.includes('://')) {
            const artifactExists = db.prepare(
              'SELECT artifact_id FROM artifacts WHERE artifact_id = ?'
            ).get(ref);
            if (!artifactExists) {
              brokenLinks.push({
                type: 'result_ref_missing_artifact',
                severity: 'error',
                taskId: task.task_id,
                artifactId: ref,
                reason: `Task ${task.task_id} result_ref ${ref} does not exist in artifacts table`,
                recommendedAction: 'Investigate artifact commit failure or data corruption.',
              });
            }
          }
        }

        if (task.status === 'succeeded') {
          const taskRuns = runsByTask.get(task.task_id) ?? [];
          const hasSucceededRun = taskRuns.some(r => r.execution_status === 'succeeded');
          if (!hasSucceededRun) {
            brokenLinks.push({
              type: 'task_succeeded_no_succeeded_run',
              severity: 'error',
              taskId: task.task_id,
              reason: `Task ${task.task_id} is succeeded but has no succeeded run`,
              recommendedAction: 'Investigate task/run state inconsistency. Consider recovery sweep.',
            });
          }
        }

        if (task.status === 'leased' && task.lease_expires_at) {
          const expiresAt = new Date(task.lease_expires_at).getTime();
          if (expiresAt < Date.now()) {
            brokenLinks.push({
              type: 'lease_stuck',
              severity: 'warning',
              taskId: task.task_id,
              reason: `Task ${task.task_id} is leased but lease expired at ${task.lease_expires_at}`,
              recommendedAction: 'Run recovery sweep or manually release the lease.',
            });
          }
        }

        if (task.status === 'retry_wait' && task.attempt_count >= task.max_attempts) {
          brokenLinks.push({
            type: 'retry_wait_exceeded',
            severity: 'warning',
            taskId: task.task_id,
            reason: `Task ${task.task_id} in retry_wait with attempt_count=${task.attempt_count} >= max_attempts=${task.max_attempts}`,
            recommendedAction: 'Investigate persistent failure. Consider marking as failed or increasing max_attempts.',
          });
        }
      }

      const idempotencyMap = new Map<string, number>();
      for (const a of piArtifacts) {
        const key = `${a.source_task_id}:${a.artifact_kind}`;
        idempotencyMap.set(key, (idempotencyMap.get(key) ?? 0) + 1);
      }
      for (const [key, count] of idempotencyMap) {
        if (count > 1) {
          const [sourceTaskId, artifactKind] = key.split(':');
          brokenLinks.push({
            type: 'pi_artifact_duplicate',
            severity: 'warning',
            reason: `Duplicate PI artifact: source_task_id=${sourceTaskId}, artifact_kind=${artifactKind} appears ${count} times`,
            recommendedAction: 'Investigate idempotency violation in artifact commit logic.',
          });
        }
      }

      const affectedEntities = new Set<string>();
      for (const link of brokenLinks) {
        if (link.taskId) affectedEntities.add(link.taskId);
        if (link.candidateId) affectedEntities.add(link.candidateId);
      }

      const hasErrorLinks = brokenLinks.some(l => l.severity === 'error');
      const hasWarningLinks = brokenLinks.some(l => l.severity === 'warning');

      let overallStatus: 'ok' | 'degraded' | 'error' = 'ok';
      if (hasErrorLinks) overallStatus = 'error';
      else if (hasWarningLinks) overallStatus = 'degraded';

      return {
        overallStatus,
        brokenLinks,
        chainSummaries: {
          totalCandidates: consumedCandidates.length,
          totalDreamerTasks: dreamerTasks.length,
          totalPhilosopherTasks: philosopherTasks.length,
          totalPIArtifacts: piArtifacts.length,
          chainsWithBrokenLinks: affectedEntities.size,
        },
        generatedAt,
      };
    } catch {
      return {
        overallStatus: 'error',
        brokenLinks: [{
          type: 'database_read_error',
          severity: 'error',
          reason: 'Failed to read state.db for chain integrity check',
          recommendedAction: 'Verify database file integrity and permissions.',
        }],
        chainSummaries: {
          totalCandidates: 0,
          totalDreamerTasks: 0,
          totalPhilosopherTasks: 0,
          totalPIArtifacts: 0,
          chainsWithBrokenLinks: 0,
        },
        generatedAt,
      };
    } finally {
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
    }
  }
}
