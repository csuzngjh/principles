import * as path from 'path';
import * as fs from 'fs';
import type { Command } from 'commander';
import {
  createRuntimeStateHandle,
  appendRecoveryAction,
  inspectFailedTaskRecovery,
  recoverSingleFailedTask,
  listRecoveryActions,
  hydratePITaskRecord,
  type FailedTaskRecoveryAuditRecord,
} from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { buildExecutionNextAction } from './runtime-recovery-failed-tasks.js';

interface RecoveryFailedTaskOptions {
  workspace?: string;
  taskId?: string;
  dryRun?: boolean;
  confirm?: boolean;
  resetBudget?: boolean;
  decidedBy?: string;
  repairAudit?: boolean;
  json?: boolean;
}

/** ERR-001-safe record narrowing for untrusted parsed JSON (rc-1/rc-2). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emit(payload: Record<string, unknown>, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined) continue;
      console.log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    }
  }
}

function refusal(payload: Record<string, unknown>, json: boolean | undefined): void {
  emit({ ok: false, ...payload }, json);
  process.exitCode = 1;
}

/**
 * PRI-991 (P1-01): both modes refuse a workspace whose state.db does not
 * exist BEFORE opening any connection — dry-run must not create it and
 * confirm must not bootstrap a wrong-typed path. The open itself re-validates
 * (no TOCTOU reliance): the check only picks the refusal path.
 */
function stateDbPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', 'state.db');
}

/**
 * PRI-991 (P1-01): classify storage-level open/query failures (missing file,
 * not-a-database, missing tables) as structured `storage_unavailable`
 * instead of the generic recovery_error — dry-run's read-only connection
 * cannot migrate or bootstrap, so these are terminal for the invocation.
 */
function isSqliteUnavailable(err: unknown): boolean {
  if (!isRecord(err)) return false;
  return typeof err.code === 'string' && err.code.startsWith('SQLITE_');
}

/**
 * PRI-991 (P2-B): channel-aware recovery nextAction. A recovered
 * code_tool_hook Artificer task is NOT executable via run-once (it refuses
 * Code Rule tasks) — the next auto-consumer cycle runs the IAER evidence
 * preflight and, without Owner evidence, parks the task in
 * needs_human_review at zero model cost. Every OTHER kind reuses the shared
 * per-kind guidance authority (buildExecutionNextAction) so both recovery
 * surfaces stay identical.
 */
function buildRecoveryNextAction(task: { taskId: string; taskKind: string; inputRef: string | null; diagnosticJson: string | null }): string {
  const { diagnosticJson } = task;
  if (diagnosticJson !== null && diagnosticJson.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(diagnosticJson);
      if (isRecord(parsed) && Object.hasOwn(parsed, 'pi_metadata')) {
        const meta = parsed.pi_metadata;
        if (isRecord(meta) && Object.hasOwn(meta, 'channel') && typeof meta.channel === 'string' && meta.channel === 'code_tool_hook') {
          return 'Task recovered to pending. The next auto-consumer cycle runs the evidence preflight on it: without Owner evidence it is parked in needs_human_review (zero model cost), then attach/resume via: pd runtime internalization evidence attach --confirm → pd runtime internalization evidence resume --confirm';
        }
      }
    } catch {
      // Unparseable payload — fall through to the per-kind guidance below.
    }
  }
  return buildExecutionNextAction(task);
}

/**
 * PRI-991 (r2 P2): the JSONL projection is a read-check-append sequence —
 * concurrent confirm/repair processes can each observe an actionId missing
 * and append it twice. This lock (O_EXCL create, git-12 precedent: an
 * existing lock is never overwritten or auto-deleted) serializes ALL
 * projections for one workspace so the check+append pair is atomic. A stale
 * lock from a crashed holder blocks projections until a human removes it —
 * the durable row facts are unaffected.
 */
function projectionLockPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.state', 'recovery_actions.jsonl.lock');
}

interface ProjectionOutcome {
  ok: boolean;
  projected: number;
  skipped: number;
  reasonCode?: string;
  reason?: string;
  nextAction?: string;
}

/**
 * Project the durable recovery facts that are missing from the JSONL,
 * serialized by the projection lock. Sync I/O inside the lock keeps the
 * check+append pair atomic within the process and the lock file arbitrates
 * across processes. Returns which records were projected / already present,
 * or a structured refusal (lock held / sink failure) with ZERO appends.
 */
