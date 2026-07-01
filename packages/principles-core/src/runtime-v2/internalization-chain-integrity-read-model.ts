import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { MVP_ENABLED_CHANNELS, ROUTE_CHANNEL_MAP, CANDIDATE_KIND_TO_ROUTE } from './internalization/intake-to-internalization-bridge.js';
import { DEFAULT_RETRY_WAIT_STALE_TTL_MS } from './internalization/internalization-task-guards.js';
import { assertMainlineContract, type MainlineSnapshot } from './mainline-contract.js';

export interface BrokenLink {
  type: string;
  severity: 'warning' | 'error';
  taskId?: string;
  candidateId?: string;
  artifactId?: string;
  runId?: string;
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
  /** Optional pre-assembled mainline snapshot. When provided, its contract verdict is merged into brokenLinks. */
  mainlineSnapshot?: MainlineSnapshot;
}

function readOwnProperty(obj: object, key: string): unknown {
  if (Object.hasOwn(obj, key)) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

export type PIMetadataParseResult =
  | { status: 'missing' }
  | {
      status: 'parsed';
      parentTaskId?: string;
      dependencyTaskIds?: string[];
    }
  | {
      status: 'malformed';
      reason: string;
      bestEffortParentIds: string[];
    };

const REASON_MAX_LENGTH = 120;

function truncateReason(raw: string): string {
  if (raw.length <= REASON_MAX_LENGTH) return raw;
  return raw.slice(0, REASON_MAX_LENGTH - 3) + '...';
}

function safeJsonParse(json: string): { status: 'ok'; value: unknown } | { status: 'malformed'; reason: string } {
  try {
    return { status: 'ok', value: JSON.parse(json) };
  } catch {
    return { status: 'malformed', reason: truncateReason('diagnosticJson is not valid JSON') };
  }
}

function extractBestEffortParentIds(meta: object): string[] {
  const ids: string[] = [];
  const parentTaskId = readOwnProperty(meta, 'parentTaskId');
  if (typeof parentTaskId === 'string') {
    ids.push(parentTaskId);
  }
  const depIds = readOwnProperty(meta, 'dependencyTaskIds');
  if (Array.isArray(depIds)) {
    for (const id of depIds) {
      if (typeof id === 'string') {
        ids.push(id);
      }
    }
  }
  return ids;
}

export function extractPIMetadata(diagJson: string | null): PIMetadataParseResult {
  if (!diagJson) return { status: 'missing' };

  const parsed = safeJsonParse(diagJson);
  if (parsed.status === 'malformed') return { ...parsed, bestEffortParentIds: [] };

  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { status: 'malformed', reason: truncateReason('diagnosticJson parsed to non-object'), bestEffortParentIds: [] };
  }

  let meta: object = parsed.value;
  const piMeta = readOwnProperty(parsed.value, 'pi_metadata');
  if (piMeta !== undefined) {
    if (typeof piMeta !== 'object' || piMeta === null || Array.isArray(piMeta)) {
      const bestEffort = extractBestEffortParentIds(parsed.value);
      return { status: 'malformed', reason: truncateReason('pi_metadata is not an object'), bestEffortParentIds: bestEffort };
    }
    meta = piMeta;
  }

  const parentTaskId = readOwnProperty(meta, 'parentTaskId');
  const depIds = readOwnProperty(meta, 'dependencyTaskIds');

  if (parentTaskId !== undefined && typeof parentTaskId !== 'string') {
    const bestEffort = extractBestEffortParentIds(meta);
    return { status: 'malformed', reason: truncateReason('parentTaskId is not a string'), bestEffortParentIds: bestEffort };
  }

  if (depIds !== undefined) {
    if (!Array.isArray(depIds)) {
      const bestEffort = extractBestEffortParentIds(meta);
      return { status: 'malformed', reason: truncateReason('dependencyTaskIds is not an array'), bestEffortParentIds: bestEffort };
    }
    for (let i = 0; i < depIds.length; i++) {
      if (typeof depIds[i] !== 'string') {
        const bestEffort = extractBestEffortParentIds(meta);
        return { status: 'malformed', reason: truncateReason('dependencyTaskIds contains non-string element'), bestEffortParentIds: bestEffort };
      }
    }
  }

  if (parentTaskId === undefined && depIds === undefined) {
    return { status: 'missing' };
  }

  const result: { status: 'parsed'; parentTaskId?: string; dependencyTaskIds?: string[] } = { status: 'parsed' };
  if (typeof parentTaskId === 'string') {
    result.parentTaskId = parentTaskId;
  }
  if (Array.isArray(depIds)) {
    const validatedDependencyTaskIds: string[] = [];
    for (const id of depIds) {
      if (typeof id === 'string') {
        validatedDependencyTaskIds.push(id);
      }
    }
    if (validatedDependencyTaskIds.length > 0) {
      result.dependencyTaskIds = validatedDependencyTaskIds;
    }
  }
  return result;
}

export class InternalizationChainIntegrityReadModel {
  private readonly dbPath: string;
  private readonly mainlineSnapshot?: MainlineSnapshot;

