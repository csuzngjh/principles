/**
 * Shared host-neutral internalization consumer cycle (PRI-624 Slice C).
 *
 * Extracted verbatim from openclaw-plugin's
 * `internalization-auto-consumer-service.ts` `runConsumerCycle` so that the
 * OpenClaw auto-consumer scheduler and the Companion workspace worker call
 * ONE downstream execution implementation (SPEC §13: "reusing existing
 * downstream consumer logic" — the Companion must not copy it):
 *
 *   flag gate → config/runtime config → state handle → orchestrator(dryRun)
 *   → queue read model → consumer decision → wakeOnce loop → adapter
 *   → runner construction (dreamer…rollout_reviewer) → runner.run
 *   → commit proposal → finally: recovery sweep + reconciliation budget
 *
 * The lease is acquired INSIDE runner.run by the Runtime V2 lease manager
 * (persisted in `<workspace>/.pd/state.db`, cross-process safe) — this cycle
 * never leases by itself, so two schedulers (OpenClaw + Companion) racing on
 * one workspace converge to exactly-once execution via lease_conflict.
 *
 * Hosts inject: a logger, a structured-event sink, their tool catalog, and an
 * env getter. Everything else is the existing production path.
 */
import { createHash } from 'node:crypto';
import {
  createRuntimeStateHandle,
  InternalizationOrchestrator,
  DreamerRunner,
  PhilosopherRunner,
  ScribeRunner,
  ArtificerRunner,
  EvaluatorRunner,
  RolloutReviewerRunner,
  DefaultDreamerValidator,
  DefaultPhilosopherValidator,
  DefaultScribeValidator,
  DefaultArtificerValidator,
  DefaultEvaluatorValidator,
  DefaultRolloutReviewerValidator,
  PiAiRuntimeAdapter,
  L2AgentLoopAdapter,
  buildL2PrincipleReaderFromLedger,
  OpenClawCliRuntimeAdapter,
  storeEmitter,
  createProductionGateDeps,
  resolveRuntimeConfigFromPdConfig,
  isRuntimeConfigError,
  computeConsumerDecision,
  FULL_CHAIN_CONSUMER_RUNNER_KINDS,
  DEFAULT_CONSUMER_RUNNER_KINDS,
  InternalizationQueueReadModel,
  MVP_CORE_TASK_KINDS,
  SqliteConnection,
  SqliteReconciliationCursorStore,
  SUCCEEDED_TRANSITIONS_SCOPE,
  type PDRuntimeAdapter,
  type RuntimeStateManager,
  type WakeOnceResult,
} from '@principles/core/runtime-v2';
import { loadLedger } from '@principles/core/principle-tree-ledger';
import { loadPdConfigForPlugin, loadFeatureFlagFromConfig } from './pd-config.js';
import { createEvaluatorRepairDeps, createRolloutGovernanceDeps, type ConsumerGovernanceLogger } from './internalization-consumer-governance.js';
import { WorkspaceTelemetryEmitter } from './workspace-telemetry-emitter.js';

export const INTERNALIZATION_AUTO_CONSUMER_FLAG_ID = 'internalization_auto_consumer';

/** Structural logger port — OpenClaw PluginLogger and worker loggers satisfy this. */
export interface ConsumerCycleLogger extends ConsumerGovernanceLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface ConsumerHostToolCatalog {
  readonly readOnlyTools: readonly string[];
  readonly writeTools: readonly string[];
}

export interface InternalizationConsumerCyclePorts {
  /** Runner-owner label recorded on leases ('auto-consumer' | 'companion-worker' | …). */
  readonly owner: string;
  readonly logger: ConsumerCycleLogger;
  /** Structured event sink (OpenClaw: SystemLogger.log; worker: its own log). */
  readonly emitEvent: (event: string, payloadJson: string) => void;
  /**
   * Host-declared runtime-authoritative tool catalog (evaluator; PRI-630).
   * Optional: hosts that have not declared a catalog (Codex as of PRI-624)
   * omit it and the evaluator keeps its pre-catalog behavior — a wrong-host
   * catalog would be worse than none.
   */
  readonly hostToolCatalog?: ConsumerHostToolCatalog;
  /** Log label used in human log prefixes ('AutoConsumer' | 'CodexWorker' | …). */
  readonly logLabel: string;
  readonly envGetter?: (name: string) => string | undefined;
}

