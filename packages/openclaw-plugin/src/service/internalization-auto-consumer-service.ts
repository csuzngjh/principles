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

let consumerTimeoutId: ReturnType<typeof setTimeout> | null = null;
let consumerStopped = false;
const startedWorkspaces = new Set<string>();

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
      nextAction:
        'pd runtime internalization run-once --workspace "<workspace>" --runner dreamer --runtime config --json',
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

    const decision = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 1,
    });

    if (!decision.shouldConsume) {
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', JSON.stringify({
        reason: decision.reason,
      }));
      return;
    }

    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: 'auto-consumer', runtimeKind: 'config', dryRun: false },
    );

    const wakeResult = await orchestrator.wakeOnce('dreamer');

    if (wakeResult.decision !== 'would_lease') {
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', JSON.stringify({
        decision: wakeResult.decision,
        reason: wakeResult.decision === 'no_ready_tasks'
          ? (wakeResult as { reason: string }).reason
          : undefined,
      }));
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

    if (startedWorkspaces.has(workspaceDir)) {
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
        nextAction:
          'pd runtime internalization run-once --workspace "<workspace>" --runner dreamer --runtime config --json',
        flagSource: flag.source,
      });
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_DISABLED', disabledInfo);
      logger.info(
        `[PD:AutoConsumer] NOT started for workspace: ${workspaceDir}. Disabled (source: ${flag.source}).`,
      );
      return;
    }

    startedWorkspaces.add(workspaceDir);
    consumerStopped = false;

    const interval = INTERNALIZATION_AUTO_CONSUMER_INTERVAL_MS;

    async function runCycle(): Promise<void> {
      if (consumerStopped) return;
      await runConsumerCycle(workspaceDir, logger);
      if (consumerStopped) return;
      consumerTimeoutId = setTimeout(runCycle, interval);
      consumerTimeoutId.unref();
    }

    consumerTimeoutId = setTimeout(() => {
      void runCycle().catch((err: unknown) => {
        logger.error(`[PD:AutoConsumer] Startup cycle failed: ${String(err)}`);
        if (consumerStopped) return;
        consumerTimeoutId = setTimeout(runCycle, interval);
        consumerTimeoutId.unref();
      });
    }, INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS);
    consumerTimeoutId.unref();

    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_STARTED', JSON.stringify({
      intervalMs: interval,
      initialDelayMs: INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS,
    }));
    logger.info(
      `[PD:AutoConsumer] Started for workspace: ${workspaceDir} (interval: ${interval}ms, initial delay: ${INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS}ms)`,
    );
  },

  stop(_ctx: OpenClawPluginServiceContext): void {
    consumerStopped = true;
    startedWorkspaces.clear();
    if (consumerTimeoutId) clearTimeout(consumerTimeoutId);
    consumerTimeoutId = null;
  },
};
