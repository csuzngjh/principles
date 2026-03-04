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
import { handleInitStrategy, handleManageOkr } from './commands/strategy.js';
import { handleEvolveTask } from './commands/evolver.js';
import { handleBootstrapTools } from './commands/capabilities.js';

const plugin = {
  id: "principles-disciple",
  name: "Principles Disciple",
  description: "Evolutionary programming agent framework with strategic guardrails and reflection loops.",

  register(api: OpenClawPluginApi) {
    api.logger.info("Principles Disciple Plugin registered.");

    // ── Prompt injection: USER_CONTEXT, CURRENT_FOCUS, pain signals, capabilities ──
    api.on(
      'before_prompt_build',
      (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext): PluginHookBeforePromptBuildResult | void => {
        return handleBeforePromptBuild(event, ctx);
      }
    );

    // ── Gatekeeper: block writes to risk_paths without a READY plan ──
    api.on(
      'before_tool_call',
      (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext): PluginHookBeforeToolCallResult | void => {
        const pluginConfig = api.pluginConfig ?? {};
        return handleBeforeToolCall(event, { ...ctx, pluginConfig });
      }
    );

    // ── Pain signal: capture tool failures into .pain_flag ──
    api.on(
      'after_tool_call',
      (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
        const pluginConfig = api.pluginConfig ?? {};
        handleAfterToolCall(event, { ...ctx, pluginConfig });
      }
    );

    // ── Lifecycle: summarise pain before session clear ──
    api.on(
      'before_reset',
      async (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext): Promise<void> => {
        await handleBeforeReset(event, ctx);
      }
    );

    // ── Lifecycle: flush checkpoint before compaction ──
    api.on(
      'before_compaction',
      async (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext): Promise<void> => {
        await handleBeforeCompaction(event, ctx);
      }
    );

    // ── Subagent propagation: log PD protocol injection ──
    api.on(
      'subagent_spawning',
      (event: PluginHookSubagentSpawningEvent, _ctx: PluginHookSubagentContext): PluginHookSubagentSpawningResult => {
        api.logger.info(`[PD] Subagent spawning: ${event.agentId} (child: ${event.childSessionKey})`);
        return { status: "ok" };
      }
    );

    // ── Slash commands (auto-reply, bypass LLM) ──
    api.registerCommand({
      name: "init-strategy",
      description: "Initialize evolutionary OKR strategy",
      acceptsArgs: false,
      handler: (ctx) => handleInitStrategy(ctx)
    });

    api.registerCommand({
      name: "manage-okr",
      description: "Manage project OKRs and focus areas",
      acceptsArgs: false,
      handler: (ctx) => handleManageOkr(ctx)
    });

    api.registerCommand({
      name: "evolve-task",
      description: "Trigger the Evolver agent for deep code repair via sessions_spawn",
      acceptsArgs: true,
      handler: (ctx) => handleEvolveTask(ctx)
    });

    api.registerCommand({
      name: "bootstrap-tools",
      description: "Scan and upgrade environment capabilities",
      acceptsArgs: false,
      handler: (ctx) => handleBootstrapTools(ctx)
    });
  }
};

export default plugin;
