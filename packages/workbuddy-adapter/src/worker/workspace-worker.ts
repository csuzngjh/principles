/**
 * WorkBuddy Workspace worker cycle (SPEC workbuddy-host-adapter §5 Part 5;
 * ADR-0020 §11.1 shape, third host instance).
 *
 * ONE Workspace-scoped worker cycle with exactly two background
 * responsibilities — the Codex catch-up step is DELIBERATELY ABSENT because
 * the WorkBuddy MVP excludes transcript ingestion (SPEC §1 Excluded; the
 * hook itself is the only evidence producer):
 *
 *   1. run the idempotent reconciliation pass (shared host-runtime authority),
 *      then admit the hook's BARE failure pains into the same governance
 *      queue (review R2/P1 — no inline admission exists on this host; the
 *      sweep reuses the ONE admission table and the crash-safe task ensure)
 *   2. lease + run one Diagnostician execution, then ONE bounded downstream
 *      consumer cycle through the SHARED host-neutral executor
 *      (internalization_auto_consumer = workspace execution authority)
 *
 * Every step reuses existing authority: reconciliation reuses
 * `reconcileGovernanceContinuation`, the diagnostician reuses the
 * PainSignalBridge lease/runner contract, downstream reuses the same
 * `runInternalizationConsumerCycle` the OpenClaw auto-consumer and the Codex
 * worker run. No new task store, no private retry queue, no second
 * scheduler state — and no Codex flag, path or transcript semantics are
 * borrowed (SPEC §5: 不借用 Codex flag/日志伪装归因).
 *
 * Correctness under concurrent consumers (Companion-spawned `pd workbuddy
 * worker` + manual `pd runtime internalization run-once`) is owned by the
 * durable Runtime V2 task lease — never by process-local state. The
 * governance workspace is the single canonical directory
 * (`~/.workbuddy/pd-workspace`), so two projects never double-schedule:
 * they share one workspace and the lease serialises consumption.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  computeFeatureFlagsFromConfig,
  createRuntimeStateHandle,
  createPainSignalBridge,
  isRetryWaitBackoffElapsed,
  PrincipleTreeLedgerAdapter,
  resolveDiagnosticianCapability,
  type TaskRecord,
} from '@principles/core/runtime-v2';
import {
  admitBareHostPains,
  loadPdConfigForPlugin,
  loadFeatureFlagFromConfig,
  reconcileGovernanceContinuation,
  runInternalizationConsumerCycle,
  saveHostToolDeclaration,
  type AdmitBareHostPainsResult,
  type InternalizationConsumerCycleOutcome,
  type ConsumerCycleLogger,
  type ReconcileGovernanceContinuationResult,
} from '@principles/host-runtime';
import { WORKBUDDY_TOOL_SEMANTICS, WORKBUDDY_TOOL_SEMANTIC_MAPPINGS } from '../tool-semantics.js';

export type WorkbuddyWorkerMode = 'ready' | 'manual_action_required' | 'paused' | 'degraded';

export interface WorkbuddyWorkerCycleStepReport {
  readonly reconcile: ReconcileGovernanceContinuationResult;
  /**
   * Bare-pain admission sweep (review R2/P1): the WorkBuddy hook writes bare
   * failure pains with no inline admission, so the worker admits them into the
   * shared governance queue before the diagnostician step.
   */
  readonly admission: AdmitBareHostPainsResult;
  /** At most ONE diagnostician execution per cycle (bounded work). */
  readonly diagnostician: {
    readonly taskId: string;
    readonly status: 'succeeded' | 'failed' | 'retried' | 'skipped' | 'degraded';
    readonly message?: string;
    readonly errorCategory?: string;
    readonly nextAction?: string;
  } | null;
  readonly downstream: InternalizationConsumerCycleOutcome | null;
}

export interface WorkbuddyWorkerCycleResult {
  readonly workspaceDir: string;
  readonly mode: WorkbuddyWorkerMode;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly report?: WorkbuddyWorkerCycleStepReport;
}

export interface WorkbuddyWorkerCycleOptions {
  readonly workspaceDir: string;
  readonly now?: Date;
  readonly logger?: ConsumerCycleLogger;
  readonly emitEvent?: (event: string, payloadJson: string) => void;
  /** Cap on diagnostician candidates inspected per cycle (default 5). */
  readonly diagnosticianCandidateLimit?: number;
}

const WORKER_OWNER = 'companion-worker';
const DEFAULT_DIAG_CANDIDATE_LIMIT = 5;

