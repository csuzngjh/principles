import { handleBeforePromptBuild } from './hooks/prompt';
import { handleBeforeToolCall } from './hooks/gate';
import { handleAfterToolCall } from './hooks/pain';
import { handleInitStrategy, handleManageOkr } from './commands/strategy';
import { handleEvolveTask } from './commands/evolver';
const plugin = {
    id: "principles-disciple",
    name: "Principles Disciple",
    description: "Evolutionary programming agent framework with strategic guardrails and reflection loops.",
    register(api) {
        api.logger.info("Principles Disciple Plugin registered.");
        // Merge OpenClaw config with local PROFILE.json in hooks
        api.on('before_prompt_build', (event, ctx) => handleBeforePromptBuild(event, ctx));
        api.on('before_tool_call', (event, ctx) => {
            // Pass the plugin config to the handler
            return handleBeforeToolCall(event, { ...ctx, pluginConfig: api.pluginConfig });
        });
        api.on('after_tool_call', (event, ctx) => {
            return handleAfterToolCall(event, { ...ctx, pluginConfig: api.pluginConfig });
        });
        // Listen for agent communication to inject protocol schemas
        api.on('message_sending', (event) => {
            if (event.content && event.content.includes('agent_send')) {
                api.logger.info("Intercepted agent_send, ensuring protocol alignment.");
            }
        });
        api.registerCommand({
            name: "init-strategy",
            description: "Initialize evolutionary OKR strategy",
            handler: (ctx) => handleInitStrategy(ctx)
        });
        api.registerCommand({
            name: "manage-okr",
            description: "Manage project OKRs and focus",
            handler: (ctx) => handleManageOkr(ctx)
        });
        api.registerCommand({
            name: "evolve-task",
            description: "Trigger the Evolver agent for deep code repair (sessions_spawn mode)",
            handler: (ctx) => handleEvolveTask(ctx)
        });
    }
};
export default plugin;