function projectRecoveryRecordsOnce(workspaceDir: string, taskId: string, records: readonly FailedTaskRecoveryAuditRecord[]): ProjectionOutcome {
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const lockPath = projectionLockPath(workspaceDir);
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch {
    return {
      ok: false,
      projected: 0,
      skipped: 0,
      reasonCode: 'audit_projection_locked',
      reason: `Another projection holds ${lockPath}`,
      nextAction: 'Wait for the concurrent projection to finish, or (if its holder process is gone) remove the stale lock file manually, then re-run',
    };
  }
  try {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    } catch {
      // Holder info is best-effort debugging aid — never blocks projection.
    }
    const projectedIds = new Set(listRecoveryActions(workspaceDir, { taskId }).map((a) => a.actionId));
    const missing = records.filter((r) => !projectedIds.has(r.actionId));
    for (const record of missing) {
      appendRecoveryAction(workspaceDir, {
        actionId: record.actionId,
        taskId,
        previousStatus: record.previousStatus,
        result: 'recovered',
        operator: record.operator ?? undefined,
        forceApplied: record.budgetResetApplied,
        previousAttemptCount: record.previousAttemptCount,
      });
    }
    return { ok: true, projected: missing.length, skipped: records.length - missing.length };
  } catch (err: unknown) {
    return {
      ok: false,
      projected: 0,
      skipped: 0,
      reasonCode: 'audit_projection_failed',
      reason: err instanceof Error ? err.message : String(err),
      nextAction: 'Fix the audit sink (workspace/.state/recovery_actions.jsonl); the durable row facts are untouched — re-run --repair-audit afterwards',
    };
  } finally {
    fs.closeSync(lockFd);
    fs.rmSync(lockPath, { force: true });
  }
}

async function repairAuditProjection(opts: RecoveryFailedTaskOptions, workspaceDir: string): Promise<void> {  // Read-only DB handle (no bootstrap, no writes); the ONLY write this mode
  // performs is the idempotent JSONL projection append, serialized by the
  // projection lock (r2 P2: check-then-append alone is not concurrency-safe).
  let handle: Awaited<ReturnType<typeof createRuntimeStateHandle>> | null = null;
  try {
    handle = await createRuntimeStateHandle({ workspaceDir, readonly: true, bootstrapIfMissing: false });
    const rawTask = await handle.stateManager.getTask(String(opts.taskId));
    if (!rawTask) {
      refusal({ reason: 'Task not found in this workspace', reasonCode: 'task_not_found', taskId: opts.taskId, nextAction: 'Verify the exact taskId (pd runtime internalization queue --json)' }, opts.json);
      return;
    }
    const piTask = hydratePITaskRecord(rawTask);
    const records = piTask?.failedTaskRecoveries ?? [];
    if (records.length === 0) {
      refusal({
        reason: 'No durable recovery fact in the task metadata — nothing to project',
        reasonCode: 'no_durable_recovery_record',
        taskId: opts.taskId,
        nextAction: 'recovery_actions.jsonl has no row-fact fallback for this task (legacy absent-metadata recovery); the recovery itself stands as reported by its confirm output',
      }, opts.json);
      return;
    }
    const outcome = projectRecoveryRecordsOnce(workspaceDir, String(opts.taskId), records);
    if (!outcome.ok) {
      refusal({
        reason: outcome.reason,
        reasonCode: outcome.reasonCode,
        taskId: opts.taskId,
        nextAction: outcome.nextAction,
      }, opts.json);
      return;
    }
    emit({
      ok: true,
      mode: 'repair_audit',
      taskId: opts.taskId,
      auditStatus: outcome.projected > 0 ? 'repaired' : 'already_projected',
      projected: outcome.projected,
      alreadyProjected: outcome.skipped,
      totalDurableFacts: records.length,
      nextAction: outcome.projected > 0
        ? 'Audit projection restored. Verify: pd runtime internalization queue --json (task state untouched by this mode)'
        : 'Nothing to do — the JSONL projection already carries every durable actionId',
    }, opts.json);
  } catch (err: unknown) {
    if (isSqliteUnavailable(err)) {
      refusal({ reason: err instanceof Error ? err.message : String(err), reasonCode: 'storage_unavailable', nextAction: 'Check the workspace path — repair-audit opens the database read-only and never creates it' }, opts.json);
      return;
    }
    refusal({ reason: err instanceof Error ? err.message : String(err), reasonCode: 'repair_failed', nextAction: 'Fix the audit sink (workspace/.state/recovery_actions.jsonl) and re-run; the durable row fact is untouched' }, opts.json);
  } finally {
    if (handle) await handle.close();
  }
}