export interface InternalizationConsumerCycleOutcome {
  readonly ran: boolean;
  readonly skipReason?: string;
  readonly taskId?: string;
  readonly taskKind?: string;
  readonly runStatus?: 'succeeded' | 'failed' | 'retried';
}

function contentHashFn(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function formatRunOnceCommand(workspaceDir: string): string {
  return `pd runtime internalization run-once --workspace "${workspaceDir}" --runner dreamer --runtime config --json`;
}

function getNextActionForError(category?: string): string {
  if (category === 'lease_conflict') {
    return 'Retry later or check for concurrent worker processes.';
  }
  if (category === 'timeout') {
    return 'Check model provider service status/latency, or increase timeout settings in workflows.yaml.';
  }
  if (category === 'cancelled') {
    return 'Re-enqueue or restart the task if it was cancelled by mistake.';
  }
  if (category === 'output_invalid') {
    return 'Verify if model outputs conform to expected schema and adjust prompt or validation templates if needed.';
  }
  if (category === 'input_invalid') {
    return 'Check predecessor task outputs and database integrity for malformed input references.';
  }
  if (category === 'max_attempts_exceeded') {
    return 'Investigate persistent failures, correct the root issue, and clear last_error or reset attempt count.';
  }
  return 'Run: pd runtime internalization run-once --runner dreamer --runtime config --json to isolate the failure.';
}

/**
 * PRI-554: safe per-cycle expired-lease recovery sweep.
 * - sweep 失败不阻塞 consumer cycle (下轮再试); 显式留痕
 *   INTERNALIZATION_CONSUMER_RECOVER_FAILED (rc-9)。
 */
async function safeRunRecoverySweep(
  stateManager: RuntimeStateManager,
  ports: InternalizationConsumerCyclePorts,
): Promise<void> {
  const { logger, emitEvent, logLabel } = ports;
  try {
    const sweep = await stateManager.runRecoverySweep();
    if (sweep.recovered > 0 || sweep.errors.length > 0) {
      emitEvent('INTERNALIZATION_CONSUMER_RECOVERED', JSON.stringify({
        recovered: sweep.recovered,
        failed: sweep.errors.length,
        errors: sweep.errors,
      }));
      logger.info(
        `[PD:${logLabel}] Recovery sweep: recovered=${sweep.recovered} failed=${sweep.errors.length}`,
      );
    }
  } catch (sweepErr) {
    emitEvent('INTERNALIZATION_CONSUMER_RECOVER_FAILED', String(sweepErr));
    logger.warn(`[PD:${logLabel}] Recovery sweep failed: ${String(sweepErr)}`);
  }
}

/**
 * A (crash window / 最终复核): bounded + fair + restart-durable 的
 * succeeded-transition reconciliation 预算。
 * - ASC 稳定全序 (SQL ORDER BY updated_at, task_id) + 独占元组游标;
 * - 每周期 RECONCILIATION_BUDGET 条,扫到尾部 wrap-around 重置;
 * - 游标持久化于 state.db reconciliation_cursor — restart 后继续;
 * - P1: 任何 reconcile_error 显式留痕 (不依赖 recovered>0)。
 */
const RECONCILIATION_BUDGET = 5;

async function runReconciliationBudget(
  workspaceDir: string,
  orchestrator: InternalizationOrchestrator,
  ports: InternalizationConsumerCyclePorts,
): Promise<void> {
  const { logger, emitEvent, logLabel } = ports;
  try {
    const conn = new SqliteConnection(workspaceDir);
    try {
      const cursorStore = new SqliteReconciliationCursorStore(conn);
      const stored = cursorStore.get(SUCCEEDED_TRANSITIONS_SCOPE);
      const recon = await orchestrator.reconcileSucceededTransitions({
        limit: RECONCILIATION_BUDGET,
        cursor: stored ? { updatedAt: stored.lastUpdatedAt, taskId: stored.lastTaskId } : undefined,
        logger: { info: (msg: string) => logger.info(msg) },
      });
      if (recon.wrappedAround) {
        cursorStore.clear(SUCCEEDED_TRANSITIONS_SCOPE);
      } else {
        cursorStore.set(SUCCEEDED_TRANSITIONS_SCOPE, recon.nextCursor);
      }

      const errors = recon.outcomes.filter((o) => o.decision.startsWith('reconcile_error'));
      if (recon.recovered > 0 || errors.length > 0) {
        emitEvent('INTERNALIZATION_CONSUMER_RECONCILED', JSON.stringify({
          scanned: recon.scanned,
          recovered: recon.recovered,
          alreadyMaterialized: recon.alreadyMaterialized,
          blocked: recon.blocked,
          wrappedAround: recon.wrappedAround,
          recoveries: recon.outcomes.filter((o) => o.decision === 'successor_created' || o.decision.includes('reopened')),
          // P1 (最终复核): per-task 错误显式可观测 — 即使 recovered=0
          errors,
        }));
        logger.info(`[PD:${logLabel}] Reconciliation: recovered=${recon.recovered} errors=${errors.length} wrapped=${recon.wrappedAround}`);
      }
    } finally {
      try { conn.close(); } catch { /* best-effort */ }
    }
  } catch (reconErr) {
    // reconciliation 失败不阻塞周期 (下轮再试);显式留痕 (rc-9)
    emitEvent('INTERNALIZATION_CONSUMER_RECONCILE_FAILED', String(reconErr));
    logger.warn(`[PD:${logLabel}] Succeeded-transition reconciliation failed: ${String(reconErr)}`);
  }
}

/**
 * Run ONE bounded consumer cycle for a workspace. At most one downstream task
 * is leased and executed per cycle (DEFAULT_CONSUMER_MAX_TASKS_PER_CYCLE=1);
 * backlog converges over repeated cycles and never starves reconciliation
 * (bounded budget in the finally block).
 */
export async function runInternalizationConsumerCycle(
  workspaceDir: string,
  ports: InternalizationConsumerCyclePorts,
): Promise<InternalizationConsumerCycleOutcome> {
  const { logger, emitEvent, logLabel, owner } = ports;
  const {hostToolCatalog} = ports;
  const envGetter = ports.envGetter ?? ((name: string) => process.env[name]);
  let orchestrator: InternalizationOrchestrator | null = null;
  const flag = loadFeatureFlagFromConfig(workspaceDir, INTERNALIZATION_AUTO_CONSUMER_FLAG_ID, {
    info: (msg: string) => logger.info(msg),
    warn: (msg: string) => logger.warn(msg),
  });

  if (!flag.enabled) {
    const disabledInfo = JSON.stringify({
      reason: 'internalization_auto_consumer_disabled',
      nextAction: formatRunOnceCommand(workspaceDir),
      flagSource: flag.source,
    });
    emitEvent('INTERNALIZATION_CONSUMER_SKIP', disabledInfo);
    logger.info(`[PD:${logLabel}] Cycle skipped: auto-consumer disabled. Source: ${flag.source}`);
    return { ran: false, skipReason: 'internalization_auto_consumer_disabled' };
  }

  const configResult = loadPdConfigForPlugin(workspaceDir);
  if (!configResult.ok) {
    const malformedInfo = JSON.stringify({
      reason: 'config_malformed',
      nextAction: configResult.errors[0]?.nextAction ?? 'Fix .pd/config.yaml and retry',
      errors: configResult.errors.map((e) => e.reason),
    });
    emitEvent('INTERNALIZATION_CONSUMER_SKIP', malformedInfo);
    logger.warn(`[PD:${logLabel}] Config malformed, skipping cycle.`);
    return { ran: false, skipReason: 'config_malformed' };
  }

  const runtimeConfigResult = resolveRuntimeConfigFromPdConfig(
    configResult.effective,
    (name: string) => envGetter(name),
  );

  if (isRuntimeConfigError(runtimeConfigResult)) {
    const rtInfo = JSON.stringify({
      reason: 'runtime_config_error',
      message: runtimeConfigResult.message,
      nextAction: runtimeConfigResult.nextAction,
    });
    emitEvent('INTERNALIZATION_CONSUMER_SKIP', rtInfo);
    logger.warn(`[PD:${logLabel}] Runtime config error: ${runtimeConfigResult.message}`);
    return { ran: false, skipReason: 'runtime_config_error' };
  }

  let handle: Awaited<ReturnType<typeof createRuntimeStateHandle>> | null = null;
  try {
    handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    const { stateManager } = handle;

    // A (最终复核): orchestrator 必须在所有队列状态相关的早退之前创建 —
    // 纯 orphan 场景 (succeeded 后 crash、队列全空 → readyTaskCount=0) 恰恰
    // 是 reconciliation 存在的理由; 若 orchestrator 为 null, finally 的
    // bounded budget 不会执行, orphan 永远无法恢复。
    const {runtimeKind} = runtimeConfigResult;
    orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner, runtimeKind, dryRun: true },
    );

    const readModel = new InternalizationQueueReadModel(stateManager);
    readModel.setPolicy({
      enabledChannels: new Set(['prompt', 'code_tool_hook', 'defer_archive']),
      actionableTaskKinds: new Set(MVP_CORE_TASK_KINDS),
    });
    const snapshot = await readModel.getSnapshot();

    if (snapshot.readyTasks.length > 5) {
      logger.warn(`[PD:${logLabel}] Backlog detected: ${snapshot.readyTasks.length} tasks ready. Processing only one task.`);
    }

    // PRI-419 amendment: when internalization_full_chain is ON (default), the
    // consumer advances the full dreamer→…→evaluator→rollout_reviewer chain
    // so artifacts reach validation_status='validated' and the approval queue is
    // populated unattended. The human gate is the approval queue (Console), not
    // the rollout_reviewer step. flag-off reverts to dreamer-only.
    const fullChainFlag = loadFeatureFlagFromConfig(workspaceDir, 'internalization_full_chain');
    const consumerRunnerKinds = fullChainFlag.enabled
      ? FULL_CHAIN_CONSUMER_RUNNER_KINDS
      : DEFAULT_CONSUMER_RUNNER_KINDS;

    const decision = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: snapshot.readyTasks.length,
      runnerKinds: consumerRunnerKinds,
    });

    if (!decision.shouldConsume) {
      // 早退不跳过 reconciliation — finally 的 bounded budget 仍会执行
      emitEvent('INTERNALIZATION_CONSUMER_SKIP', JSON.stringify({
        reason: decision.reason,
        readyTaskCount: snapshot.readyTasks.length,
      }));
      return { ran: false, skipReason: decision.reason };
    }

    // Advance the configured runner kinds in priority order (dreamer first,
    // then philosopher→…→rollout_reviewer under full-chain scope). Lease the
    // first ready task whose dependencies are satisfied.
    let wakeResult: Extract<WakeOnceResult, { decision: 'would_lease' }> | null = null;
    let lastSkipDecision = 'no_ready_tasks';
    let lastSkipReason: string | undefined;
    for (const kind of decision.runnerKinds) {
      const candidate = await orchestrator.wakeOnce(kind);
      if (candidate.decision === 'would_lease') {
        wakeResult = candidate;
        break;
      }
      // Keep decision/reason paired across iterations so the final SKIP log
      // never reports a stale reason from an earlier kind (EP-03 observability).
      lastSkipDecision = candidate.decision;
      lastSkipReason = candidate.decision === 'no_ready_tasks' ? candidate.reason : undefined;
    }

    if (!wakeResult) {
      // A: 预算由周期 finally 统一执行 (每周期恰一次,含 backlog 场景)
      const skipPayload: Record<string, unknown> = { decision: lastSkipDecision };
      if (lastSkipReason) {
        skipPayload.reason = lastSkipReason;
      }
      emitEvent('INTERNALIZATION_CONSUMER_SKIP', JSON.stringify(skipPayload));
      logger.info(`[PD:${logLabel}] No task to consume: ${lastSkipDecision}`);
      return { ran: false, skipReason: lastSkipDecision };
    }

    let adapter: PDRuntimeAdapter;
    if (runtimeKind === 'pi-ai') {
      // PRI-419: when l2_dreamer flag is on AND this is a dreamer task, route
      // through the L2 multi-turn agent loop. Non-dreamer runners always use PiAi.
      const l2Flag = loadFeatureFlagFromConfig(workspaceDir, 'l2_dreamer');
      if (l2Flag.enabled && wakeResult.taskKind === 'dreamer') {
        const stateDir = `${workspaceDir}/.state`;
        const principleReader = buildL2PrincipleReaderFromLedger(loadLedger(stateDir), {
          logger: { warn: (msg: string) => logger.warn(msg) },
        });
        adapter = new L2AgentLoopAdapter(
          {
            provider: runtimeConfigResult.provider ?? 'openai',
            model: runtimeConfigResult.model ?? 'gpt-4o',
            apiKeyEnv: runtimeConfigResult.apiKeyEnv ?? 'OPENAI_API_KEY',
            baseUrl: runtimeConfigResult.baseUrl,
            workspace: workspaceDir,
            totalBudgetMs: runtimeConfigResult.timeoutMs,
          },
          {
            artifactReader: {
              // Explicit adapter: PIArtifactRecord → PdL2ArtifactReader. The store returns
              // PIArtifactRecord (with PIArtifactKind enum); map to the ArtifactSummary shape.
              getArtifactById: async (id: string) => {
                const r = await stateManager.piArtifactStore.getArtifactById(id);
                return r ? { artifactId: r.artifactId, artifactKind: String(r.artifactKind), sourceTaskId: r.sourceTaskId, contentJson: r.contentJson, createdAt: r.createdAt } : null;
              },
              listBySourceTaskId: async (taskId: string) => {
                const records = await stateManager.piArtifactStore.listBySourceTaskId(taskId);
                return records.map(r => ({ artifactId: r.artifactId, artifactKind: String(r.artifactKind), sourceTaskId: r.sourceTaskId, contentJson: r.contentJson, createdAt: r.createdAt }));
              },
            },
            principleReader,
          },
        );
      } else {
        adapter = new PiAiRuntimeAdapter({
          provider: runtimeConfigResult.provider ?? 'openai',
          model: runtimeConfigResult.model ?? 'gpt-4o',
          apiKeyEnv: runtimeConfigResult.apiKeyEnv ?? 'OPENAI_API_KEY',
          maxRetries: runtimeConfigResult.maxRetries,
          maxTokens: runtimeConfigResult.maxTokens,
          timeoutMs: runtimeConfigResult.timeoutMs,
          baseUrl: runtimeConfigResult.baseUrl,
          workspace: workspaceDir,
        });
      }
    } else if (runtimeKind === 'openclaw-cli') {
      adapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: runtimeConfigResult.openclawMode ?? 'default',
        workspaceDir: workspaceDir,
      });
    } else {
      throw new Error(`Unsupported runtime kind resolved for auto-consumer: ${runtimeKind}`);
    }

    const {taskId} = wakeResult;
    const {taskKind} = wakeResult;
    // Issue 2: forward effectiveConfig so runners can resolve feature flags
    // (e.g. `artificer_output_retry`) — mirrors the diagnostician wiring
    // (ADR-0019). Flag-off / absent = legacy behavior.
    const runnerOptions = { owner, runtimeKind, effectiveConfig: configResult.effective };

    // PRI-634 A3: workspace-scoped telemetry sink for the evaluator runner.
    // Constructed here (per-wake, workspaceDir in scope) so events from THIS
    // workspace's runner are attributable to THIS workspace — a global
    // subscriber on the storeEmitter singleton cannot (multi-workspace
    // isolation, see workspace-telemetry-emitter.ts). Persist failures
    // degrade through the host's structured event port, never break the runner.
    const evaluatorEmitter = new WorkspaceTelemetryEmitter(storeEmitter, workspaceDir, (detail) => {
      emitEvent('WORKSPACE_TELEMETRY_PERSIST_FAILED', detail);
    });

    // Dispatch by leased task kind. Only kinds listed in
    // FULL_CHAIN_CONSUMER_RUNNER_KINDS can be leased here; anything else
    // (e.g. diagnostician) hits the default branch — fail loud if it does (EP-03).
    let runner: DreamerRunner | PhilosopherRunner | ScribeRunner | ArtificerRunner | EvaluatorRunner | RolloutReviewerRunner;
    switch (taskKind) {
      case 'dreamer':
        runner = new DreamerRunner(
          { stateManager, runtimeAdapter: adapter, eventEmitter: storeEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDreamerValidator(), contentHashFn },
          runnerOptions,
        );
        break;
      case 'philosopher':
        runner = new PhilosopherRunner(
          { stateManager, runtimeAdapter: adapter, eventEmitter: storeEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultPhilosopherValidator(), contentHashFn },
          runnerOptions,
        );
        break;
      case 'scribe':
        runner = new ScribeRunner(
          { stateManager, runtimeAdapter: adapter, eventEmitter: storeEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultScribeValidator(), contentHashFn },
          runnerOptions,
        );
        break;
      case 'artificer':
        runner = new ArtificerRunner(
          { stateManager, runtimeAdapter: adapter, eventEmitter: storeEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultArtificerValidator(), contentHashFn },
          runnerOptions,
        );
        break;
      case 'evaluator':
        // P0-D 生产接线: PRI-509 repair loop 正式进入 consumer (bounded,
        // flag evaluator_artificer_repair_loop 保留运行时关闭能力)。needs_revision
        // → seed artificer repair; commit 门控保证不再并行 seed rollout_reviewer。
        // PRI-630: 注入宿主声明的 runtime-authoritative 工具目录 — 工具名合法
        // 性以目录为准,禁止 LLM 凭记忆判 "非标准工具名" (链 48371236 根因②)。
        // PRI-634 A1/A3: (a) 注入 canonical production gateDeps — 此前缺省导致
        // adversarial replay 结构性不可达 (链 48371236 根因 A1); (b) evaluator
        // 的事件改走 workspace-scoped emitter, 只把 4 类 critical events 落盘到
        // <workspaceDir>/.pd/telemetry/critical-events.jsonl, 其余照旧转发全局
        // storeEmitter (multi-workspace 隔离, 见 workspace-telemetry-emitter.ts)。
        // gateDeps 属于 evaluator production semantics, 不是宿主可选能力 —
        // 无论 OpenClaw 还是 Codex worker 执行, deterministic gate wiring
        // 必须存在 (第二个 options 参数, 绝不放第一个 deps 参数)。
        runner = new EvaluatorRunner(
          {
            stateManager, runtimeAdapter: adapter, eventEmitter: evaluatorEmitter,
            artifactStore: stateManager.piArtifactStore, validator: new DefaultEvaluatorValidator(),
            ...createEvaluatorRepairDeps(workspaceDir, stateManager, logger),
          },
          {
            ...runnerOptions,
            gateDeps: createProductionGateDeps(),
            ...(hostToolCatalog
              ? { hostToolCatalog: { readOnlyTools: [...hostToolCatalog.readOnlyTools], writeTools: [...hostToolCatalog.writeTools] } }
              : {}),
          },
        );
        break;
      case 'rollout_reviewer':
        // Lineage echo reconciliation is built into the runner: LLM-truncated
        // taskId / sourceEvaluatorArtifactId echoes are overwritten with the
        // authoritative values before validation, so a bad echo no longer
        // dead-ends the candidate before the approval queue.
        //
        // P0-E/F 治理接线: approve_rollout → 自动 ActivationDispatcher (低风险
        // auto_activate / 高风险 approvals.pending); needs_revision → reopen
        // scribe/artificer 修订 (绝不进入 approval 队列, INV-04)。
        runner = new RolloutReviewerRunner(
          {
            stateManager, runtimeAdapter: adapter, eventEmitter: storeEmitter,
            artifactStore: stateManager.piArtifactStore, validator: new DefaultRolloutReviewerValidator(),
            ...createRolloutGovernanceDeps(workspaceDir, orchestrator, logger),
          },
          runnerOptions,
        );
        break;
      default:
        emitEvent('INTERNALIZATION_CONSUMER_SKIP', JSON.stringify({ decision: 'no_runner_for_kind', taskKind }));
        logger.warn(`[PD:${logLabel}] No consumer runner for task kind '${taskKind}'; skipping. Advance manually: pd runtime internalization run-once --runner ${taskKind}`);
        return { ran: false, skipReason: 'no_runner_for_kind', taskKind };
    }

    logger.info(`[PD:${logLabel}] Running ${taskKind} task: ${taskId}`);
    emitEvent('INTERNALIZATION_CONSUMER_RUN', JSON.stringify({
      taskId,
      taskKind,
    }));

    let runResult;
    try {
      runResult = await runner.run(taskId);
    } catch (runErr) {
      logger.error(`[PD:${logLabel}] Runner crashed for task ${taskId}: ${String(runErr)}`);
      try {
        const task = await stateManager.getTask(taskId);
        const failureReason = `Unhandled runner exception: ${runErr instanceof Error ? runErr.message : String(runErr)}`;
        if (task && stateManager.getRetryPolicy().shouldRetry(task)) {
          await stateManager.markTaskRetryWait(taskId, 'execution_failed', failureReason);
          logger.info(`[PD:${logLabel}] Marked task ${taskId} as retry_wait.`);
        } else {
          await stateManager.markTaskFailed(taskId, 'execution_failed', failureReason);
          logger.info(`[PD:${logLabel}] Marked task ${taskId} as failed.`);
        }
      } catch (dbErr) {
        logger.error(`[PD:${logLabel}] Failed to update state for crashed task ${taskId}: ${String(dbErr)}`);
      }
      throw runErr;
    }

    if (runResult.status === 'succeeded') {
      let commitResult: Awaited<ReturnType<typeof orchestrator.commitNextTaskProposal>> | null = null;
      try {
        commitResult = await orchestrator.commitNextTaskProposal(taskId);
      } catch (commitErr) {
        // The task itself succeeded — a successor-proposal failure must not
        // misreport the run; surface it as its own structured event (rc-9).
        emitEvent('INTERNALIZATION_CONSUMER_COMMIT_FAILED', JSON.stringify({ taskId, error: String(commitErr).slice(0, 300) }));
        logger.warn(`[PD:${logLabel}] Task ${taskId} succeeded but successor proposal failed: ${String(commitErr).slice(0, 200)}`);
      }
      emitEvent('INTERNALIZATION_CONSUMER_SUCCESS', JSON.stringify({
        taskId,
        status: runResult.status,
        ...(commitResult ? { successorDecision: commitResult.decision } : { successorDecision: 'commit_failed' }),
      }));
      logger.info(
        `[PD:${logLabel}] Task ${taskId} succeeded. Successor: ${commitResult ? commitResult.decision : 'commit_failed'}`,
      );
      return { ran: true, taskId, taskKind, runStatus: 'succeeded' };
    }
    const {errorCategory} = runResult;
    const {failureReason} = runResult;
    const nextAction = getNextActionForError(errorCategory);
    emitEvent('INTERNALIZATION_CONSUMER_TASK_FAILED', JSON.stringify({
      taskId,
      status: runResult.status,
      errorCategory,
      failureReason,
      nextAction,
    }));
    logger.warn(
      `[PD:${logLabel}] Task ${taskId} status: ${runResult.status}. Category: ${errorCategory}. Reason: ${failureReason}. Next Action: ${nextAction}`
    );
    return { ran: true, taskId, taskKind, runStatus: runResult.status === 'retried' ? 'retried' : 'failed' };
  } catch (err) {
    emitEvent('INTERNALIZATION_CONSUMER_ERROR', String(err));
    logger.error(`[PD:${logLabel}] Cycle error: ${String(err)}`);
    return { ran: false, skipReason: 'cycle_error' };
  } finally {
    // PRI-554: per-cycle expired-lease recovery sweep. Worker process death
    // mid-lease leaves tasks invisible to findCandidates (pending/retry_wait
    // only); without this sweep they stay leased forever. Runs before
    // reconciliation and is gated on `handle` (not `orchestrator`) so it still
    // executes if the orchestrator constructor threw — enumerate every early
    // return between resource-open and the finally steps (ERR-024).
    if (handle) {
      await safeRunRecoverySweep(handle.stateManager, ports);
    }
    // A (最终复核): 每周期固定小预算 — continuous backlog 下 reconciliation
    // 不会被 ready 任务永久饿死 (公平性);游标 restart-durable。
    // 必须在 handle.close() 之前执行 (orchestrator 共享该 stateManager)。
    if (orchestrator) {
      await runReconciliationBudget(workspaceDir, orchestrator, ports);
    }
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}
