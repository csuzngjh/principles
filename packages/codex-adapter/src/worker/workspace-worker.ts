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
 *   4. SPEC-CODEX-PAIN-CLOSURE-001 CR-05: continue the post-processing of
 *      succeeded diagnoses (pending candidates, intake/seed orphans) WITHOUT
 *      re-running the diagnosis LLM; CR-08: persist cycle liveness facts
 *      (readiness is computed elsewhere and never implies liveness).
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
  createWorkspaceBehaviorEvidencePort,
  createCodexArtificerTrustedFactsPort,
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

export interface CodexWorkerPostProcessingReport {
  readonly resumedTaskIds: readonly string[];
  readonly processedCount: number;
  /** Eligible-after-this-cycle backlog size (oldest-first scan is bounded). */
  readonly remainingCount: number;
  readonly oldestAgeMs: number | null;
  readonly blocked: readonly { candidateId: string; reason: string }[];
}

export interface CodexWorkerCycleStepReport {
  readonly catchUp: CodexCatchUpResult;
  readonly reconcile: ReconcileGovernanceContinuationResult;
  /** CR-05: succeeded-diagnosis post-processing continuation (no LLM). */
  readonly postProcessing: CodexWorkerPostProcessingReport | null;
  /** At most ONE diagnostician execution per cycle (bounded work). */
  readonly diagnostician: {
    readonly taskId: string;
    readonly status: 'succeeded' | 'failed' | 'retried' | 'skipped' | 'degraded';
    readonly message?: string;
    readonly errorCategory?: string;
    /** PRI-638 P1-C: recovery action for capability-disabled pauses. */
    readonly nextAction?: string;
    /**
     * PRI-917 v0.3.3 review fix (P2-2): candidates parked by the Reuse Review
     * Gate (suspected duplicates awaiting the Owner). Forwarded per-candidate
     * so the report shows WHAT awaits the Owner, not just a degraded status.
     */
    readonly reuseReviewRequiredCandidateIds?: readonly string[];
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
/** CR-05 §9.1: bounded per-cycle post-processing continuation budget. */
const DEFAULT_POST_PROCESSING_LIMIT = 2;
/** CR-08 §9.3: liveness facts are worker-owned runtime state (not governance truth). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LIVENESS_FILE = 'codex-worker-liveness.json';
const LIVENESS_STAGE_DEADLINE_MS = {
  catch_up: 5 * 60_000,
  reconcile: 5 * 60_000,
  diagnosis_execution: 15 * 60_000,
  post_processing: 5 * 60_000,
  downstream_cycle: 10 * 60_000,
};

export function readCodexWorkerLiveness(workspaceDir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(path.resolve(workspaceDir), '.state', LIVENESS_FILE), 'utf8'));
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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

function writeLiveness(workspaceDir: string, patch: Record<string, unknown>): void {
  try {
    const root = path.resolve(workspaceDir);
    const stateDir = path.join(root, '.state');
    const file = path.join(stateDir, LIVENESS_FILE);
    // The subpath is a constant, so containment always holds — the explicit
    // check keeps the write boundary auditable (defense in depth).
    if (!file.startsWith(root + path.sep)) return;
    if (!directoryExists(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    let current: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isPlainRecord(parsed)) current = parsed;
    } catch {
      current = {};
    }
    const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
    // CodeQL (insecure temporary file): the fixed predictable `.tmp` name is a
    // symlink-swap surface in a shared state dir. Write+rename through an
    // EXCLUSIVE random temp file in the same directory (O_EXCL | 0600) — the
    // rename stays atomic within the directory.
    const tmp = path.join(stateDir, `${LIVENESS_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(merged));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch {
    // liveness bookkeeping must never break the cycle (rc-9: the cycle report
    // itself remains the observable degradation channel)
  }
}

/**
 * Oldest pending diagnostician first; retry_wait candidates are filtered to
 * those whose backoff window has ELAPSED, so an old-but-still-waiting task
 * cannot starve a younger eligible one (review P1). The candidate set stays
 * bounded (`limit`), and executePendingDiagnosis re-enforces the backoff
 * window on the chosen task — no double bookkeeping.
 */
const DIAGNOSTICIAN_FAIR_SHARE_SCOPE = 'codex-worker-diagnostician-fair-share';

/**
 * SPEC §9.1 fair-share pick (review P1): pending and due-retry are both
 * continuously-eligible classes; neither may starve the other while new
 * pending signals keep arriving. A persistent round-robin cursor (stored in
 * the existing reconciliation_cursor authority, so a worker restart does NOT
 * reset it to pending-priority) alternates service between the two classes —
 * each eligible class is served at least every other cycle, well inside the
 * 3-full-cycle bound. Single-eligible work is always served.
 */
async function pickDiagnosticianCandidate(stateManager: Awaited<ReturnType<typeof createRuntimeStateHandle>>['stateManager'], limit: number, nowIso: string): Promise<TaskRecord | null> {
  const pending = await stateManager.listTasks({ taskKind: 'diagnostician', status: 'pending', orderBy: 'updated_at_asc', limit });
  const [pendingTask] = pending;
  let retryTask: TaskRecord | null = null;
  const retrying = await stateManager.listTasks({ taskKind: 'diagnostician', status: 'retry_wait', orderBy: 'updated_at_asc', limit });
  for (const candidate of retrying) {
    if (isRetryWaitBackoffElapsed(candidate.status, candidate.leaseExpiresAt)) {
      retryTask = candidate;
      break;
    }
  }
  if (pendingTask === undefined && retryTask === null) return null;
  if (retryTask === null) {
    await stateManager.setDiagnosticianServiceCursor(DIAGNOSTICIAN_FAIR_SHARE_SCOPE, { lastUpdatedAt: nowIso, lastTaskId: 'pending' });
    return pendingTask ?? null;
  }
  if (pendingTask === undefined) {
    await stateManager.setDiagnosticianServiceCursor(DIAGNOSTICIAN_FAIR_SHARE_SCOPE, { lastUpdatedAt: nowIso, lastTaskId: 'retry_wait' });
    return retryTask;
  }
  const cursor = await stateManager.getDiagnosticianServiceCursor(DIAGNOSTICIAN_FAIR_SHARE_SCOPE);
  const serveRetryFirst = cursor?.lastTaskId !== 'retry_wait';
  const servedClass = serveRetryFirst ? 'retry_wait' : 'pending';
  await stateManager.setDiagnosticianServiceCursor(DIAGNOSTICIAN_FAIR_SHARE_SCOPE, { lastUpdatedAt: nowIso, lastTaskId: servedClass });
  return serveRetryFirst ? retryTask : pendingTask;
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
  const cycleStartedAt = new Date();

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
    // PRI-1063 (review fix): single-line flow mapping — see catch-up.ts.
    return { ...base, mode: 'paused', reason: 'host.codex_disabled', nextAction: 'Enable Codex PD behavior in the Workspace .pd/config.yaml — in the existing "features:" block set host.codex: {enabled: true} (one flat key, not nested).' };
  }

  // CR-08: liveness bookkeeping starts only after the workspace proved
  // eligible — writing into a missing workspace directory would fabricate it.
  writeLiveness(workspaceDir, {
    lastCycleStartedAt: cycleStartedAt.toISOString(),
    runningStage: 'catch_up',
    stageDeadline: new Date(cycleStartedAt.getTime() + LIVENESS_STAGE_DEADLINE_MS.catch_up).toISOString(),
  });

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
  const reconcile = await reconcileGovernanceContinuation({
    workspaceDir,
    conversationIngestionEnabled: flags.codex_conversation_ingestion?.enabled === true,
  });

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
      report: { catchUp, reconcile, postProcessing: null, diagnostician: null, downstream: null },
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
        const candidate = await pickDiagnosticianCandidate(handle.stateManager, options.diagnosticianCandidateLimit ?? DEFAULT_DIAG_CANDIDATE_LIMIT, new Date().toISOString());
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
          // PRI-917 v0.3.3 review fix (P2-2): forward the parked-candidate
          // dispositions so the Owner sees the pending items instead of a bare
          // degraded status with no subject.
          const reuseReviewRequired = (executed.candidateOutcomes ?? [])
            .filter((outcome) => outcome.reason === 'reuse_review_required')
            .map((outcome) => outcome.candidateId);
          diagnostician = {
            taskId: candidate.taskId,
            status: executed.status,
            ...(executed.message !== undefined ? { message: executed.message.slice(0, 200) } : {}),
            ...(executed.errorCategory !== undefined ? { errorCategory: executed.errorCategory } : {}),
            ...(reuseReviewRequired.length > 0 ? { reuseReviewRequiredCandidateIds: reuseReviewRequired } : {}),
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
        report: { catchUp, reconcile, postProcessing: null, diagnostician: null, downstream: null },
      };
    }
  }

  // Step 6b — SPEC-CODEX-PAIN-CLOSURE-001 CR-05 (SPEC §9.1): continue the
  // post-processing of SUCCEEDED diagnoses (candidates stuck before
  // admission/intake/seed — the original incident shape) without re-running
  // the diagnosis LLM. Runs in the SAME consumer-flag authority as fresh
  // diagnoses; every class (pending / due-retry / post-processing) is served
  // every cycle it has eligible work, so no class can starve another
  // (SPEC §9.1: each eligible class served within 3 full cycles).
  let postProcessing: CodexWorkerPostProcessingReport | null = null;
  writeLiveness(workspaceDir, { runningStage: 'post_processing', stageDeadline: new Date(Date.now() + LIVENESS_STAGE_DEADLINE_MS.post_processing).toISOString() });
  if (consumerFlag.enabled && !diagnosticianDisabled) {
    try {
      const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
      try {
        const { eligible: backlog, corrupt } = await handle.stateManager.listDiagnosisPostProcessingBacklog({ limit: DEFAULT_POST_PROCESSING_LIMIT });
        const { eligible: backlogAll, corrupt: corruptAll } = await handle.stateManager.listDiagnosisPostProcessingBacklog({ limit: 200 });
        const oldestCreatedAt = backlogAll[0]?.createdAt;
        const blocked: { candidateId: string; reason: string }[] = [];
        // SPEC review round-4 P1: corrupt admission_json rows are surfaced as a
        // candidate-level queryable blocker — never deleted, never eligible for
        // writes, never blocking healthy work (the scan filters via json_valid).
        for (const item of corruptAll) {
          blocked.push({ candidateId: item.candidateId, reason: 'admission_json_corrupt: repair or re-run the diagnosis (pd candidate show reports the unreadable disposition)' });
        }
        const resumedTaskIds = new Set<string>();
        if (backlog.length > 0) {
          const stateDir = path.join(workspaceDir, '.state');
          const bridge = await createPainSignalBridge({
            workspaceDir,
            stateDir,
            ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
            owner: WORKER_OWNER,
            effectiveConfig: config.effective,
            getEnvVar: (name: string) => process.env[name],
          });
          for (const item of backlog) {
            const resumed = await bridge.resumeSucceededDiagnosisPostProcessing({ taskId: item.taskId });
            if (resumed.status === 'resumed') {
              resumedTaskIds.add(item.taskId);
            } else if (resumed.status === 'blocked') {
              blocked.push({ candidateId: item.candidateId, reason: resumed.reason ?? 'blocked' });
            }
            for (const skip of resumed.skipped ?? []) blocked.push(skip);
          }
        }
        postProcessing = {
          resumedTaskIds: [...resumedTaskIds],
          processedCount: backlog.length,
          remainingCount: Math.max(0, backlogAll.length - backlog.length),
          oldestAgeMs: oldestCreatedAt !== undefined ? Math.max(0, Date.now() - Date.parse(oldestCreatedAt)) : null,
          blocked,
        };
        if (corrupt.length > 0) {
          emitEvent('CODEX_WORKER_ADMISSION_CORRUPT', JSON.stringify({ candidateIds: corruptAll.map((c) => c.candidateId) }));
        }
        if (backlog.length > 0) {
          emitEvent('CODEX_WORKER_POST_PROCESSING', JSON.stringify(postProcessing));
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
      return {
        ...base,
        mode: 'degraded',
        reason: `post_processing_continuation_failed:${detail}`,
        nextAction: 'Inspect the workspace state.db principle_candidates/tasks; the worker retries automatically on the next cycle.',
        report: { catchUp, reconcile, postProcessing: null, diagnostician, downstream: null },
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
    // CodeRabbit CR-2 (PRI-813): creating activations while the Codex
    // declaration is absent would let promotion fall back to the OpenClaw
    // liveness contract (host_tool_declaration_missing → OpenClaw default)
    // and falsely pass host-liveness checks for a Codex activation. Degrade
    // this cycle instead; the next cycle retries the declaration first.
    return {
      ...base,
      mode: 'degraded',
      reason: `host_tool_declaration_persist_failed:${declared.reason}`,
      nextAction: 'Repair Codex host declaration persistence (.pd/host-tool-semantics/codex.json) before running the downstream internalization cycle; the worker retries automatically on the next cycle.',
      report: { catchUp, reconcile, postProcessing: null, diagnostician, downstream: null },
    };
  }
  writeLiveness(workspaceDir, { runningStage: 'downstream_cycle', stageDeadline: new Date(Date.now() + LIVENESS_STAGE_DEADLINE_MS.downstream_cycle).toISOString() });
  const downstream = await runInternalizationConsumerCycle(workspaceDir, {
    owner: WORKER_OWNER,
    logLabel: 'CodexWorker',
    logger,
    emitEvent,
    behaviorEvidence: createWorkspaceBehaviorEvidencePort(workspaceDir, CODEX_TOOL_SEMANTICS),
    trustedFacts: createCodexArtificerTrustedFactsPort(),
    toolSemantics: CODEX_TOOL_SEMANTICS,
    // PRI-741: artificer generation gets the Codex host projection
    // (Bash/apply_patch — evidence-bound, intentionally sparse).
    hostKinds: ['codex'],
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
  writeLiveness(workspaceDir, {
    runningStage: null,
    stageDeadline: null,
    lastCycleCompletedAt: new Date().toISOString(),
    lastCycleDurationMs: Date.now() - cycleStartedAt.getTime(),
    lastCycleMode: degradedReason !== undefined ? 'degraded' : 'ready',
    ...(degradedReason !== undefined ? { lastDegradedReason: degradedReason } : {}),
  });
  return {
    ...base,
    mode: degradedReason !== undefined ? 'degraded' : 'ready',
    ...(degradedReason !== undefined ? { reason: degradedReason, nextAction: 'Inspect the Workspace .pd/config.yaml runtime profile and the per-step report above; the worker retries automatically on the next cycle.' } : {}),
    report: { catchUp, reconcile, postProcessing, diagnostician, downstream },
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