  constructor(opts: InternalizationChainIntegrityReadModelOptions) {
    this.dbPath = path.join(opts.workspaceDir, '.pd', 'state.db');
    this.mainlineSnapshot = opts.mainlineSnapshot;
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
        "SELECT candidate_id, task_id, source_run_id, recommendation_kind FROM principle_candidates WHERE status = 'consumed'"
      ).all() as { candidate_id: string; task_id: string; source_run_id: string; recommendation_kind: string | null }[];

      // Recommendation kinds that do NOT require internalization — they are correctly
      // absent from the internalization pipeline by design (see internalization-route.ts).
      // Defect-004 fix: 'implementation' routes to 'implementation-candidate' which
      // is consumed by the evaluator/scribe path directly, not via dreamer. Treating
      // it as missing-dreamer was a false positive (7 of 18 reported candidates).
      const NON_INTERNALIZABLE_KINDS = new Set(['defer', 'implementation']);

      const allTasks = db.prepare(
        'SELECT task_id, task_kind, status, result_ref, lease_owner, lease_expires_at, attempt_count, max_attempts, diagnostic_json, updated_at FROM tasks'
      ).all() as { task_id: string; task_kind: string; status: string; result_ref: string | null; lease_owner: string | null; lease_expires_at: string | null; attempt_count: number; max_attempts: number; diagnostic_json: string | null; updated_at: string }[];

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
      const runIdSet = new Set(allRuns.map(r => r.run_id));
      const piArtifactIdSet = new Set(piArtifacts.map(a => a.artifact_id));

      const dreamerTasks = allTasks.filter(t => t.task_kind === 'dreamer');
      const philosopherTasks = allTasks.filter(t => t.task_kind === 'philosopher');

