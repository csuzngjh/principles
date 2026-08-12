import type { OpenClawPluginServiceContext, PluginLogger } from '../openclaw-sdk.js';
import {
  createRuntimeStateHandle,
  InternalizationOrchestrator,
  DreamerRunner,
  PhilosopherRunner,
  ScribeRunner,
  ArtificerRunner,
  EvaluatorRunner,
  DefaultDreamerValidator,
  DefaultPhilosopherValidator,
  DefaultScribeValidator,
  DefaultArtificerValidator,
  DefaultEvaluatorValidator,
  PiAiRuntimeAdapter,
  L2AgentLoopAdapter,
  buildL2PrincipleReaderFromLedger,
  OpenClawCliRuntimeAdapter,
  storeEmitter,
  resolveRuntimeConfigFromPdConfig,
  isRuntimeConfigError,
  computeConsumerDecision,
  FULL_CHAIN_CONSUMER_RUNNER_KINDS,
  DEFAULT_CONSUMER_RUNNER_KINDS,
  InternalizationQueueReadModel,
  MVP_CORE_TASK_KINDS,
  type PDRuntimeAdapter,
  type WakeOnceResult,
} from '@principles/core/runtime-v2';
import { loadLedger } from '@principles/core/principle-tree-ledger';
import { loadPdConfigForPlugin, loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
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
    // auto-consumer advances the full dreamer→…→evaluator chain so artifacts
    // reach validation_status='validated'. flag-off reverts to dreamer-only.
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
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', JSON.stringify({
        reason: decision.reason,
        readyTaskCount: snapshot.readyTasks.length,
      }));
      return;
    }

    const runtimeKind = runtimeConfigResult.runtimeKind;

    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: 'auto-consumer', runtimeKind, dryRun: true },
    );

    // Advance the configured runner kinds in priority order (dreamer first,
    // then philosopher→…→evaluator under full-chain scope). Lease the first
    // ready task whose dependencies are satisfied. rollout_reviewer is never
    // in the auto-consume set — it stays a manual Owner gate.
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
    const runnerOptions = { owner: 'auto-consumer' as const, runtimeKind };

    // Dispatch by leased task kind. rollout_reviewer and diagnostician stages
    // are never auto-consumed (excluded from FULL_CHAIN_CONSUMER_RUNNER_KINDS),
    // so they should not reach the default branch — fail loud if they do (EP-03).
    let runner: DreamerRunner | PhilosopherRunner | ScribeRunner | ArtificerRunner | EvaluatorRunner;
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
        // Base construction — the PRI-509 repair loop is intentionally NOT
        // wired here; it stays opt-in via the separate evaluator_artificer_repair_loop
        // flag (quiet, default off). When omitted, evaluator follows the legacy
        // needs_revision path (no repair task seeded), which is sufficient for
        // artifacts to reach validation_status='validated' on approved candidates.
        runner = new EvaluatorRunner(
          { stateManager, runtimeAdapter: adapter, eventEmitter: storeEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultEvaluatorValidator() },
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
    if (handle) {
      await handle.close().catch(() => {});
    }
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
