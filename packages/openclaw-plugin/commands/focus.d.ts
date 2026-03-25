/**
 * /pd-focus 命令 - 管理 CURRENT_FOCUS.md
 *
 * 功能：
 * - status: 查看当前状态和历史版本
 * - compress: 手动压缩并备份
 * - history: 查看历史版本列表
 * - rollback: 回滚到指定历史版本
 */
import type { PluginCommandContext, PluginCommandResult, OpenClawPluginApi } from '../openclaw-sdk.js';
/**
 * 处理 /pd-focus 命令
 */
export declare function handleFocusCommand(ctx: PluginCommandContext, api: OpenClawPluginApi): Promise<PluginCommandResult>;
