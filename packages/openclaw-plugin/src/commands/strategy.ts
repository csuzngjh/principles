import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';
import { WorkspaceContext } from '../core/workspace-context.js';

/**
 * /pd-init — conversational Principle Context interview (SPEC v1.1 §8.4).
 *
 * The command ONLY interviews the Owner and outputs a three-section draft.
 * It never creates, overwrites, migrates or rewrites CURRENT_FOCUS.md: the
 * file is the Owner-maintained Principle Context source and every write stays
 * with the Owner. When the file is missing, the Owner creates it manually
 * (an automated template placement is Batch 3 work, NOT authorized yet, so
 * this command must not advertise it).
 */
export function handleInitStrategy(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'strategy');
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });

  // Display-only relative paths: normalize Windows separators so the guidance
  // reads identically on every host (no path computation depends on this).
  const toDisplayPath = (value: string): string =>
    value.replace(workspaceDir, '').replace(/^[/\\]+/u, '').replace(/\\/gu, '/');
  const okrDir = toDisplayPath(wctx.resolve('OKR_DIR'));
  const focusPath = toDisplayPath(wctx.resolve('CURRENT_FOCUS'));

  return {
    text:
      `🎯 **Principle Context 初始化访谈**\n\n` +
      `Agent 将通过访谈帮你整理长期背景（而非任务管理）：\n\n` +
      `**访谈提纲：**\n` +
      `1. **Long-term Background（长期背景）** — 项目的目标与战略背景是什么？\n` +
      `2. **Important Constraints（重要约束）** — 有哪些必须遵守的约束与价值取向？\n` +
      `3. **Current Direction（当前方向）** — 当前阶段的长期方向是什么？\n\n` +
      `**Agent 指令：** 围绕以上三节访谈 Owner，整理出三节草案并完整展示给 Owner；` +
      `由 Owner 自行复制或手动编辑 \`${focusPath}\`。` +
      `**禁止**自动创建、覆盖、迁移或重写该文件；对既有旧内容只提供整理建议，不做自动转换。\n\n` +
      `💡 若 \`${focusPath}\` 尚不存在：请 Owner 手动创建该文件（目标路径为工作区内的 \`${focusPath}\`）。` +
      `可参考 \`${okrDir}/\` 中的现有上下文。`,
  };
}
