import type {
  OpenClawPluginApi,
  PluginHookBeforePromptBuildEvent,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
  PluginHookBeforeToolCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookBeforeResetEvent,
  PluginHookBeforeCompactionEvent,
  PluginHookSubagentSpawningEvent,
  PluginHookSubagentContext,
  PluginHookSubagentSpawningResult,
} from './openclaw-sdk.js';

import { handleBeforePromptBuild } from './hooks/prompt.js';
import { handleBeforeToolCall } from './hooks/gate.js';
import { handleAfterToolCall } from './hooks/pain.js';
import { handleBeforeReset, handleBeforeCompaction } from './hooks/lifecycle.js';
import { handleLlmOutput } from './hooks/llm.js';
import { handleSubagentEnded } from './hooks/subagent.js';
import { handleInitStrategy, handleManageOkr } from './commands/strategy.js';
import { handleEvolveTask } from './commands/evolver.js';
import { handleBootstrapTools, handleResearchTools } from './commands/capabilities.js';
import { handleThinkingOs } from './commands/thinking-os.js';
import { EvolutionWorkerService } from './service/evolution-worker.js';

const plugin = {
  id: "principles-disciple",
  name: "Principles Disciple",
  description: "Evolutionary programming agent framework with strategic guardrails and reflection loops.",

  register(api: OpenClawPluginApi) {
    api.logger.info("Principles Disciple Plugin registered.");

    let workspaceDir: string;
    try {
      workspaceDir = api.resolvePath('.');
    } catch (err) {
      api.logger.error(`[PD] Failed to resolve workspace directory: ${String(err)}`);
      workspaceDir = process.cwd();
    }

    // ── Prompt injection ──
    api.on(
      'before_prompt_build',
      (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext): PluginHookBeforePromptBuildResult | void => {
        try {
          return handleBeforePromptBuild(event, ctx);
        } catch (err) {
          api.logger.error(`[PD] Error in before_prompt_build: ${String(err)}`);
        }
      }
    );

    // ── Gatekeeper ──
    api.on(
      'before_tool_call',
      (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext): PluginHookBeforeToolCallResult | void => {
        try {
          const pluginConfig = api.pluginConfig ?? {};
          return handleBeforeToolCall(event, { ...ctx, workspaceDir, pluginConfig });
        } catch (err) {
          api.logger.error(`[PD] Error in before_tool_call: ${String(err)}`);
        }
      }
    );

    // ── Pain signal ──
    api.on(
      'after_tool_call',
      (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
        try {
          const pluginConfig = api.pluginConfig ?? {};
          handleAfterToolCall(event, { ...ctx, workspaceDir, pluginConfig });
        } catch (err) {
          api.logger.error(`[PD] Error in after_tool_call: ${String(err)}`);
        }
      }
    );

    // ── Lifecycle: Reset ──
    api.on(
      'before_reset',
      async (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext): Promise<void> => {
        try {
          await handleBeforeReset(event, ctx);
        } catch (err) {
          api.logger.error(`[PD] Error in before_reset: ${String(err)}`);
        }
      }
    );

    // ── Lifecycle: Compaction ──
    api.on(
      'before_compaction',
      async (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext): Promise<void> => {
        try {
          await handleBeforeCompaction(event, ctx);
        } catch (err) {
          api.logger.error(`[PD] Error in before_compaction: ${String(err)}`);
        }
      }
    );

    // ── LLM Cognitive Tracking: Catch agent confusion ──
    api.on(
      'llm_output',
      (event, ctx): void => {
        try {
          handleLlmOutput(event, { ...ctx, workspaceDir });
        } catch (err) {
          api.logger.error(`[PD] Error in llm_output: ${String(err)}`);
        }
      }
    );

    // ── Subagent propagation ──
    api.on(
      'subagent_spawning',
      (event: PluginHookSubagentSpawningEvent, _ctx: PluginHookSubagentContext): PluginHookSubagentSpawningResult => {
        try {
          api.logger.info(`[PD] Subagent spawning: ${event.agentId} (child: ${event.childSessionKey}). Principles protocol injected.`);
          return { status: "ok" };
        } catch (err) {
          api.logger.error(`[PD] Error in subagent_spawning: ${String(err)}`);
          return { status: "ok" };
        }
      }
    );

    // ── Subagent outcome: Catch subagent failures ──
    api.on(
      'subagent_ended',
      (event, ctx): void => {
        try {
          handleSubagentEnded(event, { ...ctx, workspaceDir });
        } catch (err) {
          api.logger.error(`[PD] Error in subagent_ended: ${String(err)}`);
        }
      }
    );

    // ── Service: Autonomous Background Evolution Worker ──
    try {
      api.registerService(EvolutionWorkerService);
    } catch (err) {
      api.logger.error(`[PD] Failed to register EvolutionWorkerService: ${String(err)}`);
    }

    // ── Slash commands ──
    api.registerCommand({
      name: "init-strategy",
      description: "Initialize evolutionary OKR strategy",
      acceptsArgs: false,
      handler: (ctx) => {
        try {
          return handleInitStrategy(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /init-strategy failed: ${String(err)}`);
          return { text: "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "manage-okr",
      description: "Manage project OKRs and focus areas",
      acceptsArgs: false,
      handler: (ctx) => {
        try {
          return handleManageOkr(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /manage-okr failed: ${String(err)}`);
          return { text: "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "evolve-task",
      description: "Trigger the Evolver agent for deep code repair via sessions_spawn",
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          return handleEvolveTask(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /evolve-task failed: ${String(err)}`);
          return { text: "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "bootstrap-tools",
      description: "Scan and upgrade environment capabilities",
      acceptsArgs: false,
      handler: (ctx) => {
        try {
          return handleBootstrapTools(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /bootstrap-tools failed: ${String(err)}`);
          return { text: "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "research-tools",
      description: "Ask the agent to research front-edge CLI tools online",
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          return handleResearchTools(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /research-tools failed: ${String(err)}`);
          return { text: "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "thinking-os",
      description: "Manage the Thinking OS cognitive layer (status/propose/audit)",
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          return handleThinkingOs({ ...ctx, config: { workspaceDir } });
        } catch (err) {
          api.logger.error(`[PD] Command /thinking-os failed: ${String(err)}`);
          return { text: "Command failed. Check logs." };
        }
      }
    });
  }
};

export default plugin;
