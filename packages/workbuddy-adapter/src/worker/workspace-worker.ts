/**
 * WorkBuddy Workspace worker cycle (SPEC workbuddy-host-adapter §5 Part 5;
 * ADR-0020 §11.1 shape, third host instance).
 *
 * ONE Workspace-scoped worker cycle with three bounded background
 * responsibilities (PRI-1171 P2 tickets ⑤/⑥): transcript catch-up (gated by
 * workbuddy_conversation_ingestion AND the v3 consent ledger), idempotent
 * reconciliation, and one diagnostician/consumer pass. Catch-up runs BEFORE
 * the paused early-return so hook lag keeps draining even while execution is
 * off. Flag-off performs zero transcript I/O.
 *
 *   1. run the idempotent reconciliation pass (shared host-runtime authority)
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
 * durable Runtime task lease — never by process-local state. The
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
  pickDiagnosticianCandidate,
  reconcileWaitingTargetEvidenceTasks,
  type TargetEvidenceReconcileReport,
  PrincipleTreeLedgerAdapter,
  resolveDiagnosticianCapability,
  storeEmitter,
  type TaskRecord,
} from '@principles/core/runtime';
import {
  loadPdConfigForPlugin,
  loadFeatureFlagFromConfig,
  reconcileGovernanceContinuation,
  runInternalizationConsumerCycle,
  runStage2CorrectionCycle,
  createSignalClassifierForWorkspace,
  createGovernanceTrajectoryTurnReader,
  createConsentLedgerSourceMaterialAuthorization,
  createHostIntentDocReader,
  WorkspaceTelemetryEmitter,
  isAutomaticPainSubmissionAuthorized,
  saveHostToolDeclaration,
  HOST_TOOL_DECLARATION_VERSION,
  type InternalizationConsumerCycleOutcome,
  type ConsumerCycleLogger,
  type ReconcileGovernanceContinuationResult,
  type SignalLlmClassifier,
  type Stage2CorrectionCycleReport,
} from '@principles/host-runtime';
import { WORKBUDDY_TOOL_SEMANTICS, WORKBUDDY_TOOL_SEMANTIC_MAPPINGS } from '../tool-semantics.js';
import { catchUpWorkbuddyIngestion, type WorkbuddyCatchUpResult } from '../ingestion/catch-up.js';
import { readWorkbuddyTargetTurnEvidence } from '../ingestion/pain-receipt-fallback.js';

export type WorkbuddyWorkerMode = 'ready' | 'manual_action_required' | 'paused' | 'degraded';

export interface WorkbuddyWorkerCycleStepReport {
  /** PRI-1171 P2 ticket ⑤: bounded transcript catch-up, before reconciliation. */
  readonly catchUp: WorkbuddyCatchUpResult;
  readonly reconcile: ReconcileGovernanceContinuationResult;
  /** At most ONE diagnostician execution per cycle (bounded work). */
  readonly diagnostician: {
    readonly taskId: string;
    readonly status: 'succeeded' | 'failed' | 'retried' | 'skipped' | 'degraded';
    readonly message?: string;
    readonly errorCategory?: string;
    readonly nextAction?: string;
  } | null;
  readonly downstream: InternalizationConsumerCycleOutcome | null;
  /** PRI-1296: bounded exact-target evidence reconcile, before candidate picking. */
  readonly targetEvidenceReconcile?: TargetEvidenceReconcileReport;
  /** Phase B Stage-2 review step (always last, ≤2 candidates / ≤60s aggregate). */
  readonly stage2?: Stage2CorrectionCycleReport;
}

export interface WorkbuddyWorkerCycleResult {
  readonly workspaceDir: string;
  readonly mode: WorkbuddyWorkerMode;
  readonly reason?: string;
  readonly nextAction?: string;
  /**
   * Degradations that did NOT decide the cycle mode. A `paused` cycle still
   * runs catch-up, so its degradation must stay visible instead of being
   * swallowed by the paused early return (P2 review).
   */
  readonly degradations?: readonly string[];
  readonly report?: WorkbuddyWorkerCycleStepReport;
}