function workerLogger(logger?: ConsumerCycleLogger): ConsumerCycleLogger {
  return logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Oldest pending diagnostician first; retry_wait candidates are filtered to
 * those whose backoff window has ELAPSED (same discipline as the Codex
 * worker — an old-but-waiting task cannot starve a younger eligible one).
 */
async function pickDiagnosticianCandidate(stateManager: Awaited<ReturnType<typeof createRuntimeStateHandle>>['stateManager'], limit: number): Promise<TaskRecord | null> {
  const pending = await stateManager.listTasks({ taskKind: 'diagnostician', status: 'pending', orderBy: 'updated_at_asc', limit });
  const [first] = pending;
  if (first !== undefined) return first;
  const retrying = await stateManager.listTasks({ taskKind: 'diagnostician', status: 'retry_wait', orderBy: 'updated_at_asc', limit });
  for (const candidate of retrying) {
    if (isRetryWaitBackoffElapsed(candidate.status, candidate.leaseExpiresAt)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Run ONE bounded worker cycle for a canonical governance workspace. Never
 * throws: every failure becomes a structured degraded result with a
 * nextAction.
 */
export async function runWorkbuddyWorkspaceWorkerCycle(options: WorkbuddyWorkerCycleOptions): Promise<WorkbuddyWorkerCycleResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const logger = workerLogger(options.logger);
  const emitEvent = options.emitEvent ?? ((_event: string, _payload: string) => undefined);
  const base = { workspaceDir };

  // Step 1 — Workspace eligibility.
  if (!directoryExists(workspaceDir)) {
    return { ...base, mode: 'degraded', reason: 'workspace_missing', nextAction: 'The governance workspace directory no longer exists; run the WorkBuddy setup flow to re-initialize it. No PD state was mutated.' };
  }

  const config = loadPdConfigForPlugin(workspaceDir);
  if (!config.ok) {
    const [first] = config.errors;
    return { ...base, mode: 'degraded', reason: `pd_config_invalid:${first?.reason ?? 'unknown'}`, nextAction: first?.nextAction ?? 'Repair the governance workspace .pd/config.yaml.' };
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  if (flags['host.workbuddy']?.enabled !== true) {
    return { ...base, mode: 'paused', reason: 'host.workbuddy_disabled', nextAction: 'Set features.host.workbuddy.enabled=true in the governance workspace .pd/config.yaml to enable WorkBuddy PD behavior.' };
  }

  const consumerFlag = loadFeatureFlagFromConfig(workspaceDir, 'internalization_auto_consumer', { info: (m) => logger.info(m), warn: (m) => logger.warn(m) });

  // The Diagnostician capability gate resolves from the same canonical
  // authority as the runtime factory. An Owner-disabled agent is an
  // intentional governance state: no candidate picking, no provider calls,
  // no degraded mode; reconciliation and downstream keep running.
  const capability = resolveDiagnosticianCapability(config.effective);
  const diagnosticianDisabled = !capability.available;

  // Step 2 — Idempotent reconciliation (always runs; creates no LLM work).
  const reconcile = await reconcileGovernanceContinuation({ workspaceDir });

  // Step 2b — Bare-pain admission (review R2/P1): the hook leaves bare
  // workbuddy failure pains that no inline admission exists for. Without this
  // sweep the evidence rows never reach the diagnostician queue. Runs AFTER
  // reconcile (which continues already-admitted markers) and ensures tasks
  // through the same crash-safe seam; bounded and idempotent.
  const admission = await admitBareHostPains({ workspaceDir, hostKind: 'workbuddy' });

  // Steps 3–5 — execution authority: internalization_auto_consumer.
  let diagnostician: WorkbuddyWorkerCycleStepReport['diagnostician'] = null;
  if (diagnosticianDisabled) {
    diagnostician = {
      taskId: '',
      status: 'skipped',
      message: 'capability_disabled',
      nextAction: capability.available ? undefined : capability.nextAction,
    };
  } else if (!consumerFlag.enabled) {
    return {
      ...base,
      mode: 'paused',
      reason: 'internalization_auto_consumer_disabled',
      nextAction: 'Automatic internalization execution is paused for this governance workspace; manual commands remain available: pd diagnose, pd runtime internalization run-once.',
      report: { reconcile, admission, diagnostician: null, downstream: null },
    };
  } else {
    try {
      const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
      try {
        const sweep = await handle.stateManager.runRecoverySweep();
        if (sweep.recovered > 0 || sweep.errors.length > 0) {
          emitEvent('WORKBUDDY_WORKER_RECOVERY_SWEEP', JSON.stringify({ recovered: sweep.recovered, failed: sweep.errors.length }));
        }
        const candidate = await pickDiagnosticianCandidate(handle.stateManager, options.diagnosticianCandidateLimit ?? DEFAULT_DIAG_CANDIDATE_LIMIT);
        if (candidate !== null) {
          const stateDir = path.join(workspaceDir, '.state');
          const bridge = await createPainSignalBridge({
            workspaceDir,
            stateDir,
            ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
            owner: WORKER_OWNER,
            effectiveConfig: config.effective,
            getEnvVar: (name: string) => process.env[name],
          });
          const executed = await bridge.executePendingDiagnosis({ taskId: candidate.taskId });
          diagnostician = {
            taskId: candidate.taskId,
            status: executed.status,
            ...(executed.message !== undefined ? { message: executed.message.slice(0, 200) } : {}),
            ...(executed.errorCategory !== undefined ? { errorCategory: executed.errorCategory } : {}),
          };
        } else {
          const waiting = await handle.stateManager.listTasks({ taskKind: 'diagnostician', status: 'retry_wait', orderBy: 'updated_at_asc', limit: 1 });
          const [oldestWaiting] = waiting;
          if (oldestWaiting !== undefined && !isRetryWaitBackoffElapsed(oldestWaiting.status, oldestWaiting.leaseExpiresAt)) {
            diagnostician = { taskId: oldestWaiting.taskId, status: 'skipped', message: 'retry_wait_pending' };
          }
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
      return {
        ...base,
        mode: 'degraded',
        reason: `diagnostician_execution_failed:${detail}`,
        nextAction: 'Inspect the governance workspace runtime profile and provider configuration; the task keeps its pending/retry state and no evidence was mutated.',
        report: { reconcile, admission, diagnostician: null, downstream: null },
      };
    }
  }

  // Step 6 — ONE bounded downstream consumer cycle via the shared executor,
  // with the WorkBuddy host declaration (probe-verified tool names: Read /
  // Write / Edit / Bash are capitalized) persisted for host-neutral consumers.
  const declared = saveHostToolDeclaration(workspaceDir, {
    version: 1,
    hostKind: 'workbuddy',
    mappings: WORKBUDDY_TOOL_SEMANTIC_MAPPINGS,
    declaredAt: new Date().toISOString(),
  });
  if (!declared.ok) {
    logger.warn?.(`[PD:WorkbuddyWorker] Failed to persist WorkBuddy tool declaration: ${declared.reason} — host-neutral consumers will not find it (rc-9)`);
    return {
      ...base,
      mode: 'degraded',
      reason: `host_tool_declaration_persist_failed:${declared.reason}`,
      nextAction: 'Repair WorkBuddy host declaration persistence (.pd/host-tool-semantics/workbuddy.json) before running the downstream internalization cycle; the worker retries automatically on the next cycle.',
      report: { reconcile, admission, diagnostician, downstream: null },
    };
  }
  const downstream = await runInternalizationConsumerCycle(workspaceDir, {
    owner: WORKER_OWNER,
    logLabel: 'WorkbuddyWorker',
    logger,
    emitEvent,
    toolSemantics: WORKBUDDY_TOOL_SEMANTICS,
    hostKinds: ['workbuddy'],
  });

  const degradedReason: string | undefined
    = !reconcile.ok ? `reconcile:${reconcile.reason ?? 'failed'}`
    : !admission.ok ? `admission:${admission.reason ?? 'failed'}`
    : diagnostician?.status === 'failed' && diagnostician.errorCategory !== 'lease_conflict' ? `diagnostician_failed:${diagnostician.message ?? 'max_attempts_exceeded'}`
    : diagnostician?.status === 'degraded' ? `diagnostician_degraded:${diagnostician.message ?? 'unknown'}`
    : downstream.skipReason === 'runtime_config_error' || downstream.skipReason === 'cycle_error' || downstream.skipReason === 'config_malformed' ? `downstream:${downstream.skipReason}`
    : undefined;
  return {
    ...base,
    mode: degradedReason !== undefined ? 'degraded' : 'ready',
    ...(degradedReason !== undefined ? { reason: degradedReason, nextAction: 'Inspect the governance workspace .pd/config.yaml runtime profile and the per-step report above; the worker retries automatically on the next cycle.' } : {}),
    report: { reconcile, admission, diagnostician, downstream },
  };
}
