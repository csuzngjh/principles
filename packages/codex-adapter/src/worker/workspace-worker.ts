/**
 * Codex Workspace worker cycle (PRI-624 Slice C; SPEC §13/§15; ADR-0020 §11.1).
 *
 * ONE Workspace-scoped worker cycle with exactly three background
 * responsibilities (the Owner-approved MVP exception — NOT a general daemon):
 *
 *   1. catch up transcript lag   (gated by codex_conversation_ingestion)
 *   2. run the Slice B idempotent reconciliation pass
 *   3. lease + run one Diagnostician task, then ONE bounded downstream
 *      consumer cycle through the SHARED host-neutral executor
 *      (internalization_auto_consumer = workspace execution authority)
 *
 * Every step reuses existing authority: catch-up reuses the Slice A/B
 * ingestion + admission seams, reconciliation reuses
 * `reconcileGovernanceContinuation`, the diagnostician reuses the
 * PainSignalBridge lease/runner contract, downstream reuses the same
 * `runInternalizationConsumerCycle` the OpenClaw auto-consumer runs. No new
 * task store, no private retry queue, no second scheduler state.
 *
 * Correctness under concurrent consumers (OpenClaw auto-consumer + this
 * worker on one workspace) is owned by the durable Runtime V2 task lease —
 * never by process-local state.
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
  loadPdConfigForPlugin,
  loadFeatureFlagFromConfig,
  reconcileGovernanceContinuation,
  runInternalizationConsumerCycle,
  saveHostToolDeclaration,
  type InternalizationConsumerCycleOutcome,
  type ConsumerCycleLogger,
  type ReconcileGovernanceContinuationResult,
} from '@principles/host-runtime';
import { catchUpCodexIngestion, type CodexCatchUpResult } from '../ingestion/catch-up.js';
import type { TranscriptPort } from '../ingestion/transcript-decoder.js';
import { CODEX_TOOL_SEMANTIC_MAPPINGS, CODEX_TOOL_SEMANTICS } from '../tool-semantics.js';

export type CodexWorkerMode = 'ready' | 'manual_action_required' | 'paused' | 'degraded';

export interface CodexWorkerCycleStepReport {
  readonly catchUp: CodexCatchUpResult;
  readonly reconcile: ReconcileGovernanceContinuationResult;
  /** At most ONE diagnostician execution per cycle (bounded work). */
  readonly diagnostician: {
    readonly taskId: string;
    readonly status: 'succeeded' | 'failed' | 'retried' | 'skipped' | 'degraded';
    readonly message?: string;
    readonly errorCategory?: string;
    /** PRI-638 P1-C: recovery action for capability-disabled pauses. */
    readonly nextAction?: string;
  } | null;
  readonly downstream: InternalizationConsumerCycleOutcome | null;
}

export interface CodexWorkerCycleResult {
  readonly workspaceDir: string;
  readonly mode: CodexWorkerMode;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly report?: CodexWorkerCycleStepReport;
}

export interface CodexWorkerCycleOptions {
  readonly workspaceDir: string;
  readonly env?: { CODEX_HOME?: string | undefined };
  readonly now?: Date;
  readonly logger?: ConsumerCycleLogger;
  readonly emitEvent?: (event: string, payloadJson: string) => void;
  readonly port?: TranscriptPort;
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
 * those whose backoff window has ELAPSED, so an old-but-still-waiting task
 * cannot starve a younger eligible one (review P1). The candidate set stays
 * bounded (`limit`), and executePendingDiagnosis re-enforces the backoff
 * window on the chosen task — no double bookkeeping.
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
 * Run ONE bounded worker cycle for a canonical workspace. Never throws:
 * every failure becomes a structured degraded result with a nextAction.
 */
export async function runCodexWorkspaceWorkerCycle(options: CodexWorkerCycleOptions): Promise<CodexWorkerCycleResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const logger = workerLogger(options.logger);
  const emitEvent = options.emitEvent ?? ((_event: string, _payload: string) => undefined);
  const base = { workspaceDir };

