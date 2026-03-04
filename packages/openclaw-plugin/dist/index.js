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
        api.on('before_prompt_build', (event, ctx) => handleBeforePromptBuild(event, ctx));
        api.on('before_tool_call', (event, ctx) => handleBeforeToolCall(event, ctx));
        api.on('after_tool_call', (event, ctx) => handleAfterToolCall(event, ctx));
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
            description: "Trigger the Evolver agent for deep code repair",
            handler: (ctx) => handleEvolveTask(ctx)
        });
    }
};
export default plugin;
