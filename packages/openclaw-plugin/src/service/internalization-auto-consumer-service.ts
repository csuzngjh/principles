import type { OpenClawPluginServiceContext, PluginLogger } from '../openclaw-sdk.js';
import {
  createRuntimeStateHandle,
  InternalizationOrchestrator,
  DreamerRunner,
  DefaultDreamerValidator,
  PiAiRuntimeAdapter,
  storeEmitter,
  resolveRuntimeConfigFromPdConfig,
  isRuntimeConfigError,
  computeConsumerDecision,
  InternalizationQueueReadModel,
  MVP_CORE_TASK_KINDS,
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

async function runConsumerCycle(
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

    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: 'auto-consumer', runtimeKind: 'config', dryRun: false },
    );

    const wakeResult = await orchestrator.wakeOnce('dreamer');

    if (wakeResult.decision !== 'leased') {
      const skipPayload: Record<string, unknown> = {
        decision: wakeResult.decision,
      };
      if (Object.hasOwn(wakeResult, 'reason')) {
        const rawReason = (wakeResult as unknown as Record<string, unknown>).reason;
        if (typeof rawReason === 'string') {
          skipPayload.reason = rawReason;
        }
      }
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', JSON.stringify(skipPayload));
      logger.info(`[PD:AutoConsumer] No task to consume: ${wakeResult.decision}`);
      return;
    }

    const adapter = new PiAiRuntimeAdapter({
      provider: runtimeConfigResult.provider ?? 'openai',
      model: runtimeConfigResult.model ?? 'gpt-4o',
      apiKeyEnv: runtimeConfigResult.apiKeyEnv ?? 'OPENAI_API_KEY',
      maxRetries: runtimeConfigResult.maxRetries,
      timeoutMs: runtimeConfigResult.timeoutMs,
      baseUrl: runtimeConfigResult.baseUrl,
      workspace: workspaceDir,
    });

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
        runtimeKind: 'config',
      },
    );

    const taskId = wakeResult.taskId;
    logger.info(`[PD:AutoConsumer] Running dreamer task: ${taskId}`);
    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_RUN', JSON.stringify({
      taskId,
      taskKind: 'dreamer',
    }));

    const runResult = await runner.run(taskId);

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
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_TASK_FAILED', JSON.stringify({
        taskId,
        status: runResult.status,
      }));
      logger.warn(`[PD:AutoConsumer] Task ${taskId} status: ${runResult.status}`);
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
