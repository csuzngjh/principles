import type { OpenClawPluginServiceContext, PluginLogger } from '../openclaw-sdk.js';
import {
  createRuntimeStateHandle,
  InternalizationOrchestrator,
  DreamerRunner,
  DefaultDreamerValidator,
  PiAiRuntimeAdapter,
  L2AgentLoopAdapter,
  buildL2PrincipleReader,
  OpenClawCliRuntimeAdapter,
  storeEmitter,
  resolveRuntimeConfigFromPdConfig,
  isRuntimeConfigError,
  computeConsumerDecision,
  InternalizationQueueReadModel,
  MVP_CORE_TASK_KINDS,
  type PDRuntimeAdapter,
} from '@principles/core/runtime-v2';
import { loadPdConfigForPlugin, loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { SystemLogger } from '../core/system-logger.js';

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

    const decision = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: snapshot.readyTasks.length,
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

    const wakeResult = await orchestrator.wakeOnce('dreamer');

    if (wakeResult.decision !== 'would_lease') {
      const skipPayload: Record<string, unknown> = {
        decision: wakeResult.decision,
      };
      if (wakeResult.decision === 'no_ready_tasks') {
        skipPayload.reason = wakeResult.reason;
      }
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', JSON.stringify(skipPayload));
      logger.info(`[PD:AutoConsumer] No task to consume: ${wakeResult.decision}`);
      return;
    }

    let adapter: PDRuntimeAdapter;
    if (runtimeKind === 'pi-ai') {
      // PRI-419: when l2_dreamer flag is on, route through the L2 multi-turn agent loop.
      const l2Flag = loadFeatureFlagFromConfig(workspaceDir, 'l2_dreamer');
      if (l2Flag.enabled) {
        const stateDir = `${workspaceDir}/.state`;
        const principleReader = buildL2PrincipleReader(stateDir, {
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

    const validator = new DefaultDreamerValidator();
    const runner = new DreamerRunner(
      {
        stateManager,
        runtimeAdapter: adapter,
        eventEmitter: storeEmitter,
        artifactStore: stateManager.piArtifactStore,
        validator,
      },
      {
        owner: 'auto-consumer',
        runtimeKind,
      },
    );

    const taskId = wakeResult.taskId;
    logger.info(`[PD:AutoConsumer] Running dreamer task: ${taskId}`);
    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_RUN', JSON.stringify({
      taskId,
      taskKind: 'dreamer',
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