      for (const candidate of consumedCandidates) {
        if (candidate.recommendation_kind && NON_INTERNALIZABLE_KINDS.has(candidate.recommendation_kind)) {
          continue;
        }

        const mappedRoute = candidate.recommendation_kind
          ? CANDIDATE_KIND_TO_ROUTE[candidate.recommendation_kind]
          : undefined;
        const mappedChannel = mappedRoute ? ROUTE_CHANNEL_MAP[mappedRoute] : undefined;
        if (mappedChannel && !MVP_ENABLED_CHANNELS.has(mappedChannel)) {
          continue;
        }

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

      // F10-2: Check principle_candidates.source_run_id → runs.run_id (dangling reference).
      // A consumed candidate's source_run_id must reference an existing run. If the
      // run was deleted or the id was corrupted, lineage is broken (rc-6).
      for (const candidate of consumedCandidates) {
        if (!candidate.source_run_id) continue;
        if (!runIdSet.has(candidate.source_run_id)) {
          brokenLinks.push({
            type: 'candidate_source_run_id_dangling',
            severity: 'error',
            candidateId: candidate.candidate_id,
            runId: candidate.source_run_id,
            reason: `Consumed candidate ${candidate.candidate_id} references non-existent source_run_id ${candidate.source_run_id}`,
            recommendedAction: 'Investigate run deletion or data corruption. Re-run the source task or correct source_run_id.',
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
          if (meta.status === 'parsed') {
            return meta.parentTaskId === dreamerTask.task_id || meta.dependencyTaskIds?.includes(dreamerTask.task_id);
          }
          if (meta.status === 'malformed') {
            return meta.bestEffortParentIds.includes(dreamerTask.task_id);
          }
          return false;
        });
        if (!hasPhilosopherSuccessor) {
          brokenLinks.push({
            type: 'missing_philosopher_successor',
            severity: 'warning',
            taskId: dreamerTask.task_id,
            reason: `Succeeded dreamer task ${dreamerTask.task_id} has no philosopher successor task`,
            recommendedAction: `pd runtime internalization enqueue-successors --workspace <workspace> --confirm, then pd runtime internalization run-once --workspace <workspace> --runner philosopher`,
          });
        }
      }

      for (const philosopherTask of philosopherTasks) {
        const philMeta = extractPIMetadata(philosopherTask.diagnostic_json);
        if (philMeta.status === 'malformed') {
          brokenLinks.push({
            type: 'metadata_malformed',
            severity: 'warning',
            taskId: philosopherTask.task_id,
            reason: philMeta.reason,
            recommendedAction: 'Investigate diagnostic_json corruption. Re-seed task with valid metadata or clear diagnostic_json.',
          });
        }

        if (philosopherTask.status === 'pending' || philosopherTask.status === 'leased') {
          let hasDreamerDependency = false;
          if (philMeta.status === 'parsed' && philMeta.dependencyTaskIds && philMeta.dependencyTaskIds.length > 0) {
            hasDreamerDependency = philMeta.dependencyTaskIds.some((id: string) => taskMap.has(id) && taskMap.get(id)?.task_kind === 'dreamer');
          } else if (philMeta.status === 'malformed' && philMeta.bestEffortParentIds.length > 0) {
            hasDreamerDependency = philMeta.bestEffortParentIds.some((id: string) => taskMap.has(id) && taskMap.get(id)?.task_kind === 'dreamer');
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
            } else {
              const artifactRow = db.prepare(
                'SELECT task_id FROM artifacts WHERE artifact_id = ?'
              ).get(ref) as { task_id: string } | undefined;
              if (artifactRow && artifactRow.task_id !== task.task_id) {
                brokenLinks.push({
                  type: 'lineage_mismatch',
                  severity: 'error',
                  taskId: task.task_id,
                  artifactId: ref,
                  reason: `Task ${task.task_id} result_ref ${ref} has task_id ${artifactRow.task_id} which does not match owning task_id`,
                  recommendedAction: 'Investigate artifact assignment logic or data corruption.',
                });
              }
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
                ? 'Fix the unparseable lease_expires_at timestamp then run: pd runtime internalization integrity-repair --workspace <workspace> --confirm'
                : 'Run: pd runtime internalization integrity-repair --workspace <workspace> --confirm',
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

        // F7-6 (PRI-442): detect time-based staleness — a task in retry_wait
        // longer than the TTL without recovery. Previously a task could cycle
        // retry_wait → pending → leased → retry_wait indefinitely without
        // exceeding max_attempts, leaving it silently stuck for weeks.
        // Uses updated_at as the entry-time proxy (set when the task last
        // transitioned into retry_wait). rc-9: observability gap fix.
        if (task.status === 'retry_wait' && task.updated_at) {
          const updatedAtMs = new Date(task.updated_at).getTime();
          if (!Number.isNaN(updatedAtMs) && (Date.now() - updatedAtMs) >= DEFAULT_RETRY_WAIT_STALE_TTL_MS) {
            const staleHours = Math.floor((Date.now() - updatedAtMs) / (60 * 60 * 1000));
            brokenLinks.push({
              type: 'retry_wait_stale',
              severity: 'warning',
              taskId: task.task_id,
              reason: `Task ${task.task_id} in retry_wait for ~${staleHours}h (updated_at=${task.updated_at}), exceeding stale TTL of ${DEFAULT_RETRY_WAIT_STALE_TTL_MS / (60 * 60 * 1000)}h`,
              recommendedAction: 'Investigate stuck recovery sweep or persistent transient failure. Consider manual recovery: pd runtime internalization integrity-repair --workspace <workspace> --confirm, or force-fail the task.',
            });
          }
        }
      }

      // Detect stale running runs (orphan runs where task is no longer leased)
      for (const run of allRuns) {
        if (run.execution_status !== 'running') continue;

        // If task is still leased with non-expired lease, the run is live — skip
        const runTask = taskMap.get(run.task_id);
        if (runTask?.status === 'leased' && runTask.lease_expires_at) {
          const expiresAt = new Date(runTask.lease_expires_at).getTime();
          if (!Number.isNaN(expiresAt) && expiresAt >= Date.now()) {
            continue;
          }
        }

        // If task is still leased with expired lease, already reported as lease_stuck — skip
        if (runTask?.status === 'leased') continue;

        // Orphaned running run: task is NOT leased but run is still running
        const taskStatusSummary = runTask
          ? `task status is ${runTask.status}`
          : 'task no longer exists';
        brokenLinks.push({
          type: 'running_run_stuck',
          severity: 'error',
          taskId: run.task_id,
          runId: run.run_id,
          reason: `Run ${run.run_id} for task ${run.task_id} is still 'running' but ${taskStatusSummary}`,
          recommendedAction: `Mark the run as failed: pd runtime internalization integrity-repair --workspace <workspace> --confirm`,
        });
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

      // F9-2: Check activations.artifact_id → pi_artifacts.artifact_id (dangling reference).
      // An active activation's artifact_id must reference an existing pi_artifact.
      // If the artifact was deleted or the id was corrupted, the activation cannot
      // function (RuleHost cannot load implementationCode, dispatcher cannot verify
      // lineage). This is an error-level break (rc-6-lineage-consistency).
      const activations = db.prepare(
        'SELECT activation_id, artifact_id, channel FROM activations WHERE deactivated_at IS NULL'
      ).all() as { activation_id: string; artifact_id: string; channel: string }[];
      for (const act of activations) {
        if (!piArtifactIdSet.has(act.artifact_id)) {
          brokenLinks.push({
            type: 'activation_artifact_id_dangling',
            severity: 'error',
            artifactId: act.artifact_id,
            reason: `Active activation ${act.activation_id} (channel=${act.channel}) references non-existent artifact_id ${act.artifact_id}`,
            recommendedAction: 'Investigate artifact deletion or data corruption. Deactivate the orphaned activation or restore the artifact.',
          });
        }
      }

      // Merge mainline contract verdicts when a pre-assembled snapshot is provided.
      if (this.mainlineSnapshot) {
        const verdict = assertMainlineContract(this.mainlineSnapshot);
        for (const stage of verdict.stages) {
          if (stage.status !== 'violation') continue;
          const painId = verdict.painId ?? 'unknown';
          brokenLinks.push({
            type: `mainline_contract_${stage.stage}`,
            severity: 'error',
            reason: `[painId=${painId}] ${stage.reason}`,
            recommendedAction: stage.nextAction ?? 'Review the mainline contract output and fix the reported stage.',
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
