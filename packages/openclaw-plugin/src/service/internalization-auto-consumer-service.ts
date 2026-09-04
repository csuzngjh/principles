/**
 * OpenClaw internalization auto-consumer service.
 *
 * PRI-624 (Codex Closure Slice C): the downstream execution logic now lives in
 * the shared host-neutral `runInternalizationConsumerCycle`
 * (`@principles/host-runtime`), extracted verbatim from this service so the
 * OpenClaw scheduler and the Companion workspace worker execute ONE
 * implementation. This module keeps only what is genuinely OpenClaw-specific:
 * the service lifecycle (timer chain per workspace), the OpenClaw tool
 * catalog, the plugin logger, and SystemLogger event emission.
 */
import type { OpenClawPluginServiceContext, PluginLogger } from '../openclaw-sdk.js';
import { READ_ONLY_TOOL_NAMES, LOW_RISK_WRITE_TOOL_NAMES, HIGH_RISK_TOOL_NAMES, AGENT_TOOL_NAMES } from '../constants/tools.js';
import { OPENCLAW_TOOL_SEMANTICS, OPENCLAW_TOOL_SEMANTIC_MAPPINGS } from '../constants/tool-semantics.js';
import { runInternalizationConsumerCycle, INTERNALIZATION_AUTO_CONSUMER_FLAG_ID, saveHostToolDeclaration } from '@principles/host-runtime';
import { loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { SystemLogger } from '../core/system-logger.js';

const INTERNALIZATION_AUTO_CONSUMER_INTERVAL_MS = 120_000;
const INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS = 30_000;

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

export async function runConsumerCycle(
  workspaceDir: string,
  logger: PluginLogger,
): Promise<void> {
  await runInternalizationConsumerCycle(workspaceDir, {
    owner: 'auto-consumer',
    logLabel: 'AutoConsumer',
    logger,
    emitEvent: (event, payload) => SystemLogger.log(workspaceDir, event, payload),
    hostToolCatalog: {
      readOnlyTools: READ_ONLY_TOOL_NAMES,
      writeTools: [...LOW_RISK_WRITE_TOOL_NAMES, ...HIGH_RISK_TOOL_NAMES, ...AGENT_TOOL_NAMES],
    },
    // PRI-634-F: OpenClaw tool semantics (derived from constants/tools.ts) —
    // the activation gate replays with production-identical tool resolution.
    toolSemantics: OPENCLAW_TOOL_SEMANTICS,
  });
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

    // PRI-634-F R2: persist the OpenClaw tool declaration as workspace
    // provenance — host-neutral consumers (pd-cli activation) load it to run
    // reliability validation with the SAME registry instead of guessing the
    // host. The declaration derives from this package's constants (single
    // source); each gateway start refreshes it.
    const declared = saveHostToolDeclaration(workspaceDir, {
      version: 1,
      hostKind: 'openclaw',
      mappings: OPENCLAW_TOOL_SEMANTIC_MAPPINGS,
      declaredAt: new Date().toISOString(),
    });
    if (!declared.ok) {
      logger.warn(`[PD:AutoConsumer] Failed to persist OpenClaw tool declaration: ${declared.reason} — pd-cli reliability validation will not find it (rc-9)`);
    }

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