export async function handleRuntimeRecoveryFailedTask(opts: RecoveryFailedTaskOptions): Promise<void> {
  if (opts.dryRun && opts.confirm) {
    refusal({
      reason: 'Error: --dry-run and --confirm are mutually exclusive',
      reasonCode: 'flag_conflict',
      nextAction: 'Specify only one of --dry-run or --confirm (dry-run is the default)',
    }, opts.json);
    return;
  }
  if (opts.repairAudit && opts.confirm) {
    refusal({
      reason: 'Error: --repair-audit and --confirm are mutually exclusive',
      reasonCode: 'flag_conflict',
      nextAction: '--repair-audit only re-projects the JSONL audit from the durable row fact; it never mutates task state',
    }, opts.json);
    return;
  }
  const rawTaskId = opts.taskId ?? '';
  const taskId = rawTaskId.trim();
  if (taskId === '' || taskId !== rawTaskId) {
    refusal({
      reason: 'Error: --task-id requires the exact task id (no surrounding whitespace)',
      reasonCode: 'invalid_task_id',
      nextAction: 'Copy the full taskId from: pd runtime internalization queue --json (or the audit-artificer-evidence output)',
    }, opts.json);
    return;
  }

  // PRI-991 (r2 P1-03): the UNIFIED workspace authority resolves every
  // target — explicit flag included — so assertSafeDirectoryRoot (empty /
  // parent traversal / filesystem root) and the config-difference warnings
  // apply to this state-mutating command like every other CLI command.
  let workspaceDir: string;
  try {
    workspaceDir = resolveWorkspaceDir(opts.workspace);
  } catch (err: unknown) {
    refusal({
      reason: err instanceof Error ? err.message : String(err),
      reasonCode: 'workspace_invalid',
      nextAction: 'Provide a safe explicit workspace directory with --workspace <path> (no traversal segments, not a filesystem root)',
    }, opts.json);
    return;
  }

  // PRI-991 (P1-01): refuse before opening ANY connection when the database
  // does not exist — dry-run must not create it, confirm must not bootstrap.
  if (!fs.existsSync(stateDbPath(workspaceDir))) {
    refusal({
      reason: `No state database at ${stateDbPath(workspaceDir)}`,
      reasonCode: 'storage_unavailable',
      nextAction: 'This workspace has no .pd/state.db — verify the --workspace path; recovery never creates databases',
    }, opts.json);
    return;
  }

  if (opts.repairAudit) {
    await repairAuditProjection(opts, workspaceDir);
    return;
  }

  const isConfirm = opts.confirm ?? false;

  // PRI-991 (P1-01): dry-run opens a STRICTLY read-only connection with
  // bootstrap disabled — no mkdir, no WAL journal, no schema init/migration
  // can happen from the file open onward. Confirm uses the controlled write
  // connection (bootstrap likewise disabled: the DB is known to exist).
  let closeHandle: (() => Promise<void>) | null = null;
  try {
    const handle = await createRuntimeStateHandle({
      workspaceDir,
      readonly: !isConfirm,
      bootstrapIfMissing: false,
    });
    closeHandle = handle.close;
    const { stateManager } = handle;

    if (!isConfirm) {
      // Dry-run (default): pure read — no task mutation, no audit append.
      const inspection = await inspectFailedTaskRecovery(stateManager, taskId);
      const plannedChange = inspection.eligible && inspection.isExhausted === true
        ? {
            status: 'failed → pending',
            attemptBudget: `${inspection.attemptCount}/${inspection.maxAttempts} → 0/${(inspection.maxAttempts ?? 0) + 3} (with --reset-budget)`,
            audit: 'a durable recovery fact is written into the task metadata in the same transaction, then projected to .state/recovery_actions.jsonl',
          }
        : inspection.eligible
          ? {
              status: 'failed → pending',
              attemptBudget: `${inspection.attemptCount}/${inspection.maxAttempts} → 0/${inspection.maxAttempts}`,
              audit: 'a durable recovery fact is written into the task metadata in the same transaction, then projected to .state/recovery_actions.jsonl',
            }
          : undefined;
      const payload: Record<string, unknown> = {
        ok: inspection.eligible,
        mode: 'dry_run',
        ...inspection,
        plannedChange,
        wouldWriteAudit: false,
        workspace: workspaceDir,
        ...(inspection.eligible
          ? { nextAction: inspection.isExhausted === true
            ? 'Recover with: pd runtime recovery failed-task --task-id <exact-task-id> --confirm --reset-budget'
            : 'Recover with: pd runtime recovery failed-task --task-id <exact-task-id> --confirm' }
          : {}),
      };
      if (!inspection.eligible) {
        payload.reasonCode = inspection.reasonCode;
      }
      emit(payload, opts.json);
      if (!inspection.eligible) {
        process.exitCode = 1;
      }
      return;
    }

    // Confirm: precheck for precise structured refusals (and zero writes on
    // refusal), then the strict single-task mutation (full-snapshot CAS).
    const inspection = await inspectFailedTaskRecovery(stateManager, taskId);
    if (!inspection.eligible) {
      refusal({
        reason: 'Task is not recoverable in its current state',
        reasonCode: inspection.reasonCode,
        taskId,
        taskKind: inspection.taskKind,
        status: inspection.status,
        attemptCount: inspection.attemptCount,
        maxAttempts: inspection.maxAttempts,
        nextAction: inspection.nextAction,
      }, opts.json);
      return;
    }

    // PRI-991 (r2 P1-02): BEFORE the CAS, project any durable facts from
    // PRIOR recoveries that never made it to the JSONL — otherwise this
    // recovery's array append (bounded retention) could be the last holder
    // of an unprojected actionId. Projection failure aborts the confirm
    // BEFORE any state change (cli-5): the Owner fixes the sink and retries.
    const preTask = await stateManager.getTask(taskId);
    const prePi = preTask ? hydratePITaskRecord(preTask) : null;
    const preRecords = prePi?.failedTaskRecoveries ?? [];
    if (preRecords.length > 0) {
      const pre = projectRecoveryRecordsOnce(workspaceDir, taskId, preRecords);
      if (!pre.ok) {
        refusal({
          reason: pre.reason ?? 'Audit projection failed before recovery',
          reasonCode: pre.reasonCode ?? 'audit_projection_failed',
          taskId,
          nextAction: `${pre.nextAction} The recovery was NOT executed (zero state change) — retry after the audit sink is writable`,
        }, opts.json);
        return;
      }
    }

    const outcome = await recoverSingleFailedTask(stateManager, taskId, {
      resetBudget: opts.resetBudget ?? false,
      // r2 P1-01: the label rides the durable fact in the SAME CAS.
      operator: opts.decidedBy,
    });
    if (outcome.status !== 'recovered') {
      // Lost a race against a concurrent writer, or a guard fired at mutation
      // time — structured refusal, zero writes.
      refusal({
        reason: 'Task recovery refused (guard fired or state changed between precheck and mutation)',
        reasonCode: outcome.status === 'not_found' ? 'task_not_found' : outcome.status,
        taskId,
        ...(outcome.status === 'not_failed' ? { currentStatus: outcome.previousStatus } : {}),
        ...(outcome.status === 'budget_exhausted'
          ? { nextAction: outcome.nextAction }
          : { nextAction: 'Re-run the dry-run to inspect the current state' }),
      }, opts.json);
      return;
    }

    // PRI-991 (P1-03): the durable audit fact is ALREADY committed inside the
    // recovery CAS (task metadata failedTaskRecoveries, actionId shared).
    // The JSONL line is a projection under the projection lock; a projection
    // failure must never misreport the recovery as failed — and never asks
    // the Owner to re-confirm.
    const current = await stateManager.getTask(taskId);
    const projected = projectRecoveryRecordsOnce(workspaceDir, taskId, [
      {
        actionId: outcome.actionId,
        recoveredAt: new Date().toISOString(),
        operator: opts.decidedBy?.trim() ? opts.decidedBy.trim() : null,
        previousStatus: 'failed',
        previousAttemptCount: outcome.previousAttemptCount,
        previousMaxAttempts: outcome.previousMaxAttempts,
        newMaxAttempts: outcome.newMaxAttempts,
        budgetResetApplied: outcome.budgetResetApplied,
      },
    ]);
    const auditStatus: 'projected' | 'recovered_but_audit_failed' = projected.ok ? 'projected' : 'recovered_but_audit_failed';
    const auditFailureReason = projected.ok ? undefined : projected.reason;

    const nextAction = buildRecoveryNextAction({
      taskId,
      taskKind: outcome.taskKind,
      inputRef: current?.inputRef ?? null,
      diagnosticJson: typeof current?.diagnosticJson === 'string' ? current.diagnosticJson : null,
    });

    emit({
      ok: true,
      mode: 'confirm',
      taskId,
      taskKind: outcome.taskKind,
      previousStatus: outcome.previousStatus,
      newStatus: current?.status ?? 'pending',
      attemptCount: current?.attemptCount ?? 0,
      maxAttempts: current?.maxAttempts ?? outcome.newMaxAttempts,
      previousAttemptCount: outcome.previousAttemptCount,
      previousMaxAttempts: outcome.previousMaxAttempts,
      newMaxAttempts: outcome.newMaxAttempts,
      budgetResetApplied: outcome.budgetResetApplied,
      auditStatus,
      ...(auditStatus === 'recovered_but_audit_failed'
        ? {
            auditFailureReason,
            auditActionId: outcome.actionId,
            decidedByLabel: opts.decidedBy ?? null,
            nextAction: `Recovery IS committed (durable fact in the task metadata, actionId ${outcome.actionId}); the JSONL projection failed (${auditFailureReason ?? 'unknown'}). Do NOT re-run --confirm. Repair with: pd runtime recovery failed-task --task-id <exact-task-id> --repair-audit`,
          }
        : {
            auditActionId: outcome.actionId,
            nextAction,
          }),
      workspace: workspaceDir,
    }, opts.json);
  } catch (err: unknown) {
    if (isSqliteUnavailable(err)) {
      refusal({
        reason: err instanceof Error ? err.message : String(err),
        reasonCode: 'storage_unavailable',
        nextAction: 'The database could not be opened in its requested mode (readonly for --dry-run); recovery never migrates or bootstraps schemas',
      }, opts.json);
      return;
    }
    refusal({
      reason: err instanceof Error ? err.message : String(err),
      reasonCode: 'recovery_error',
      nextAction: 'Check the workspace path and DB connectivity, then re-run the dry-run',
    }, opts.json);
  } finally {
    if (closeHandle) {
      await closeHandle();
    }
  }
}

