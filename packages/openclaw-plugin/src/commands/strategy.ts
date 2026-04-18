import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';
import { WorkspaceContext } from '../core/workspace-context.js';

export function handleInitStrategy(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'strategy');
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });

  const okrDir = wctx.resolve('OKR_DIR').replace(workspaceDir, '').replace(/^\/+/, '');
  const focusPath = wctx.resolve('CURRENT_FOCUS').replace(workspaceDir, '').replace(/^\/+/, '');
  const userContextPath = wctx.resolve('USER_CONTEXT').replace(workspaceDir, '').replace(/^\/+/, '');

  return {
    text:
      `🎯 **Strategy Initialization**\n\n` +
      `The Agent will now conduct a deep interview to establish your project's vision and strategic OKRs.\n\n` +
      `**Instructions for Agent:** Read \`${okrDir}/\` for existing context. ` +
      `Generate \`${focusPath}\` with the top 1-3 strategic focus areas based on the user interview. ` +
      `Then update \`${userContextPath}\` with key user preferences discovered.`,
  };
}

export function handleManageOkr(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'strategy:manageOkr');
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });

  const focusPath = wctx.resolve('CURRENT_FOCUS').replace(workspaceDir, '').replace(/^\/+/, '');
  const weekStatePath = wctx.resolve('WEEK_STATE').replace(workspaceDir, '').replace(/^\/+/, '');

  return {
    text:
      `📊 **OKR Management**\n\n` +
      `The Agent will analyze recent work and align sub-agent objectives.\n\n` +
      `**Instructions for Agent:** Read \`${focusPath}\` and \`${weekStatePath}\`. ` +
      `Compare them against recent session history. ` +
      `Update OKRs as needed and output a brief alignment report. ` +
      `If OKRs are stale (>7 days), prompt the user for a re-alignment conversation.`,
  };
}
