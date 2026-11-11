/**
 * `pd trajectory maintain | retention status | vacuum` — SPEC-PD-TR-001.
 *
 * CLI contract:
 * - `--json` writes exactly one JSON document to stdout (cli-1);
 * - refusals carry a structured `reason` + `nextAction` and exit non-zero
 *   without mutating anything (cli-5, cli-6);
 * - `vacuum` is dry-run unless `--yes` (cli-4).
 */
import {
  readTrajectoryRetentionStatus,
  runTrajectoryRetention,
  vacuumTrajectoryDatabase,
} from '@principles/host-runtime';
import type {
  TrajectoryRetentionReport,
  TrajectoryRetentionStatus,
  TrajectoryVacuumReport,
} from '@principles/host-runtime';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

export interface TrajectoryMaintainOptions {
  workspace?: string;
  json?: boolean;
}

export interface TrajectoryStatusOptions {
  workspace?: string;
  json?: boolean;
}

export interface TrajectoryVacuumOptions {
  workspace?: string;
  json?: boolean;
  yes?: boolean;
}

function printMaintain(report: TrajectoryRetentionReport): void {
  if (report.outcome === 'skipped') {
    console.log(`Retention skipped: ${report.reason ?? 'unknown'}`);
    if (report.nextAction !== undefined) console.log(`Next: ${report.nextAction}`);
    return;
  }
  const deleted = Object.entries(report.deletedByTable)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${table}=${count}`)
    .join(' ');
  console.log(
    `Retention ${report.outcome} (cutoff ${report.cutoff ?? 'n/a'}, ${report.batches} batch(es), `
    + `${report.totalDurationMs} ms total, max batch ${report.maxBatchDurationMs} ms)`
    + (deleted === '' ? ', deleted 0 rows' : `: ${deleted}`),
  );
  if (report.partial) console.log('Partial: the run budget or batch budget was exhausted; the next run continues.');
  if (report.backoffUntil !== null) console.log(`Backoff until ${report.backoffUntil}`);
  if (report.nextAction !== undefined) console.log(`Next: ${report.nextAction}`);
}

/**
 * Reasons that mean "this run was supposed to delete but could not" and that a
 * human/automation must act on. Deliberately EXCLUDES the designed yields —
 * `deferred:busy`, `deadline`, `run_budget_exhausted`, `no_progress:*`,
 * `batch_over_budget`, `locked`, `not_due:*`, `backoff:*` — because a healthy
 * cron must not page on the budget doing its job.
 *
 * Included:
 * - `failed:`            unhandled error, deletion stopped;
 * - `audit_failed:`      fail-closed: the batch was NOT deleted because the
 *                        audit list could not be written;
 * - `config_invalid:` /  config refuses to load or degrades: nothing is deleted;
 *   `degraded:`
 * - `journal_mode_not_wal` the database can never be swept in this mode;
 * - `clock_*` / `marker_timestamp_invalid` the clock/marker guard skipped the
 *                        run (forward/invalid self-heals next run, backwards
 *                        persists while the clock is wrong);
 * - `index_failed:`      sweeping works but the plan is degraded; persistent
 *                        until repaired;
 * - `invariant_violation` row counts did not reconcile.
 */
const OPERATOR_FAILURE_REASON_PREFIXES: readonly string[] = Object.freeze([
  'failed:',
  'audit_failed:',
  'config_invalid:',
  'degraded:',
  'journal_mode_not_wal',
  'clock_',
  'marker_timestamp_invalid',
  'index_failed:',
]);

/**
 * Exit code for `pd trajectory maintain`: 1 only when the run needs a human,
 * 0 for success, intentional-off states and designed budget/busy yields.
 */
export function retentionExitCode(report: TrajectoryRetentionReport): 0 | 1 {
  if (report.outcome === 'invariant_violation') return 1;
  const reason = report.reason ?? '';
  return OPERATOR_FAILURE_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix)) ? 1 : 0;
}

export async function handleTrajectoryMaintain(opts: TrajectoryMaintainOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  // Manual invocations are the fallback for workspaces with no running worker,
  // so they ignore `intervalHours`; lock, clock guards, budgets and the
  // fail-closed config rules all still apply.
  const report = runTrajectoryRetention({ workspaceDir, trigger: 'manual' });

  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printMaintain(report);
  }

  const exitCode = retentionExitCode(report);
  if (exitCode !== 0) process.exitCode = exitCode;
}

export async function handleTrajectoryRetentionStatus(opts: TrajectoryStatusOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const status: TrajectoryRetentionStatus = readTrajectoryRetentionStatus(workspaceDir);

  if (opts.json === true) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(`Workspace: ${status.workspaceDir}`);
  console.log(`Database:  ${status.dbPath} (${status.dbExists ? 'present' : 'missing'})`);
  console.log(
    `Policy:    enabled=${status.policy.enabled} retentionDays=${status.policy.retentionDays} `
    + `intervalHours=${status.policy.intervalHours} batchSize=${status.policy.batchSize} `
    + `runBudgetMs=${status.policy.runBudgetMs}`
    + (status.policy.degradedReason === undefined ? '' : ` [degraded: ${status.policy.degradedReason}]`),
  );
  console.log(`Last run:  ${status.marker.lastRunAt ?? 'never'} (${status.marker.lastOutcome ?? 'n/a'})`);
  console.log(`Cutoff:    ${status.marker.lastCutoff ?? 'n/a'}`);
  console.log(`Next run:  cutoff ${status.nextCutoff ?? 'n/a (no sweep scheduled)'}`);
  if (status.marker.backoffUntil !== null) console.log(`Backoff:   ${status.marker.backoffUntil}`);
  if (status.markerError !== null) console.log(`Marker:    unreadable (${status.markerError})`);
  if (status.dbError !== null) console.log(`Database:  unreadable (${status.dbError})`);
  if (status.indexesMissing.length > 0) {
    console.log(`Indexes:   missing ${status.indexesMissing.join(', ')} — run \`pd trajectory vacuum --yes\``);
  }
  if (status.expiredByTable !== null) {
    const counts = Object.entries(status.expiredByTable)
      .map(([table, count]) => `${table}=${count}`)
      .join(' ');
    // Same cutoff the next run will use, so this is a projection, not a
    // different definition of "expired" (F4).
    console.log(`Next delete: ${counts}`);
  }
}