  // Step 1 — Workspace eligibility.
  if (!directoryExists(workspaceDir)) {
    return { ...base, mode: 'degraded', reason: 'workspace_missing', nextAction: 'The workspace directory no longer exists; remove it from the install manifest or restore it. No PD state was mutated.' };
  }

  const config = loadPdConfigForPlugin(workspaceDir);
  if (!config.ok) {
    const [first] = config.errors;
    return { ...base, mode: 'degraded', reason: `pd_config_invalid:${first?.reason ?? 'unknown'}`, nextAction: first?.nextAction ?? 'Repair .pd/config.yaml.' };
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  if (flags['host.codex']?.enabled !== true) {
    return { ...base, mode: 'paused', reason: 'host.codex_disabled', nextAction: 'Set features.host.codex.enabled=true in the Workspace .pd/config.yaml to enable Codex PD behavior.' };
  }

  const consumerFlag = loadFeatureFlagFromConfig(workspaceDir, 'internalization_auto_consumer', { info: (m) => logger.info(m), warn: (m) => logger.warn(m) });

  // PRI-638 P1-C: the Diagnostician capability gate is resolved from the same
  // canonical authority the runtime factory uses. An Owner-disabled agent is
  // an intentional governance state: the worker must NOT pick pending tasks,
  // must NOT invoke any runner (provider calls = 0), must NOT report the
  // workspace degraded, and must keep catch-up / reconciliation / downstream
  // running. Pending tasks stay untouched and resume on a later cycle after
  // the Owner re-enables the agent.
  const capability = resolveDiagnosticianCapability(config.effective);
  const diagnosticianDisabled = !capability.available;

  // Step 2 — Catch-up transcript lag (SPEC §13: gated by the ingestion flag,
  // NOT by the consumer flag; catchUpCodexIngestion re-checks and returns a
  // zero-I/O skip when ingestion is off).
  const catchUp = await catchUpCodexIngestion({
    workspaceDir,
    env: options.env,
    now: options.now,
    port: options.port,
  });

  // Step 3 — Slice B idempotent reconciliation (always runs; creates no LLM work).
  const reconcile = await reconcileGovernanceContinuation({ workspaceDir });

  // Steps 4–6 — execution authority: internalization_auto_consumer.
  let diagnostician: CodexWorkerCycleStepReport['diagnostician'] = null;
  if (diagnosticianDisabled) {
    // PRI-638 P1-C: intentional governance pause. No candidate picking, no
    // provider call, no degraded mode. The rest of the cycle (downstream)
    // continues below; pending tasks resume once the Owner re-enables.
    diagnostician = {
      taskId: '',
      status: 'skipped',
      message: 'capability_disabled',
      nextAction: capability.available ? undefined : capability.nextAction,
    };
  } else if (!consumerFlag.enabled) {
    // paused: execution pause, NOT evidence freeze. Catch-up + reconcile
    // already ran above; manual CLI remains allowed (SPEC §13).
    return {
      ...base,
      mode: 'paused',
      reason: 'internalization_auto_consumer_disabled',
      nextAction: 'Automatic internalization execution is paused for this Workspace; manual commands remain available: pd diagnose, pd runtime internalization run-once.',
      report: { catchUp, reconcile, diagnostician: null, downstream: null },
    };
  } else {
    // Step 4 — expired-lease recovery sweep, then Step 5/6: at most one
    // Diagnostician task via the existing bridge lease/runner contract.
    // (Reached only when the Diagnostician capability is enabled AND the
    // consumer flag is on — an intentional capability pause never reaches
    // candidate picking or any provider call.)
    try {
      const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
      try {
        const sweep = await handle.stateManager.runRecoverySweep();
        if (sweep.recovered > 0 || sweep.errors.length > 0) {
          emitEvent('CODEX_WORKER_RECOVERY_SWEEP', JSON.stringify({ recovered: sweep.recovered, failed: sweep.errors.length }));
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
          // The bridge stays cached per workspace (bounded: one per workspace
          // per worker process, exactly like the OpenClaw plugin host) — no
          // per-cycle dispose, so a concurrent cycle can never hit a disposed
          // bridge. The factory self-disposes losing concurrent constructions.
        } else {
          // No eligible candidate, but a retry_wait task may still be inside
          // its backoff window — report it so the cycle is observable instead
          // of looking like "nothing pending" (review P1: head-of-line).
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
        nextAction: 'Inspect the Workspace runtime profile and provider configuration; the task keeps its pending/retry state and no evidence was mutated.',
        report: { catchUp, reconcile, diagnostician: null, downstream: null },
      };
    }
  }

  // Step 7 — ONE bounded downstream consumer cycle via the shared executor
  // (same implementation the OpenClaw auto-consumer runs).
  // PRI-634-F R2: persist the Codex tool declaration (workspace provenance
  // for host-neutral consumers) and thread the registry into the cycle so
  // activation-gate replay resolves Codex tool semantics (Bash, not bash).
  const declared = saveHostToolDeclaration(workspaceDir, {
    version: 1,
    hostKind: 'codex',
    mappings: CODEX_TOOL_SEMANTIC_MAPPINGS,
    declaredAt: new Date().toISOString(),
  });
  if (!declared.ok) {
    logger.warn?.(`[PD:CodexWorker] Failed to persist Codex tool declaration: ${declared.reason} — host-neutral consumers will not find it (rc-9)`);
  }
  const downstream = await runInternalizationConsumerCycle(workspaceDir, {
    owner: WORKER_OWNER,
    logLabel: 'CodexWorker',
    logger,
    emitEvent,
    toolSemantics: CODEX_TOOL_SEMANTICS,
    // No hostToolCatalog: PD has not declared a Codex tool catalog; a wrong
    // (OpenClaw) catalog would be worse than none (PRI-630 follow-up).
  });

  // Aggregated mode: degraded overrides all (review P1).  Any component
  // degrading — catch-up, reconciliation, diagnostician or downstream —
  // surfaces the workspace as degraded, with the highest-priority reason.
  // A lease_conflict diagnostician failure is contention, not degradation:
  // another consumer owns the task, which is normal operation.
  const degradedReason: string | undefined
    = catchUp.status === 'degraded' ? `catch_up:${catchUp.remainingLagRollouts[0] ?? 'unknown'}`
    : !reconcile.ok ? `reconcile:${reconcile.reason ?? 'failed'}`
    : diagnostician?.status === 'failed' && diagnostician.errorCategory !== 'lease_conflict' ? `diagnostician_failed:${diagnostician.message ?? 'max_attempts_exceeded'}`
    : diagnostician?.status === 'degraded' ? `diagnostician_degraded:${diagnostician.message ?? 'unknown'}`
    : downstream.skipReason === 'runtime_config_error' || downstream.skipReason === 'cycle_error' || downstream.skipReason === 'config_malformed' ? `downstream:${downstream.skipReason}`
    : undefined;
  return {
    ...base,
    mode: degradedReason !== undefined ? 'degraded' : 'ready',
    ...(degradedReason !== undefined ? { reason: degradedReason, nextAction: 'Inspect the Workspace .pd/config.yaml runtime profile and the per-step report above; the worker retries automatically on the next cycle.' } : {}),
    report: { catchUp, reconcile, diagnostician, downstream },
  };
}

export interface CodexWorkerStatusEvaluation {
  readonly mode: CodexWorkerMode;
  readonly reason?: string;
  readonly nextAction?: string;
}

// Slice D (PRI-625): the mode authority moved to host-runtime so the CLI and
// Console §15 health surfaces share ONE semantics with the worker. Re-exported
// here for compatibility with every existing importer.
export { computeCodexWorkerStatusMode } from '@principles/host-runtime';
