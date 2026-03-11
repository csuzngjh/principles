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
  PluginHookAfterCompactionEvent,
  PluginHookSubagentEndedEvent,
  PluginHookLlmOutputEvent,
  PluginHookSubagentSpawningEvent,
  PluginHookSubagentSpawningResult,
  PluginHookSubagentContext,
} from './openclaw-sdk.js';
import { handleBeforePromptBuild } from './hooks/prompt.js';
import { handleBeforeToolCall } from './hooks/gate.js';
import { handleAfterToolCall } from './hooks/pain.js';
import { handleBeforeReset, handleBeforeCompaction, handleAfterCompaction } from './hooks/lifecycle.js';
import { handleLlmOutput } from './hooks/llm.js';
import { handleSubagentEnded } from './hooks/subagent.js';
import { handleInitStrategy, handleManageOkr } from './commands/strategy.js';
import { handleBootstrapTools, handleResearchTools } from './commands/capabilities.js';
import { handleThinkingOs } from './commands/thinking-os.js';
import { handleEvolveTask } from './commands/evolver.js';
import { handleTrustCommand } from './commands/trust.js';
import { handlePainCommand } from './commands/pain.js';
import { EvolutionWorkerService } from './service/evolution-worker.js';
import { ensureWorkspaceTemplates } from './core/init.js';
import { migrateDirectoryStructure } from './core/migration.js';
import { SystemLogger } from './core/system-logger.js';
import { deepReflectTool } from './tools/deep-reflect.js';

// Track initialization to avoid repeated calls
let workspaceInitialized = false;

const plugin = {
  name: "Principles Disciple",
  description: "Evolutionary programming agent framework with strategic guardrails and reflection loops.",

  register(api: OpenClawPluginApi) {
    api.logger.info("Principles Disciple Plugin registered.");

    const language = (api.pluginConfig?.language as string) || 'en';

    // ── Hook: Prompt Building ──
    api.on(
      'before_prompt_build',
      async (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext): Promise<PluginHookBeforePromptBuildResult | void> => {
        try {
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          if (!workspaceInitialized && workspaceDir) {
            migrateDirectoryStructure(api, workspaceDir);
            ensureWorkspaceTemplates(api, workspaceDir, language);
            SystemLogger.log(workspaceDir, 'SYSTEM_BOOT', `Principles Disciple online. Language: ${language}`);
            workspaceInitialized = true;
          }
          return await handleBeforePromptBuild(event, { ...ctx, api, workspaceDir });
        } catch (err) {
          api.logger.error(`[PD] Error in before_prompt_build: ${String(err)}`);
        }
      }
    );

    // ── Hook: Security Gate ──
    api.on(
      'before_tool_call',
      (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext): PluginHookBeforeToolCallResult | void => {
        try {
          const pluginConfig = api.pluginConfig ?? {};
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          const logger = api.logger;
          return handleBeforeToolCall(event, { ...ctx, workspaceDir, pluginConfig, logger });
        } catch (err) {
          api.logger.error(`[PD] Error in before_tool_call: ${String(err)}`);
        }
      }
    );

    // ── Hook: Pain & Trust ──
    api.on(
      'after_tool_call',
      (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
        try {
          const pluginConfig = api.pluginConfig ?? {};
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          // Pass api separately to handleAfterToolCall to maintain type safety
          handleAfterToolCall(event, { ...ctx, workspaceDir, pluginConfig }, api);
        } catch (err) {
          api.logger.error(`[PD] Error in after_tool_call: ${String(err)}`);
        }
      }
    );

    // ── Hook: LLM Analysis ──
    api.on(
      'llm_output',
      (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void => {
        try {
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          handleLlmOutput(event, { ...ctx, workspaceDir });
        } catch (err) {
          api.logger.error(`[PD] Error in llm_output: ${String(err)}`);
        }
      }
    );

    // ── Hook: Subagent Loop Closure ──
    api.on(
      'subagent_spawning',
      (_event: PluginHookSubagentSpawningEvent, _ctx: PluginHookSubagentContext): void | PluginHookSubagentSpawningResult => {
        // No-op for now, just to satisfy the interface expected by tests.
        return { status: 'ok' };
      }
    );

    api.on(
      'subagent_ended',
      (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext): void => {
        try {
          const workspaceDir = api.resolvePath('.');
          handleSubagentEnded(event, { ...ctx, workspaceDir });
        } catch (err) {
          api.logger.error(`[PD] Error in subagent_ended: ${String(err)}`);
        }
      }
    );

    // ── Hook: Lifecycle ──
    api.on('before_reset', (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => {
      const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
      return handleBeforeReset(event, { ...ctx, workspaceDir });
    });
    
    api.on('before_compaction', (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => {
      const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
      return handleBeforeCompaction(event, { ...ctx, workspaceDir });
    });
    
    api.on('after_compaction', (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => {
      const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
      return handleAfterCompaction(event, { ...ctx, workspaceDir });
    });

    // ── Service: Background Evolution Worker ──
    try {
      EvolutionWorkerService.api = api;
      api.registerService(EvolutionWorkerService);
    } catch (err) {
      api.logger.error(`[PD] Failed to register EvolutionWorkerService: ${String(err)}`);
    }

    // ── Slash Commands ──
    api.registerCommand({
      name: "init-strategy",
      description: "Initialize strategy interview and OKRs",
      handler: (ctx) => handleInitStrategy(ctx)
    });

    api.registerCommand({
      name: "manage-okr",
      description: "Analyze progress and align OKRs",
      handler: (ctx) => handleManageOkr(ctx)
    });

    api.registerCommand({
      name: "bootstrap-tools",
      description: "Auto-detect and save environment capabilities",
      handler: (ctx) => handleBootstrapTools(ctx)
    });

    api.registerCommand({
      name: "research-tools",
      description: "Initiate research for tool upgrades",
      handler: (ctx) => handleResearchTools(ctx)
    });

    api.registerCommand({
      name: "thinking-os",
      description: "Manage Thinking OS mental models and candidates",
      acceptsArgs: true,
      handler: (ctx) => handleThinkingOs(ctx)
    });

    api.registerCommand({
      name: "evolve-task",
      description: "Diagnose systemic pain and evolve principles",
      acceptsArgs: true,
      handler: (ctx) => handleEvolveTask(ctx)
    });

    api.registerCommand({
      name: "evolution-daily",
      description: "Send evolution daily report",
      handler: (_ctx) => {
        return { text: "请执行 evolution-daily 技能来配置并发送进化日报。系统将引导你完成配置流程，包括发送时间、渠道和报告风格偏好。" };
      }
    });

    api.registerCommand({
      name: "workspace-grooming",
      description: "Trigger a cyber-housekeeper to clean up and organize your workspace root.",
      handler: (_ctx) => {
        return { text: "请调用 `workspace-grooming` 技能来执行大扫除。例如输入: '执行 /workspace-grooming 技能'" };
      }
    });

    api.registerCommand({
      name: "trust",
      description: "View Agent trust score and security stage",
      handler: (ctx) => {
        const workspaceDir = api.resolvePath('.');
        return { text: handleTrustCommand({ ...ctx, workspaceDir }) };
      }
    });

    api.registerCommand({
      name: "pd-status",
      description: "View Digital Nerve System status (GFI and Pain Dictionary)",
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = api.resolvePath('.');
          // Ensure workspaceDir is in config for handlePainCommand
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handlePainCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-status failed: ${String(err)}`);
          return { text: "Command failed. Check logs." };
        }
      }
    });

    // ── Tools ──
    api.registerTool(deepReflectTool);
  }
};

export default plugin;
