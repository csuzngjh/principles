import type { OpenClawPluginServiceContext, PluginLogger } from '../openclaw-sdk.js';
import { READ_ONLY_TOOL_NAMES, LOW_RISK_WRITE_TOOL_NAMES, HIGH_RISK_TOOL_NAMES, AGENT_TOOL_NAMES } from '../constants/tools.js';
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
  type PDRuntimeAdapter,
  type RuntimeStateManager,
  type WakeOnceResult,
} from '@principles/core/runtime-v2';
import { loadLedger } from '@principles/core/principle-tree-ledger';
import { loadPdConfigForPlugin, loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { createEvaluatorRepairDeps, createRolloutGovernanceDeps } from './auto-consumer-governance-wiring.js';
import { WorkspaceTelemetryEmitter } from './workspace-telemetry-sink.js';
import {
  SqliteConnection,
  SqliteReconciliationCursorStore,
  SUCCEEDED_TRANSITIONS_SCOPE,
} from '@principles/core/runtime-v2';
import { SystemLogger } from '../core/system-logger.js';
import { computeHash as contentHashFn } from '../utils/hashing.js';

const INTERNALIZATION_AUTO_CONSUMER_INTERVAL_MS = 120_000;
const INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS = 30_000;
const INTERNALIZATION_AUTO_CONSUMER_FLAG_ID = 'internalization_auto_consumer';

export interface InternalizationAutoConsumerServiceShape {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void;
  stop?: (ctx: OpenClawPluginServiceContext) => void;
}

interface WorkspaceConsumerState {
  stopped: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

const workspaceStates = new Map<string, WorkspaceConsumerState>();

function getWorkspaceState(workspaceDir: string): WorkspaceConsumerState {
  let state = workspaceStates.get(workspaceDir);
  if (!state) {
    state = { stopped: false, timeoutId: null };
    workspaceStates.set(workspaceDir, state);
  }
  return state;
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

export async function runConsumerCycle(
  workspaceDir: string,
  logger: PluginLogger,
): Promise<void> {
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
    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', disabledInfo);
    logger.info(`[PD:AutoConsumer] Cycle skipped: auto-consumer disabled. Source: ${flag.source}`);
    return;
  }

  const configResult = loadPdConfigForPlugin(workspaceDir);
  if (!configResult.ok) {
    const malformedInfo = JSON.stringify({
      reason: 'config_malformed',
      nextAction: configResult.errors[0]?.nextAction ?? 'Fix .pd/config.yaml and retry',
      errors: configResult.errors.map((e) => e.reason),
    });
    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', malformedInfo);
    logger.warn(`[PD:AutoConsumer] Config malformed, skipping cycle.`);
    return;
  }

  const runtimeConfigResult = resolveRuntimeConfigFromPdConfig(
    configResult.effective,
    (name: string) => process.env[name],
  );

  if (isRuntimeConfigError(runtimeConfigResult)) {
    const rtInfo = JSON.stringify({
      reason: 'runtime_config_error',
      message: runtimeConfigResult.message,
      nextAction: runtimeConfigResult.nextAction,
    });
    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', rtInfo);
    logger.warn(`[PD:AutoConsumer] Runtime config error: ${runtimeConfigResult.message}`);
    return;
  }

  let handle: Awaited<ReturnType<typeof createRuntimeStateHandle>> | null = null;
  try {
    handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    const { stateManager } = handle;

    // A (最终复核): orchestrator 必须在所有队列状态相关的早退之前创建 —
    // 纯 orphan 场景 (succeeded 后 crash、队列全空 → readyTaskCount=0) 恰恰
    // 是 reconciliation 存在的理由; 若 orchestrator 为 null, finally 的
    // bounded budget 不会执行, orphan 永远无法恢复。
    const runtimeKind = runtimeConfigResult.runtimeKind;
    orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: 'auto-consumer', runtimeKind, dryRun: true },
    );

    const readModel = new InternalizationQueueReadModel(stateManager);
    readModel.setPolicy({
      enabledChannels: new Set(['prompt', 'code_tool_hook', 'defer_archive']),
      actionableTaskKinds: new Set(MVP_CORE_TASK_KINDS),
    });
    const snapshot = await readModel.getSnapshot();

    if (snapshot.readyTasks.length > 5) {
      logger.warn(`[PD:AutoConsumer] Backlog detected: ${snapshot.readyTasks.length} tasks ready. Processing only one task.`);
    }

    // PRI-419 amendment: when internalization_full_chain is ON (default), the
    // auto-consumer advances the full dreamer→…→evaluator→rollout_reviewer chain
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
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', JSON.stringify({
        reason: decision.reason,
        readyTaskCount: snapshot.readyTasks.length,
      }));
      return;
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
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', JSON.stringify(skipPayload));
      logger.info(`[PD:AutoConsumer] No task to consume: ${lastSkipDecision}`);
      return;
    }

    let adapter: PDRuntimeAdapter;
    if (runtimeKind === 'pi-ai') {
      // PRI-419: when l2_dreamer flag is on AND this is a dreamer task, route
      // through the L2 multi-turn agent loop. Non-dreamer runners always use PiAi.
      const l2Flag = loadFeatureFlagFromConfig(workspaceDir, 'l2_dreamer');
      if (l2Flag.enabled && wakeResult.taskKind === 'dreamer') {
        const stateDir = `${workspaceDir}/.state`;
        const principleReader = buildL2PrincipleReaderFromLedger(loadLedger(stateDir), {
          logger: { warn: (msg) => logger.warn(msg) },
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

    const taskId = wakeResult.taskId;
    const taskKind = wakeResult.taskKind;
    // Issue 2: forward effectiveConfig so runners can resolve feature flags
    // (e.g. `artificer_output_retry`) — mirrors the diagnostician wiring
    // (ADR-0019). Flag-off / absent = legacy behavior.
    const runnerOptions = { owner: 'auto-consumer' as const, runtimeKind, effectiveConfig: configResult.effective };

    // PRI-634 A3: workspace-scoped telemetry sink for the evaluator runner.
    // Constructed here (per-wake, workspaceDir in scope) so events from THIS
    // workspace's runner are attributable to THIS workspace — a global
    // subscriber on the storeEmitter singleton cannot (multi-workspace
    // isolation, see workspace-telemetry-sink.ts).
    const evaluatorEmitter = new WorkspaceTelemetryEmitter(storeEmitter, workspaceDir);

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
        // P0-D 生产接线: PRI-509 repair loop 正式进入 auto-consumer (bounded,
        // flag evaluator_artificer_repair_loop 保留运行时关闭能力)。needs_revision
        // → seed artificer repair; commit 门控保证不再并行 seed rollout_reviewer。
        // PRI-630: 注入宿主声明的 runtime-authoritative 工具目录 — 工具名合法
        // 性以目录为准,禁止 LLM 凭记忆判 "非标准工具名" (链 48371236 根因②)。
        // PRI-634 A1/A3: (a) 注入 canonical production gateDeps — 此前缺省导致
        // adversarial replay 结构性不可达 (链 48371236 根因 A1); (b) evaluator
        // 的事件改走 workspace-scoped emitter, 只把 4 类 critical events 落盘到
        // <workspaceDir>/.pd/telemetry/critical-events.jsonl, 其余照旧转发全局
        // storeEmitter (multi-workspace 隔离, 见 workspace-telemetry-sink.ts)。
        runner = new EvaluatorRunner(
          {
            stateManager, runtimeAdapter: adapter, eventEmitter: evaluatorEmitter,
            artifactStore: stateManager.piArtifactStore, validator: new DefaultEvaluatorValidator(),
            ...createEvaluatorRepairDeps(workspaceDir, stateManager, logger),
          },
          {
            ...runnerOptions,
            gateDeps: createProductionGateDeps(),
            hostToolCatalog: {
              readOnlyTools: [...READ_ONLY_TOOL_NAMES],
              writeTools: [...LOW_RISK_WRITE_TOOL_NAMES, ...HIGH_RISK_TOOL_NAMES, ...AGENT_TOOL_NAMES],
            },
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
        SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', JSON.stringify({ decision: 'no_runner_for_kind', taskKind }));
        logger.warn(`[PD:AutoConsumer] No auto-consumer runner for task kind '${taskKind}'; skipping. Advance manually: pd runtime internalization run-once --runner ${taskKind}`);
        return;
    }

    logger.info(`[PD:AutoConsumer] Running ${taskKind} task: ${taskId}`);
    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_RUN', JSON.stringify({
      taskId,
      taskKind,
    }));

    let runResult;
    try {
      runResult = await runner.run(taskId);
    } catch (runErr) {
      logger.error(`[PD:AutoConsumer] Runner crashed for task ${taskId}: ${String(runErr)}`);
      try {
        const task = await stateManager.getTask(taskId);
        const failureReason = `Unhandled runner exception: ${runErr instanceof Error ? runErr.message : String(runErr)}`;
        if (task && stateManager.getRetryPolicy().shouldRetry(task)) {
          await stateManager.markTaskRetryWait(taskId, 'execution_failed', failureReason);
          logger.info(`[PD:AutoConsumer] Marked task ${taskId} as retry_wait.`);
        } else {
          await stateManager.markTaskFailed(taskId, 'execution_failed', failureReason);
          logger.info(`[PD:AutoConsumer] Marked task ${taskId} as failed.`);
        }
      } catch (dbErr) {
        logger.error(`[PD:AutoConsumer] Failed to update state for crashed task ${taskId}: ${String(dbErr)}`);
      }
      throw runErr;
    }

    if (runResult.status === 'succeeded') {
      const commitResult = await orchestrator.commitNextTaskProposal(taskId);
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SUCCESS', JSON.stringify({
        taskId,
        status: runResult.status,
        successorDecision: commitResult.decision,
      }));
      logger.info(
        `[PD:AutoConsumer] Task ${taskId} succeeded. Successor: ${commitResult.decision}`,
      );
    } else {
      const errorCategory = runResult.errorCategory;
      const failureReason = runResult.failureReason;
      const nextAction = getNextActionForError(errorCategory);
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_TASK_FAILED', JSON.stringify({
        taskId,
        status: runResult.status,
        errorCategory,
        failureReason,
        nextAction,
      }));
      logger.warn(
        `[PD:AutoConsumer] Task ${taskId} status: ${runResult.status}. Category: ${errorCategory}. Reason: ${failureReason}. Next Action: ${nextAction}`
      );
    }
  } catch (err) {
    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_ERROR', String(err));
    logger.error(`[PD:AutoConsumer] Cycle error: ${String(err)}`);
  } finally {
    // PRI-554: per-cycle expired-lease recovery sweep. Worker process death
    // mid-lease leaves tasks invisible to findCandidates (pending/retry_wait
    // only); without this sweep they stay leased forever. Runs before
    // reconciliation and is gated on `handle` (not `orchestrator`) so it still
    // executes if the orchestrator constructor threw — enumerate every early
    // return between resource-open and the finally steps (ERR-024).
    if (handle) {
      await safeRunRecoverySweep(workspaceDir, handle.stateManager, logger);
    }
    // A (最终复核): 每周期固定小预算 — continuous backlog 下 reconciliation
    // 不会被 ready 任务永久饿死 (公平性);游标 restart-durable。
    // 必须在 handle.close() 之前执行 (orchestrator 共享该 stateManager)。
    if (orchestrator) {
      await runReconciliationBudget(workspaceDir, orchestrator, logger);
    }
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

/**
 * PRI-554: safe per-cycle expired-lease recovery sweep.
 * - sweep 失败不阻塞 consumer cycle (下轮再试); 显式留痕
 *   INTERNALIZATION_CONSUMER_RECOVER_FAILED (rc-9)。
 * - 有实际恢复或逐任务错误时记录 recovered/failed 计数, 与
 *   runReconciliationBudget 同级观测; sweep 自身对每个恢复的任务发遥测事件
 *   (task_retried / task_failed), 此处不重复。
 */
async function safeRunRecoverySweep(
  workspaceDir: string,
  stateManager: RuntimeStateManager,
  logger: PluginLogger,
): Promise<void> {
  try {
    const sweep = await stateManager.runRecoverySweep();
    if (sweep.recovered > 0 || sweep.errors.length > 0) {
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_RECOVERED', JSON.stringify({
        recovered: sweep.recovered,
        failed: sweep.errors.length,
        errors: sweep.errors,
      }));
      logger.info(
        `[PD:AutoConsumer] Recovery sweep: recovered=${sweep.recovered} failed=${sweep.errors.length}`,
      );
    }
  } catch (sweepErr) {
    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_RECOVER_FAILED', String(sweepErr));
    logger.warn(`[PD:AutoConsumer] Recovery sweep failed: ${String(sweepErr)}`);
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
  logger: PluginLogger,
): Promise<void> {
  try {
    const conn = new SqliteConnection(workspaceDir);
    try {
      const cursorStore = new SqliteReconciliationCursorStore(conn);
      const stored = cursorStore.get(SUCCEEDED_TRANSITIONS_SCOPE);
      const recon = await orchestrator.reconcileSucceededTransitions({
        limit: RECONCILIATION_BUDGET,
        cursor: stored ? { updatedAt: stored.lastUpdatedAt, taskId: stored.lastTaskId } : undefined,
        logger: { info: (msg) => logger.info(msg) },
      });
      if (recon.wrappedAround) {
        cursorStore.clear(SUCCEEDED_TRANSITIONS_SCOPE);
      } else {
        cursorStore.set(SUCCEEDED_TRANSITIONS_SCOPE, recon.nextCursor);
      }

      const errors = recon.outcomes.filter((o) => o.decision.startsWith('reconcile_error'));
      if (recon.recovered > 0 || errors.length > 0) {
        SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_RECONCILED', JSON.stringify({
          scanned: recon.scanned,
          recovered: recon.recovered,
          alreadyMaterialized: recon.alreadyMaterialized,
          blocked: recon.blocked,
          wrappedAround: recon.wrappedAround,
          recoveries: recon.outcomes.filter((o) => o.decision === 'successor_created' || o.decision.includes('reopened')),
          // P1 (最终复核): per-task 错误显式可观测 — 即使 recovered=0
          errors,
        }));
        logger.info(`[PD:AutoConsumer] Reconciliation: recovered=${recon.recovered} errors=${errors.length} wrapped=${recon.wrappedAround}`);
      }
    } finally {
      try { conn.close(); } catch { /* best-effort */ }
    }
  } catch (reconErr) {
    // reconciliation 失败不阻塞周期 (下轮再试);显式留痕 (rc-9)
    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_RECONCILE_FAILED', String(reconErr));
    logger.warn(`[PD:AutoConsumer] Succeeded-transition reconciliation failed: ${String(reconErr)}`);
  }
}