/**
 * Register `failed-task` (singular) under `pd runtime recovery` (PRI-991).
 * The exact single-task counterpart of the batch `failed-tasks` command:
 * the two coexist and the batch command is unchanged.
 */
export function registerRuntimeRecoveryFailedTaskCommand(
  recoveryCmd: Command,
  handlers: { failedTask?: typeof handleRuntimeRecoveryFailedTask } = {},
): void {
  const handler = handlers.failedTask ?? handleRuntimeRecoveryFailedTask;
  recoveryCmd
    .command('failed-task')
    .description('Recover ONE failed task by exact taskId (dry-run default; exhausted tasks additionally require --reset-budget)')
    .requiredOption('--task-id <taskId>', 'Exact task id — no prefix, no wildcard, no fallback to batch recovery')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--dry-run', 'Strictly read-only precheck: opens the DB read-only (never creates/migrates), shows the exact planned change (default)')
    .option('--confirm', 'Actually recover this one task (full-snapshot CAS; durable audit fact + JSONL projection)')
    .option('--reset-budget', 'Explicitly reset an exhausted attempt budget (required when attempts are exhausted; records previousAttemptCount in the audit)')
    .option('--repair-audit', 'Idempotently re-project the JSONL audit line from the durable recovery fact in the task metadata (never mutates task state)')
    .option('--decidedBy <label>', 'Operator-provided label recorded in the audit log (a label, NOT an authenticated identity)')
    .option('--json', 'Output raw JSON')
    .action(async (opts: RecoveryFailedTaskOptions) => {
      await handler(opts);
    });
}