function printVacuum(report: TrajectoryVacuumReport): void {
  if (report.refusedReason !== null) {
    console.log(`VACUUM refused: ${report.refusedReason}`);
    console.log(
      `Size ${report.sizeBeforeBytes} bytes, free ${report.freeBytes ?? 'unknown'}, `
      + `required ${report.requiredBytes ?? 'unknown'} (2 x size + 10%)`,
    );
    if (report.nextAction !== undefined) console.log(`Next: ${report.nextAction}`);
    return;
  }
  if (!report.applied) {
    console.log(
      `VACUUM dry run: size ${report.sizeBeforeBytes} bytes, freelist ${report.freelistBefore ?? 'unknown'} pages, `
      + `free ${report.freeBytes ?? 'unknown'}, required ${report.requiredBytes ?? 'unknown'}`,
    );
    if (report.nextAction !== undefined) console.log(`Next: ${report.nextAction}`);
    return;
  }
  console.log(
    `VACUUM done in ${report.durationMs} ms: ${report.sizeBeforeBytes} -> ${report.sizeAfterBytes ?? 'unknown'} bytes, `
    + `freelist ${report.freelistBefore ?? 'unknown'} -> ${report.freelistAfter ?? 'unknown'} pages`,
  );
  if (report.indexes !== null) {
    console.log(
      `Indexes:   ${report.indexes.applied.length} applied, ${report.indexes.skipped.length} skipped`,
    );
  }
}

export async function handleTrajectoryVacuum(opts: TrajectoryVacuumOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const report = vacuumTrajectoryDatabase({ workspaceDir, apply: opts.yes === true });

  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printVacuum(report);
  }

  if (report.refusedReason !== null) {
    process.exitCode = 1;
  }
}
