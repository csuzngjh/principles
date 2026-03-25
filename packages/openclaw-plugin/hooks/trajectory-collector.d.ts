/**
 * Trajectory Collector - 行为进化引擎 Phase 0 数据收集
 *
 * 收集工具调用和 LLM 输出到 memory/trajectories/ 目录
 * 用于分析工具使用模式、识别原则应用案例、评估行为质量
 */
import type { PluginHookAfterToolCallEvent, PluginHookToolContext, PluginHookLlmOutputEvent, PluginHookAgentContext, PluginHookBeforeMessageWriteEvent } from '../openclaw-sdk.js';
/**
 * 工具调用完成后的处理
 * 记录：工具名、参数、结果、错误、执行时间
 */
export declare function handleAfterToolCall(event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext & {
    workspaceDir?: string;
}): void;
/**
 * LLM 输出处理
 * 记录：provider、model、输出长度、token 使用量
 */
export declare function handleLlmOutput(event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext & {
    workspaceDir?: string;
}): void;
/**
 * 消息写入前的处理
 * 记录：用户/助手消息内容
 */
export declare function handleBeforeMessageWrite(event: PluginHookBeforeMessageWriteEvent, ctx: PluginHookAgentContext & {
    workspaceDir?: string;
}): void;
/**
 * 轨迹汇总统计（供 cron 任务调用）
 */
export declare function computeTrajectoryStats(workspaceDir: string): object;
