import { handleBeforePromptBuild } from './hooks/prompt';
import { handleBeforeToolCall } from './hooks/gate';
import { handleAfterToolCall } from './hooks/pain';
import { handleInitStrategy, handleManageOkr } from './commands/strategy';

export function register(api: any): void {
  api.logger.info("Principles Disciple Plugin registered.");

  api.on('before_prompt_build', (event: any, ctx: any) => handleBeforePromptBuild(event, ctx));
  api.on('before_tool_call', (event: any, ctx: any) => handleBeforeToolCall(event, ctx));
  api.on('after_tool_call', (event: any, ctx: any) => handleAfterToolCall(event, ctx));

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
}