export interface WorkbuddyWorkerCycleOptions {
  readonly workspaceDir: string;
  readonly now?: Date;
  readonly logger?: ConsumerCycleLogger;
  readonly emitEvent?: (event: string, payloadJson: string) => void;
  /** Cap on diagnostician candidates inspected per cycle (default 5). */
  readonly diagnosticianCandidateLimit?: number;
  /** Stage-2 classifier injection (tests); undefined = resolve from config. */
  readonly stage2Classifier?: SignalLlmClassifier | null;
  readonly stage2AggregateBudgetMs?: number;
}

const WORKER_OWNER = 'companion-worker';
const DEFAULT_DIAG_CANDIDATE_LIMIT = 5;

// ── Cycle liveness (Phase 2, SPEC §11 / TD §2.3: WorkBuddy had NO liveness
// record — FR-10 health was undecidable). Same shape and atomic-write
// discipline as the Codex worker's `.state/codex-worker-liveness.json`
// (CR-08 §9.3: liveness facts are worker-owned runtime state, never
// governance truth). ────────────────────────────────────────────────────
const LIVENESS_FILE = 'workbuddy-worker-liveness.json';
const LIVENESS_STAGE_DEADLINE_MS = {
  catch_up: 5 * 60_000,
  reconcile: 5 * 60_000,
  diagnosis_execution: 15 * 60_000,
  downstream_cycle: 10 * 60_000,
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * WHO drove this cycle — same attribution contract as the Codex worker
 * (PRI-1264 + Phase 2 `service_host` driver identity, TD §5.2).
 */
export function workbuddyWorkerCycleDriver(): 'companion' | 'service_host' | 'manual' {
  const source = process.env.PD_INVOCATION_SOURCE;
  if (source === 'companion') return 'companion';
  if (source === 'service_host') return 'service_host';
  return 'manual';
}

/**
 * F13 (TD §5.2): the coordinator passes a unique invocation id; when
 * present it lands in the liveness record so the shared per-workspace file
 * can be correlated back to the exact Service Host invocation.
 * R5 review fix: a manual/companion cycle carries NO invocation id, so the
 * patch must CLEAR the field — otherwise a completed manual run would keep
 * masquerading under the previous shadow run's id.
 */
function invocationIdLivenessPatch(): Record<string, unknown> {
  const invocationId = process.env.PD_INVOCATION_ID;
  return typeof invocationId === 'string' && invocationId.length > 0
    ? { lastInvocationId: invocationId }
    : { lastInvocationId: null };
}

/** Read the persisted liveness record, or null when absent/unreadable. */
export function readWorkbuddyWorkerLiveness(workspaceDir: string): Record<string, unknown> | null {
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
    // Exclusive random temp + rename (same CodeQL-safe pattern as Codex).
    const tmp = path.join(stateDir, `${LIVENESS_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(merged));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch {
    // Liveness bookkeeping must never break the cycle (rc-9: the cycle
    // report remains the observable degradation channel).
  }
}

/**
 * F9 review fix: settle the liveness record for EARLY returns (consumer
 * pause, structured degradations). A cycle that stops after the `catch_up`
 * stage write must not leave a stale runningStage + deadline behind —
 * liveness readers would report the finished cycle as still mid-stage.
 */
function finalizeLiveness(
  workspaceDir: string,
  cycleStartedAt: Date,
  settlement: { mode: 'paused' | 'degraded'; reason?: string },
): void {
  writeLiveness(workspaceDir, {
    runningStage: null,
    stageDeadline: null,
    lastCycleCompletedAt: new Date().toISOString(),
    lastCycleDurationMs: Date.now() - cycleStartedAt.getTime(),
    lastCycleMode: settlement.mode,
    lastCycleDriver: workbuddyWorkerCycleDriver(),
    ...(settlement.reason !== undefined ? { lastDegradedReason: settlement.reason } : {}),
    ...invocationIdLivenessPatch(),
  });
}

/**
 * PRI-1275 review round (CR-2): the candidate pick delegates to the SHARED
 * Core `pickDiagnosticianCandidate` — the same authority the Codex worker
 * uses. Its store queries exclude `waiting_for_target_evidence` /
 * `blocked_by_source_material_consent` tasks INSIDE the SQL (before ORDER BY
 * + LIMIT), so a task left waiting by the receipt recovery can never block
 * the head of this host's diagnostician queue (SPEC §4 A3), and the
 * pending/retry_wait fair-share cursor stays one implementation for both
 * hosts. The local oldest-first variant this replaces had none of those
 * exclusions.
 */
async function pickNextDiagnosticianCandidate(
  stateManager: Awaited<ReturnType<typeof createRuntimeStateHandle>>['stateManager'],
  limit: number,
): Promise<TaskRecord | null> {
  return pickDiagnosticianCandidate(stateManager, limit, new Date().toISOString());
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
  const cycleStartedAt = new Date();

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
    // Same PRI-1264 discipline as Codex: an intentional CONFIG pause keeps
    // the heartbeat alive — the worker IS cycling, deliberately idle.
    writeLiveness(workspaceDir, {
      runningStage: 'paused',
      stageDeadline: null,
      lastCycleStartedAt: cycleStartedAt.toISOString(),
      lastCycleDriver: workbuddyWorkerCycleDriver(),
    });
    // PRI-1063 (review fix): single-line flow mapping — see pd-hook.ts.
    return { ...base, mode: 'paused', reason: 'host.workbuddy_disabled', nextAction: 'Enable WorkBuddy PD behavior in the governance workspace .pd/config.yaml — in the existing "features:" block set host.workbuddy: {enabled: true} (one flat key, not nested).' };
  }

  // Liveness bookkeeping starts only after eligibility (CR-08 ordering —
  // writing into a missing workspace directory would fabricate it).
  writeLiveness(workspaceDir, {
    lastCycleStartedAt: cycleStartedAt.toISOString(),
    runningStage: 'catch_up',
    stageDeadline: new Date(cycleStartedAt.getTime() + LIVENESS_STAGE_DEADLINE_MS.catch_up).toISOString(),
    lastCycleDriver: workbuddyWorkerCycleDriver(),
  });

  const consumerFlag = loadFeatureFlagFromConfig(workspaceDir, 'internalization_auto_consumer', { info: (m) => logger.info(m), warn: (m) => logger.warn(m) });

  // The Diagnostician capability gate resolves from the same canonical
  // authority as the runtime factory. An Owner-disabled agent is an
  // intentional governance state: no candidate picking, no provider calls,
  // no degraded mode; reconciliation and downstream keep running.
  const capability = resolveDiagnosticianCapability(config.effective);
  const diagnosticianDisabled = !capability.available;

  // Step 2 — Bounded transcript catch-up (PRI-1171 P2 ⑤). Runs BEFORE the
  // consumer paused early-return, and performs ZERO transcript I/O when the
  // flag or the consent record is off (both gates live in the orchestrator).
  const ingestionEnabled = flags.workbuddy_conversation_ingestion?.enabled === true;
  const catchUp = catchUpWorkbuddyIngestion({
    workspaceDir,
    ingestionEnabled,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  // Step 3 — Idempotent reconciliation (always runs; creates no LLM work).
  // `codexConversationIngestionEnabled` gates the CODEX-only promotion
  // recovery (it promotes Codex transcript evidence). The WorkBuddy worker has
  // no authority over that consent, so it never passes its own flag: doing so
  // would let opting into WorkBuddy ingestion unlock promotion of Codex
  // session evidence after a Codex opt-out.
  const reconcile = await reconcileGovernanceContinuation({
    workspaceDir,
    codexConversationIngestionEnabled: false,
    // Legacy alias: both names must stay false for an older host-runtime.
    conversationIngestionEnabled: false,
  });

  // Steps 3–5 — execution authority: internalization_auto_consumer.
  let diagnostician: WorkbuddyWorkerCycleStepReport['diagnostician'] = null;
  // PRI-1296: filled by the exact-target evidence reconcile below.
  let targetEvidenceReconcile: TargetEvidenceReconcileReport | null = null;
  if (diagnosticianDisabled) {
    diagnostician = {
      taskId: '',
      status: 'skipped',
      message: 'capability_disabled',
      nextAction: capability.available ? undefined : capability.nextAction,
    };
  } else if (!consumerFlag.enabled) {
    // F9: the cycle ENDED here (paused) — settle the liveness record so the
    // in-flight `catch_up` stage and its deadline do not survive it.
    // P2-01 (final-remediation review): EVERY earlier stage's failure must
    // reach the result — not catch-up only. A reconcile failure under a
    // consumer pause is a degraded cycle, never a clean paused + exit 0.
    const prePauseDegradations: string[] = [];
    if (catchUp.status === 'degraded') {
      prePauseDegradations.push(`catch_up:${catchUp.reason ?? 'degraded'}`);
    }
    if (!reconcile.ok) {
      prePauseDegradations.push(`reconcile:${reconcile.reason ?? 'failed'}`);
    }
    for (const d of reconcile.degradations) {
      const tagged = `reconcile:${d}`;
      if (!prePauseDegradations.includes(tagged)) prePauseDegradations.push(tagged);
    }
    if (prePauseDegradations.length > 0) {
      const reason = `paused_stage_failures:${prePauseDegradations.join('|').slice(0, 160)}`;
      finalizeLiveness(workspaceDir, cycleStartedAt, { mode: 'degraded', reason });
      return {
        ...base,
        mode: 'degraded',
        reason,
        // Keep the REAL failing stage's recovery guidance ahead of the
        // generic pause hint (P2-01 §C: catchUp.nextAction must not be
        // overwritten by a generic paused suggestion).
        nextAction: catchUp.status === 'degraded' && catchUp.nextAction !== undefined
          ? catchUp.nextAction
          : (reconcile.nextAction ?? 'Inspect the governance workspace trajectory store and transcript consent; the worker retries automatically on the next cycle.'),
        degradations: prePauseDegradations,
        report: { catchUp, reconcile, diagnostician: null, downstream: null },
      };
    }
    finalizeLiveness(workspaceDir, cycleStartedAt, { mode: 'paused' });
    return {
      ...base,
      mode: 'paused',
      reason: 'internalization_auto_consumer_disabled',
      nextAction: 'Automatic internalization execution is paused for this governance workspace; manual commands remain available: pd diagnose, pd runtime internalization run-once.',
      report: { catchUp, reconcile, diagnostician: null, downstream: null },
    };
  } else {
    try {
      const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
      try {
        const sweep = await handle.stateManager.runRecoverySweep();
        if (sweep.recovered > 0 || sweep.errors.length > 0) {
          emitEvent('WORKBUDDY_WORKER_RECOVERY_SWEEP', JSON.stringify({ recovered: sweep.recovered, failed: sweep.errors.length }));
        }
        // PRI-1296: reconcile waiting target evidence BEFORE the candidate
        // picker. Catch-up may have just delivered the exact target turn, and
        // the picker SQL excludes waiting tasks; doing this after picking
        // would let diagnosis consume a task before its evidence exists.
        targetEvidenceReconcile = await reconcileWaitingTargetEvidenceTasks({
          stateManager: handle.stateManager,
          readTargetTurnEvidence: (sessionId, turnId) => readWorkbuddyTargetTurnEvidence(workspaceDir, sessionId, turnId),
          sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(workspaceDir),
          hostKind: 'workbuddy',
          nowIso: new Date().toISOString(),
        });
        if (targetEvidenceReconcile.flipped > 0 || targetEvidenceReconcile.blocked > 0 || targetEvidenceReconcile.errors.length > 0) {
          emitEvent('WORKBUDDY_WORKER_TARGET_EVIDENCE_RECONCILE', JSON.stringify(targetEvidenceReconcile));
        }
        const candidate = await pickNextDiagnosticianCandidate(handle.stateManager, options.diagnosticianCandidateLimit ?? DEFAULT_DIAG_CANDIDATE_LIMIT);
        if (candidate !== null) {
          const stateDir = path.join(workspaceDir, '.state');
          let releaseBridge: (() => Promise<void>) | undefined;
          try {
            const bridge = await createPainSignalBridge({
              workspaceDir,
              stateDir,
              ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
              owner: WORKER_OWNER,
              effectiveConfig: config.effective,
              getEnvVar: (name: string) => process.env[name],
              // PRI-1233 / SPEC §9.2: this worker is where Stage A actually runs
              // for governance-admitted WorkBuddy pains — the neutral host reader
              // must ride along (flag-off = zero filesystem access inside it).
              intentDocReader: createHostIntentDocReader({ workspaceDir, effectiveConfig: config.effective }),
              // PRI-1287 review round: this worker is also a Stage A entry point.
              // Bind the same workspace-scoped critical-event sink as the L3
              // auto-run so Intent degradation evidence survives the process.
              telemetrySink: new WorkspaceTelemetryEmitter(storeEmitter, workspaceDir, (detail) => {
                try {
                  emitEvent('WORKBUDDY_WORKER_CRITICAL_TELEMETRY_PERSIST_FAILED', detail);
                } catch {
                  // Telemetry persistence warnings must never fail the worker cycle.
                }
              }),
              // PRI-1265: the worker's Stage A gets the bound session's ORIGINAL
              // turns from the workspace's own consent-tiered governance store.
              trajectoryTurnReader: createGovernanceTrajectoryTurnReader({ workspaceDir, sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(workspaceDir) }),
              // PRI-1283 R2: latest-consent gate consulted per assembly / model call.
              sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(workspaceDir),
              // SPEC §9.6: lazy probe — a revoked flag stops persisted
              // automatic_hook tasks at the bridge's execution boundary.
              isAutoPainSubmissionAuthorized: () => isAutomaticPainSubmissionAuthorized(workspaceDir),
            }, (release) => { releaseBridge = release; });
            const executed = await bridge.executePendingDiagnosis({ taskId: candidate.taskId });
            diagnostician = {
              taskId: candidate.taskId,
              status: executed.status,
              ...(executed.message !== undefined ? { message: executed.message.slice(0, 200) } : {}),
              ...(executed.errorCategory !== undefined ? { errorCategory: executed.errorCategory } : {}),
            };
          } finally {
            await releaseBridge?.();
          }
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
      const reason = `diagnostician_execution_failed:${detail}`;
      // F9: settle the liveness record on the degraded early return.
      finalizeLiveness(workspaceDir, cycleStartedAt, { mode: 'degraded', reason });
      return {
        ...base,
        mode: 'degraded',
        reason,
        nextAction: 'Inspect the governance workspace runtime profile and provider configuration; the task keeps its pending/retry state and no evidence was mutated.',
        report: { catchUp, reconcile, diagnostician: null, downstream: null, ...(targetEvidenceReconcile !== null ? { targetEvidenceReconcile } : {}) },
      };
    }
  }

  // Step 6 — ONE bounded downstream consumer cycle via the shared executor,
  // with the WorkBuddy host declaration (probe-verified tool names: Read /
  // Write / Edit / Bash are capitalized) persisted for host-neutral consumers.
  const declared = saveHostToolDeclaration(workspaceDir, {
    version: HOST_TOOL_DECLARATION_VERSION,
    hostKind: 'workbuddy',
    mappings: WORKBUDDY_TOOL_SEMANTIC_MAPPINGS,
    declaredAt: new Date().toISOString(),
  });
  if (!declared.ok) {
    logger.warn?.(`[PD:WorkbuddyWorker] Failed to persist WorkBuddy tool declaration: ${declared.reason} — host-neutral consumers will not find it (rc-9)`);
    const reason = `host_tool_declaration_persist_failed:${declared.reason}`;
    // F9: settle the liveness record on the degraded early return.
    finalizeLiveness(workspaceDir, cycleStartedAt, { mode: 'degraded', reason });
    return {
      ...base,
      mode: 'degraded',
      reason,
      nextAction: 'Repair WorkBuddy host declaration persistence (.pd/host-tool-semantics/workbuddy.json) before running the downstream internalization cycle; the worker retries automatically on the next cycle.',
      report: { catchUp, reconcile, diagnostician, downstream: null, ...(targetEvidenceReconcile !== null ? { targetEvidenceReconcile } : {}) },
    };
  }
  writeLiveness(workspaceDir, { runningStage: 'downstream_cycle', stageDeadline: new Date(Date.now() + LIVENESS_STAGE_DEADLINE_MS.downstream_cycle).toISOString() });
  const downstream = await runInternalizationConsumerCycle(workspaceDir, {
    owner: WORKER_OWNER,
    logLabel: 'WorkbuddyWorker',
    logger,
    emitEvent,
    toolSemantics: WORKBUDDY_TOOL_SEMANTICS,
    hostKinds: ['workbuddy'],
  });

  // Step 7 (SPEC v0.3.1 §2) — Stage-2 correction review, ALWAYS last.
  const stage2Resolution = options.stage2Classifier === undefined
    ? createSignalClassifierForWorkspace(workspaceDir)
    : null;
  const stage2Classifier = options.stage2Classifier !== undefined
    ? options.stage2Classifier
    : (stage2Resolution?.ok === true ? stage2Resolution.classifier : null);
  const stage2ClassifierState = options.stage2Classifier === null
    ? 'disabled'
    : stage2Classifier === null
      ? (stage2Resolution !== null && !stage2Resolution.ok && stage2Resolution.readiness === 'disabled' ? 'disabled' : 'unavailable')
      : 'used';
  const stage2 = await runStage2CorrectionCycle({
    workspaceDir,
    classifier: stage2Classifier,
    classifierState: stage2ClassifierState,
    ...(options.stage2AggregateBudgetMs !== undefined ? { aggregateBudgetMs: options.stage2AggregateBudgetMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    onEvent: emitEvent,
  });

  const degradedReason: string | undefined
    = !reconcile.ok ? `reconcile:${reconcile.reason ?? 'failed'}`
    : catchUp.status === 'degraded' ? `catch_up:${catchUp.reason ?? 'degraded'}`
    : diagnostician?.status === 'failed' && diagnostician.errorCategory !== 'lease_conflict' ? `diagnostician_failed:${diagnostician.message ?? 'max_attempts_exceeded'}`
    : diagnostician?.status === 'degraded' ? `diagnostician_degraded:${diagnostician.message ?? 'unknown'}`
    : downstream.skipReason === 'runtime_config_error' || downstream.skipReason === 'cycle_error' || downstream.skipReason === 'config_malformed' ? `downstream:${downstream.skipReason}`
    : !stage2.ok ? `stage2:${stage2.reason ?? 'failed'}`
    : undefined;
  writeLiveness(workspaceDir, {
    runningStage: null,
    stageDeadline: null,
    lastCycleCompletedAt: new Date().toISOString(),
    lastCycleDurationMs: Date.now() - cycleStartedAt.getTime(),
    lastCycleMode: degradedReason !== undefined ? 'degraded' : 'ready',
    lastCycleDriver: workbuddyWorkerCycleDriver(),
    ...(degradedReason !== undefined ? { lastDegradedReason: degradedReason } : {}),
    ...invocationIdLivenessPatch(),
  });
  return {
    ...base,
    mode: degradedReason !== undefined ? 'degraded' : 'ready',
    ...(degradedReason !== undefined ? { reason: degradedReason, nextAction: 'Inspect the governance workspace .pd/config.yaml runtime profile and the per-step report above; the worker retries automatically on the next cycle.' } : {}),
    report: { catchUp, reconcile, diagnostician, downstream, ...(targetEvidenceReconcile !== null ? { targetEvidenceReconcile } : {}), stage2 },
  };
}
