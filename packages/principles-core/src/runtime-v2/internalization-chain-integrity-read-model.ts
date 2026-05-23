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

export function extractPIMetadata(diagJson: string | null): { parentTaskId?: string; dependencyTaskIds?: string[] } {
  if (!diagJson) return {};
  try {
    const parsed: unknown = JSON.parse(diagJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const meta = Object.hasOwn(parsed, 'pi_metadata') ? (parsed as Record<string, unknown>).pi_metadata : parsed;
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return {};
    const metaObj = meta as Record<string, unknown>;
    const result: { parentTaskId?: string; dependencyTaskIds?: string[] } = {};
    if (Object.hasOwn(metaObj, 'parentTaskId') && typeof metaObj.parentTaskId === 'string') {
      result.parentTaskId = metaObj.parentTaskId;
    }
    if (Object.hasOwn(metaObj, 'dependencyTaskIds') && Array.isArray(metaObj.dependencyTaskIds)) {
      const validated = metaObj.dependencyTaskIds.filter((id: unknown): id is string => typeof id === 'string');
      if (validated.length > 0) {
        result.dependencyTaskIds = validated;
      }
    }
    return result;
  } catch {
    return {};
  }
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
      db = new Database(this.dbPath, { readonly: true });

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
          a => a.source_task_id === dreamerTask.task_id && a.artifact_kind === 'principle'
        );
        if (!hasDreamerArtifact) {
          brokenLinks.push({
            type: 'missing_dreamer_pi_artifact',
            severity: 'error',
            taskId: dreamerTask.task_id,
            reason: `Succeeded dreamer task ${dreamerTask.task_id} has no principle artifact`,
            recommendedAction: 'Re-run the dreamer task or investigate artifact commit failure.',
          });
        }

        const hasPhilosopherSuccessor = philosopherTasks.some(pt => {
          const meta = extractPIMetadata(pt.diagnostic_json);
          return meta.parentTaskId === dreamerTask.task_id || meta.dependencyTaskIds?.includes(dreamerTask.task_id);
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
          const philMeta = extractPIMetadata(philosopherTask.diagnostic_json);
          if (philMeta.dependencyTaskIds && philMeta.dependencyTaskIds.length > 0) {
            hasDreamerDependency = philMeta.dependencyTaskIds.some((id: string) => taskMap.has(id) && taskMap.get(id)?.task_kind === 'dreamer');
          }

          if (!hasDreamerDependency) {
            const candidateForPhilosopher = consumedCandidates.find(c => c.task_id === philosopherTask.task_id);
            if (candidateForPhilosopher) {
              const dreamerForCandidate = dreamerTasks.find(dt => {
                try {
                  const diag = dt.diagnostic_json ? JSON.parse(dt.diagnostic_json) : null;
                  return diag?.candidateId === candidateForPhilosopher.candidate_id;
                } catch {
                  return false;
                }
              });
              if (dreamerForCandidate) {
                const hasDreamerPi = piArtifacts.some(
                  a => a.source_task_id === dreamerForCandidate.task_id && a.artifact_kind === 'principle'
                );
                if (!hasDreamerPi) {
                  brokenLinks.push({
                    type: 'philosopher_missing_dreamer_artifact',
                    severity: 'warning',
                    taskId: philosopherTask.task_id,
                    reason: `Philosopher task ${philosopherTask.task_id} depends on dreamer task ${dreamerForCandidate.task_id} which has no principle artifact`,
                    recommendedAction: 'Ensure dreamer task has completed and committed artifacts before philosopher runs.',
                  });
                }
              } else {
                brokenLinks.push({
                  type: 'philosopher_missing_dreamer_artifact',
                  severity: 'warning',
                  taskId: philosopherTask.task_id,
                  reason: `Philosopher task ${philosopherTask.task_id} has no dreamer task for candidate ${candidateForPhilosopher.candidate_id}`,
                  recommendedAction: 'Seed a dreamer task for the candidate before philosopher runs.',
                });
              }
            } else {
              brokenLinks.push({
                type: 'philosopher_dependency_unverifiable',
                severity: 'warning',
                taskId: philosopherTask.task_id,
                reason: `Philosopher task ${philosopherTask.task_id} has no dependencyTaskIds and no candidate link; dependency chain unverifiable`,
                recommendedAction: 'Add dependencyTaskIds to diagnostic_json or verify candidate linkage.',
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
          if (Number.isNaN(expiresAt) || expiresAt < Date.now()) {
            const reasonSuffix = Number.isNaN(expiresAt)
              ? `has unparseable lease_expires_at: ${task.lease_expires_at}`
              : `lease expired at ${task.lease_expires_at}`;
            brokenLinks.push({
              type: 'lease_stuck',
              severity: 'warning',
              taskId: task.task_id,
              reason: `Task ${task.task_id} is leased but ${reasonSuffix}`,
              recommendedAction: Number.isNaN(expiresAt)
                ? 'Fix the unparseable lease_expires_at timestamp or manually release the lease.'
                : 'Run recovery sweep or manually release the lease.',
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