export const InternalizationAutoConsumerService: InternalizationAutoConsumerServiceShape = {
  id: 'principles-internalization-auto-consumer',

  start(ctx: OpenClawPluginServiceContext): void {
    const maybeWorkspaceDir = ctx?.workspaceDir;
    const logger = ctx?.logger || console;

    if (!maybeWorkspaceDir) {
      logger.warn('[PD:AutoConsumer] No workspace directory, not starting.');
      return;
    }

    const workspaceDir: string = maybeWorkspaceDir;
    const state = getWorkspaceState(workspaceDir);

    if (!state.stopped && state.timeoutId !== null) {
      logger.info(`[PD:AutoConsumer] Already started for workspace: ${workspaceDir}`);
      return;
    }

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
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_DISABLED', disabledInfo);
      logger.info(
        `[PD:AutoConsumer] NOT started for workspace: ${workspaceDir}. Disabled (source: ${flag.source}).`,
      );
      return;
    }

    state.stopped = false;

    const interval = INTERNALIZATION_AUTO_CONSUMER_INTERVAL_MS;

    function scheduleNext(): void {
      if (state.stopped) return;
      state.timeoutId = setTimeout(runCycle, interval);
      state.timeoutId?.unref();
    }

    async function runCycle(): Promise<void> {
      if (state.stopped) return;
      await runConsumerCycle(workspaceDir, logger);
      scheduleNext();
    }

    state.timeoutId = setTimeout(() => {
      void runCycle().catch((err: unknown) => {
        logger.error(`[PD:AutoConsumer] Startup cycle failed: ${String(err)}`);
        if (state.stopped) return;
        state.timeoutId = setTimeout(runCycle, interval);
        state.timeoutId?.unref();
      });
    }, INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS);
    state.timeoutId?.unref();

    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_STARTED', JSON.stringify({
      intervalMs: interval,
      initialDelayMs: INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS,
    }));
    logger.info(
      `[PD:AutoConsumer] Started for workspace: ${workspaceDir} (interval: ${interval}ms, initial delay: ${INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS}ms)`,
    );
  },

  stop(ctx: OpenClawPluginServiceContext): void {
    const workspaceDir = ctx?.workspaceDir;
    if (workspaceDir) {
      const state = workspaceStates.get(workspaceDir);
      if (state) {
        state.stopped = true;
        if (state.timeoutId) clearTimeout(state.timeoutId);
        state.timeoutId = null;
      }
      workspaceStates.delete(workspaceDir);
    } else {
      for (const [, state] of workspaceStates) {
        state.stopped = true;
        if (state.timeoutId) clearTimeout(state.timeoutId);
        state.timeoutId = null;
      }
      workspaceStates.clear();
    }
  },
};
