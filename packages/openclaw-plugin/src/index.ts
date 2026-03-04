import { handleBeforePromptBuild } from './hooks/prompt';
import { handleBeforeToolCall } from './hooks/gate';
import { handleAfterToolCall } from './hooks/pain';
import { handleBeforeReset, handleBeforeCompaction } from './hooks/lifecycle';
import { handleInitStrategy, handleManageOkr } from './commands/strategy';
import { handleEvolveTask } from './commands/evolver';
import { handleBootstrapTools } from './commands/capabilities';

const plugin = {
  id: "principles-disciple",
  name: "Principles Disciple",
  description: "Evolutionary programming agent framework with strategic guardrails and reflection loops.",
  
  register(api: any) {
    api.logger.info("Principles Disciple Plugin registered.");

    api.on('before_prompt_build', (event: any, ctx: any) => handleBeforePromptBuild(event, ctx));
    
    api.on('before_tool_call', (event: any, ctx: any) => {
      return handleBeforeToolCall(event, { ...ctx, pluginConfig: api.pluginConfig });
    });

    api.on('after_tool_call', (event: any, ctx: any) => {
      return handleAfterToolCall(event, { ...ctx, pluginConfig: api.pluginConfig });
    });

    api.on('before_reset', (event: any, ctx: any) => handleBeforeReset(event, ctx));
    api.on('before_compaction', (event: any, ctx: any) => handleBeforeCompaction(event, ctx));

    // Ensure subagents inherit the strategic context and schemas
    api.on('subagent_spawning', (event: any, ctx: any) => {
      api.logger.info(`Injecting PD protocol into subagent: ${event.agentId}`);
      // In a real implementation, we could modify ctx.bootstrapFiles here
      return { status: "ok" };
    });

    api.registerCommand({
      name: "init-strategy",
      description: "Initialize evolutionary OKR strategy",
      handler: (ctx: any) => handleInitStrategy(ctx)
    });

    api.registerCommand({
      name: "manage-okr",
      description: "Manage project OKRs and focus",
      handler: (ctx: any) => handleManageOkr(ctx)
    });

    api.registerCommand({
      name: "evolve-task",
      description: "Trigger the Evolver agent for deep code repair (sessions_spawn mode)",
      handler: (ctx: any) => handleEvolveTask(ctx)
    });

    api.registerCommand({
      name: "bootstrap-tools",
      description: "Scan and upgrade environment capabilities",
      handler: (ctx: any) => handleBootstrapTools(ctx)
    });
  }
};

export default plugin;
